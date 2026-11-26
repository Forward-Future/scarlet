import { randomUUID } from "node:crypto";
import { cutText } from "@scarlet/shared";

/** Elapsed time for log lines: "850ms", "12s", "45m 2s", "1h 3m". Matches the desktop host's log. */
export function humanDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs <= 0) return `${Math.max(0, Math.round(ms))}ms`;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Time since an ISO timestamp, for log lines. Empty when it is missing or unreadable. */
export function since(iso: string | null | undefined, now = Date.now()): string {
  const start = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(start) ? humanDuration(now - start) : "";
}

/**
 * For a failure that can repeat on every call, such as one the window polls into: one line a minute for each key,
 * with a count of the ones in between.
 */
export function throttledLog(log: (line: string) => void, everyMs = 60_000, capacity = 200) {
  const last = new Map<string, { at: number; more: number }>();
  return (key: string, line: string, now = Date.now()) => {
    const seen = last.get(key);
    if (seen && now - seen.at < everyMs) { seen.more++; return; }
    last.delete(key);
    last.set(key, { at: now, more: 0 });
    // Keys are in the order they were last logged: expired ones go first, and a live key only when the map is still
    // over capacity, so many keys at once don't defeat the throttle.
    for (const [old, entry] of last) {
      if (last.size <= capacity && now - entry.at < everyMs) break;
      last.delete(old);
    }
    log(seen?.more ? `${line} (and ${seen.more} more like it)` : line);
  };
}

/** One line of a request or error for the log. */
export function clip(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${cutText(line, max - 1)}…` : line;
}
export const REQUEST_ID_HEADER = "x-scarlet-request-id";
const requestIds = new WeakMap<Request, string>();

export function requestLogId(request: Request): string {
  const claimed = request.headers.get(REQUEST_ID_HEADER);
  if (claimed && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(claimed)) return claimed;
  let id = requestIds.get(request);
  if (!id) requestIds.set(request, id = randomUUID());
  return id;
}

/** Only opaque engine-generated identifiers belong in shareable diagnostics. */
export function logId(id: string): string {
  return /^(?:(?:tsk|med|prj|rnd|chg|host)_[a-z0-9]{12}|chg_[a-f0-9]{64}_(?:applied|review))$/.test(id) ? id : "unknown";
}

/** A `throttledLog` for each engine context, made on first use: `const failures = throttledPerCtx(); failures(ctx)(key, line)`. */
export function throttledPerCtx() {
  const logs = new WeakMap<object, ReturnType<typeof throttledLog>>();
  return (ctx: { log(line: string): void }) => {
    let log = logs.get(ctx);
    if (!log) logs.set(ctx, log = throttledLog(line => ctx.log(line)));
    return log;
  };
}
