//! Incremental tailer for `agy`'s per-session `transcript.jsonl`, reporting live
//! token usage mid-turn while `session/prompt` is in flight.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde_json::Value;

use super::super::usage::{add_usage, gemini_transcript_step_usage, AgentUsage};
use crate::util::{env_get, home_dir};

/// Path to `agy`'s per-session `transcript.jsonl`, where completed planner steps are written mid-turn.
pub fn agy_transcript_path(env: &HashMap<String, String>, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.contains("..") {
        return None;
    }
    let home = env_get(env, "HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| env_get(env, "USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(home_dir);
    Some(
        home.join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join(session_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl"),
    )
}

/// Incrementally tails `agy`'s `transcript.jsonl` to report live token counts mid-turn,
/// since `agy acp`'s `usage_update` notifications only report context-window fill (`used`/`size`).
#[derive(Debug, Default)]
pub(super) struct TranscriptUsageTailer {
    path: Option<PathBuf>,
    offset: u64,
    seen_steps: HashSet<u64>,
    turn_usage: Option<AgentUsage>,
}

impl TranscriptUsageTailer {
    pub(super) fn open(&mut self, env: &HashMap<String, String>, session_id: &str, skip_existing: bool) {
        self.path = agy_transcript_path(env, session_id);
        self.offset = if skip_existing {
            self.path
                .as_ref()
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };
        self.seen_steps.clear();
        self.turn_usage = None;
    }

    pub(super) fn poll(&mut self, model: Option<&str>) -> Option<AgentUsage> {
        let path = self.path.as_ref()?;
        let Ok(mut file) = std::fs::File::open(path) else {
            return self.turn_usage.clone();
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len <= self.offset {
            return self.turn_usage.clone();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return self.turn_usage.clone();
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_err() {
            return self.turn_usage.clone();
        }
        // Only consume through the last newline so a concurrently written partial line is read next time.
        let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
            return self.turn_usage.clone();
        };
        self.offset = self.offset.saturating_add((last_nl + 1) as u64);
        for line in buf[..=last_nl].split(|&b| b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if let Some(step_usage) = gemini_transcript_step_usage(Some(&val), model) {
                if let Some(idx) = val.get("step_index").and_then(Value::as_u64) {
                    if !self.seen_steps.insert(idx) {
                        continue;
                    }
                }
                self.turn_usage = add_usage(self.turn_usage.take(), Some(step_usage));
            }
        }
        self.turn_usage.clone()
    }

    pub(super) fn reset_turn(&mut self) {
        self.turn_usage = None;
    }
}
