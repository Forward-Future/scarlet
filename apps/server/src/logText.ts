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
export function throttledLog(log: (line: string) => void, everyMs = 60_000) {
  const last = new Map<string, { at: number; more: number }>();
  return (key: string, line: string, now = Date.now()) => {
    const seen = last.get(key);
    if (seen && now - seen.at < everyMs) { seen.more++; return; }
    last.delete(key);
    last.set(key, { at: now, more: 0 });
    if (last.size > 200) last.delete(last.keys().next().value!);
    log(seen?.more ? `${line} (and ${seen.more} more like it)` : line);
  };
}

/** One line of a request or error for the log. */
export function clip(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
