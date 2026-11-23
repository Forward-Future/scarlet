/**
 * Non-blocking subscription quota probes for Claude Code, Codex (ChatGPT), and Gemini (agy).
 * All three queries spend zero tokens and parse provider payloads defensively.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAvailability, QuotaBucket, SubscriptionQuota } from "@scarlet/shared";
import type { CliAgent } from "./modelCatalog.js";
import { asRecord, jsonLine, spawnLines } from "./runners/spawn.js";

const PROBE_TIMEOUT_MS = 15_000;

/** Subscriptions only: omit quota when a provider is signed in via API key or not signed in. */
export function isQuotaEligible(agent: Pick<AgentAvailability, "id" | "installed" | "loggedIn" | "auth">): boolean {
  return (agent.id === "claude" || agent.id === "codex" || agent.id === "gemini")
    && agent.installed
    && agent.loggedIn !== false
    && agent.auth !== "api_key";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function normalizeResetTime(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  const num = finiteNumber(value);
  if (num === undefined || num <= 0) return undefined;
  // Unix seconds (~1e9) vs milliseconds (~1e12).
  const ms = num < 1e12 ? num * 1000 : num;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function formatPlanLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const known: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    max: "Max",
    team: "Team",
    enterprise: "Enterprise",
    edu: "Edu",
    go: "Go",
  };
  const lower = trimmed.toLowerCase();
  if (known[lower]) return known[lower];
  // Preserve human-formatted tier strings like "Google AI Ultra".
  if (/[A-Z]/.test(trimmed)) return trimmed;
  return trimmed.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Parse Claude Code's `control_response` (`get_usage`) payload.
 * `utilization` / `percent` report % USED, so remaining = `100 - used`.
 */
export function parseClaudeQuota(payload: unknown, fetchedAt = new Date().toISOString()): SubscriptionQuota | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  if (root.rate_limits_available === false) return undefined;
  const rateLimits = asRecord(root.rate_limits) ?? root;
  const buckets: QuotaBucket[] = [];

  const readWindow = (obj: unknown, id: string, label: string, window: string) => {
    const rec = asRecord(obj);
    if (!rec) return;
    const used = finiteNumber(rec.utilization ?? rec.percent ?? rec.used_percent);
    if (used === undefined) return;
    const resetsAt = normalizeResetTime(rec.resets_at ?? rec.resetsAt);
    buckets.push({
      id,
      label,
      window,
      remainingPercent: clampPercent(100 - used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };

  readWindow(rateLimits.five_hour, "five_hour", "5-hour", "5h");
  readWindow(rateLimits.seven_day, "seven_day", "Weekly", "weekly");

  // Fallback to `limits` array when `five_hour`/`seven_day` objects are absent.
  const rawLimits = Array.isArray(rateLimits.limits)
    ? rateLimits.limits
    : Array.isArray(root.limits)
      ? root.limits
      : [];
  for (const entry of rawLimits) {
    const lim = asRecord(entry);
    if (!lim) continue;
    const scope = asRecord(lim.scope);
    const hasScope = Boolean(scope?.model || scope?.surface);
    if (hasScope) continue;
    const kind = typeof lim.kind === "string" ? lim.kind.toLowerCase() : "";
    const group = typeof lim.group === "string" ? lim.group.toLowerCase() : "";
    const used = finiteNumber(lim.percent ?? lim.utilization);
    if (used === undefined) continue;
    const resetsAt = normalizeResetTime(lim.resets_at ?? lim.resetsAt);
    const isFiveHour = kind.includes("five_hour") || kind.includes("5h") || group === "session" || group === "5h";
    const isWeekly = kind.includes("weekly") || kind.includes("seven_day") || group === "weekly";
    if (isFiveHour && !buckets.some((b) => b.window === "5h")) {
      buckets.push({
        id: kind || "five_hour",
        label: "5-hour",
        window: "5h",
        remainingPercent: clampPercent(100 - used),
        ...(resetsAt ? { resetsAt } : {}),
      });
    } else if (isWeekly && !buckets.some((b) => b.window === "weekly")) {
      buckets.push({
        id: kind || "seven_day",
        label: "Weekly",
        window: "weekly",
        remainingPercent: clampPercent(100 - used),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }

  if (!buckets.length) return undefined;
  buckets.sort((a, b) => (a.window === "5h" ? -1 : b.window === "5h" ? 1 : 0));
  const plan = formatPlanLabel(root.subscription_type ?? rateLimits.subscription_type);
  return { ...(plan ? { plan } : {}), buckets, fetchedAt };
}

function codexWindowMeta(windowDurationMins: number | undefined, fallbackId: "primary" | "secondary"): { id: string; label: string; window?: string } {
  if (windowDurationMins === undefined || windowDurationMins <= 0) {
    return fallbackId === "primary"
      ? { id: "primary", label: "5-hour", window: "5h" }
      : { id: "secondary", label: "Weekly", window: "weekly" };
  }
  if (windowDurationMins <= 360) {
    const hours = Math.max(1, Math.round(windowDurationMins / 60));
    return { id: `${hours}h`, label: `${hours}-hour`, window: `${hours}h` };
  }
  if (windowDurationMins >= 6 * 1440 && windowDurationMins <= 8 * 1440) {
    return { id: "weekly", label: "Weekly", window: "weekly" };
  }
  if (windowDurationMins >= 1440) {
    const days = Math.round(windowDurationMins / 1440);
    return { id: `${days}d`, label: `${days}-day`, window: `${days}d` };
  }
  const hours = Math.round(windowDurationMins / 60);
  return { id: `${hours}h`, label: `${hours}-hour`, window: `${hours}h` };
}

/**
 * Parse Codex App Server's `account/rateLimits/read` result (or `account/rateLimits/updated` notification params)
 * plus optional `account/read` result.
 */
export function parseCodexQuota(
  rateLimitsPayload: unknown,
  accountPayload?: unknown,
  fetchedAt = new Date().toISOString(),
): SubscriptionQuota | undefined {
  const accountRoot = asRecord(accountPayload);
  const accountObj = asRecord(accountRoot?.account) ?? accountRoot;
  if (accountObj && typeof accountObj.type === "string" && accountObj.type.toLowerCase() === "apikey") {
    return undefined;
  }

  const root = asRecord(rateLimitsPayload);
  if (!root) return undefined;

  let snapshot = asRecord(root.rateLimits);
  if (!snapshot) {
    const byId = asRecord(root.rateLimitsByLimitId);
    if (byId) {
      snapshot = asRecord(byId.codex) ?? Object.values(byId).map(asRecord).find(Boolean);
    }
  }
  if (!snapshot && (root.primary || root.secondary)) {
    snapshot = root;
  }
  if (!snapshot) return undefined;

  const buckets: QuotaBucket[] = [];
  const pushWindow = (win: unknown, fallbackId: "primary" | "secondary") => {
    const rec = asRecord(win);
    if (!rec) return;
    const used = finiteNumber(rec.usedPercent ?? rec.used_percent);
    if (used === undefined) return;
    const mins = finiteNumber(rec.windowDurationMins ?? rec.window_duration_mins);
    const meta = codexWindowMeta(mins, fallbackId);
    const resetsAt = normalizeResetTime(rec.resetsAt ?? rec.resets_at);
    const id = buckets.some((b) => b.id === meta.id) ? fallbackId : meta.id;
    buckets.push({
      id,
      label: meta.label,
      ...(meta.window ? { window: meta.window } : {}),
      remainingPercent: clampPercent(100 - used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };

  pushWindow(snapshot.primary, "primary");
  pushWindow(snapshot.secondary, "secondary");
  const credits = asRecord(snapshot.credits);
  const unlimited = credits?.unlimited === true;
  if (!buckets.length && !unlimited) return undefined;

  const plan = formatPlanLabel(snapshot.planType ?? snapshot.plan_type ?? accountObj?.planType ?? accountObj?.plan_type);
  return { ...(plan ? { plan } : {}), buckets, ...(unlimited ? { unlimited: true } : {}), fetchedAt };
}

function shortGeminiGroup(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("claude") && lower.includes("gpt")) return "Claude/GPT";
  return name.replace(/\s+models?$/i, "").trim() || name;
}

function shortGeminiWindow(window: string | undefined, name: string | undefined): { tag: string; window?: string; order: number } {
  const w = (window ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (w === "5h" || n.includes("five hour") || n.includes("5-hour") || n.includes("5h")) {
    return { tag: "5h", window: "5h", order: 0 };
  }
  if (w === "weekly" || w === "7d" || n.includes("weekly") || n.includes("7d")) {
    return { tag: "7d", window: "weekly", order: 1 };
  }
  return { tag: window || name || "limit", window: window || undefined, order: 2 };
}

/**
 * Parse Gemini (`agy -p /usage --output-format json`) output.
 * `remaining_fraction` is 0..1 remaining directly.
 */
export function parseGeminiQuota(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
  plan?: string,
): SubscriptionQuota | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const command = asRecord(root.command);
  const data = asRecord(command?.data) ?? asRecord(root.data) ?? root;
  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (!groups.length) return undefined;

  const buckets: QuotaBucket[] = [];
  // Prefer Gemini Models group first; only include additional groups when present and distinct.
  const orderedGroups = [...groups].sort((a, b) => {
    const aName = String(asRecord(a)?.name ?? "").toLowerCase();
    const bName = String(asRecord(b)?.name ?? "").toLowerCase();
    const aGem = aName.includes("gemini") ? 0 : 1;
    const bGem = bName.includes("gemini") ? 0 : 1;
    return aGem - bGem;
  });

  // In Scarlet's Gemini provider picker, the primary Gemini group is always shown.
  // Include other groups only if no Gemini group was present or if their remaining % is lower (< 100%).
  const hasGeminiGroup = orderedGroups.some((g) => String(asRecord(g)?.name ?? "").toLowerCase().includes("gemini"));
  for (const rawGroup of orderedGroups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const groupName = typeof group.name === "string" ? group.name : "Gemini";
    const isGeminiGroup = groupName.toLowerCase().includes("gemini");
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
    const parsedGroup: Array<{ bucket: QuotaBucket; order: number }> = [];
    for (const rawBucket of rawBuckets) {
      const rec = asRecord(rawBucket);
      if (!rec) continue;
      const frac = finiteNumber(rec.remaining_fraction ?? rec.remainingFraction);
      if (frac === undefined) continue;
      const win = shortGeminiWindow(
        typeof rec.window === "string" ? rec.window : undefined,
        typeof rec.name === "string" ? rec.name : undefined,
      );
      const resetsAt = normalizeResetTime(rec.reset_time ?? rec.resetTime ?? rec.resets_at);
      const prefix = shortGeminiGroup(groupName);
      const id = typeof rec.id === "string" && rec.id ? rec.id : `${prefix.toLowerCase()}-${win.tag}`;
      parsedGroup.push({
        order: win.order,
        bucket: {
          id,
          label: `${prefix} · ${win.tag}`,
          ...(win.window ? { window: win.window } : {}),
          remainingPercent: clampPercent(frac * 100),
          ...(resetsAt ? { resetsAt } : {}),
        },
      });
    }
    if (!parsedGroup.length) continue;
    // Skip secondary 3P groups when Gemini group exists and the 3P group is untouched (all 100%).
    if (hasGeminiGroup && !isGeminiGroup && parsedGroup.every((x) => x.bucket.remainingPercent >= 100)) {
      continue;
    }
    parsedGroup.sort((a, b) => a.order - b.order);
    buckets.push(...parsedGroup.map((x) => x.bucket));
  }

  if (!buckets.length) return undefined;
  const formattedPlan = formatPlanLabel(plan);
  return { ...(formattedPlan ? { plan: formattedPlan } : {}), buckets, fetchedAt };
}

/** Query the installed CLI for live subscription quota remaining without spending tokens. */
export async function probeSubscriptionQuota(
  agent: CliAgent,
  file: string,
  env: NodeJS.ProcessEnv,
): Promise<SubscriptionQuota | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), "scarlet-quota-"));
  try {
    if (agent === "gemini") {
      let stdout = "";
      const proc = spawnLines(file, ["-p", "/usage", "--output-format", "json"], {
        cwd,
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
        onLine(line) {
          stdout += line + "\n";
        },
      });
      const outcome = await proc.done;
      if (outcome.timedOut || outcome.code !== 0) return undefined;
      const trimmed = stdout.trim();
      if (!trimmed) return undefined;
      try {
        return parseGeminiQuota(JSON.parse(trimmed));
      } catch {
        // Fallback: parse the last JSON line if stdout had prefix warnings.
        for (const line of trimmed.split(/\r?\n/).reverse()) {
          try {
            const parsed = parseGeminiQuota(JSON.parse(line));
            if (parsed) return parsed;
          } catch { /* keep trying */ }
        }
        return undefined;
      }
    }

    if (agent === "claude") {
      let usagePayload: unknown;
      let done = false;
      const proc = spawnLines(
        file,
        ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"],
        {
          cwd,
          env,
          timeoutMs: PROBE_TIMEOUT_MS,
          interactive: true,
          onLine(line) {
            if (done) return;
            const rec = jsonLine(line);
            if (rec?.type !== "control_response") return;
            const resp = asRecord(rec.response);
            if (resp?.request_id !== "usage") return;
            done = true;
            if (resp.subtype !== "error") usagePayload = resp.response;
            proc.child.stdin?.end();
            proc.kill();
          },
        },
      );
      proc.child.stdin?.write(JSON.stringify({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }) + "\n");
      proc.child.stdin?.write(JSON.stringify({ type: "control_request", request_id: "usage", request: { subtype: "get_usage" } }) + "\n");
      proc.child.stdin?.end();
      await proc.done;
      return usagePayload ? parseClaudeQuota(usagePayload) : undefined;
    }

    // Codex (`codex app-server`): initialize -> initialized -> account/rateLimits/read + account/read
    let rateLimitsResult: unknown;
    let accountResult: unknown;
    let gotRateLimits = false;
    let gotAccount = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      proc.child.stdin?.end();
      proc.kill();
    };
    const proc = spawnLines(file, ["app-server"], {
      cwd,
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      interactive: true,
      onLine(line) {
        if (done) return;
        const rec = jsonLine(line);
        if (!rec) return;
        if (rec.id === 1) {
          if (rec.error) { finish(); return; }
          proc.child.stdin?.write(JSON.stringify({ method: "initialized" }) + "\n");
          proc.child.stdin?.write(JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} }) + "\n");
          proc.child.stdin?.write(JSON.stringify({ id: 3, method: "account/read", params: {} }) + "\n");
        } else if (rec.id === 2) {
          gotRateLimits = true;
          if (!rec.error) rateLimitsResult = rec.result;
          if (gotAccount) finish();
        } else if (rec.id === 3) {
          gotAccount = true;
          if (!rec.error) accountResult = rec.result;
          if (gotRateLimits) finish();
        }
      },
    });
    proc.child.stdin?.write(JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "scarlet", version: "0.1.4" }, capabilities: { experimentalApi: true } },
    }) + "\n");
    await proc.done;
    return rateLimitsResult ? parseCodexQuota(rateLimitsResult, accountResult) : undefined;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
