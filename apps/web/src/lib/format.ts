import { AGENT_LABEL } from "@scarlet/shared";
import { clock, formatTimecode } from "@scarlet/timeline";
import type { Author } from "@scarlet/timeline";

/** Timecode via @scarlet/timeline; never hand-roll this. */
export function tc(seconds: number, fps: number): string {
  return formatTimecode(seconds, fps);
}

export function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${r.toString().padStart(2, "0")}s` : `${r}s`;
}

export function relTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 45) return "just now";
  // Whole units that have passed, so the minutes never reach 60 nor the hours 24.
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/**
 * A project in the Trash, in one wording wherever the Trash is listed: "Deleted 1h ago · gone for good in 20 days".
 * Without the day it goes (an older engine's storage list) only the first half is said.
 */
export function trashedLine(deletedAt: string, purgeAt?: string): string {
  if (!purgeAt) return `Deleted ${relTime(deletedAt)}`;
  const days = Math.max(0, Math.ceil((Date.parse(purgeAt) - Date.now()) / 86_400_000));
  // A project past its date waits for the next sweep: "in 0 days" reads as a mistake.
  return `Deleted ${relTime(deletedAt)} · gone for good ${days === 0 ? "today" : `in ${plural(days, "day")}`}`;
}

export function absTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  const last = parts[parts.length - 1];
  if (parts.length === 1 || !last) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  // The unit is picked from the rounded figure, so a size just under the next unit reads "1.0 MB", not "1024 KB".
  const kb = (n / 1024).toFixed(0);
  if (Number(kb) < 1024) return `${kb} KB`;
  const mb = (n / 1024 ** 2).toFixed(1);
  if (Number(mb) < 1024) return `${mb} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A token count at a glance: 850 tokens, 48.2K tokens, 312K tokens, 1.2M tokens. */
export function tokenLabel(n: number): string {
  if (n === 1) return "1 token";
  if (n < 1000) return `${n} tokens`;
  const [value, unit] = n < 999_500 ? [n / 1000, "K"] : [n / 1_000_000, "M"];
  const shown = value >= 100 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${shown}${unit} tokens`;
}

/** Every part of a token total, for a tooltip or an accessible label. */
export function tokenBreakdown(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; runs?: number }): string {
  const parts = [
    `${u.inputTokens.toLocaleString()} input`,
    `${u.outputTokens.toLocaleString()} output`,
    u.cacheReadTokens ? `${u.cacheReadTokens.toLocaleString()} cache read` : "",
    u.cacheWriteTokens ? `${u.cacheWriteTokens.toLocaleString()} cache write` : "",
    u.runs && u.runs > 1 ? `${u.runs} runs` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Who made something, by the name the interface uses. The engine records an agent by its id ("claude"), so the name
 * comes from the id. The model isn't named: what is recorded is an alias ("opus") that a newer model takes over.
 */
export function authorLabel(a: Author): string {
  if (a.type === "agent") return (AGENT_LABEL as Record<string, string>)[a.id ?? ""] ?? a.name;
  if (a.type === "scarlet") return "Scarlet";
  return a.name;
}

export function pct(p: number): string {
  return `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/**
 * Where something is in the video, for people: 0:05, 1:02:07. One form everywhere a position is read: the player,
 * tags, lists and the transcript. `playbackClock` is the exact time, for where the editor places something to the
 * frame: the timeline's playhead and the note under the pointer, and Export's range.
 */
export { clock };

/**
 * A stretch of the video on the clock, from where it starts to where it ends: "0:04 – 0:06". With both ends in the
 * same second the clock alone would say one time twice, so each then carries its tenth: "0:04.2 – 0:04.8".
 */
export function clockRange(start: number, end: number): string {
  if (clock(start) !== clock(end)) return `${clock(start)} – ${clock(end)}`;
  // Cut to the tenth, as the clock is cut to the second, so neither end reads as the next second.
  const tenth = (seconds: number) => `${clock(seconds)}.${Math.floor((Math.max(0, seconds) + 1e-6) * 10) % 10}`;
  return `${tenth(start)} – ${tenth(end)}`;
}

/**
 * A length as people read it: "0.4 s", "12 s", "3:41" from a minute up, and "1:12:15" from an hour, as a clock reads
 * it. One form everywhere a length shows: a cut's row, its mark, the band on the timeline, the sentence that counts
 * the cuts, and a run's steps and summary.
 */
export function lengthLabel(seconds: number): string {
  // Up to what rounds to 59 s. The half second below a minute carries to 1:00 instead of reading "60 s".
  if (seconds < 59.5) {
    // Rounded before the form is picked, so 9.97 reads "10" and not "10.0".
    const tenths = Math.round(seconds * 10) / 10;
    return `${tenths < 10 ? tenths.toFixed(1) : Math.round(seconds)} s`;
  }
  // Round once, so 119.6 s carries to 2:00 instead of reading 1:60, and 3599.7 s to 1:00:00 instead of 60:00.
  return clock(Math.round(seconds));
}

/** How much a cut took out: "−0.4 s", "−12 s", "−3:41". */
export function removedSeconds(seconds: number): string {
  return `−${lengthLabel(seconds)}`;
}

/** Playback position with millisecond precision. Round once so carries reach the clock. */
export function playbackClock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${clock(Math.floor(ms / 1000))}.${String(ms % 1000).padStart(3, "0")}`;
}
