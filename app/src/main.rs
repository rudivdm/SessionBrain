//! sessionbrain-app: the SessionBrain hub and window in one program.
//!
//!   sessionbrain-app hub                        run the hub (what the systemd user service runs)
//!   sessionbrain-app window [--session ID]      open the window; starts a hub inside it when none runs
//!   sessionbrain-app here                       print the session the focused window runs (for Super+Shift+W)
//!   sessionbrain-app records FILE               print the slim records the hub would take from a transcript
//!
//! Environment: SESSIONBRAIN_PORT (7317 for the first account, one up for each after it), SESSIONBRAIN_KEY_FILE, SESSIONBRAIN_CLAUDE, SESSIONBRAIN_SESSIONS_DIR, SESSIONBRAIN_PROJECTS_DIR.

mod here;
mod hub;
mod registry;
mod sessions;
mod transcript;
mod window;

use std::time::{Duration, Instant};

fn usage() -> ! {
    eprintln!("usage: sessionbrain-app hub | window [--session ID] | here | records TRANSCRIPT | --version");
    std::process::exit(2)
}

fn run_hub() -> ! {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio");
    match rt.block_on(hub::run(hub::Config::from_env())) {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("hub") => run_hub(),
        Some("here") => here::run(),
        Some("--version") => println!("sessionbrain-app {}", env!("CARGO_PKG_VERSION")),
        Some("records") => {
            let Some(path) = args.get(1) else { usage() };
            let mut follower = transcript::Follower::new(path.into());
            let mut out = std::io::BufWriter::new(std::io::stdout().lock());
            loop {
                let (records, _) = follower.poll();
                if records.is_empty() {
                    break;
                }
                for r in records {
                    use std::io::Write;
                    let _ = writeln!(out, "{r}");
                }
            }
        }
        Some("window") | None => {
            let mut session = None;
            let mut it = args.iter().skip(1);
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--session" => session = it.next().cloned(),
                    _ => usage(),
                }
            }
            if let Some(s) = &session {
                if !registry::valid_id(s) {
                    eprintln!("not a session id: {s}");
                    std::process::exit(2);
                }
            }
            let port = hub::port();
            if !hub::page_port_answers(port) {
                // No hub running (the service is off): this window carries one for as long as it is open.
                std::thread::spawn(|| run_hub());
                let since = Instant::now();
                while !hub::page_port_answers(port) && since.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            let base = format!("http://127.0.0.1:{port}/");
            let key = match hub::key() {
                Ok(k) => k,
                Err(e) => {
                    eprintln!("SessionBrain: {e}");
                    std::process::exit(1)
                }
            };
            let url = match session {
                Some(s) => format!("{base}?session={s}&key={key}"),
                None => format!("{base}?key={key}"),
            };
            window::open(url, base);
        }
        _ => usage(),
    }
}
