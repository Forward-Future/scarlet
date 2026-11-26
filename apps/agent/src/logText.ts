/** Small helpers for the host's log lines, as the engine has them (apps/server/src/logText.ts). */
import { cutText } from "@scarlet/shared";

/** Elapsed time for log lines: "850ms", "12s", "45m 2s", "1h 3m". Matches the desktop host. */
export function humanDuration(ms: number): string {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs === 0) return `${Math.max(0, Math.round(ms))}ms`;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * For a failure that can repeat on every call, such as a quota probe after every run: one line a minute for each key,
 * with a count of the ones in between.
 */
export function throttledLog(log: (line: string) => void, everyMs = 60_000, capacity = 200) {
  const last = new Map<string, { at: number; more: number }>();
  return (key: string, line: string, now = Date.now()) => {
    const seen = last.get(key);
    if (seen && now - seen.at < everyMs) { seen.more++; return; }
    last.delete(key);
    last.set(key, { at: now, more: 0 });
    for (const [old, entry] of last) {
      if (last.size <= capacity && now - entry.at < everyMs) break;
      last.delete(old);
    }
    log(seen?.more ? `${line} (and ${seen.more} more like it)` : line);
  };
}

/** One line of an error for the log. */
export function clip(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${cutText(line, max - 1)}…` : line;
}

/** The last few lines a CLI wrote on stderr, on one line, as the desktop host logs them (`stderr_tail_line`). */
export function stderrTail(stderr: string, max = 800): string | undefined {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const tail = lines.slice(-5).join(" | ");
  return tail.length > max ? `…${tail.slice(-max)}` : tail;
}

/**
 * The flags of a CLI's command line, by name only and once each: what it was launched with, without a value (a
 * session id, a config value, a path) or anything else on the line.
 */
export function flagNames(args: readonly string[]): string {
  const names = new Set<string>();
  for (const arg of args) {
    const m = /^(--?[a-zA-Z][\w-]*)/.exec(arg);
    if (m) names.add(m[1]!);
  }
  return [...names].join(",");
}
