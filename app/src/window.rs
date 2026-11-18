//! The SessionBrain window: the hub's page in WebKitGTK (through wry), a fraction of a browser's weight.
//!
//! WebKit keeps a page's animation running while its window sits on another workspace, so on
//! Hyprland the window watches the compositor's events and tells the page when it is out of
//! sight; the page then pauses the map and stops redrawing.

use serde_json::Value;
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::Duration,
};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

#[derive(Debug)]
enum UserEvent {
    Visible(bool),
    PageLoaded,
    Title(String),
}

pub fn open(url: String, base: String) -> ! {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("SessionBrain")
        .with_inner_size(LogicalSize::new(1180.0, 820.0))
        .build(&event_loop)
        .expect("cannot open the window");

    let loaded = event_loop.create_proxy();
    let titled = event_loop.create_proxy();
    let debug = std::env::var_os("SESSIONBRAIN_DEBUG").is_some();
    let builder = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(&format!("window.__sessionbrainHost = true; window.__sessionbrainDebug = {debug};"))
        .with_ipc_handler(move |req| {
            if debug {
                eprintln!("page: {}", req.body());
            }
        })
        // The window shows the hub's pages and nothing else.
        .with_navigation_handler(move |to| to.starts_with(&base))
        .with_on_page_load_handler(move |event, _| {
            if matches!(event, wry::PageLoadEvent::Finished) {
                let _ = loaded.send_event(UserEvent::PageLoaded);
            }
        })
        .with_document_title_changed_handler(move |title| {
            let _ = titled.send_event(UserEvent::Title(title));
        });

    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().expect("no GTK box")).expect("cannot start WebKitGTK")
    };
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window).expect("cannot start the web view");

    watch_hyprland(event_loop.create_proxy());

    let mut visible = true;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Visible(v)) => {
                if std::env::var_os("SESSIONBRAIN_DEBUG").is_some() {
                    eprintln!("hyprland: window {}", if v { "shown" } else { "out of sight" });
                }
                visible = v;
                let _ = webview.evaluate_script(&format!("window.__sessionbrainVisible && window.__sessionbrainVisible({v})"));
            }
            Event::UserEvent(UserEvent::PageLoaded) => {
                let _ = webview.evaluate_script(&format!("window.__sessionbrainVisible && window.__sessionbrainVisible({visible})"));
            }
            Event::UserEvent(UserEvent::Title(title)) => window.set_title(if title.is_empty() { "SessionBrain" } else { &title }),
            _ => {}
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Hyprland: is this window on a workspace that is shown?

fn hypr_dir() -> Option<PathBuf> {
    let sig = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    let runtime = std::env::var("XDG_RUNTIME_DIR").ok()?;
    Some(PathBuf::from(runtime).join("hypr").join(sig))
}

fn query(dir: &Path, request: &str) -> Option<Value> {
    let mut s = UnixStream::connect(dir.join(".socket.sock")).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    s.write_all(request.as_bytes()).ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    serde_json::from_str(&out).ok()
}

/// Whether this process's window is on a shown workspace; None when it cannot be told yet.
pub fn shown(dir: &Path, pid: u32) -> Option<bool> {
    let monitors = query(dir, "j/monitors")?;
    let clients = query(dir, "j/clients")?;
    let mut showing = HashSet::new();
    for m in monitors.as_array()? {
        if let Some(id) = m.pointer("/activeWorkspace/id").and_then(Value::as_i64) {
            showing.insert(id);
        }
        if let Some(id) = m.pointer("/specialWorkspace/id").and_then(Value::as_i64).filter(|id| *id != 0) {
            showing.insert(id);
        }
    }
    let mine = clients.as_array()?.iter().find(|c| c.get("pid").and_then(Value::as_u64) == Some(pid as u64))?;
    if mine.get("hidden").and_then(Value::as_bool) == Some(true) {
        return Some(false);
    }
    Some(showing.contains(&mine.pointer("/workspace/id").and_then(Value::as_i64)?))
}

const EVENTS: &[&str] = &[
    "workspace", "workspacev2", "focusedmon", "focusedmonv2", "activewindow", "activewindowv2", "movewindow", "movewindowv2",
    "openwindow", "closewindow", "activespecial", "activespecialv2", "moveworkspace", "moveworkspacev2", "minimized",
];

fn watch_hyprland(proxy: EventLoopProxy<UserEvent>) {
    let Some(dir) = hypr_dir() else { return };
    std::thread::spawn(move || {
        let pid = std::process::id();
        let mut last: Option<bool> = None;
        let check = |last: &mut Option<bool>| {
            if let Some(v) = shown(&dir, pid) {
                if *last != Some(v) {
                    *last = Some(v);
                    let _ = proxy.send_event(UserEvent::Visible(v));
                }
            }
        };
        loop {
            match UnixStream::connect(dir.join(".socket2.sock")) {
                Ok(stream) => {
                    check(&mut last);
                    for line in BufReader::new(stream).lines() {
                        let Ok(line) = line else { break };
                        let name = line.split(">>").next().unwrap_or("");
                        if EVENTS.contains(&name) {
                            check(&mut last);
                        }
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(5)),
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}
