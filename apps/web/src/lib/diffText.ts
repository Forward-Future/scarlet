/**
 * Render a TimelineDiff as a readable list. Wording mirrors
 * @scarlet/timeline's describeDiff so what the agent wrote in a change
 * description and what the UI shows under "View diff" read the same.
 */
import type { Clip, TimelineDiff } from "@scarlet/timeline";
import { describeDiff } from "@scarlet/timeline";

export type DiffLineKind = "added" | "removed" | "modified" | "moved" | "track" | "markers" | "duration";

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Per-field before → after values for modified clips. */
  fields?: FieldChange[];
  /** Timeline time to jump to, when meaningful. */
  at?: number;
}

function fmtValue(v: unknown): string {
  if (v === undefined) return "–";
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    return `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
  }
  return String(v);
}

export function fieldChanges(before: Clip, after: Clip, fields: string[]): FieldChange[] {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  return fields.map((field) => ({ field, before: fmtValue(a[field]), after: fmtValue(b[field]) }));
}

/**
 * describeDiff emits one line per clip diff, then one per track diff, then
 * "Markers changed" and a duration line. We walk the same order so each line
 * can be tagged with a kind and enriched with field values.
 */
export function diffLines(d: TimelineDiff, fmt: (s: number) => string): DiffLine[] {
  const texts = describeDiff(d, fmt);
  const out: DiffLine[] = [];
  let i = 0;
  for (const c of d.clips) {
    const text = texts[i++] ?? "";
    switch (c.type) {
      case "added":
        out.push({ kind: "added", text, at: c.clip.timelineIn });
        break;
      case "removed":
        out.push({ kind: "removed", text, at: c.clip.timelineIn });
        break;
      case "modified":
        out.push({ kind: "modified", text, fields: fieldChanges(c.before, c.after, c.fields), at: c.after.timelineIn });
        break;
      case "movedTrack":
        out.push({ kind: "moved", text, at: c.after.timelineIn });
        break;
    }
  }
  for (let k = 0; k < d.tracks.length; k++) out.push({ kind: "track", text: texts[i++] ?? "" });
  if (d.markersChanged) out.push({ kind: "markers", text: texts[i++] ?? "" });
  if (d.durationBefore !== d.durationAfter) out.push({ kind: "duration", text: texts[i++] ?? "" });
  return out;
}

/** Short summary chip text, e.g. "2 added · 1 removed · 3 changed". */
export function diffSummary(d: TimelineDiff): string {
  const n = { added: 0, removed: 0, modified: 0, moved: 0 };
  for (const c of d.clips) {
    if (c.type === "added") n.added++;
    else if (c.type === "removed") n.removed++;
    else if (c.type === "modified") n.modified++;
    else n.moved++;
  }
  const parts: string[] = [];
  if (n.added) parts.push(`${n.added} added`);
  if (n.removed) parts.push(`${n.removed} removed`);
  if (n.modified) parts.push(`${n.modified} changed`);
  if (n.moved) parts.push(`${n.moved} moved`);
  if (d.tracks.length) parts.push(`${d.tracks.length} track${d.tracks.length === 1 ? "" : "s"}`);
  if (d.durationBefore !== d.durationAfter) {
    const delta = d.durationAfter - d.durationBefore;
    parts.push(`${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}s`);
  }
  return parts.length ? parts.join(" · ") : "No clip changes";
}
