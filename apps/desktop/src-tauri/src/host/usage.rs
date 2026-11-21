//! Token usage from each CLI's final report, normalized to Scarlet's AgentUsage
//! (port of apps/agent/src/runners/usage.ts). `input_tokens` never includes cache
//! reads or writes, so totals add up the same way for every agent.

use serde::Serialize;
use serde_json::{Map, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// The part of `output_tokens` spent on reasoning, where the CLI reports it.
    pub reasoning_tokens: u64,
}

impl AgentUsage {
    pub fn add(self, other: AgentUsage) -> AgentUsage {
        AgentUsage {
            model: self.model.or(other.model),
            input_tokens: self.input_tokens.saturating_add(other.input_tokens).min(MAX_SAFE_INTEGER),
            output_tokens: self.output_tokens.saturating_add(other.output_tokens).min(MAX_SAFE_INTEGER),
            cache_read_tokens: self.cache_read_tokens.saturating_add(other.cache_read_tokens).min(MAX_SAFE_INTEGER),
            cache_write_tokens: self.cache_write_tokens.saturating_add(other.cache_write_tokens).min(MAX_SAFE_INTEGER),
            reasoning_tokens: self.reasoning_tokens.saturating_add(other.reasoning_tokens).min(MAX_SAFE_INTEGER),
        }
    }

    /// What is left of this count once `earlier` is taken off, each kind of token on its own and never under zero.
    pub fn less(self, earlier: &AgentUsage) -> AgentUsage {
        AgentUsage {
            model: self.model,
            input_tokens: self.input_tokens.saturating_sub(earlier.input_tokens),
            output_tokens: self.output_tokens.saturating_sub(earlier.output_tokens),
            cache_read_tokens: self.cache_read_tokens.saturating_sub(earlier.cache_read_tokens),
            cache_write_tokens: self.cache_write_tokens.saturating_sub(earlier.cache_write_tokens),
            reasoning_tokens: self.reasoning_tokens.saturating_sub(earlier.reasoning_tokens),
        }
    }

    /// Fill in the requested model when the CLI did not name one.
    pub fn or_model(mut self, model: Option<&str>) -> AgentUsage {
        if self.model.is_none() {
            self.model = model_name(model);
        }
        self
    }
}

pub fn add_usage(a: Option<AgentUsage>, b: Option<AgentUsage>) -> Option<AgentUsage> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.add(b)),
        (a, b) => a.or(b),
    }
}

/// A finite, nonnegative whole count, else 0.
pub fn token_count(v: Option<&Value>) -> u64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => (n.floor() as u64).min(MAX_SAFE_INTEGER),
        _ => 0,
    }
}

fn model_name(m: Option<&str>) -> Option<String> {
    m.map(str::trim).filter(|m| !m.is_empty()).map(|m| m.chars().take(200).collect())
}

fn counts<'a>(raw: Option<&'a Value>, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    raw.and_then(Value::as_object).filter(|o| keys.iter().any(|k| o.get(*k).is_some_and(Value::is_number)))
}

/// Claude Code `usage` (result or per-message): input already excludes the cache.
pub fn claude_usage(raw: Option<&Value>, model: Option<&str>) -> Option<AgentUsage> {
    let u = counts(raw, &["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])?;
    Some(AgentUsage {
        model: model_name(model),
        input_tokens: token_count(u.get("input_tokens")),
        output_tokens: token_count(u.get("output_tokens")),
        cache_read_tokens: token_count(u.get("cache_read_input_tokens")),
        cache_write_tokens: token_count(u.get("cache_creation_input_tokens")),
        reasoning_tokens: 0,
    })
}

/// Codex `turn.completed.usage`: input includes cached input; output includes reasoning.
pub fn codex_usage(raw: Option<&Value>, model: Option<&str>) -> Option<AgentUsage> {
    normalize_codex_usage(raw, model, ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"])
}

/// Codex App Server reports the thread's usage: `total` from its first turn, which a resumed thread carries over from
/// the runs before, and `last` for the latest model call.
pub fn codex_app_server_usage(raw: Option<&Value>, model: Option<&str>) -> Option<AgentUsage> {
    normalize_codex_usage(raw, model, ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"])
}

fn normalize_codex_usage(raw: Option<&Value>, model: Option<&str>, keys: [&str; 5]) -> Option<AgentUsage> {
    let u = counts(raw, &keys)?;
    let [input, output, cached, written, reasoning] = keys.map(|key| token_count(u.get(key)));
    Some(AgentUsage {
        model: model_name(model),
        input_tokens: input.saturating_sub(cached).saturating_sub(written),
        output_tokens: output,
        cache_read_tokens: cached,
        cache_write_tokens: written,
        reasoning_tokens: reasoning,
    })
}

/// Gemini usage: ACP `PromptResponse.usage` (camelCase) or legacy `result.stats` (snake_case).
/// In `agy acp`, `inputTokens` already excludes cached reads and writes (`inputTokens + cachedReadTokens +
/// cachedWriteTokens + outputTokens == totalTokens`). When `totalTokens` instead matches `inputTokens + outputTokens`,
/// subtract cache counts so `input_tokens` stays uncached.
pub fn gemini_usage(raw: Option<&Value>, model: Option<&str>) -> Option<AgentUsage> {
    if let Some(s) = counts(raw, &["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]) {
        let raw_input = token_count(s.get("inputTokens"));
        let output = token_count(s.get("outputTokens"));
        let cached = token_count(s.get("cachedReadTokens"));
        let written = token_count(s.get("cachedWriteTokens"));
        let cache = cached.saturating_add(written);
        let total = token_count(s.get("totalTokens"));
        let input_includes_cache = total > 0
            && cache > 0
            && raw_input >= cache
            && raw_input.saturating_add(output).abs_diff(total)
                < raw_input.saturating_add(cache).saturating_add(output).abs_diff(total);
        let input = if input_includes_cache { raw_input.saturating_sub(cache) } else { raw_input };
        // `reasoning_tokens` is part of `output_tokens`. agy's output already holds its thoughts (`totalTokens` adds up
        // without them, and a step that only thought counts output tokens); where they are reported apart (the total
        // counts them on top, or output is smaller than they are), they are output too.
        let thought = token_count(s.get("thoughtTokens"));
        let counted = input.saturating_add(cache).saturating_add(output);
        let thought_apart = thought > 0
            && (output < thought || (total > 0 && counted.saturating_add(thought).abs_diff(total) < counted.abs_diff(total)));
        return Some(AgentUsage {
            model: model_name(model),
            input_tokens: input,
            output_tokens: if thought_apart { output.saturating_add(thought) } else { output },
            cache_read_tokens: cached,
            cache_write_tokens: written,
            reasoning_tokens: thought,
        });
    }
    let s = counts(raw, &["input_tokens", "output_tokens", "input", "cached"])?;
    let cached = token_count(s.get("cached"));
    let input = if s.get("input").is_some_and(Value::is_number) {
        token_count(s.get("input"))
    } else {
        token_count(s.get("input_tokens")).saturating_sub(cached)
    };
    Some(AgentUsage {
        model: model_name(model),
        input_tokens: input,
        output_tokens: token_count(s.get("output_tokens")),
        cache_read_tokens: cached,
        ..Default::default()
    })
}

/// One `PLANNER_RESPONSE` step from `agy`'s `transcript.jsonl`: `input_tokens` already excludes cache reads.
pub fn gemini_transcript_step_usage(raw: Option<&Value>, model: Option<&str>) -> Option<AgentUsage> {
    let step = raw.and_then(Value::as_object)?;
    if step.get("type").and_then(Value::as_str) != Some("PLANNER_RESPONSE") {
        return None;
    }
    let u = counts(raw, &["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "thought_tokens", "reasoning_tokens"])?;
    let usage = AgentUsage {
        model: model_name(model),
        input_tokens: token_count(u.get("input_tokens")),
        output_tokens: token_count(u.get("output_tokens")),
        cache_read_tokens: token_count(u.get("cache_read_tokens")),
        cache_write_tokens: token_count(u.get("cache_write_tokens")),
        reasoning_tokens: token_count(u.get("thought_tokens").or_else(|| u.get("reasoning_tokens"))),
    };
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_read_tokens == 0
        && usage.cache_write_tokens == 0
        && usage.reasoning_tokens == 0
    {
        return None;
    }
    Some(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_each_cli() {
        let claude = claude_usage(
            Some(&json!({"input_tokens": 10, "output_tokens": 200, "cache_read_input_tokens": 3000, "cache_creation_input_tokens": 400})),
            Some("claude-opus-5-5"),
        );
        assert_eq!(claude, Some(AgentUsage { model: Some("claude-opus-5-5".into()), input_tokens: 10, output_tokens: 200, cache_read_tokens: 3000, cache_write_tokens: 400, reasoning_tokens: 0 }));

        let codex = codex_usage(Some(&json!({"input_tokens": 1000, "cached_input_tokens": 800, "output_tokens": 50, "reasoning_output_tokens": 20})), None);
        assert_eq!(codex, Some(AgentUsage { input_tokens: 200, output_tokens: 50, cache_read_tokens: 800, reasoning_tokens: 20, ..Default::default() }));

        let gemini = gemini_usage(Some(&json!({"input_tokens": 1200, "output_tokens": 300, "cached": 1000, "input": 200})), Some("gemini-3-pro"));
        assert_eq!(gemini, Some(AgentUsage { model: Some("gemini-3-pro".into()), input_tokens: 200, output_tokens: 300, cache_read_tokens: 1000, ..Default::default() }));
        assert_eq!(gemini_usage(Some(&json!({"input_tokens": 1200, "cached": 1000})), None).map(|u| u.input_tokens), Some(200));

        // Real `agy acp` PromptResponse.usage: inputTokens is already uncached (2151 + 7634 + 18 = 9803).
        let gemini_acp = gemini_usage(
            Some(&json!({"inputTokens": 2151, "outputTokens": 18, "cachedReadTokens": 7634, "cachedWriteTokens": 0, "thoughtTokens": 15, "totalTokens": 9803})),
            Some("gemini-4-neon"),
        );
        assert_eq!(
            gemini_acp,
            Some(AgentUsage {
                model: Some("gemini-4-neon".into()),
                input_tokens: 2151,
                output_tokens: 18,
                cache_read_tokens: 7634,
                cache_write_tokens: 0,
                reasoning_tokens: 15,
            })
        );
        // Inclusive ACP usage (totalTokens == inputTokens + outputTokens) still separates cache from input.
        let gemini_acp_inclusive = gemini_usage(
            Some(&json!({"inputTokens": 1500, "outputTokens": 250, "cachedReadTokens": 900, "cachedWriteTokens": 100, "thoughtTokens": 80, "totalTokens": 1750})),
            Some("gemini-3.1-pro"),
        );
        assert_eq!(
            gemini_acp_inclusive,
            Some(AgentUsage {
                model: Some("gemini-3.1-pro".into()),
                input_tokens: 500,
                output_tokens: 250,
                cache_read_tokens: 900,
                cache_write_tokens: 100,
                reasoning_tokens: 80,
            })
        );

        // Thoughts reported apart from output are output too: the total counts them on top, or output is smaller.
        let apart = |raw: Value| gemini_usage(Some(&raw), None).map(|u| (u.input_tokens, u.output_tokens, u.reasoning_tokens));
        assert_eq!(apart(json!({"inputTokens": 100, "outputTokens": 60, "thoughtTokens": 50, "cachedReadTokens": 40, "totalTokens": 250})), Some((100, 110, 50)));
        assert_eq!(apart(json!({"inputTokens": 100, "outputTokens": 20, "thoughtTokens": 50})), Some((100, 70, 50)));
        // agy's own, where the output holds them, stays as it is (above too).
        assert_eq!(apart(json!({"inputTokens": 100, "outputTokens": 60, "thoughtTokens": 50, "cachedReadTokens": 40, "totalTokens": 200})), Some((100, 60, 50)));

        let step = gemini_transcript_step_usage(
            Some(&json!({"step_index": 3, "type": "PLANNER_RESPONSE", "status": "DONE", "input_tokens": 2151, "cache_read_tokens": 7634, "output_tokens": 18})),
            Some("gemini-4-neon"),
        );
        assert_eq!(
            step,
            Some(AgentUsage {
                model: Some("gemini-4-neon".into()),
                input_tokens: 2151,
                output_tokens: 18,
                cache_read_tokens: 7634,
                ..Default::default()
            })
        );
        assert_eq!(
            gemini_transcript_step_usage(Some(&json!({"type": "GENERIC", "input_tokens": 10})), None),
            None
        );
    }

    #[test]
    fn reports_nothing_without_counts_and_ignores_bad_values() {
        assert_eq!(claude_usage(Some(&json!({"service_tier": "standard"})), None), None);
        assert_eq!(codex_usage(None, None), None);
        assert_eq!(gemini_usage(Some(&json!({"total_tokens": 100})), None), None);
        assert_eq!([token_count(Some(&json!(-5))), token_count(Some(&json!(2.7))), token_count(Some(&json!("9")))], [0, 2, 0]);
    }

    #[test]
    fn adds_runs_and_serializes_camel_case() {
        let a = AgentUsage { input_tokens: 1, ..Default::default() };
        let b = AgentUsage { input_tokens: 2, model: Some("m".into()), ..Default::default() };
        let sum = add_usage(Some(a), Some(b)).unwrap();
        assert_eq!((sum.input_tokens, sum.model.as_deref()), (3, Some("m")));
        assert_eq!(
            serde_json::to_value(AgentUsage { input_tokens: 5, ..Default::default() }.or_model(Some("opus"))).unwrap(),
            json!({"model": "opus", "inputTokens": 5, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "reasoningTokens": 0})
        );
    }
}
