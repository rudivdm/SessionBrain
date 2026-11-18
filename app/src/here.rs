//! `sessionbrain-app here`: which session the person is looking at.
//!
//! The session whose Claude process runs under the focused window (a terminal, or Orca with all of
//! its terminals); when that is several, the one that wrote to its transcript last; when it is none,
//! the most recently active session anywhere. Prints the session id, `-` when the focused window is
//! SessionBrain itself (keep what it shows), or nothing when no session is open.

use crate::registry::AgentRow;
use crate::{sessions, transcript};
use std::collections::HashMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// The focused window's pid and class, from Hyprland. None off Hyprland.
fn focused_window() -> Option<(u32, String)> {
    let out = std::process::Command::new("hyprctl").args(["activewindow", "-j"]).output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let pid = v.get("pid")?.as_i64().filter(|p| *p > 0)? as u32;
    Some((pid, v.get("class").and_then(|c| c.as_str()).unwrap_or("").to_string()))
}

/// Every process's parent, read from /proc.
fn parents() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let Ok(dir) = std::fs::read_dir("/proc") else { return map };
    for entry in dir.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        let Some(close) = stat.rfind(')') else { continue };
        if let Some(ppid) = stat[close + 1..].split_whitespace().nth(1).and_then(|p| p.parse().ok()) {
            map.insert(pid, ppid);
        }
    }
    map
}

fn runs_under(mut pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    for _ in 0..64 {
        if pid == ancestor {
            return true;
        }
        match parents.get(&pid) {
            Some(&p) if p != 0 && p != pid => pid = p,
            _ => return false,
        }
    }
    false
}

/// When the person last wrote to a session: its newest prompt (not a task notice) in the last
/// 512 KB of its transcript. A busy agent writes all the time, so typing is the better sign of
/// which session is in front of them; without a prompt, the transcript's last write, else its start.
fn last_active(row: &AgentRow, projects: &Path) -> (i64, i64) {
    let Some(path) = transcript::locate(projects, row.cwd.as_deref(), &row.session_id) else {
        return (0, row.started_at.unwrap_or(0));
    };
    let written = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(row.started_at.unwrap_or(0));
    (last_prompt(&path).unwrap_or(0), written)
}

fn last_prompt(path: &Path) -> Option<i64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(512 * 1024))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    String::from_utf8_lossy(&buf)
        .lines()
        .rev()
        .filter(|l| l.contains("\"type\":\"user\""))
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| transcript::slim(&v))
        .find(|r| r["k"] == "prompt" && r.get("notice").is_none() && r.get("agent").is_none())
        .and_then(|r| r["at"].as_i64())
}

/// The session to show, given the open sessions and the focused window's pid.
pub fn pick(rows: &[AgentRow], focused: Option<u32>, parents: &HashMap<u32, u32>, projects: &Path) -> Option<String> {
    let under: Vec<&AgentRow> = match focused {
        Some(f) => rows.iter().filter(|r| r.pid.is_some_and(|p| runs_under(p, f, parents))).collect(),
        None => Vec::new(),
    };
    let pool: Vec<&AgentRow> = if under.is_empty() { rows.iter().collect() } else { under };
    pool.into_iter().max_by_key(|r| last_active(r, projects)).map(|r| r.session_id.clone())
}

pub fn run() {
    let focused = focused_window();
    if focused.as_ref().is_some_and(|(_, class)| class == "sessionbrain-app") {
        println!("-");
        return;
    }
    let rows = sessions::read_dir(&sessions::sessions_dir()).unwrap_or_default();
    if let Some(id) = pick(&rows, focused.map(|(pid, _)| pid), &parents(), &transcript::projects_dir()) {
        println!("{id}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, pid: u32, started: i64) -> AgentRow {
        AgentRow { session_id: id.into(), cwd: None, kind: None, name: None, pid: Some(pid), status: None, started_at: Some(started) }
    }

    #[test]
    fn the_session_under_the_focused_window_wins_and_the_latest_one_otherwise() {
        // 100 is a terminal running claude 101; 200 is Orca with claude 211 and 221 in two terminals.
        let parents: HashMap<u32, u32> = [(101, 100), (100, 1), (210, 200), (211, 210), (220, 200), (221, 220), (200, 1)].into();
        let rows = vec![row("term", 101, 5), row("orca-old", 211, 1), row("orca-new", 221, 3)];
        let none = Path::new("/nonexistent");
        assert_eq!(pick(&rows, Some(100), &parents, none).as_deref(), Some("term"));
        assert_eq!(pick(&rows, Some(200), &parents, none).as_deref(), Some("orca-new"));
        // A browser or anything else with no Claude under it: the most recently active session.
        assert_eq!(pick(&rows, Some(999), &parents, none).as_deref(), Some("term"));
        assert_eq!(pick(&rows, None, &parents, none).as_deref(), Some("term"));
        assert_eq!(pick(&[], Some(100), &parents, none), None);
    }

    #[test]
    fn a_loop_in_the_process_tree_does_not_hang() {
        let parents: HashMap<u32, u32> = [(5, 6), (6, 5)].into();
        assert!(!runs_under(5, 7, &parents));
    }
}
