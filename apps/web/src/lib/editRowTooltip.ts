import { clipRange, splitEditWords, type Change, type Clip, type MediaAsset, type Timeline, type TimeRange, type Transition } from "@scarlet/timeline";
import { REVISED_CHECK, type Thread, type ThreadEdit } from "@scarlet/shared";
import { editDetail } from "./editDetail";
import { editKindWord } from "./editKind";
import { lengthLabel, removedSeconds } from "./format";
import type { Revision } from "./passCalls";

export interface RowTooltipInfo {
  /** Primary heading (the full edit label or summary). */
  tip: string;
  /** Short plain-language summary line (edit kind, cut amount or key setting, and live status). */
  meta?: string;
  /** Optional quiet note underneath, only for actionable cues (review check, to-do ask, earlier revision, or extra moment edits). */
  detail?: string;
}

export interface RowTooltipContext {
  change?: Change;
  timeline?: Timeline | null;
  media?: readonly Pick<MediaAsset, "id" | "name">[];
  fps?: number;
  status?: string;
  /** The model at work on it now, while Scarlet adds or revises it ("B-roll · Gemini 3 Pro" when handed off). */
  by?: string;
  version?: number;
  places?: number;
}

type Op = Record<string, unknown>;
type EditLike = Omit<ThreadEdit, "at"> & { at?: number };

const SLACK = 0.5;
const TOUCH = 0.05;
const EXACT_MATCH_SLACK = 0.2;
const QUOTE_MOST = 64;
const SETTLED_OR_QUEUED_STATUS = new Set(["Kept", "Done", "Rejected", "Up next", "Queued"]);

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (value: number) => `${Math.round(value * 10) / 10} s`;
const quote = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? `“${flat.length > QUOTE_MOST ? `${flat.slice(0, QUOTE_MOST - 1).trimEnd()}…` : flat}”` : undefined;
};
const unquote = (text: string) => text.replace(/^[“"']|[”"']$/g, "").trim();
const friendlyGain = (volume: number) => {
  if (volume <= 0) return "muted";
  const db = Math.round(20 * Math.log10(volume));
  if (db === 0) return "at full volume";
  return db < 0 ? `quieter (−${Math.abs(db)} dB)` : `louder (+${db} dB)`;
};
const decibels = (db: number) => {
  const whole = Math.round(db);
  return whole === 0 ? "0 dB" : `${whole > 0 ? "+" : "−"}${Math.abs(whole)} dB`;
};
const levelWords = (keys: unknown, volume: number) => {
  if (!Array.isArray(keys)) return;
  const dbs = (keys as { time?: unknown; db?: unknown }[])
    .filter(k => typeof k?.db === "number" && typeof k.time === "number")
    .sort((a, b) => (a.time as number) - (b.time as number))
    .map(k => k.db as number);
  if (!dbs.length) return;
  const low = Math.min(...dbs), high = Math.max(...dbs);
  const down = low < 0 && -low >= high;
  const runs = dbs.filter((db, i) => (down ? db < 0 : db > 0) && !(i > 0 && (down ? dbs[i - 1]! < 0 : dbs[i - 1]! > 0))).length;
  const base = volume > 0 ? 20 * Math.log10(volume) : 0;
  if (!runs) return;
  return `${down ? "lowered" : "raised"} to ${decibels(base + (down ? low : high))}`;
};
const transitionWords = (t: Partial<Transition>) => {
  if (!t.type) return;
  const name = t.type[0]!.toUpperCase() + t.type.slice(1);
  const way = t.type === "push" || t.type === "slide" || t.type === "whip" ? ` ${t.direction ?? "left"}` : "";
  return typeof t.duration === "number" ? `${name}${way} transition · ${seconds(t.duration)}` : `${name}${way} transition`;
};
const speedWords = (rate: number) => {
  const clean = Math.round(rate * 100) / 100;
  if (clean > 1) return `${clean}× faster`;
  if (clean < 1) return `${clean}× slower`;
  return "Normal speed";
};
const zoomRangeWords = (from: number, to: number) => {
  const a = Math.round(from * 100);
  const b = Math.round(to * 100);
  if (a === 100 && b > 100) return `Zooms in to ${b}%`;
  if (b === 100 && a > 100) return `Zooms out to ${b}%`;
  return `Zooms ${a}% to ${b}%`;
};
const hasMeasurement = (text: string) => /(%|dB|×|\bframes?\b|\b\d+(?:\.\d+)?\s*s\b)/i.test(text);

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’‘]/g, "'").replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const distinct = (candidate: string | undefined, against: string): string | undefined => {
  const trimmed = candidate?.trim();
  if (!trimmed) return undefined;
  const n = norm(trimmed);
  if (!n) return undefined;
  const base = norm(against);
  if (base === n) return undefined;
  if (n.length >= 3 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(n)}(?:$|[^\\p{L}\\p{N}])`, "u").test(base)) {
    return undefined;
  }
  return trimmed;
};

/** Combine a live status word and active model into one clean phrase (e.g. "Revising with GPT-6.2-Sol"). */
function appendStatus(parts: string[], status?: string, by?: string) {
  const cleanStatus = status && status !== "Rejected" ? status : undefined;
  if (cleanStatus && by && cleanStatus.endsWith("…") && !by.includes(" · ")) {
    parts.push(`${cleanStatus.slice(0, -1)} with ${by}`);
    return;
  }
  if (cleanStatus) parts.push(cleanStatus);
  if (by) parts.push(by);
}

/**
 * Turn compact card detail strings from `editDetail` into simpler plain-English tooltip copy without clip filenames
 * that repeat the row title.
 */
function humanizeDetail(kind: EditLike["kind"], raw: string): string | undefined {
  // Keep only the first piece when an edit generated a long list of steps (e.g. many captions at once).
  const first = raw.split(" · ")[0]!.trim();
  if (!first) return undefined;

  if (kind === "text") return first;

  const opacity = /(?:^|\s+at\s+)(\d+% opacity)$/.exec(first);
  if (opacity) return opacity[1];

  if (kind === "zoom") {
    const move = /^Zooms (\d+)% → (\d+)%$/.exec(first);
    if (move) return zoomRangeWords(Number(move[1]) / 100, Number(move[2]) / 100);
    return first;
  }

  if (kind === "reframe") {
    const scale = /^Scales (\d+)% → (\d+)%$/.exec(first);
    if (scale) return `Scales to ${scale[2]}%`;
    return first;
  }

  if (kind === "speed") {
    const m = /^(\d+(?:\.\d+)?)× speed$/.exec(first);
    if (m) return speedWords(Number(m[1]));
    return first;
  }

  if (kind === "transition") {
    const m = /^(.+?),\s*(\d+(?:\.\d+)?\s*s)$/.exec(first);
    if (m) return `${m[1]} transition · ${m[2]}`;
    return /\btransition\b/i.test(first) ? first : `${first} transition`;
  }

  if (kind === "voice") {
    const mix = /\bat (\d+%)$/.exec(first);
    return mix ? `Voice cleanup (${mix[1]})` : "Voice cleanup";
  }

  if (kind === "overlay" || kind === "graphic" || kind === "broll") {
    if (first === "A colour card") return "Colour card";
    if (/^Fades (?:in|out) over /i.test(first)) return first.toLowerCase();
    // Omit raw clip/generated-asset names — the edit title already names what was added.
    return undefined;
  }

  if (kind === "audio" || kind === "dip") {
    const dipped = /^.+?\s+(down|up) to ([+−-]?\d+ dB)(?:\s+in \d+ places)?$/.exec(first);
    if (dipped) return `${dipped[1] === "down" ? "lowered" : "raised"} to ${dipped[2]}`;
    const added = /^Added .+,\s*([+−-]\d+ dB|muted|at full level)$/.exec(first);
    if (added) {
      if (added[1] === "muted") return "muted";
      if (added[1] === "at full level") return undefined;
      return `${added[1]!.startsWith("+") ? "louder" : "quieter"} (${added[1]})`;
    }
    if (/^Added /i.test(first)) return undefined;
    const leveled = /^.+?\s+([+−-]\d+ dB)$/.exec(first);
    if (leveled) return `${leveled[1]!.startsWith("+") ? "louder" : "quieter"} (${leveled[1]})`;
    if (/\bback to a steady level$/i.test(first)) return "back to a steady level";
    if (/^Sound fades (in|out) over /i.test(first)) return first.replace(/^Sound /i, "");
    if (/^(?:Sound )?muted$/i.test(first)) return "muted";
    if (/at full level$/i.test(first)) return "at full volume";
    if (/^(?:Muted|Unmuted) /i.test(first)) return first;
    return undefined;
  }

  return first;
}

/** Same settled-time rule as `editKind.ts`: where an op's start lands after later global ripple ops. */
function settled(time: number, later: Op[]): number {
  for (const op of later) {
    if (op.trackIds !== undefined) continue;
    if (op.op === "rippleDelete" && typeof op.start === "number" && typeof op.end === "number") {
      if (time > op.start) time -= Math.min(time, op.end) - op.start;
    } else if (op.op === "rippleInsertGap" && typeof op.at === "number" && typeof op.duration === "number") {
      if (time >= op.at) time += op.duration;
    }
  }
  return time;
}

/**
 * Find how many seconds of footage a cut edit removed, from `beforeCut` first, then from the change's own
 * applied joins, rippleDelete ops, leftOut joins, or cutReasons when `beforeCut` wasn't attached.
 */
export function cutRemovedSeconds(edit: EditLike, change?: Change): number | undefined {
  if (edit.beforeCut) {
    const dur = edit.beforeCut.removed.end - edit.beforeCut.removed.start;
    if (dur > 0) return dur;
  }
  if (!change) return undefined;
  const appliedJoin = change.appliedReview?.joins[edit.spot];
  if (appliedJoin && appliedJoin.removed.end > appliedJoin.removed.start) {
    return appliedJoin.removed.end - appliedJoin.removed.start;
  }
  const ops = (change.ops ?? []) as Op[];
  if (ops.length) {
    let globalRemoved = 0;
    let trackRemoved = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.op !== "rippleDelete" || typeof op.start !== "number" || typeof op.end !== "number" || op.end <= op.start) continue;
      const at = settled(op.start, ops.slice(i + 1));
      if (at >= edit.range.start - SLACK && at <= edit.range.end + SLACK) {
        if (op.trackIds === undefined) globalRemoved += op.end - op.start;
        else trackRemoved += op.end - op.start;
      }
    }
    if (globalRemoved > 0) return globalRemoved;
    if (trackRemoved > 0) return trackRemoved;
  }
  if (change.leftOut?.joins.length) {
    const sum = change.leftOut.joins
      .filter(j => j.at >= edit.range.start - SLACK && j.at <= edit.range.end + SLACK && j.removed.end > j.removed.start)
      .reduce((acc, j) => acc + (j.removed.end - j.removed.start), 0);
    if (sum > 0) return sum;
  }
  if (change.cutReasons?.length) {
    const title = (edit.reason && edit.summary) || edit.label;
    const matched = change.cutReasons.filter(r =>
      r.end > r.start && (r.summary === title || r.reason === edit.reason || r.reason === title),
    );
    if (matched.length === 1) return matched[0]!.end - matched[0]!.start;
    if (change.cutReasons.length === 1 && change.cutReasons[0]!.end > change.cutReasons[0]!.start) {
      return change.cutReasons[0]!.end - change.cutReasons[0]!.start;
    }
  }
  return undefined;
}

/** Find inserted duration (for `restore` / `insert` edits) from range or `rippleInsertGap` ops. */
function addedSeconds(edit: EditLike, change?: Change): number | undefined {
  const span = edit.range.end - edit.range.start;
  if (span >= TOUCH) return span;
  const ops = (change?.ops ?? []) as Op[];
  if (!ops.length) return undefined;
  let total = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.op !== "rippleInsertGap" || typeof op.at !== "number" || typeof op.duration !== "number" || op.duration <= 0) continue;
    const at = settled(op.at, ops.slice(i + 1));
    if (at >= edit.range.start - SLACK && at <= edit.range.end + SLACK) total += op.duration;
  }
  return total > 0 ? total : undefined;
}

/**
 * Fallback detail reader from the current timeline when a change has no granular `ops` (such as a full-timeline save)
 * or for reframe crop/pan transforms that `editDetail` leaves unspecified. Never includes raw media filenames.
 */
function timelineFallbackDetail(edit: EditLike, { timeline, fps }: RowTooltipContext): { kind?: EditLike["kind"]; detail?: string } {
  if (!timeline) return {};
  const rangeOf = (clip: Clip) => {
    try { return clipRange(clip); } catch { return undefined; }
  };
  const overlaps = (r: TimeRange | undefined) => !!r && r.start <= edit.range.end + SLACK && r.end >= edit.range.start - SLACK
    && (edit.range.end - edit.range.start <= TOUCH || r.end - r.start <= TOUCH
      || Math.min(r.end, edit.range.end) - Math.max(r.start, edit.range.start) > TOUCH);
  const exactMatch = (r: TimeRange | undefined) => !!r
    && Math.abs(r.start - edit.range.start) <= EXACT_MATCH_SLACK
    && Math.abs(r.end - edit.range.end) <= EXACT_MATCH_SLACK;

  const baseVideoId = timeline.tracks.find(t => t.kind === "video")?.id;
  const kind = edit.kind;

  if (kind === "text") {
    const quotes = timeline.tracks.flatMap(t => t.clips)
      .flatMap(c => {
        if (c.kind !== "caption" || !overlaps(rangeOf(c))) return [];
        const q = quote(c.text);
        return q ? [q] : [];
      });
    if (quotes.length) return { detail: quotes[0] };
  }

  if (kind === "audio" || kind === "dip") {
    for (const track of timeline.tracks) {
      if (track.kind !== "audio") continue;
      for (const clip of track.clips) {
        if (clip.kind !== "media" || !overlaps(rangeOf(clip))) continue;
        const moves = levelWords(clip.volumeKeyframes, clip.volume ?? 1);
        if (moves) return { detail: moves };
        if (typeof clip.volume === "number" && clip.volume !== 1) return { detail: friendlyGain(clip.volume) };
      }
    }
  }

  if (kind === "voice") {
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== "media" || !overlaps(rangeOf(clip))) continue;
        const cleanup = clip.effects?.find(e => e.type === "voiceCleanup" && e.enabled !== false);
        if (!cleanup) continue;
        const mix = (cleanup.params as { mix?: unknown } | undefined)?.mix;
        const mixWords = typeof mix === "number" && mix < 1 ? ` (${percent(Math.max(0, mix))})` : "";
        return { detail: `Voice cleanup${mixWords}` };
      }
    }
  }

  if (kind === "broll" || kind === "graphic" || kind === "overlay") {
    for (const track of timeline.tracks) {
      if (track.kind !== "video" || track.id === baseVideoId) continue;
      for (const clip of track.clips) {
        if (!overlaps(rangeOf(clip))) continue;
        if (clip.kind === "color") return { detail: "Colour card" };
        if (clip.kind === "media" && clip.opacity !== undefined && clip.opacity < 1) {
          return { detail: `${percent(clip.opacity)} opacity` };
        }
      }
    }
  }

  if (kind === "zoom" || kind === "reframe") {
    for (const track of timeline.tracks) {
      if (track.kind !== "video") continue;
      for (const clip of track.clips) {
        if (clip.kind !== "media" || !overlaps(rangeOf(clip))) continue;
        const kfs = (clip.keyframes ?? []).map(k => k.transform?.scale).filter((s): s is number => typeof s === "number");
        if (kfs.length > 1 && kfs[0] !== kfs.at(-1)) {
          if (kind === "zoom" && kfs.some(s => s > 1.001)) return { detail: zoomRangeWords(kfs[0]!, kfs.at(-1)!) };
          if (kind === "reframe" && kfs.every(s => s <= 1.001)) return { detail: `Scales to ${percent(kfs.at(-1)!)}` };
        }
        const tr = clip.transform;
        if (tr) {
          if (kind === "zoom" && typeof tr.scale === "number" && tr.scale > 1.001) return { detail: `Zoom to ${percent(tr.scale)}` };
          if (kind === "reframe") {
            if (typeof tr.scale === "number" && tr.scale < 0.999) return { detail: `Inset at ${percent(tr.scale)}` };
            const cropped = (tr.cropLeft ?? 0) > 0 || (tr.cropRight ?? 0) > 0 || (tr.cropTop ?? 0) > 0 || (tr.cropBottom ?? 0) > 0;
            const moved = Math.abs(tr.x ?? 0) > 0.005 || Math.abs(tr.y ?? 0) > 0.005;
            if (cropped && moved) return { detail: "Cropped & repositioned" };
            if (cropped) return { detail: "Cropped" };
            if (moved) return { detail: "Repositioned" };
          }
        }
      }
    }
  }

  if (kind === "speed") {
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === "media" && overlaps(rangeOf(clip)) && typeof clip.speed === "number" && Math.abs(clip.speed - 1) > 0.01) {
          return { detail: speedWords(clip.speed) };
        }
      }
    }
  }

  if (kind === "transition") {
    for (const track of timeline.tracks) {
      if (track.kind !== "video") continue;
      for (const clip of track.clips) {
        if (clip.kind === "media" && clip.transitionIn && Math.abs(clip.timelineIn - edit.range.start) <= SLACK) {
          const words = transitionWords(clip.transitionIn);
          if (words) return { detail: words };
        }
      }
    }
  }

  if (kind === "split") {
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === "media" && clip.splitEdit && overlaps(rangeOf(clip))) {
          const words = splitEditWords(clip.splitEdit, fps);
          if (words.length) return { detail: words[0] };
        }
      }
    }
  }

  // For unclassified ("other" / undefined) edits from full-timeline saves, check for an exact clip match on
  // caption, audio, or overlay tracks so the hover still surfaces its real kind and setting.
  if (!kind || kind === "other") {
    for (const track of timeline.tracks) {
      if (track.kind === "caption") {
        const hit = track.clips.find(c => c.kind === "caption" && exactMatch(rangeOf(c)));
        if (hit && hit.kind === "caption") {
          const q = quote(hit.text);
          if (q) return { kind: "text", detail: q };
        }
      } else if (track.kind === "audio") {
        const hit = track.clips.find(c => c.kind === "media" && exactMatch(rangeOf(c)));
        if (hit && hit.kind === "media") {
          const moves = levelWords(hit.volumeKeyframes, hit.volume ?? 1);
          const detail = moves ?? (typeof hit.volume === "number" && hit.volume !== 1 ? friendlyGain(hit.volume) : undefined);
          return { kind: "audio", ...(detail && { detail }) };
        }
      } else if (track.kind === "video" && track.id !== baseVideoId) {
        const hit = track.clips.find(c => exactMatch(rangeOf(c)));
        if (hit) {
          const detail = hit.kind === "color" ? "Colour card"
            : hit.kind === "media" && hit.opacity !== undefined && hit.opacity < 1 ? `${percent(hit.opacity)} opacity` : undefined;
          return { kind: "overlay", ...(detail && { detail }) };
        }
      }
    }
  }

  return {};
}

/** True when `detail` already opens with or directly states `kindWord`, so prefixing `kindWord` would stutter. */
function detailStatesKind(kindWord: string, detail: string): boolean {
  const k = kindWord.toLowerCase();
  const d = detail.toLowerCase();
  if (d.startsWith(k)) return true;
  if (k === "zoom" && /^zooms?\b/.test(d)) return true;
  if (k === "speed" && /\b(faster|slower|speed)$/.test(d)) return true;
  if (k === "transition" && /\btransition\b/.test(d)) return true;
  if (k === "reframe" && /^(inset|scales?|cropped|repositioned)\b/.test(d)) return true;
  return false;
}

/** Find the Change object that created `edit` inside a thread's changes or flagged changes. */
export function changeForEdit(thread: Pick<Thread, "changes" | "flagged"> | undefined, changeId: string): Change | undefined {
  if (!thread) return undefined;
  return thread.changes.find(c => c.id === changeId) ?? thread.flagged?.find(c => c.id === changeId);
}

/**
 * Build plain, easy-to-scan hover tooltip content (title + one compact summary line + optional actionable cue)
 * for an edit row. Omits clip filenames and editorial rationale already shown in the title or on the edit card.
 */
export function editRowTooltip(edit: EditLike, ctx: RowTooltipContext = {}): RowTooltipInfo {
  const title = (edit.reason && edit.summary) || edit.label;
  const isCut = !!edit.beforeCut || edit.kind === "cut";
  const span = Math.max(0, edit.range.end - edit.range.start);
  const hasSpan = span >= TOUCH;
  const parts: string[] = [];

  if (isCut) {
    parts.push(edit.rejected ? "Rejected cut" : "Cut");
    const removed = cutRemovedSeconds(edit, ctx.change);
    if (removed !== undefined) parts.push(removedSeconds(removed));
    else if (edit.rejected && hasSpan) parts.push(lengthLabel(span));
  } else if (edit.marker) {
    parts.push("To do");
  } else if (edit.onlyCheck) {
    parts.push("Needs a look");
  } else if (edit.kind === "restore") {
    parts.push(edit.rejected ? "Rejected put back" : "Put back");
    const added = addedSeconds(edit, ctx.change);
    if (added !== undefined) parts.push(`+${lengthLabel(added)}`);
  } else if (edit.kind === "insert") {
    if (edit.rejected) parts.push("Rejected");
    parts.push("Insert");
    const added = addedSeconds(edit, ctx.change);
    if (added !== undefined) parts.push(`+${lengthLabel(added)}`);
  } else {
    if (edit.rejected) parts.push("Rejected");
    const detailEdit = edit.kind === "broll" ? { ...edit, kind: "overlay" as const } : edit;
    const rawDetail = editDetail(ctx.change, detailEdit, { timeline: ctx.timeline, media: ctx.media ?? [], fps: ctx.fps });
    const fallback = rawDetail ? {} : timelineFallbackDetail(edit, ctx);
    const effectiveKind = (edit.kind && edit.kind !== "other" ? edit.kind : undefined) ?? fallback.kind;
    const detailText = rawDetail ? humanizeDetail(effectiveKind, rawDetail) : fallback.detail;
    const kindWord = editKindWord(edit) ?? (fallback.kind ? editKindWord({ kind: fallback.kind }) : undefined);

    if (effectiveKind === "text") {
      const freshQuote = detailText && distinct(unquote(detailText), title) ? detailText : undefined;
      parts.push(freshQuote ? `Caption: ${freshQuote}` : "Caption");
      if (hasSpan) parts.push(lengthLabel(span));
    } else if (detailText) {
      if (kindWord && !detailStatesKind(kindWord, detailText)) parts.push(kindWord);
      parts.push(detailText);
      const showSpanWithDetail = effectiveKind === "broll" || effectiveKind === "graphic" || effectiveKind === "overlay"
        || (effectiveKind !== "transition" && effectiveKind !== "split" && !hasMeasurement(detailText));
      if (hasSpan && showSpanWithDetail) parts.push(lengthLabel(span));
    } else if (kindWord) {
      parts.push(kindWord);
      if (hasSpan && effectiveKind !== "transition") parts.push(lengthLabel(span));
    } else if (hasSpan) {
      parts.push(`Lasts ${lengthLabel(span)}`);
    }
  }

  if (ctx.places && ctx.places > 1) parts.push(`in ${ctx.places} places`);
  appendStatus(parts, ctx.status, ctx.by);

  // Quiet detail line underneath: only actionable cues (review check when waiting on the editor, or to-do ask).
  // Scarlet's general rationale (`edit.reason`) lives on the edit card when opened and is not repeated on hover.
  const isWaiting = !edit.rejected && (!ctx.status || (!SETTLED_OR_QUEUED_STATUS.has(ctx.status) && !ctx.status.endsWith("…")));
  const waitingCheck = isWaiting && edit.check && edit.check !== REVISED_CHECK
    ? (edit.reviewSays || edit.check) : undefined;
  const detail = distinct(waitingCheck, title)
    ?? distinct(edit.marker ? edit.todo : undefined, title);

  return {
    tip: title,
    ...(parts.length > 0 && { meta: parts.join(" · ") }),
    ...(detail && { detail }),
  };
}

/** Build plain, easy-to-scan hover tooltip content for a staged dialogue pass call. */
export function callRowTooltip(call: {
  summary: string;
  reason?: string;
  tag: string;
  length?: number;
  state: "approved" | "skipped" | "open" | "revising";
  version: number;
  earlier?: Revision;
  word?: string;
  by?: string;
}): RowTooltipInfo {
  const isCutProposal = call.tag === "Cut" || call.tag.startsWith("−");
  const parts: string[] = [];
  if (isCutProposal) {
    parts.push("Cut");
    if (call.length && call.length > 0) parts.push(removedSeconds(call.length));
    else if (call.tag.startsWith("−")) parts.push(call.tag);
  } else {
    parts.push("Keep");
    if (call.length && call.length > 0) parts.push(lengthLabel(call.length));
  }
  if (call.state === "approved") parts.push("Kept");
  else if (call.state === "skipped") parts.push("Rejected");
  else appendStatus(parts, call.word, call.by);

  const earlierNote = call.earlier
    ? `Earlier: ${call.earlier.reason ?? "Scarlet’s earlier version."}${call.earlier.note ? `\nYou: “${call.earlier.note}”` : ""}`
    : undefined;
  const detail = earlierNote ?? (call.state === "open" ? distinct(call.reason, call.summary) : undefined);

  return {
    tip: call.summary,
    meta: parts.join(" · "),
    ...(detail && { detail }),
  };
}

/** Build plain, easy-to-scan hover tooltip content for a pass call decided before the pass applied. */
export function decidedCallRowTooltip(call: { label: string; note?: string; length?: number; approved: boolean }): RowTooltipInfo {
  const parts = [call.approved ? "Kept cut" : "Rejected cut"];
  if (call.length && call.length > 0) parts.push(lengthLabel(call.length));
  return {
    tip: call.label,
    meta: parts.join(" · "),
  };
}

/** Build plain, easy-to-scan hover tooltip content for a moment (multiple overlapping edits on one row). */
export function momentRowTooltip(
  mainLabel: string,
  members: readonly { label: string; value?: string; kind?: string }[],
  _range?: TimeRange,
  status?: string,
): RowTooltipInfo {
  const parts = [`${members.length} edits`];
  const tags = [...new Set(members.map(m => m.value || m.kind).filter((v): v is string => !!v && v !== "Edit"))];
  if (tags.length) parts.push(tags.slice(0, 3).join(", "));
  if (status) parts.push(status);
  // List only additional edits in this moment so the main title isn't repeated verbatim.
  const otherLines = members.length > 1
    ? members.map(m => m.label).filter((label): label is string => !!distinct(label, mainLabel))
    : [];
  const detail = otherLines.length > 0 ? otherLines.join("\n") : undefined;
  return {
    tip: mainLabel,
    meta: parts.join(" · "),
    ...(detail && { detail }),
  };
}
