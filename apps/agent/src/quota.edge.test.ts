import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPlanLabel, parseClaudeQuota, parseCodexQuota, parseGeminiQuota, probeSubscriptionQuota } from "./quota.js";
import { spawnLines, type SpawnHandle, type SpawnLinesOptions, type SpawnOutcome } from "./runners/spawn.js";

// The CLI is the boundary: spawnLines is replaced by a peer that answers what Scarlet writes to it.
vi.mock("./runners/spawn.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./runners/spawn.js")>()), spawnLines: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const NOW = "2026-11-22T00:00:00.000Z";
const outcome = (over: Partial<SpawnOutcome> = {}): SpawnOutcome =>
  ({ code: 0, signal: null, timedOut: false, stalled: false, aborted: false, killed: false, stderr: "", ...over });

/**
 * A CLI that answers each line written to it with the lines `reply` returns, and exits once killed or, after its input
 * closes, once it has answered.
 */
function peer(reply: (request: Record<string, any>) => unknown[] = () => [], ending: Partial<SpawnOutcome> = {}) {
  const calls: Array<{ file: string; args: string[]; opts: SpawnLinesOptions; requests: Array<Record<string, any>>; killed: boolean }> = [];
  vi.mocked(spawnLines).mockImplementation((file, args, opts) => {
    let finish!: (outcome: SpawnOutcome) => void;
    const done = new Promise<SpawnOutcome>(resolve => { finish = resolve; });
    const call = { file, args, opts, requests: [] as Array<Record<string, any>>, killed: false };
    calls.push(call);
    const stdin = {
      write(line: string) {
        const request = JSON.parse(line);
        call.requests.push(request);
        for (const response of reply(request)) queueMicrotask(() => opts.onLine(typeof response === "string" ? response : JSON.stringify(response)));
      },
      end() { setImmediate(() => finish(outcome(ending))); },
    };
    return { child: { stdin }, done, kill: () => { call.killed = true; finish(outcome({ ...ending, killed: true })); } } as unknown as SpawnHandle;
  });
  return calls;
}

/** A CLI that prints these lines and exits. */
function printer(lines: string[], ending: Partial<SpawnOutcome> = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  vi.mocked(spawnLines).mockImplementation((_file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    for (const line of lines) opts.onLine(line);
    return { child: {}, done: Promise.resolve(outcome(ending)), kill: () => {} } as unknown as SpawnHandle;
  });
  return calls;
}

const geminiUsage = { command: { data: { groups: [{ name: "Gemini Models", buckets: [{ id: "g-5h", window: "5h", remaining_fraction: 0.5 }] }] } } };

describe("probeSubscriptionQuota for Gemini", () => {
  it("reads agy's /usage JSON, even printed over several lines, and cleans up its folder", async () => {
    const calls = printer(JSON.stringify(geminiUsage, null, 2).split("\n"));
    const quota = await probeSubscriptionQuota("gemini", "agy", {});
    expect(quota?.buckets).toEqual([{ id: "g-5h", label: "Gemini · 5h", window: "5h", remainingPercent: 50 }]);
    expect(calls[0]!.args).toEqual(["-p", "/usage", "--output-format", "json"]);
    expect(existsSync(calls[0]!.cwd)).toBe(false);
  });

  it("reads the last JSON line after warnings", async () => {
    printer(["Warning: something odd", JSON.stringify({ unrelated: true }), JSON.stringify(geminiUsage), "{not json"]);
    expect((await probeSubscriptionQuota("gemini", "agy", {}))?.buckets).toHaveLength(1);
  });

  it("reads nothing from a failed, timed-out, silent or unreadable run", async () => {
    const usage = JSON.stringify(geminiUsage);
    printer([usage], { code: 1 });
    expect(await probeSubscriptionQuota("gemini", "agy", {})).toBeUndefined();
    printer([usage], { timedOut: true });
    expect(await probeSubscriptionQuota("gemini", "agy", {})).toBeUndefined();
    printer(["", "  "]);
    expect(await probeSubscriptionQuota("gemini", "agy", {})).toBeUndefined();
    printer(["Signed out", "Please log in"]);
    expect(await probeSubscriptionQuota("gemini", "agy", {})).toBeUndefined();
  });
});

describe("probeSubscriptionQuota for Claude", () => {
  const usage = { rate_limits: { five_hour: { utilization: 25 } }, subscription_type: "max" };

  it("asks Claude Code for its usage after initializing, then stops it", async () => {
    const calls = peer(request => request.request_id === "usage"
      ? ["not json", { type: "system" }, { type: "control_response", response: { request_id: "init" } },
        { type: "control_response", response: { request_id: "usage", subtype: "success", response: usage } },
        { type: "control_response", response: { request_id: "usage", subtype: "success", response: { rate_limits: { five_hour: { utilization: 99 } } } } }]
      : []);
    const quota = await probeSubscriptionQuota("claude", "claude", { HOME: "/home/me" });
    expect(quota).toMatchObject({ plan: "Max", buckets: [{ id: "five_hour", remainingPercent: 75 }] });
    const [call] = calls;
    expect(call!.requests.map(r => r.request.subtype)).toEqual(["initialize", "get_usage"]);
    expect(call!.args).toContain("--no-session-persistence");
    expect(call!.opts).toMatchObject({ interactive: true, env: { HOME: "/home/me" } });
    expect(call!.killed).toBe(true);
  });

  it("reads nothing when the usage request fails or is never answered", async () => {
    peer(request => request.request_id === "usage" ? [{ type: "control_response", response: { request_id: "usage", subtype: "error", error: "nope" } }] : []);
    expect(await probeSubscriptionQuota("claude", "claude", {})).toBeUndefined();
    peer();
    expect(await probeSubscriptionQuota("claude", "claude", {})).toBeUndefined();
  });
});

describe("probeSubscriptionQuota for Codex", () => {
  const limits = { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } } };
  const answer = (over: { init?: unknown; limits?: unknown; account?: unknown; order?: "account-first" } = {}) => (request: Record<string, any>) => {
    if (request.id === 1) return ["garbage", { method: "note" }, over.init ?? { id: 1, result: {} }];
    if (request.id === 3) {
      const replies = [over.limits ?? { id: 2, result: limits }, over.account ?? { id: 3, result: { account: { type: "chatgpt", planType: "plus" } } }];
      return over.order === "account-first" ? replies.reverse() : replies;
    }
    return [];
  };

  it("initializes the app server, then reads its rate limits and account", async () => {
    const calls = peer(answer());
    const quota = await probeSubscriptionQuota("codex", "codex", {});
    expect(quota).toMatchObject({ plan: "Plus", buckets: [{ id: "5h", remainingPercent: 60 }] });
    expect(calls[0]!.args).toEqual(["app-server"]);
    expect(calls[0]!.requests.map(r => r.method)).toEqual(["initialize", "initialized", "account/rateLimits/read", "account/read"]);
    expect(calls[0]!.killed).toBe(true);
  });

  it("waits for both answers in either order", async () => {
    peer(answer({ order: "account-first" }));
    expect((await probeSubscriptionQuota("codex", "codex", {}))?.plan).toBe("Plus");
  });

  it("reads the limits without a plan when the account can't be read", async () => {
    peer(answer({ account: { id: 3, error: { message: "no" } } }));
    const quota = await probeSubscriptionQuota("codex", "codex", {});
    expect(quota?.plan).toBeUndefined();
    expect(quota?.buckets).toHaveLength(1);
  });

  it("omits an API-key account's quota", async () => {
    peer(answer({ account: { id: 3, result: { account: { type: "apiKey" } } } }));
    expect(await probeSubscriptionQuota("codex", "codex", {})).toBeUndefined();
  });

  it("reads nothing when initializing or the rate limits fail", async () => {
    const calls = peer(answer({ init: { id: 1, error: { message: "old version" } } }));
    expect(await probeSubscriptionQuota("codex", "codex", {})).toBeUndefined();
    expect(calls[0]!.requests.map(r => r.method)).toEqual(["initialize"]);
    expect(calls[0]!.killed).toBe(true);
    peer(answer({ limits: { id: 2, error: { message: "unavailable" } } }));
    expect(await probeSubscriptionQuota("codex", "codex", {})).toBeUndefined();
  });
});

describe("formatPlanLabel", () => {
  it("names known plans, keeps formatted names and titles the rest", () => {
    expect(formatPlanLabel(" PLUS ")).toBe("Plus");
    expect(formatPlanLabel("team")).toBe("Team");
    expect(formatPlanLabel("google_ai-pro")).toBe("Google Ai Pro");
    expect(formatPlanLabel("")).toBeUndefined();
    expect(formatPlanLabel("   ")).toBeUndefined();
    expect(formatPlanLabel(5)).toBeUndefined();
  });
});

describe("parseClaudeQuota", () => {
  it("reads unscoped limits when the named windows are absent, 5-hour first", () => {
    const quota = parseClaudeQuota({ limits: [
      null,
      { kind: "weekly_all", percent: 20, resetsAt: 1_795_000_000 },
      { group: "session", utilization: 130, resets_at: "" },
      { kind: "five_hour_scoped", percent: 1, scope: { surface: "web" } },
      { kind: "5h_extra", percent: 50 },
      { kind: "seven_day_more", percent: 50 },
      { kind: "monthly", percent: 10 },
      { kind: "weekly_blank" },
    ], subscription_type: "claude_max" }, NOW);
    expect(quota).toEqual({ plan: "Claude Max", fetchedAt: NOW, buckets: [
      { id: "five_hour", label: "5-hour", window: "5h", remainingPercent: 0 },
      { id: "weekly_all", label: "Weekly", window: "weekly", remainingPercent: 80, resetsAt: new Date(1_795_000_000_000).toISOString() },
    ] });
  });

  it("reads the windows at the top level and the plan beside them", () => {
    const quota = parseClaudeQuota({ rate_limits: { seven_day: { used_percent: 12.345, resetsAt: 1_795_000_000_000 }, five_hour: { percent: -5 },
      subscription_type: "pro", limits: [{ kind: "five_hour", percent: 90 }] } }, NOW);
    expect(quota).toEqual({ plan: "Pro", fetchedAt: NOW, buckets: [
      { id: "five_hour", label: "5-hour", window: "5h", remainingPercent: 100 },
      { id: "seven_day", label: "Weekly", window: "weekly", remainingPercent: 87.7, resetsAt: new Date(1_795_000_000_000).toISOString() },
    ] });
  });

  it("reads nothing without a usable window, and ignores reset times it can't read", () => {
    expect(parseClaudeQuota({ five_hour: { resets_at: "2026-11-22T02:00:00Z" } }, NOW)).toBeUndefined();
    expect(parseClaudeQuota({ five_hour: "x", limits: "x" }, NOW)).toBeUndefined();
    expect(parseClaudeQuota({ five_hour: { utilization: 10, resets_at: "soon" } }, NOW)).toEqual({ fetchedAt: NOW,
      buckets: [{ id: "five_hour", label: "5-hour", window: "5h", remainingPercent: 90 }] });
    expect(parseClaudeQuota({ five_hour: { utilization: 10, resets_at: -1 } }, NOW)!.buckets[0]!.resetsAt).toBeUndefined();
    expect(parseClaudeQuota({ five_hour: { utilization: Number.NaN } }, NOW)).toBeUndefined();
  });
});

describe("parseCodexQuota", () => {
  it("names each window by its length", () => {
    const windows = (mins: number | undefined) => parseCodexQuota({ primary: { used_percent: 10, window_duration_mins: mins } }, undefined, NOW)!.buckets[0]!;
    expect(windows(undefined)).toMatchObject({ id: "primary", label: "5-hour", window: "5h" });
    expect(windows(0)).toMatchObject({ id: "primary", label: "5-hour" });
    expect(windows(20)).toMatchObject({ id: "1h", label: "1-hour", window: "1h" });
    expect(windows(60)).toMatchObject({ id: "1h", label: "1-hour" });
    expect(windows(720)).toMatchObject({ id: "12h", label: "12-hour", window: "12h" });
    expect(windows(2880)).toMatchObject({ id: "2d", label: "2-day", window: "2d" });
    expect(windows(30 * 1440)).toMatchObject({ id: "30d", label: "30-day" });
    expect(windows(7 * 1440)).toMatchObject({ id: "weekly", label: "Weekly" });
  });

  it("names a secondary window with no length weekly, and keeps two windows of the same length apart", () => {
    const quota = parseCodexQuota({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: { usedPercent: 20, windowDurationMins: 300 } } }, {}, NOW);
    expect(quota!.buckets.map(b => b.id)).toEqual(["5h", "secondary"]);
    expect(parseCodexQuota({ secondary: { usedPercent: 20 } }, undefined, NOW)!.buckets[0]).toMatchObject({ id: "secondary", label: "Weekly", window: "weekly" });
  });

  it("reads the first limit by id when there is no codex one, and the plan from the account", () => {
    const quota = parseCodexQuota({ rateLimitsByLimitId: { other: "x", second: { primary: { usedPercent: 30 } } } }, { type: "chatgpt", plan_type: "team" }, NOW);
    expect(quota).toMatchObject({ plan: "Team", buckets: [{ id: "primary", remainingPercent: 70 }] });
  });

  it("reports unlimited credits with or without windows", () => {
    expect(parseCodexQuota({ rateLimits: { credits: { unlimited: true }, plan_type: "enterprise" } }, undefined, NOW))
      .toEqual({ plan: "Enterprise", buckets: [], unlimited: true, fetchedAt: NOW });
    expect(parseCodexQuota({ rateLimits: { credits: { unlimited: true }, primary: { usedPercent: 5 } } }, undefined, NOW)).toMatchObject({ unlimited: true, buckets: [{ remainingPercent: 95 }] });
  });

  it("reads nothing without a snapshot or a usable window", () => {
    expect(parseCodexQuota({}, undefined, NOW)).toBeUndefined();
    expect(parseCodexQuota({ rateLimitsByLimitId: {} }, undefined, NOW)).toBeUndefined();
    expect(parseCodexQuota({ rateLimits: { primary: "x", secondary: { windowDurationMins: 300 } } }, undefined, NOW)).toBeUndefined();
    expect(parseCodexQuota({ rateLimits: { credits: { unlimited: false } } }, undefined, NOW)).toBeUndefined();
  });
});

describe("parseGeminiQuota", () => {
  it("shows other groups when there is no Gemini group, untouched or not", () => {
    const quota = parseGeminiQuota({ data: { groups: [
      { name: "Claude and GPT models", buckets: [{ name: "Weekly Limit", remainingFraction: 1, resetTime: "2026-11-29T00:00:00Z" }] },
      { name: "Other Models", buckets: [{ window: "daily", remaining_fraction: 0.25 }, { name: "Five Hour", remaining_fraction: 0.5 }] },
    ] } }, NOW);
    expect(quota).toEqual({ fetchedAt: NOW, buckets: [
      { id: "claude/gpt-7d", label: "Claude/GPT · 7d", window: "weekly", remainingPercent: 100, resetsAt: "2026-11-29T00:00:00.000Z" },
      { id: "other-5h", label: "Other · 5h", window: "5h", remainingPercent: 50 },
      { id: "other-daily", label: "Other · daily", window: "daily", remainingPercent: 25 },
    ] });
  });

  it("shows a used third-party group beside the Gemini one", () => {
    const quota = parseGeminiQuota({ groups: [
      { name: "Claude and GPT models", buckets: [{ window: "7d", remaining_fraction: 0.4 }] },
      { name: "Gemini Models", buckets: [{ name: "5-hour", remaining_fraction: 0.9 }] },
    ] }, NOW, "pro");
    expect(quota).toMatchObject({ plan: "Pro", buckets: [{ id: "gemini-5h", label: "Gemini · 5h" }, { id: "claude/gpt-7d", label: "Claude/GPT · 7d" }] });
  });

  it("names a group with no name Gemini and a bucket with no name or window a limit", () => {
    const quota = parseGeminiQuota({ groups: [{ buckets: [{ remaining_fraction: 0.7, id: "" }] }] }, NOW);
    expect(quota!.buckets).toEqual([{ id: "gemini-limit", label: "Gemini · limit", remainingPercent: 70 }]);
  });

  it("keeps a group's whole name when taking off 'models' would leave nothing", () => {
    expect(parseGeminiQuota({ groups: [{ name: " Models", buckets: [{ name: "7d", remaining_fraction: 0.5 }] }] }, NOW)!.buckets[0]!.label).toBe(" Models · 7d");
  });

  it("skips what it can't read and reads nothing when that leaves no bucket", () => {
    expect(parseGeminiQuota({ groups: [null, { name: "Gemini", buckets: [null, { window: "5h" }] }, { name: "Gemini 2", buckets: "x" }] }, NOW)).toBeUndefined();
    expect(parseGeminiQuota({ command: { data: { groups: "x" } } }, NOW)).toBeUndefined();
    expect(parseGeminiQuota("x", NOW)).toBeUndefined();
  });
});
