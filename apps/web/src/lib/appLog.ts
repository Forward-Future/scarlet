/**
 * The window's side of the app log. Each line is `[tag] HH:MM:SS.mmm +gap event name=value …` (UTC, to the
 * millisecond; the gap is since that tag's last line) and lands in the desktop log as its own `[ui]` record, in order with the
 * engine's and the desktop's own lines. Tags: `app` (the session), `nav`, `action` (what the editor pressed), `api`,
 * `realtime`, `playback`, `window`, `error`.
 * Nothing is written per frame, a burst is capped per tag, and no typed text, token or query value is logged.
 */
import { desktop } from "./desktop";

export type LogFields = Record<string, unknown>;
export type LogLevel = "info" | "warn" | "error";
type Write = (lines: string[], level: LogLevel) => void;

let write: Write | undefined;
let pending: { key?: string; text: string; count: number }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
// A token bucket per tag: a busy second still gets logged, a runaway loop doesn't fill the file, and one noisy
// tag can't crowd out the others.
const BURST = 160, PER_SECOND = 40;
const buckets = new Map<string, { tokens: number; at: number; last: number; dropped: number }>();

const round = (n: number) => Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(n);
function show(value: unknown): string {
  if (typeof value === "number") return round(value);
  if (typeof value === "string") return /[\s="]/.test(value) || !value ? JSON.stringify(value) : value;
  if (Array.isArray(value)) return `[${value.map(show).join(",")}]`;
  if (value && typeof value === "object") return JSON.stringify(value, (_k, v) => typeof v === "number" ? Number(round(v)) : v);
  return String(value);
}

function flush() {
  clearTimeout(timer);
  timer = undefined;
  const lines = pending.map(p => p.count > 1 ? `${p.text} x${p.count}` : p.text);
  pending = [];
  if (lines.length) write?.(lines, "info");
}

/**
 * One line: the event and its fields. `key` marks a line that repeats in bursts (a scrub's seeks, a run's events):
 * while the same key is the latest line waiting to be written, the new one replaces it and the line ends in a count.
 * A warning or an error is written at once, at that level, so it can be found by level in the log.
 */
export function appLog(tag: string, event: string, fields?: LogFields, { key, level = "info" }: { key?: string; level?: LogLevel } = {}) {
  if (!write) return;
  const now = performance.now();
  let bucket = buckets.get(tag);
  if (!bucket) buckets.set(tag, bucket = { tokens: BURST, at: now, last: now, dropped: 0 });
  bucket.tokens = Math.min(BURST, bucket.tokens + (now - bucket.at) / 1000 * PER_SECOND);
  bucket.at = now;
  const last = pending.at(-1);
  const repeat = level === "info" && key !== undefined && last?.key === `${tag}/${key}`;
  if (!repeat) {
    if (bucket.tokens < 1) { bucket.dropped++; return; }
    bucket.tokens--;
  }
  const parts = [`[${tag}] ${new Date().toISOString().slice(11, 23)} +${Math.round(now - bucket.last)}ms ${event}`];
  bucket.last = now;
  for (const [name, value] of Object.entries(fields ?? {})) if (value !== undefined) parts.push(`${name}=${show(value)}`);
  if (bucket.dropped && !repeat) { parts.push(`unlogged=${bucket.dropped}`); bucket.dropped = 0; }
  const text = parts.join(" ");
  if (repeat) { last.text = text; last.count++; return; }
  if (level !== "info") {
    flush();
    write([text], level);
    return;
  }
  pending.push({ key: key === undefined ? undefined : `${tag}/${key}`, text, count: 1 });
  timer ??= setTimeout(flush, 250);
}

export const appLogging = () => !!write;

/** Start writing. Until then every log call is a no-op, so tests and a plain browser stay quiet. */
export function startAppLog(to: Write = (lines, level) => { void desktop.log(lines, level); }) {
  if (write) stopAppLog();
  write = to;
}

export function stopAppLog() {
  if (!write) return;
  flush();
  write = undefined;
  buckets.clear();
}

/**
 * Who asked: the nearest callers of the function that calls this, as `function@file:line:col`. In a release build
 * the names are minified, and the line and column still point into that build's bundle. A caller that returns the
 * call directly leaves no frame in WebKit, so this can come back empty.
 */
export function calledBy(depth = 3) {
  if (!write) return undefined;
  const frames = (new Error().stack ?? "").split("\n").map(line => line.trim().replace(/^at /, ""))
    .filter(line => /:\d+:\d+\)?$/.test(line)).slice(2)
    .filter(line => !/\/lib\/(player|playbackLog|appLog)\.ts/.test(line) && !/node_modules|\/chunk-|react-dom/.test(line));
  return frames.slice(0, depth).map(line => line.replace(/\(?[a-z-]+:\/\/[^/]+\//, "").replace(/\?[^:)]*/, "").replace(/\)$/, "")).join(" < ") || undefined;
}

const ids = new WeakMap<object, string>();
let nextId = 1;
/** A short name for one element or stream, the same on every line about it. */
export function logId(of: object, prefix = "v") {
  let id = ids.get(of);
  if (!id) ids.set(of, id = `${prefix}${nextId++}`);
  return id;
}

/** Text someone else wrote (an error, an alert) without the addresses in it: a sign-in page or a file's link carries a token or a path. */
export const withoutAddresses = (text: string) => text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "…");

/** A URL as its path, with the names of its query fields and none of their values: a token never reaches the log. */
export function logPath(url: string | URL) {
  try {
    const parsed = new URL(String(url), typeof location === "undefined" ? "http://x" : location.href);
    const names = [...new Set(parsed.searchParams.keys())];
    return parsed.pathname + (names.length ? `?${names.join("&")}` : "");
  } catch { return "?"; }
}
