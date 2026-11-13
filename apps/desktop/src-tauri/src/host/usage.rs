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
    let u = counts(raw, &["input_tokens", "output_tokens", "cached_input_tokens"])?;
    let cached = token_count(u.get("cached_input_tokens"));
    Some(AgentUsage {
        model: model_name(model),
        input_tokens: token_count(u.get("input_tokens")).saturating_sub(cached),
        output_tokens: token_count(u.get("output_tokens")),
        cache_read_tokens: cached,
        reasoning_tokens: token_count(u.get("reasoning_output_tokens")),
        ..Default::default()
    })
}

/// Gemini `result.stats`: `input_tokens` includes `cached`; `input` (newer CLIs) is the uncached part.
pub fn gemini_usage(raw: Option<&Value>, model: Option<&str>) -> Option<AgentUsage> {
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
