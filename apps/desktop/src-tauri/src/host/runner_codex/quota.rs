//! Codex's subscription limits, as App Server reports them during a run (`account/rateLimits/updated`).

use serde_json::Value;

use crate::host::types::{QuotaBucket, SubscriptionQuota};
use crate::util::iso_from_unix_secs;

fn format_codex_plan(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let known = match trimmed.to_ascii_lowercase().as_str() {
        "free" => Some("Free"),
        "plus" => Some("Plus"),
        "pro" => Some("Pro"),
        "max" => Some("Max"),
        "team" => Some("Team"),
        "enterprise" => Some("Enterprise"),
        "edu" => Some("Edu"),
        "go" => Some("Go"),
        _ => None,
    };
    if let Some(label) = known {
        return Some(label.to_string());
    }
    Some(trimmed.to_string())
}

fn codex_window_meta(mins: Option<f64>, fallback_id: &str) -> (String, String, Option<String>) {
    let Some(m) = mins.filter(|m| m.is_finite() && *m > 0.0) else {
        return if fallback_id == "primary" {
            ("primary".into(), "5-hour".into(), Some("5h".into()))
        } else {
            ("secondary".into(), "Weekly".into(), Some("weekly".into()))
        };
    };
    if m <= 360.0 {
        let hours = ((m / 60.0).round() as u64).max(1);
        return (format!("{hours}h"), format!("{hours}-hour"), Some(format!("{hours}h")));
    }
    if (6.0 * 1440.0..=8.0 * 1440.0).contains(&m) {
        return ("weekly".into(), "Weekly".into(), Some("weekly".into()));
    }
    if m >= 1440.0 {
        let days = (m / 1440.0).round() as u64;
        return (format!("{days}d"), format!("{days}-day"), Some(format!("{days}d")));
    }
    let hours = (m / 60.0).round() as u64;
    (format!("{hours}h"), format!("{hours}-hour"), Some(format!("{hours}h")))
}

fn codex_reset_iso(value: Option<&Value>) -> Option<String> {
    let v = value?;
    if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(s.to_string());
    }
    let num = v.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    let secs = if num >= 1e12 { (num / 1000.0).round() as i64 } else { num.round() as i64 };
    Some(iso_from_unix_secs(secs))
}

pub(super) fn parse_codex_rate_limits_notification(params: &Value, fetched_at: &str) -> Option<SubscriptionQuota> {
    let root = params.as_object()?;
    let snapshot = root
        .get("rateLimits")
        .and_then(Value::as_object)
        .or_else(|| {
            root.get("rateLimitsByLimitId")
                .and_then(Value::as_object)
                .and_then(|by_id| {
                    by_id
                        .get("codex")
                        .and_then(Value::as_object)
                        .or_else(|| by_id.values().find_map(Value::as_object))
                })
        })
        .or_else(|| (root.contains_key("primary") || root.contains_key("secondary")).then_some(root))?;

    let mut buckets = Vec::new();
    for (key, fallback_id) in [("primary", "primary"), ("secondary", "secondary")] {
        let Some(rec) = snapshot.get(key).and_then(Value::as_object) else { continue };
        let Some(used) = rec.get("usedPercent").or_else(|| rec.get("used_percent")).and_then(Value::as_f64).filter(|n| n.is_finite()) else {
            continue;
        };
        let mins = rec.get("windowDurationMins").or_else(|| rec.get("window_duration_mins")).and_then(Value::as_f64);
        let (meta_id, label, window) = codex_window_meta(mins, fallback_id);
        let id = if buckets.iter().any(|b: &QuotaBucket| b.id == meta_id) { fallback_id.to_string() } else { meta_id };
        let remaining = ((100.0 - used).clamp(0.0, 100.0) * 10.0).round() / 10.0;
        let resets_at = codex_reset_iso(rec.get("resetsAt").or_else(|| rec.get("resets_at")));
        buckets.push(QuotaBucket { id, label, window, remaining_percent: remaining, resets_at });
    }
    let unlimited = snapshot.get("credits").and_then(|c| c.get("unlimited")).and_then(Value::as_bool) == Some(true);
    if buckets.is_empty() && !unlimited {
        return None;
    }
    let plan = snapshot.get("planType").or_else(|| snapshot.get("plan_type")).and_then(Value::as_str).and_then(format_codex_plan);
    Some(SubscriptionQuota { plan, buckets, unlimited: unlimited.then_some(true), fetched_at: fetched_at.to_string() })
}
