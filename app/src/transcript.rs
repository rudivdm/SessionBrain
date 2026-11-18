//! Following a Claude session's transcript.
//!
//! Claude Code writes every session to `~/.claude/projects/<folder>/<sessionId>.jsonl`, one JSON
//! record per line, and each subagent to `<sessionId>/subagents/agent-<id>.jsonl` beside it. The hub
//! reads what is new in those files and passes on a slim copy of each record that matters to the
//! map: tool calls, their results, model steps, prompts, turn ends, compactions and context a hook
//! added. Everything else (the text of messages, tool output, thinking) stays where it is. The page
//! turns the slim records into lot-map's board (web/adapter.ts).
//!
//! The format is Claude Code's own and undocumented: anything unexpected is skipped, never fatal.

use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

/// A tool input's strings are cut to this many characters: enough for any label the map draws.
const INPUT_CLIP: usize = 300;
/// The text kept of a prompt that is a background task's notice, or of context a hook added.
const TEXT_CLIP: usize = 4000;
/// A file is read this much at a time, so a long transcript never sits in memory whole.
const READ_CHUNK: u64 = 1024 * 1024;
/// At most this much of one file is read per poll; the rest comes on the next.
const READ_PER_POLL: u64 = 32 * 1024 * 1024;
/// A file this much larger than what is kept is read from near its end on first sight.
const FIRST_READ_MAX: u64 = 24 * 1024 * 1024;

pub fn projects_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SESSIONBRAIN_PROJECTS_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude"));
    base.join("projects")
}

/// The folder name Claude Code gives a working directory: every character but a letter or digit becomes '-'.
pub fn folder_of(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Where a session's transcript is: under its working directory's folder, or in any folder.
pub fn locate(projects: &Path, cwd: Option<&str>, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    if let Some(cwd) = cwd {
        let p = projects.join(folder_of(cwd)).join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    std::fs::read_dir(projects).ok()?.flatten().map(|e| e.path().join(&name)).find(|p| p.is_file())
}

// ---------------------------------------------------------------------------------------------
// Slimming one record

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// A tool's input with every string cut short and nothing nested deeper than the map looks.
fn slim_input(v: &Value, depth: usize) -> Value {
    match v {
        Value::String(s) => Value::String(clip(s, INPUT_CLIP)),
        Value::Object(m) if depth < 2 => Value::Object(m.iter().take(24).map(|(k, v)| (k.clone(), slim_input(v, depth + 1))).collect()),
        Value::Array(a) if depth < 2 => Value::Array(a.iter().take(8).map(|v| slim_input(v, depth + 1)).collect()),
        Value::Object(_) | Value::Array(_) => Value::Null,
        other => other.clone(),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// The record's time in milliseconds since the epoch.
fn time_of(v: &Value) -> Option<i64> {
    parse_time(str_of(v, "timestamp")?)
}

/// Reads `2026-11-12T18:12:09.134Z` (UTC, as Claude Code writes it).
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut ms = 0;
    if b[19] == b'.' {
        let frac: String = s[20..].chars().take_while(char::is_ascii_digit).collect();
        let digits = frac.len().min(3);
        ms = frac[..digits].parse::<i64>().unwrap_or(0) * 10_i64.pow((3 - digits) as u32);
    }
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

/// Tokens the model was given on this step: how full the context is.
fn context_tokens(usage: &Value) -> Option<i64> {
    let n = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
    let total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    (total > 0).then_some(total)
}

/// The parts of a tool's structured result that say it went on in the background.
fn task_fields(r: &Value) -> Option<Value> {
    let r = r.as_object()?;
    let mut out = Map::new();
    for key in ["status", "agentId", "taskId", "backgroundTaskId", "timeoutMs"] {
        if let Some(v) = r.get(key) {
            if v.is_string() || v.is_number() {
                out.insert(key.into(), match v {
                    Value::String(s) => Value::String(clip(s, 80)),
                    other => other.clone(),
                });
            }
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// The slim form of one transcript record, or None for a record the map has no use for.
///
/// Kinds: `step` (a model message: its model, request, context and tool calls), `results` (tool
/// results), `prompt` (the person wrote, or a background task reported back), `abort`, `end` (the
/// turn is over), `compact`, `context` (a hook added context).
pub fn slim(v: &Value) -> Option<Value> {
    let at = time_of(v)?;
    let agent = if v.get("isSidechain").and_then(Value::as_bool) == Some(true) { str_of(v, "agentId").map(|a| clip(a, 64)) } else { None };
    let mut out = match str_of(v, "type")? {
        "assistant" => {
            let msg = v.get("message")?;
            let tools: Vec<Value> = msg
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| str_of(b, "type") == Some("tool_use"))
                        .filter_map(|b| {
                            Some(json!({
                                "id": clip(str_of(b, "id")?, 80),
                                "name": clip(str_of(b, "name")?, 80),
                                "input": slim_input(b.get("input").unwrap_or(&Value::Null), 0),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let model = str_of(msg, "model")?;
            if model == "<synthetic>" {
                return None;
            }
            let mut o = json!({"k": "step", "model": clip(model, 80), "req": clip(str_of(v, "requestId").or_else(|| str_of(msg, "id")).unwrap_or(""), 80)});
            if let Some(t) = msg.get("usage").and_then(context_tokens) {
                o["tokens"] = json!(t);
            }
            // The session asked for the long context window.
            if str_of(v, "requestedModel").is_some_and(|m| m.contains("[1m]")) {
                o["wide"] = json!(true);
            }
            if let Some(stop) = str_of(msg, "stop_reason") {
                o["stop"] = json!(clip(stop, 40));
            }
            if !tools.is_empty() {
                o["tools"] = Value::Array(tools);
            }
            o
        }
        "user" => {
            let content = v.get("message")?.get("content")?;
            let refused = v.pointer("/permissionDecision/decision").and_then(Value::as_str) == Some("reject");
            match content {
                Value::String(text) => prompt(v, text)?,
                Value::Array(blocks) => {
                    let results: Vec<Value> = blocks
                        .iter()
                        .filter(|b| str_of(b, "type") == Some("tool_result"))
                        .filter_map(|b| {
                            let mut r = json!({"id": clip(str_of(b, "tool_use_id")?, 80)});
                            if b.get("is_error").and_then(Value::as_bool) == Some(true) {
                                r["err"] = json!(true);
                            }
                            if refused {
                                r["block"] = json!(true);
                            }
                            Some(r)
                        })
                        .collect();
                    if results.is_empty() {
                        let text = blocks.iter().filter(|b| str_of(b, "type") == Some("text")).filter_map(|b| str_of(b, "text")).collect::<Vec<_>>().join("\n");
                        prompt(v, &text)?
                    } else {
                        let mut results = results;
                        if let Some(task) = v.get("toolUseResult").and_then(task_fields) {
                            results[0]["task"] = task;
                        }
                        json!({"k": "results", "results": results})
                    }
                }
                _ => return None,
            }
        }
        "system" => match str_of(v, "subtype")? {
            "turn_duration" => json!({"k": "end"}),
            "compact_boundary" => json!({"k": "compact"}),
            _ => return None,
        },
        "attachment" => {
            let a = v.get("attachment")?;
            // A background task's notice that came in while Claude was busy is queued and written
            // as an attachment, not as a prompt; without it the task would look as if it ran forever.
            if str_of(a, "type")? == "queued_command" {
                let text = str_of(a, "prompt")?.trim_start();
                if !text.starts_with("<task-notification>") {
                    return None;
                }
                let mut out = json!({"k": "prompt", "notice": clip(text, TEXT_CLIP)});
                out["at"] = json!(at);
                if let Some(a) = agent {
                    out["agent"] = json!(a);
                }
                return Some(out);
            }
            if str_of(a, "type")? != "hook_additional_context" {
                return None;
            }
            let text = match a.get("content")? {
                Value::String(s) => s.clone(),
                Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"),
                _ => return None,
            };
            let event = str_of(a, "hookEvent").unwrap_or("");
            json!({"k": "context", "event": clip(event, 40), "text": clip(&text, TEXT_CLIP)})
        }
        _ => return None,
    };
    out["at"] = json!(at);
    if let Some(a) = agent {
        out["agent"] = json!(a);
    }
    Some(out)
}

/// A message from the person (or a background task's notice, or the turn being stopped).
fn prompt(v: &Value, text: &str) -> Option<Value> {
    let trimmed = text.trim_start();
    if trimmed.starts_with("[Request interrupted by user") {
        return Some(json!({"k": "abort"}));
    }
    if trimmed.starts_with("<task-notification>") {
        return Some(json!({"k": "prompt", "notice": clip(trimmed, TEXT_CLIP)}));
    }
    // Claude Code's own messages to the model (a reminder, a command's output) are not the person's.
    if v.get("isMeta").and_then(Value::as_bool) == Some(true) || trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("<local-command") || trimmed.starts_with("<command-") || trimmed.starts_with("<bash-") {
        return None;
    }
    Some(json!({"k": "prompt"}))
}

// ---------------------------------------------------------------------------------------------
// Following the files

#[derive(Default)]
struct Tail {
    offset: u64,
    /// A line still being written: kept until its newline arrives.
    partial: Vec<u8>,
}

/// Follows one session's transcript and its subagents' transcripts.
pub struct Follower {
    pub main: PathBuf,
    tails: HashMap<PathBuf, Tail>,
}

impl Follower {
    pub fn new(main: PathBuf) -> Follower {
        Follower { main, tails: HashMap::new() }
    }

    fn files(&self) -> Vec<PathBuf> {
        let mut files = vec![self.main.clone()];
        let sub = self.main.with_extension("").join("subagents");
        if let Ok(dir) = std::fs::read_dir(sub) {
            let mut agents: Vec<PathBuf> = dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
            agents.sort();
            files.extend(agents);
        }
        files
    }

    /// The slim records written since the last call, and whether the main file started over
    /// (replaced or cut short), in which case what was kept before no longer holds.
    pub fn poll(&mut self) -> (Vec<Value>, bool) {
        self.poll_counting().0
    }

    /// `poll`, and how many bytes it read.
    pub fn poll_counting(&mut self) -> ((Vec<Value>, bool), u64) {
        let mut out = Vec::new();
        let mut restarted = false;
        let mut read = 0;
        for path in self.files() {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let len = meta.len();
            let first = !self.tails.contains_key(&path);
            let tail = self.tails.entry(path.clone()).or_default();
            if len < tail.offset {
                *tail = Tail::default();
                if path == self.main {
                    restarted = true;
                }
            }
            if first && len > FIRST_READ_MAX {
                // A very long session: its start is long off the map anyway.
                // The first line read is then cut and fails to parse, which skips it.
                tail.offset = len - FIRST_READ_MAX;
                tail.partial.clear();
            }
            if len == tail.offset {
                continue;
            }
            let Ok(mut f) = File::open(&path) else { continue };
            if f.seek(SeekFrom::Start(tail.offset)).is_err() {
                continue;
            }
            let mut this_file = 0;
            let mut buf = Vec::with_capacity(READ_CHUNK as usize);
            while this_file < READ_PER_POLL {
                buf.clear();
                match (&mut f).take(READ_CHUNK).read_to_end(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        this_file += n as u64;
                        tail.offset += n as u64;
                    }
                }
                let mut data = std::mem::take(&mut tail.partial);
                data.extend_from_slice(&buf);
                let mut lines: Vec<&[u8]> = data.split(|b| *b == b'\n').collect();
                let rest = lines.pop().unwrap_or_default().to_vec();
                for line in lines {
                    // A cheap look before parsing: most lines are records the map does not use.
                    if line.is_empty() || !wanted(line) {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_slice::<Value>(line) {
                        if let Some(s) = slim(&v) {
                            out.push(s);
                        }
                    }
                }
                tail.partial = rest;
                // A line longer than any record (garbage): dropped rather than kept growing.
                if tail.partial.len() > 64 * 1024 * 1024 {
                    tail.partial = Vec::new();
                }
            }
            read += this_file;
        }
        ((out, restarted), read)
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// A cheap look at a line before it is parsed. Claude Code writes its bookkeeping records (API
/// requests, titles, modes) with `type` first, and conversation records with `parentUuid` first.
fn wanted(line: &[u8]) -> bool {
    if line.starts_with(b"{\"type\":\"") {
        return [&b"{\"type\":\"assistant\""[..], b"{\"type\":\"user\"", b"{\"type\":\"system\"", b"{\"type\":\"attachment\""].iter().any(|p| line.starts_with(p));
    }
    let head = &line[..line.len().min(300)];
    if contains(head, b"\"attachment\":{\"type\":\"") {
        return contains(head, b"hook_additional_context") || contains(head, b"queued_command");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-11-12T18:12:09.134Z";

    #[test]
    fn reads_claude_code_timestamps() {
        assert_eq!(parse_time("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_time(AT), Some(1_794_507_129_134));
        assert_eq!(parse_time("2026-11-12T18:12:09Z"), Some(1_794_507_129_000));
        assert_eq!(parse_time("not a time"), None);
    }

    #[test]
    fn folders_are_named_like_claude_code_names_them() {
        assert_eq!(folder_of("/home/u/Dev/my.proj_x"), "-home-u-Dev-my-proj-x");
    }

    #[test]
    fn a_model_step_keeps_its_tool_calls_and_context_and_drops_the_text() {
        let rec = json!({"type": "assistant", "timestamp": AT, "isSidechain": false, "requestId": "req_1",
            "message": {"model": "claude-opus-5-5", "stop_reason": "tool_use",
                "usage": {"input_tokens": 2, "cache_read_input_tokens": 98383, "cache_creation_input_tokens": 2168},
                "content": [{"type": "text", "text": "secret thoughts"},
                            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "x".repeat(1000), "description": "list files"}}]}});
        let s = slim(&rec).unwrap();
        assert_eq!(s["k"], "step");
        assert_eq!(s["model"], "claude-opus-5-5");
        assert_eq!(s["req"], "req_1");
        assert_eq!(s["tokens"], 100_553);
        assert_eq!(s["tools"][0]["name"], "Bash");
        assert_eq!(s["tools"][0]["input"]["command"].as_str().unwrap().len(), INPUT_CLIP);
        assert!(!s.to_string().contains("secret thoughts"));
        assert!(s.get("agent").is_none());
    }

    #[test]
    fn results_carry_errors_refusals_and_background_tasks_but_not_output() {
        let rec = json!({"type": "user", "timestamp": AT, "permissionDecision": {"decision": "reject"},
            "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": "private output"}]},
            "toolUseResult": {"status": "async_launched", "agentId": "a1", "prompt": "private prompt"}});
        let s = slim(&rec).unwrap();
        assert_eq!(s, json!({"k": "results", "at": 1_794_507_129_134i64, "results": [{"id": "toolu_1", "err": true, "block": true, "task": {"status": "async_launched", "agentId": "a1"}}]}));
    }

    #[test]
    fn prompts_notices_aborts_and_what_is_not_the_person() {
        let user = |content: Value, extra: Value| {
            let mut r = json!({"type": "user", "timestamp": AT, "message": {"content": content}});
            for (k, v) in extra.as_object().unwrap() {
                r[k] = v.clone();
            }
            slim(&r)
        };
        assert_eq!(user(json!("fix the bug"), json!({})).unwrap()["k"], "prompt");
        assert!(user(json!("fix the bug"), json!({})).unwrap().get("notice").is_none());
        assert_eq!(user(json!([{"type": "text", "text": "[Request interrupted by user]"}]), json!({})).unwrap()["k"], "abort");
        let notice = user(json!("<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>"), json!({})).unwrap();
        assert!(notice["notice"].as_str().unwrap().contains("<task-id>a1"));
        assert!(user(json!("reminder"), json!({"isMeta": true})).is_none());
        assert!(user(json!("<bash-input> ls</bash-input>"), json!({})).is_none());
        assert!(user(json!("<local-command-stdout>x</local-command-stdout>"), json!({})).is_none());
    }

    #[test]
    fn the_quick_look_keeps_conversation_records_and_drops_bookkeeping() {
        assert!(wanted(br#"{"parentUuid":"x","isSidechain":false,"message":{"model":"m","type":"message"},"type":"assistant"}"#));
        assert!(wanted(br#"{"type":"system","subtype":"turn_duration"}"#));
        assert!(!wanted(br#"{"type":"api-request","sessionId":"s"}"#));
        assert!(!wanted(br#"{"type":"ai-title","aiTitle":"t"}"#));
        assert!(!wanted(br#"{"parentUuid":null,"isSidechain":false,"attachment":{"type":"hook_success"}}"#));
        assert!(wanted(br#"{"parentUuid":null,"isSidechain":false,"attachment":{"type":"hook_additional_context"}}"#));
        assert!(wanted(br#"{"parentUuid":null,"isSidechain":false,"attachment":{"type":"queued_command","prompt":"<task-notification>"}}"#));
    }

    #[test]
    fn queued_task_notices_close_their_task() {
        let notice = slim(&json!({"type": "attachment", "timestamp": AT, "attachment": {"type": "queued_command", "prompt": "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>"}})).unwrap();
        assert_eq!(notice["k"], "prompt");
        assert!(notice["notice"].as_str().unwrap().contains("<task-id>a1"));
        // A message the person typed while Claude was busy is not a notice, and is left as before.
        assert!(slim(&json!({"type": "attachment", "timestamp": AT, "attachment": {"type": "queued_command", "prompt": "also do X"}})).is_none());
    }

    #[test]
    fn subagent_records_name_their_agent() {
        let rec = json!({"type": "assistant", "timestamp": AT, "isSidechain": true, "agentId": "a24c", "message": {"model": "m", "content": []}});
        assert_eq!(slim(&rec).unwrap()["agent"], "a24c");
    }

    #[test]
    fn turn_ends_compactions_and_hook_context() {
        assert_eq!(slim(&json!({"type": "system", "subtype": "turn_duration", "timestamp": AT})).unwrap()["k"], "end");
        assert_eq!(slim(&json!({"type": "system", "subtype": "compact_boundary", "timestamp": AT})).unwrap()["k"], "compact");
        assert!(slim(&json!({"type": "system", "subtype": "away_summary", "timestamp": AT})).is_none());
        let ctx = slim(&json!({"type": "attachment", "timestamp": AT, "attachment": {"type": "hook_additional_context", "hookEvent": "UserPromptSubmit", "content": ["memory #12"]}})).unwrap();
        assert_eq!(ctx["text"], "memory #12");
        assert!(slim(&json!({"type": "attachment", "timestamp": AT, "attachment": {"type": "hook_success"}})).is_none());
        assert!(slim(&json!({"type": "api-request", "timestamp": AT})).is_none());
        assert!(slim(&json!({"type": "assistant", "message": {"model": "m"}})).is_none(), "no time");
    }

    #[test]
    fn follows_a_growing_file_its_subagents_and_a_restart() {
        let dir = std::env::temp_dir().join(format!("sessionbrain-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("s1/subagents")).unwrap();
        let main = dir.join("s1.jsonl");
        let line = |v: Value| format!("{v}\n");
        let step = |req: &str| json!({"type": "assistant", "timestamp": AT, "requestId": req, "message": {"model": "m", "content": []}});
        std::fs::write(&main, line(step("r1")) + "{\"type\":\"assistant\",\"timest").unwrap();
        let mut f = Follower::new(main.clone());
        let (recs, restarted) = f.poll();
        assert_eq!((recs.len(), restarted), (1, false));
        assert_eq!(f.poll().0.len(), 0);

        // The half-written line is finished, a garbled one and another record follow, and a subagent starts.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&main).unwrap();
        write!(file, "amp\":\"{AT}\",\"requestId\":\"r2\",\"message\":{{\"model\":\"m\",\"content\":[]}}}}\nnot json\n{}", line(step("r3"))).unwrap();
        std::fs::write(dir.join("s1/subagents/agent-a1.jsonl"), line(json!({"type": "assistant", "timestamp": AT, "isSidechain": true, "agentId": "a1", "message": {"model": "m", "content": []}}))).unwrap();
        let (recs, _) = f.poll();
        let reqs: Vec<&str> = recs.iter().filter_map(|r| r["req"].as_str()).collect();
        assert_eq!(reqs, ["r2", "r3", ""]);
        assert_eq!(recs[2]["agent"], "a1");

        // The file is replaced by a shorter one.
        std::fs::write(&main, line(step("r9"))).unwrap();
        let (recs, restarted) = f.poll();
        assert!(restarted);
        assert_eq!(recs[0]["req"], "r9");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_a_transcript_under_its_folder_or_anywhere() {
        let dir = std::env::temp_dir().join(format!("sessionbrain-locate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("-p-a")).unwrap();
        std::fs::create_dir_all(dir.join("-elsewhere")).unwrap();
        std::fs::write(dir.join("-p-a/s1.jsonl"), "").unwrap();
        std::fs::write(dir.join("-elsewhere/s2.jsonl"), "").unwrap();
        assert_eq!(locate(&dir, Some("/p/a"), "s1"), Some(dir.join("-p-a/s1.jsonl")));
        assert_eq!(locate(&dir, Some("/p/a"), "s2"), Some(dir.join("-elsewhere/s2.jsonl")));
        assert_eq!(locate(&dir, None, "s3"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
