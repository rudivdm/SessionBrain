//! The hub's memory of sessions: the list of open sessions, and for each one the recent slim
//! records of its transcript. Pure apart from the time it is handed, so it is tested without files.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

/// Ended sessions are forgotten this long after their last record.
pub const FORGET_MS: i64 = 30 * 60_000;
/// How many slim records are kept per session: far more than the map's 80 rows need.
pub const KEEP_RECORDS: usize = 3000;
/// A session counts as working while its last record is this recent, when Claude's own status is not known.
const BUSY_MS: i64 = 20_000;

/// One open session, from Claude's session files or `claude agents --json`.
#[derive(Debug, Clone, Default)]
pub struct AgentRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub pid: Option<u32>,
    pub status: Option<String>,
    pub started_at: Option<i64>,
}

impl AgentRow {
    pub fn from_json(v: &Value) -> Option<AgentRow> {
        Some(AgentRow {
            session_id: v.get("sessionId")?.as_str()?.to_string(),
            cwd: v.get("cwd").and_then(Value::as_str).map(String::from),
            kind: v.get("kind").and_then(Value::as_str).map(String::from),
            name: v.get("name").and_then(Value::as_str).map(String::from),
            pid: v.get("pid").and_then(Value::as_u64).map(|p| p as u32),
            status: v.get("status").and_then(Value::as_str).map(String::from),
            started_at: v.get("startedAt").and_then(Value::as_i64),
        })
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// How full the context is, 0 to 100: the long window when the session asked for it or is past the short one.
pub fn context_percent(tokens: i64, wide: bool) -> f64 {
    let window = if wide || tokens > 200_000 { 1_000_000.0 } else { 200_000.0 };
    ((tokens as f64 / window) * 1000.0).round() / 10.0
}

#[derive(Debug, Clone, Default)]
pub struct Session {
    pub session_id: String,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub pid: Option<u32>,
    pub activity: Option<String>,
    pub kind: Option<String>,
    pub started_at: Option<i64>,
    /// Whether its transcript has been found.
    pub found: bool,
    /// Kept as JSON text: a parsed record costs about four times the memory.
    pub records: VecDeque<Box<str>>,
    pub model: Option<String>,
    pub tokens: Option<i64>,
    pub wide: bool,
    /// Tool calls made and not yet answered.
    pub open_tools: HashSet<String>,
    /// The time of its newest record.
    pub last_seen: Option<i64>,
    /// When it was last seen open.
    pub last_listed: Option<i64>,
    /// Whether the last listing of open sessions had it.
    pub listed: bool,
}

/// What the picker shows for each session.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub session_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// live: open, and its transcript is followed; nofeed: open, transcript not found (yet); ended: closed.
    pub feed: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<f64>,
    pub running: usize,
}

/// The display name `claude agents` would give: the folder's name and the start of the id.
fn fallback_name(s: &Session) -> String {
    let folder = s
        .cwd
        .as_deref()
        .and_then(|c| c.split('/').filter(|p| !p.is_empty()).last())
        .map(str::to_lowercase)
        .unwrap_or_else(|| "session".into());
    format!("{folder}-{}", s.session_id.chars().take(4).collect::<String>())
}

#[derive(Default)]
pub struct Registry {
    pub sessions: HashMap<String, Session>,
}

impl Registry {
    fn entry(&mut self, id: &str) -> &mut Session {
        self.sessions.entry(id.to_string()).or_insert_with(|| Session { session_id: id.to_string(), ..Default::default() })
    }

    /// Merges the list of open sessions; background sessions have no terminal to sit beside and are left out.
    pub fn merge_agents(&mut self, rows: &[AgentRow], now: i64) {
        let mut seen = HashSet::new();
        for row in rows {
            if !valid_id(&row.session_id) {
                continue;
            }
            if row.kind.as_deref().is_some_and(|k| k != "interactive") {
                continue;
            }
            seen.insert(row.session_id.clone());
            let s = self.entry(&row.session_id);
            s.listed = true;
            s.last_listed = Some(now);
            if row.cwd.is_some() {
                s.cwd = row.cwd.clone();
            }
            if row.name.is_some() {
                s.name = row.name.clone();
            }
            s.pid = row.pid;
            s.activity = row.status.clone();
            s.kind = row.kind.clone();
            if row.started_at.is_some() {
                s.started_at = row.started_at;
            }
        }
        for s in self.sessions.values_mut() {
            if !seen.contains(&s.session_id) {
                s.listed = false;
                s.pid = None;
                s.activity = None;
            }
        }
    }

    pub fn mark_found(&mut self, id: &str) {
        if let Some(s) = self.sessions.get_mut(id) {
            s.found = true;
        }
    }

    /// Takes records read from a session's transcript. `restarted`: the transcript started over,
    /// so what was kept is dropped first.
    pub fn add_records(&mut self, id: &str, records: Vec<Value>, restarted: bool) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        if restarted {
            s.records.clear();
            s.open_tools.clear();
        }
        for r in records {
            let at = r.get("at").and_then(Value::as_i64);
            s.last_seen = s.last_seen.max(at);
            let main = r.get("agent").is_none();
            match r.get("k").and_then(Value::as_str) {
                Some("step") => {
                    if main {
                        s.model = r.get("model").and_then(Value::as_str).map(String::from);
                        if let Some(t) = r.get("tokens").and_then(Value::as_i64) {
                            s.tokens = Some(t);
                        }
                        s.wide = s.wide || r.get("wide").and_then(Value::as_bool) == Some(true);
                    }
                    for t in r.get("tools").and_then(Value::as_array).into_iter().flatten() {
                        if let Some(id) = t.get("id").and_then(Value::as_str) {
                            s.open_tools.insert(id.to_string());
                        }
                    }
                }
                Some("results") => {
                    for res in r.get("results").and_then(Value::as_array).into_iter().flatten() {
                        if let Some(id) = res.get("id").and_then(Value::as_str) {
                            s.open_tools.remove(id);
                        }
                    }
                }
                // The turn is over or was stopped: whatever was not answered never will be.
                Some("end") | Some("abort") if main => s.open_tools.clear(),
                _ => {}
            }
            s.records.push_back(r.to_string().into_boxed_str());
        }
        while s.records.len() > KEEP_RECORDS {
            s.records.pop_front();
        }
        // A tool call whose result was never written (the session was cut off) does not count for ever.
        if s.open_tools.len() > 64 {
            s.open_tools.clear();
        }
    }

    pub fn feed_of(s: &Session) -> &'static str {
        match (s.listed, s.found) {
            (true, true) => "live",
            (true, false) => "nofeed",
            (false, _) => "ended",
        }
    }

    /// Drops sessions that closed long ago.
    pub fn prune(&mut self, now: i64) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|_, s| {
            let last = s.last_seen.unwrap_or(0).max(s.last_listed.unwrap_or(0));
            s.listed || (last > 0 && now - last <= FORGET_MS)
        });
        before != self.sessions.len()
    }

    pub fn summary(s: &Session, now: i64) -> Summary {
        let feed = Self::feed_of(s);
        let activity = s.activity.clone().or_else(|| {
            (feed == "live").then(|| if s.last_seen.is_some_and(|t| now - t < BUSY_MS) { "busy".into() } else { "idle".into() })
        });
        Summary {
            session_id: s.session_id.clone(),
            name: s.name.clone().unwrap_or_else(|| fallback_name(s)),
            cwd: s.cwd.clone(),
            pid: s.pid,
            activity,
            kind: s.kind.clone(),
            started_at: s.started_at,
            feed,
            last_seen: s.last_seen,
            model: s.model.clone(),
            context: s.tokens.map(|t| context_percent(t, s.wide)),
            running: if feed == "live" { s.open_tools.len() } else { 0 },
        }
    }

    /// Every session the picker offers: open ones first, newest first.
    pub fn summaries(&self, now: i64) -> Vec<Summary> {
        let rank = |f: &str| match f {
            "live" => 0,
            "nofeed" => 1,
            _ => 2,
        };
        let mut list: Vec<Summary> = self.sessions.values().map(|s| Self::summary(s, now)).collect();
        list.sort_by(|a, b| {
            rank(a.feed)
                .cmp(&rank(b.feed))
                .then_with(|| b.started_at.or(b.last_seen).unwrap_or(0).cmp(&a.started_at.or(a.last_seen).unwrap_or(0)))
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        list
    }

    /// What a page following one session is sent first: the session and every record kept, as JSON.
    pub fn view(&self, id: &str, now: i64) -> Option<String> {
        let s = self.sessions.get(id)?;
        let mut out = format!("{{\"session\":{},\"records\":[", serde_json::to_string(&Self::summary(s, now)).ok()?);
        for (i, r) in s.records.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(r);
        }
        out.push_str("]}");
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open(id: &str) -> AgentRow {
        AgentRow { session_id: id.into(), kind: Some("interactive".into()), ..Default::default() }
    }
    fn step(at: i64, tools: &[&str]) -> Value {
        json!({"k": "step", "at": at, "model": "claude-opus-5-5", "req": format!("r{at}"), "tokens": 50_000,
               "tools": tools.iter().map(|t| json!({"id": t, "name": "Read", "input": {}})).collect::<Vec<_>>()})
    }

    #[test]
    fn open_with_a_transcript_is_live_without_one_is_waiting_and_closed_is_ended() {
        let mut r = Registry::default();
        r.merge_agents(&[open("s1")], 1);
        assert_eq!(r.summaries(1)[0].feed, "nofeed");
        r.mark_found("s1");
        assert_eq!(r.summaries(1)[0].feed, "live");
        r.merge_agents(&[], 2);
        assert_eq!(r.summaries(2)[0].feed, "ended");
    }

    #[test]
    fn records_give_the_model_context_and_what_is_running() {
        let mut r = Registry::default();
        r.merge_agents(&[open("s1")], 1);
        r.mark_found("s1");
        r.add_records("s1", vec![step(10, &["t1", "t2"]), json!({"k": "results", "at": 11, "results": [{"id": "t1"}]})], false);
        let s = &r.summaries(12)[0];
        assert_eq!(s.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(s.context, Some(25.0));
        assert_eq!(s.running, 1);
        assert_eq!(s.last_seen, Some(11));
        r.add_records("s1", vec![json!({"k": "end", "at": 12})], false);
        assert_eq!(r.summaries(12)[0].running, 0);
    }

    #[test]
    fn a_subagent_step_does_not_change_the_sessions_model() {
        let mut r = Registry::default();
        r.merge_agents(&[open("s1")], 1);
        r.add_records("s1", vec![step(10, &[]), json!({"k": "step", "at": 11, "model": "claude-haiku-5-5", "agent": "a1", "tokens": 5})], false);
        assert_eq!(r.summaries(12)[0].model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn the_long_window_when_asked_for_or_needed() {
        assert_eq!(context_percent(100_000, false), 50.0);
        assert_eq!(context_percent(100_000, true), 10.0);
        assert_eq!(context_percent(300_000, false), 30.0);
    }

    #[test]
    fn keeps_a_bounded_number_of_records_and_starts_over_when_the_file_does() {
        let mut r = Registry::default();
        r.merge_agents(&[open("s1")], 1);
        r.add_records("s1", (0..KEEP_RECORDS as i64 + 50).map(|i| step(i, &[])).collect(), false);
        assert_eq!(r.sessions["s1"].records.len(), KEEP_RECORDS);
        assert!(r.sessions["s1"].records[0].contains("\"at\":50,"));
        r.add_records("s1", vec![step(1, &[])], true);
        let view: Value = serde_json::from_str(&r.view("s1", 0).unwrap()).unwrap();
        assert_eq!(view["records"].as_array().unwrap().len(), 1);
        assert_eq!(view["session"]["sessionId"], "s1");
    }

    #[test]
    fn records_for_an_unknown_session_are_ignored() {
        let mut r = Registry::default();
        r.add_records("nobody", vec![step(1, &[])], false);
        assert!(r.sessions.is_empty());
    }

    #[test]
    fn names_come_from_the_listing_and_background_sessions_are_left_out() {
        let mut r = Registry::default();
        r.merge_agents(
            &[
                AgentRow { name: Some("sessionbrain-fc".into()), pid: Some(9), ..open("s1") },
                AgentRow { session_id: "bg1".into(), kind: Some("background".into()), ..Default::default() },
                AgentRow { cwd: Some("/home/u/MyProj".into()), ..open("abcd1234") },
                open("../../etc"),
            ],
            1,
        );
        let names: HashSet<String> = r.summaries(1).into_iter().map(|s| s.name).collect();
        assert_eq!(names, HashSet::from(["sessionbrain-fc".to_string(), "myproj-abcd".to_string()]));
    }

    #[test]
    fn open_sessions_come_first_newest_first() {
        let mut r = Registry::default();
        r.merge_agents(&[open("old"), AgentRow { started_at: Some(5), ..open("new") }, AgentRow { started_at: Some(1), ..open("older") }], 1);
        r.mark_found("new");
        r.mark_found("older");
        r.merge_agents(&[AgentRow { started_at: Some(5), ..open("new") }, AgentRow { started_at: Some(1), ..open("older") }], 2);
        let ids: Vec<String> = r.summaries(2).into_iter().map(|s| s.session_id).collect();
        assert_eq!(ids, ["new", "older", "old"]);
    }

    #[test]
    fn forgets_what_closed_long_ago_but_never_an_open_session() {
        let mut r = Registry::default();
        r.merge_agents(&[open("open"), open("gone")], 1000);
        r.merge_agents(&[open("open")], 1000);
        assert!(!r.prune(1000 + FORGET_MS));
        assert!(r.prune(1000 + FORGET_MS + 1));
        assert_eq!(r.sessions.keys().collect::<Vec<_>>(), ["open"]);
    }
}
