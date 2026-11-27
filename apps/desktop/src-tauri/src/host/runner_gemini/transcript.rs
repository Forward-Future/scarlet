//! Incremental tailer for `agy`'s per-session `transcript.jsonl`, reporting live
//! token usage mid-turn while `session/prompt` is in flight.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::super::usage::{add_usage, gemini_transcript_step_usage, AgentUsage};
use crate::util::{env_get, home_dir};

/// Path to `agy`'s per-session `transcript.jsonl`, where completed planner steps are written mid-turn: in the run's own
/// Gemini folder (`--gemini-dir`), or the user's `~/.gemini` when the run has none.
pub fn agy_transcript_path(env: &HashMap<String, String>, gemini_dir: Option<&Path>, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.contains("..") {
        return None;
    }
    let gemini_dir = gemini_dir.map(Path::to_path_buf).unwrap_or_else(|| {
        env_get(env, "HOME")
            .filter(|v| !v.is_empty())
            .or_else(|| env_get(env, "USERPROFILE").filter(|v| !v.is_empty()))
            .map(PathBuf::from)
            .unwrap_or_else(home_dir)
            .join(".gemini")
    });
    Some(
        gemini_dir
            .join("antigravity-cli")
            .join("brain")
            .join(session_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl"),
    )
}

/// One model step's tokens, from its `PLANNER_RESPONSE` (port of `StepTokens` in apps/agent/src/runners/geminiTranscript.ts).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct StepTokens {
    pub step: Option<u64>,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl StepTokens {
    /// The context the step sent: its input, uncached and cached.
    fn context(&self) -> u64 {
        self.input.saturating_add(self.cache_read).saturating_add(self.cache_write)
    }
}

/// A step that read much less from the cache than the step before sent: Gemini billed the rest of it uncached.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CacheMiss {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
    pub context: u64,
    pub cached: u64,
    pub missed: u64,
}

/// A run's steps: how many, the largest context one sent, and its cache misses with the tokens they re-sent uncached.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StepsReport {
    pub steps: usize,
    pub peak_context: u64,
    pub misses: Vec<CacheMiss>,
    pub missed_tokens: u64,
}

/// Least shortfall, in tokens and as a share of the step before's context, read as a miss rather than a trimmed prompt.
const MISS_TOKENS: u64 = 4_096;
const MISS_SHARE: f64 = 0.25;

/// Whether `step` missed the cache: agy's cache holds the whole of the request before, so a read far under it means
/// Gemini sent that context again uncached (`cacheMiss` in geminiTranscript.ts).
pub(super) fn cache_miss(before: &StepTokens, step: &StepTokens) -> Option<CacheMiss> {
    let context = before.context();
    let missed = context.saturating_sub(step.cache_read);
    (missed as f64 > (MISS_TOKENS as f64).max(context as f64 * MISS_SHARE))
        .then_some(CacheMiss { step: step.step, context, cached: step.cache_read, missed })
}

/// What a run's steps add up to, or nothing when the transcript gave none.
pub(super) fn steps_report(steps: &[StepTokens]) -> Option<StepsReport> {
    if steps.is_empty() {
        return None;
    }
    let misses: Vec<CacheMiss> = steps.windows(2).filter_map(|w| cache_miss(&w[0], &w[1])).collect();
    Some(StepsReport {
        steps: steps.len(),
        peak_context: steps.iter().map(StepTokens::context).max().unwrap_or(0),
        missed_tokens: misses.iter().map(|m| m.missed).sum(),
        misses,
    })
}

/// Incrementally tails `agy`'s `transcript.jsonl` to report live token counts mid-turn,
/// since `agy acp`'s `usage_update` notifications only report context-window fill (`used`/`size`).
#[derive(Debug, Default)]
pub(super) struct TranscriptUsageTailer {
    path: Option<PathBuf>,
    offset: u64,
    seen_steps: HashSet<u64>,
    turn_usage: Option<AgentUsage>,
    /// Every step of the run, across its turns, for `report`.
    steps: Vec<StepTokens>,
}

impl TranscriptUsageTailer {
    pub(super) fn open(&mut self, env: &HashMap<String, String>, gemini_dir: Option<&Path>, session_id: &str, skip_existing: bool) {
        self.path = agy_transcript_path(env, gemini_dir, session_id);
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
        self.steps.clear();
    }

    /// The run's steps so far: how many, the peak context and the cache misses.
    pub(super) fn report(&self) -> Option<StepsReport> {
        steps_report(&self.steps)
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
                let index = val.get("step_index").and_then(Value::as_u64);
                if let Some(idx) = index {
                    if !self.seen_steps.insert(idx) {
                        continue;
                    }
                }
                let step = StepTokens {
                    step: index,
                    input: step_usage.input_tokens,
                    cache_read: step_usage.cache_read_tokens,
                    cache_write: step_usage.cache_write_tokens,
                };
                // A cache miss goes in the log as its step is read, with the context Gemini then billed again uncached.
                if let Some(miss) = self.steps.last().and_then(|before| cache_miss(before, &step)) {
                    log::info!(
                        "agy cache miss at step {}: read {} of the {} tokens the step before sent",
                        miss.step.map_or_else(|| "?".to_string(), |s| s.to_string()),
                        miss.cached,
                        miss.context
                    );
                }
                self.steps.push(step);
                self.turn_usage = add_usage(self.turn_usage.take(), Some(step_usage));
            }
        }
        self.turn_usage.clone()
    }

    pub(super) fn reset_turn(&mut self) {
        self.turn_usage = None;
    }
}

#[cfg(test)]
mod steps_tests {
    use super::*;

    fn step(n: u64, input: u64, cache_read: u64) -> StepTokens {
        StepTokens { step: Some(n), input, cache_read, cache_write: 0 }
    }

    #[test]
    fn flags_a_step_that_read_far_less_from_the_cache_than_the_step_before_sent() {
        // The same steps as the TypeScript host's test, so both hosts read a run alike.
        let steps = [step(1, 26_000, 0), step(2, 2_000, 26_000), step(3, 3_000, 28_000), step(4, 120_000, 0), step(5, 1_000, 120_000), step(6, 1_000, 112_000)];
        assert_eq!(cache_miss(&steps[0], &steps[1]), None);
        assert_eq!(cache_miss(&steps[2], &steps[3]), Some(CacheMiss { step: Some(4), context: 31_000, cached: 0, missed: 31_000 }));
        assert_eq!(cache_miss(&steps[4], &steps[5]), None);
        let report = steps_report(&steps).unwrap();
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({ "steps": 6, "peakContext": 121_000, "misses": [{ "step": 4, "context": 31_000, "cached": 0, "missed": 31_000 }], "missedTokens": 31_000 })
        );
        assert_eq!(steps_report(&[]), None);
    }
}
