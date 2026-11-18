//! Which Claude sessions are open.
//!
//! Claude Code keeps one file per running session in `~/.claude/sessions/<pid>.json` with the
//! fields `claude agents --json` reports (pid, sessionId, cwd, name, kind, status, startedAt) and
//! the process's start time (`procStart`, field 22 of /proc/<pid>/stat), which tells a live session
//! from a file left behind by one that died and a pid used again since. Reading those files costs
//! next to nothing; spawning `claude agents` costs ~0.15 s of CPU. The files are undocumented, so
//! when the folder is missing the hub falls back to `claude agents --json`.

use crate::registry::AgentRow;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn sessions_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SESSIONBRAIN_SESSIONS_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude"));
    base.join("sessions")
}

/// The start time of a process, as /proc/<pid>/stat has it (field 22), or None when it is gone.
pub fn proc_start(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name (field 2) is in parentheses and may hold spaces: count from the last ')'.
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(19).map(String::from)
}

fn alive(v: &Value) -> bool {
    let Some(pid) = v.get("pid").and_then(Value::as_u64) else { return false };
    match (proc_start(pid as u32), v.get("procStart").and_then(Value::as_str)) {
        (Some(now), Some(then)) => now == then,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// The open sessions according to the session files, or None when the folder cannot be read.
pub fn read_dir(dir: &Path) -> Option<Vec<AgentRow>> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if !alive(&v) {
            continue;
        }
        if let Some(row) = AgentRow::from_json(&v) {
            rows.push(row);
        }
    }
    Some(rows)
}

/// The open sessions according to `claude agents --json`.
pub async fn from_claude(claude: &str) -> Option<Vec<AgentRow>> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(claude).args(["agents", "--json"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    Some(v.as_array()?.iter().filter_map(AgentRow::from_json).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_live_sessions_and_skips_dead_and_reused_pids() {
        let dir = std::env::temp_dir().join(format!("sessionbrain-sessions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let me = std::process::id();
        let start = proc_start(me).unwrap();
        let write = |name: &str, v: Value| std::fs::write(dir.join(name), v.to_string()).unwrap();
        write("a.json", serde_json::json!({"pid": me, "procStart": start, "sessionId": "live-1", "kind": "interactive", "name": "proj-1", "status": "busy", "cwd": "/p", "startedAt": 5}));
        write("b.json", serde_json::json!({"pid": me, "procStart": "1", "sessionId": "reused-pid", "kind": "interactive"}));
        write("c.json", serde_json::json!({"pid": 999_999_999u64, "sessionId": "dead", "kind": "interactive"}));
        write("d.key", serde_json::json!({}));
        write("e.json", Value::String("not an object".into()));
        let rows = read_dir(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "live-1");
        assert_eq!(rows[0].name.as_deref(), Some("proj-1"));
        assert_eq!(rows[0].status.as_deref(), Some("busy"));
        assert_eq!(rows[0].pid, Some(me));
    }

    #[test]
    fn a_missing_folder_reads_as_none() {
        assert!(read_dir(Path::new("/nonexistent/sessionbrain")).is_none());
    }
}
