//! The hub: keeps the list of open Claude sessions, follows each one's transcript, and serves the
//! map page with a live stream (server-sent events) on 127.0.0.1.

use crate::registry::{Registry, Summary};
use crate::sessions;
use crate::transcript::{self, Follower};
use axum::{
    extract::{Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use futures_util::{stream, Stream, StreamExt};
use serde_json::json;
use std::{
    collections::HashMap,
    convert::Infallible,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

const INDEX: &str = include_str!("../../web/index.html");
const CSS: &str = include_str!("../../web/style.css");
const ICON: &str = include_str!("../../install/sessionbrain.svg");
const APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/app.js"));
/// The page's typefaces, Geist and Geist Mono (SIL OFL; web/fonts/LICENSE-geist), in the scripts its languages need.
const FONTS: &[(&str, &[u8])] = &[
    ("geist-latin", include_bytes!("../../web/fonts/geist-latin.woff2")),
    ("geist-latin-ext", include_bytes!("../../web/fonts/geist-latin-ext.woff2")),
    ("geist-cyrillic", include_bytes!("../../web/fonts/geist-cyrillic.woff2")),
    ("geist-mono-latin", include_bytes!("../../web/fonts/geist-mono-latin.woff2")),
    ("geist-mono-latin-ext", include_bytes!("../../web/fonts/geist-mono-latin-ext.woff2")),
    ("geist-mono-cyrillic", include_bytes!("../../web/fonts/geist-mono-cyrillic.woff2")),
];

include!(concat!(env!("OUT_DIR"), "/art.rs"));

/// How often the session files are read again (a few stat and read calls).
const SCAN_EVERY: Duration = Duration::from_secs(2);
/// How often the transcripts are looked at for new lines (a stat per file when nothing changed).
const TAIL_EVERY: Duration = Duration::from_millis(400);
/// The soonest a session file change makes the session files be read again.
const SCAN_SOONEST: Duration = Duration::from_millis(100);
/// How often `claude agents` runs, only where the session files cannot be read and a page is open.
const AGENTS_EVERY: Duration = Duration::from_secs(10);

pub struct Config {
    pub port: u16,
    pub claude: String,
    pub sessions_dir: PathBuf,
    pub projects_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            port: port(),
            claude: std::env::var("SESSIONBRAIN_CLAUDE").unwrap_or_else(|_| "claude".into()),
            sessions_dir: sessions::sessions_dir(),
            projects_dir: transcript::projects_dir(),
        }
    }
}

/// The page port: SESSIONBRAIN_PORT, else this account's own. 7317 for the first account (uid 1000)
/// and one up for each after it, so two people logged in at once each reach their own hub.
pub fn port() -> u16 {
    std::env::var("SESSIONBRAIN_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or_else(own_port)
}

extern "C" {
    fn getuid() -> u32;
}

fn own_port() -> u16 {
    // SAFETY: getuid cannot fail and touches no memory of ours.
    let uid = unsafe { getuid() };
    if (1000..3000).contains(&uid) {
        7317 + (uid - 1000) as u16
    } else {
        7317
    }
}

/// Where this account's key is kept: SESSIONBRAIN_KEY_FILE, else $XDG_STATE_HOME/sessionbrain/key.
fn key_path() -> PathBuf {
    if let Ok(p) = std::env::var("SESSIONBRAIN_KEY_FILE") {
        return PathBuf::from(p);
    }
    std::env::var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/state"))
        .join("sessionbrain/key")
}

/// The key a request must carry: only this account can read the file it is kept in (0600), so
/// another account on the same computer reads nothing from this hub. Made on first use.
pub fn key() -> Result<String, String> {
    if let Ok(k) = std::env::var("SESSIONBRAIN_KEY") {
        return Ok(k);
    }
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    let path = key_path();
    let read = |p: &PathBuf| std::fs::read_to_string(p).ok().map(|k| k.trim().to_string()).filter(|k| k.len() >= 32);
    if let Some(k) = read(&path) {
        return Ok(k);
    }
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    }
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|e| format!("no randomness: {e}"))?;
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path) {
        Ok(mut f) => {
            f.write_all(key.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            Ok(key)
        }
        // Another process made it first: use theirs.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read(&path).ok_or_else(|| format!("{} is unreadable", path.display())),
        Err(e) => Err(format!("cannot make {}: {e}", path.display())),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Clone, Debug)]
enum Push {
    Sessions(Arc<String>),
    /// Everything about one session, for a page to start over from.
    View(String, Arc<String>),
    /// New records of one session.
    Records(String, Arc<String>),
    /// Asks the SessionBrain window to switch to this session (Super+Shift+W, `sessionbrain here`).
    Show(String),
}

struct Hub {
    reg: Mutex<Registry>,
    followers: Mutex<HashMap<String, Follower>>,
    tx: broadcast::Sender<Push>,
    clients: AtomicUsize,
    last_key: Mutex<String>,
    last_agents: Mutex<Option<Instant>>,
    claude: String,
    sessions_dir: PathBuf,
    projects_dir: PathBuf,
}

type Shared = Arc<Hub>;

impl Hub {
    fn summaries_json(&self) -> (String, String) {
        let list = self.reg.lock().unwrap().summaries(now_ms());
        let key = serde_json::to_string(&list.iter().cloned().map(|s| Summary { last_seen: None, ..s }).collect::<Vec<_>>()).unwrap_or_default();
        (serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()), key)
    }

    /// Tells every page about the session list, when what the picker shows has changed.
    fn push_sessions(&self, force: bool) {
        let (list, key) = self.summaries_json();
        let mut last = self.last_key.lock().unwrap();
        if !force && *last == key {
            return;
        }
        *last = key;
        let _ = self.tx.send(Push::Sessions(Arc::new(list)));
    }

    fn push_view(&self, id: &str) {
        let view = self.reg.lock().unwrap().view(id, now_ms());
        if let Some(view) = view {
            let _ = self.tx.send(Push::View(id.to_string(), Arc::new(view)));
        }
    }

    /// Reads which sessions are open (the session files, or `claude agents` where those cannot be
    /// read) and starts following the transcript of any open session not followed yet.
    async fn refresh_sessions(self: &Arc<Self>, eager: bool) {
        let dir = self.sessions_dir.clone();
        let rows = tokio::task::spawn_blocking(move || sessions::read_dir(&dir)).await.ok().flatten();
        let rows = match rows {
            Some(rows) => Some(rows),
            None => {
                let due = {
                    let last = self.last_agents.lock().unwrap();
                    last.is_none_or(|t| t.elapsed() >= AGENTS_EVERY)
                };
                if due && (eager || self.clients.load(Ordering::Relaxed) > 0) {
                    *self.last_agents.lock().unwrap() = Some(Instant::now());
                    sessions::from_claude(&self.claude).await
                } else {
                    None
                }
            }
        };
        let Some(rows) = rows else { return };
        let missing: Vec<(String, Option<String>)> = {
            let mut reg = self.reg.lock().unwrap();
            reg.merge_agents(&rows, now_ms());
            let followed = self.followers.lock().unwrap();
            reg.sessions.values().filter(|s| s.listed && !followed.contains_key(&s.session_id)).map(|s| (s.session_id.clone(), s.cwd.clone())).collect()
        };
        if missing.is_empty() {
            return;
        }
        let projects = self.projects_dir.clone();
        let found = tokio::task::spawn_blocking(move || {
            missing.into_iter().filter_map(|(id, cwd)| transcript::locate(&projects, cwd.as_deref(), &id).map(|p| (id, p))).collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut followers = self.followers.lock().unwrap();
        let mut reg = self.reg.lock().unwrap();
        for (id, path) in found {
            reg.mark_found(&id);
            followers.entry(id).or_insert_with(|| Follower::new(path));
        }
    }

    /// Reads what is new in every followed transcript and tells the pages.
    async fn tail(self: &Arc<Self>) {
        let hub = self.clone();
        let news = tokio::task::spawn_blocking(move || {
            let mut followers = hub.followers.lock().unwrap();
            let mut read = 0;
            let news = followers
                .iter_mut()
                .filter_map(|(id, f)| {
                    let ((records, restarted), n) = f.poll_counting();
                    read += n;
                    (!records.is_empty() || restarted).then(|| (id.clone(), records, restarted))
                })
                .collect::<Vec<_>>();
            if read > 4 * 1024 * 1024 {
                // After reading a long transcript, give the memory it took back to the system.
                trim_memory();
            }
            news
        })
        .await
        .unwrap_or_default();
        if news.is_empty() {
            return;
        }
        for (id, records, restarted) in news {
            let delta = (!restarted).then(|| json!({ "records": records }).to_string());
            self.reg.lock().unwrap().add_records(&id, records, restarted);
            match delta {
                Some(d) => {
                    let _ = self.tx.send(Push::Records(id, Arc::new(d)));
                }
                None => self.push_view(&id),
            }
        }
        self.push_sessions(false);
    }

    /// Forgets sessions closed long ago, and stops following their transcripts.
    fn prune(&self) -> bool {
        let mut reg = self.reg.lock().unwrap();
        let pruned = reg.prune(now_ms());
        if pruned {
            self.followers.lock().unwrap().retain(|id, _| reg.sessions.contains_key(id));
        }
        pruned
    }
}

#[cfg(target_env = "gnu")]
fn trim_memory() {
    extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    // SAFETY: malloc_trim only returns free memory to the system; it is safe to call at any time.
    unsafe {
        malloc_trim(0);
    }
}
#[cfg(not(target_env = "gnu"))]
fn trim_memory() {}

/// Counts a page while its stream is open.
struct ClientGuard(Shared);
impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------------------------
// Pages, on 127.0.0.1

fn font(file: &str) -> Response {
    let Some((_, body)) = FONTS.iter().find(|(name, _)| file.strip_suffix(".woff2") == Some(*name)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ([(header::CONTENT_TYPE, HeaderValue::from_static("font/woff2")), (header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"))], *body).into_response()
}

fn art(file: &str) -> Response {
    let Some((_, body)) = ART.iter().find(|(name, _)| *name == file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ([(header::CONTENT_TYPE, HeaderValue::from_static("image/webp")), (header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"))], *body).into_response()
}

fn asset(body: &'static str, kind: &'static str) -> Response {
    ([(header::CONTENT_TYPE, HeaderValue::from_static(kind)), (header::CACHE_CONTROL, HeaderValue::from_static("no-store"))], body).into_response()
}

async fn stream_handler(State(hub): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let session = q.get("session").cloned().filter(|s| !s.is_empty());
    hub.clients.fetch_add(1, Ordering::Relaxed);
    let guard = ClientGuard(hub.clone());
    let first_client = hub.clients.load(Ordering::Relaxed) == 1;
    if first_client {
        hub.refresh_sessions(true).await;
    }
    let rx = hub.tx.subscribe();
    let (list, _) = hub.summaries_json();
    let mut first = vec![Event::default().event("sessions").data(list)];
    if let Some(id) = &session {
        let view = hub.reg.lock().unwrap().view(id, now_ms()).unwrap_or_else(|| json!({"missing": id}).to_string());
        first.push(Event::default().event("view").data(view));
    }
    first[0] = first[0].clone().retry(Duration::from_secs(2));
    let follow = session.clone();
    let live = BroadcastStream::new(rx).filter_map(move |push| {
        let follow = follow.clone();
        async move {
            match push {
                Ok(Push::Sessions(list)) => Some(Event::default().event("sessions").data(list.as_str())),
                Ok(Push::View(id, view)) if Some(&id) == follow.as_ref() => Some(Event::default().event("view").data(view.as_str())),
                Ok(Push::Records(id, recs)) if Some(&id) == follow.as_ref() => Some(Event::default().event("records").data(recs.as_str())),
                Ok(Push::Show(id)) => Some(Event::default().event("show").data(id)),
                _ => None,
            }
        }
    });
    let all = stream::iter(first).chain(live).map(move |e| {
        let _ = &guard;
        Ok(e)
    });
    Sse::new(all).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive"))
}

struct Guard {
    hosts: Vec<String>,
    key: String,
    cookie: String,
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn guard(State(g): State<Arc<Guard>>, req: Request, next: Next) -> Response {
    // A page on another site that points a name at 127.0.0.1 (DNS rebinding) reads nothing here.
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !g.hosts.iter().any(|a| a == host) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    // Only the health check and the icon are open; everything else needs this account's key, by
    // header (the sessionbrain command), by cookie (a page that showed it once), or in the address.
    let path = req.uri().path();
    if path == "/healthz" || path == "/icon.svg" {
        return next.run(req).await;
    }
    let by_header = req.headers().get("x-sessionbrain-key").and_then(|v| v.to_str().ok()).is_some_and(|k| same(k, &g.key));
    let by_cookie = req
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .any(|(name, value)| name == g.cookie && same(value, &g.key));
    let by_address = req.uri().query().unwrap_or("").split('&').any(|kv| kv.strip_prefix("key=").is_some_and(|k| same(k, &g.key)));
    if !(by_header || by_cookie || by_address) {
        return (StatusCode::FORBIDDEN, "SessionBrain: open it from the launcher, with Super+Shift+W, or with /sessionbrain in a Claude session.").into_response();
    }
    let mut res = next.run(req).await;
    if by_address && !by_cookie {
        let cookie = format!("{}={}; Path=/; HttpOnly; SameSite=Strict", g.cookie, g.key);
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

fn page_router(hub: Shared, port: u16, key: String) -> Router {
    let g = Arc::new(Guard { hosts: vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")], key, cookie: format!("sessionbrain{port}") });
    Router::new()
        .route("/", get(|| async { asset(INDEX, "text/html; charset=utf-8") }))
        .route("/app.js", get(|| async { asset(APP_JS, "text/javascript; charset=utf-8") }))
        .route("/style.css", get(|| async { asset(CSS, "text/css; charset=utf-8") }))
        .route("/icon.svg", get(|| async { asset(ICON, "image/svg+xml") }))
        .route("/fonts/{file}", get(|axum::extract::Path(file): axum::extract::Path<String>| async move { font(&file) }))
        .route("/art/{file}", get(|axum::extract::Path(file): axum::extract::Path<String>| async move { art(&file) }))
        .route(
            "/healthz",
            get(|State(hub): State<Shared>| async move {
                let sessions = hub.reg.lock().unwrap().sessions.len();
                Json(json!({"ok": true, "sessions": sessions, "clients": hub.clients.load(Ordering::Relaxed)}))
            }),
        )
        .route(
            "/api/sessions",
            get(|State(hub): State<Shared>| async move {
                hub.refresh_sessions(true).await;
                let (list, _) = hub.summaries_json();
                ([(header::CONTENT_TYPE, "application/json")], list)
            }),
        )
        .route(
            "/api/view",
            get(|State(hub): State<Shared>, Query(q): Query<HashMap<String, String>>| async move {
                let id = q.get("session").cloned().unwrap_or_default();
                match hub.reg.lock().unwrap().view(&id, now_ms()) {
                    Some(v) => ([(header::CONTENT_TYPE, "application/json")], v).into_response(),
                    None => (StatusCode::NOT_FOUND, Json(json!({"missing": id}))).into_response(),
                }
            }),
        )
        .route(
            "/api/show",
            // A custom header: a web page cannot send one here without a CORS preflight, which is not answered.
            axum::routing::post(|State(hub): State<Shared>, headers: axum::http::HeaderMap, Query(q): Query<HashMap<String, String>>| async move {
                let id = q.get("session").cloned().unwrap_or_default();
                if headers.get("x-sessionbrain").is_none() || !crate::registry::valid_id(&id) {
                    return StatusCode::BAD_REQUEST;
                }
                let _ = hub.tx.send(Push::Show(id));
                StatusCode::NO_CONTENT
            }),
        )
        .route("/api/desktop-colors", get(|| async { desktop_colors() }))
        .route("/stream", get(stream_handler))
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
        .layer(middleware::from_fn_with_state(g, guard))
        .with_state(hub)
}

// ---------------------------------------------------------------------------------------------

/// The Omarchy theme's colours (its colors.toml: `key = "#rrggbb"` lines and `mode`), for the
/// Omarchy skin. 404 where there is no Omarchy theme.
fn desktop_colors() -> Response {
    let state = std::env::var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/state"));
    let Ok(text) = std::fs::read_to_string(state.join("omarchy/current/theme/colors.toml")) else {
        return (StatusCode::NOT_FOUND, Json(json!({}))).into_response();
    };
    let mut out = serde_json::Map::new();
    for line in text.lines().take(200) {
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim().trim_matches('"'));
        let colour = value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit());
        if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && (colour || (key == "mode" && (value == "dark" || value == "light"))) {
            out.insert(key.to_string(), json!(value));
        }
    }
    Json(serde_json::Value::Object(out)).into_response()
}

/// Whether a hub answers on the page port.
pub fn page_port_answers(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(format!("GET /healthz HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).is_err() {
        return false;
    }
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.starts_with("HTTP/1.1 200") || out.starts_with("HTTP/1.0 200")
}

/// Watches the transcripts and the session files, waking the hub when they change. Returns None
/// (and the hub polls only) when watching cannot start, for example with the folders not made yet.
fn watch(cfg: &Config, wake_tail: Arc<tokio::sync::Notify>, wake_scan: Arc<tokio::sync::Notify>) -> Option<notify::RecommendedWatcher> {
    use notify::{EventKind, RecursiveMode, Watcher};
    let sessions_dir = cfg.sessions_dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            if path.starts_with(&sessions_dir) {
                wake_scan.notify_one();
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                wake_tail.notify_one();
            }
        }
    })
    .map_err(|e| eprintln!("SessionBrain hub: not watching files ({e}); checking every {} ms", TAIL_EVERY.as_millis()))
    .ok()?;
    if let Err(e) = watcher.watch(&cfg.projects_dir, RecursiveMode::Recursive) {
        eprintln!("SessionBrain hub: not watching {} ({e}); checking every {} ms", cfg.projects_dir.display(), TAIL_EVERY.as_millis());
    }
    let _ = watcher.watch(&cfg.sessions_dir, RecursiveMode::NonRecursive);
    Some(watcher)
}

/// Runs the hub until the process is told to stop.
pub async fn run(cfg: Config) -> Result<(), String> {
    let (tx, _) = broadcast::channel(1024);
    let hub: Shared = Arc::new(Hub {
        reg: Mutex::new(Registry::default()),
        followers: Mutex::new(HashMap::new()),
        tx,
        clients: AtomicUsize::new(0),
        last_key: Mutex::new(String::new()),
        last_agents: Mutex::new(None),
        claude: cfg.claude.clone(),
        sessions_dir: cfg.sessions_dir.clone(),
        projects_dir: cfg.projects_dir.clone(),
    });

    let key = key()?;
    // A second hub fails here, with the port taken, and leaves the first alone.
    let tcp = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await.map_err(|e| format!("cannot listen on 127.0.0.1:{} (is another SessionBrain hub running?): {e}", cfg.port))?;

    // The kernel says the moment a transcript or session file changes, so the map keeps pace with
    // the terminal; the timers stay as a backstop where watching is not possible.
    let wake_tail = Arc::new(tokio::sync::Notify::new());
    let wake_scan = Arc::new(tokio::sync::Notify::new());
    let _watcher = watch(&cfg, wake_tail.clone(), wake_scan.clone());

    let ticker = hub.clone();
    tokio::spawn(async move {
        ticker.refresh_sessions(true).await;
        ticker.tail().await;
        ticker.push_sessions(true);
        let mut scan = tokio::time::interval(SCAN_EVERY);
        let mut tail = tokio::time::interval(TAIL_EVERY);
        let mut last_scan = Instant::now();
        loop {
            tokio::select! {
                _ = scan.tick() => {
                    ticker.refresh_sessions(false).await;
                    let pruned = ticker.prune();
                    ticker.push_sessions(pruned);
                    last_scan = Instant::now();
                }
                _ = wake_scan.notified() => {
                    // A session opened or closed: list it now (at most every 100 ms), then read its transcript.
                    if last_scan.elapsed() >= SCAN_SOONEST {
                        ticker.refresh_sessions(false).await;
                        ticker.push_sessions(false);
                        last_scan = Instant::now();
                        ticker.tail().await;
                    }
                }
                _ = tail.tick() => ticker.tail().await,
                _ = wake_tail.notified() => ticker.tail().await,
            }
        }
    });

    eprintln!("SessionBrain hub: pages on http://127.0.0.1:{}/, transcripts in {}", cfg.port, cfg.projects_dir.display());
    axum::serve(tcp, page_router(hub, cfg.port, key)).await.map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_made_once_readable_only_by_this_account_and_kept() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sessionbrain-key-{}", std::process::id()));
        let file = dir.join("state/sessionbrain/key");
        std::env::set_var("SESSIONBRAIN_KEY_FILE", &file);
        std::env::remove_var("SESSIONBRAIN_KEY");
        let first = key().unwrap();
        assert_eq!(first.len(), 48);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(key().unwrap(), first);
        std::env::remove_var("SESSIONBRAIN_KEY_FILE");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keys_are_compared_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
        assert!(!same("", "a"));
    }
}
