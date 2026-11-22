import { describe, expect, it } from "vitest";
import { formatPlanLabel, isQuotaEligible, parseClaudeQuota, parseCodexQuota, parseGeminiQuota } from "./quota.js";

const NOW = "2026-11-22T00:00:00.000Z";

describe("quota parsers", () => {
  it("parses live Claude get_usage payloads with seven_day and null five_hour", () => {
    const quota = parseClaudeQuota({
      rate_limits_available: true,
      subscription_type: "max",
      rate_limits: {
        five_hour: null,
        seven_day: {
          utilization: 41,
          resets_at: "2026-11-27T20:59:59.928122+00:00",
        },
        limits: [
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 41,
            resets_at: "2026-11-27T20:59:59.928122+00:00",
            scope: null,
          },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 30,
            resets_at: "2026-11-27T20:59:59.928251+00:00",
            scope: { model: { display_name: "Fable", id: null }, surface: null },
          },
        ],
      },
    }, NOW);
    expect(quota).toEqual({
      plan: "Max",
      fetchedAt: NOW,
      buckets: [
        {
          id: "seven_day",
          label: "Weekly",
          window: "weekly",
          remainingPercent: 59,
          resetsAt: "2026-11-27T20:59:59.928Z",
        },
      ],
    });
  });

  it("parses Claude five_hour and seven_day and omits quota when rate_limits_available is false", () => {
    const quota = parseClaudeQuota({
      rate_limits_available: true,
      subscription_type: "pro",
      rate_limits: {
        five_hour: { utilization: 86, resets_at: "2026-11-22T02:00:00Z" },
        seven_day: { utilization: 32, resets_at: "2026-11-25T04:00:00Z" },
      },
    }, NOW);
    expect(quota?.plan).toBe("Pro");
    expect(quota?.buckets).toEqual([
      { id: "five_hour", label: "5-hour", window: "5h", remainingPercent: 14, resetsAt: "2026-11-22T02:00:00.000Z" },
      { id: "seven_day", label: "Weekly", window: "weekly", remainingPercent: 68, resetsAt: "2026-11-25T04:00:00.000Z" },
    ]);

    expect(parseClaudeQuota({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 10 } } }, NOW)).toBeUndefined();
  });

  it("parses Codex rateLimits with unix seconds resetsAt and omits API-key accounts", () => {
    const resetSec = Math.floor(Date.parse("2026-11-22T03:18:00.000Z") / 1000);
    const weeklySec = Math.floor(Date.parse("2026-11-27T11:00:00.000Z") / 1000);
    const quota = parseCodexQuota(
      {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: resetSec },
          secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: weeklySec },
        },
      },
      { account: { type: "chatgpt", planType: "pro" } },
      NOW,
    );
    expect(quota).toEqual({
      plan: "Pro",
      fetchedAt: NOW,
      buckets: [
        { id: "5h", label: "5-hour", window: "5h", remainingPercent: 82, resetsAt: "2026-11-22T03:18:00.000Z" },
        { id: "weekly", label: "Weekly", window: "weekly", remainingPercent: 91, resetsAt: "2026-11-27T11:00:00.000Z" },
      ],
    });

    expect(parseCodexQuota(
      { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } },
      { account: { type: "apiKey" } },
      NOW,
    )).toBeUndefined();
  });

  it("parses Codex rateLimitsByLimitId fallback", () => {
    const quota = parseCodexQuota({
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 95.4, windowDurationMins: 300, resetsAt: "2026-11-22T01:00:00Z" },
        },
      },
    }, undefined, NOW);
    expect(quota).toEqual({
      fetchedAt: NOW,
      buckets: [
        { id: "5h", label: "5-hour", window: "5h", remainingPercent: 4.6, resetsAt: "2026-11-22T01:00:00.000Z" },
      ],
    });
  });

  it("parses Gemini agy /usage JSON, ordering 5h before weekly and omitting untouched 3P group", () => {
    const quota = parseGeminiQuota({
      status: "SUCCESS",
      num_turns: 0,
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.88, reset_time: "2026-11-29T00:26:58Z" },
                { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.96, reset_time: "2026-11-22T05:26:58Z" },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-29T00:26:58Z" },
                { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-22T05:26:58Z" },
              ],
            },
          ],
        },
      },
    }, NOW, "Google AI Ultra");
    expect(quota).toEqual({
      plan: "Google AI Ultra",
      fetchedAt: NOW,
      buckets: [
        { id: "gemini-5h", label: "Gemini · 5h", window: "5h", remainingPercent: 96, resetsAt: "2026-11-22T05:26:58.000Z" },
        { id: "gemini-weekly", label: "Gemini · 7d", window: "weekly", remainingPercent: 88, resetsAt: "2026-11-29T00:26:58.000Z" },
      ],
    });
  });

  it("excludes API-key or signed-out providers from quota eligibility and formats plan labels", () => {
    expect(isQuotaEligible({ id: "claude", installed: true, loggedIn: true, auth: "subscription" })).toBe(true);
    expect(isQuotaEligible({ id: "claude", installed: true, loggedIn: true, auth: "api_key" })).toBe(false);
    expect(isQuotaEligible({ id: "codex", installed: true, loggedIn: false, auth: "subscription" })).toBe(false);
    expect(isQuotaEligible({ id: "api", installed: true, loggedIn: true })).toBe(false);
    expect(formatPlanLabel("max")).toBe("Max");
    expect(formatPlanLabel("Google AI Ultra")).toBe("Google AI Ultra");
    expect(parseClaudeQuota("garbage")).toBeUndefined();
    expect(parseCodexQuota(null)).toBeUndefined();
    expect(parseGeminiQuota({})).toBeUndefined();
  });
});
