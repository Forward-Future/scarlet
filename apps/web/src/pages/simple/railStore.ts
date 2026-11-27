import { BROLL_CONTIGUOUS_GAP, matchesEdit, stretchesContiguous, type BatchSummaryItem, type EditKind, type EditRef, type ThreadEdit } from "@scarlet/shared";
import { cutKindOfRow, cutSummary, type TimeRange } from "@scarlet/timeline";
import { createContext, useContext, useSyncExternalStore } from "react";
import { editKey } from "../../lib/editMoments";
import { lengthLabel, removedSeconds as formatRemovedSeconds } from "../../lib/format";
import { ReviewLinger, type HeldFrom, type RowPlace } from "./beta/reviewTabsBeta";
import type { HoveredReviewRow, Nest } from "./types";

/** How long a row that just finished lingering stays flagged as freshly arrived in Working or Done for its glide-in animation. */
export const ARRIVE_MS = 320;

/** The lists of the column of edits: what waits on the editor, the edits Scarlet didn't flag (Low risk), what is with Scarlet, what is decided. */
export type RailSection = "you" | "low" | "working" | "done";

/** One applied edit backing a rail row (a combined cross-request row holds one or more members across threads). */
export interface RailEditMember {
  threadId: string;
  edit: Omit<ThreadEdit, "at">;
  canUnkeep: boolean;
}

/** One individual edit under an unfolded pass moment row. */
export interface RailSubRow {
  key: string;
  label: string;
  title?: string;
  tipMeta?: string;
  tipDetail?: string;
  value?: string;
  word?: string;
  decided: boolean;
  needs: boolean;
  asks: boolean;
  busy: boolean;
  revised: boolean;
  version: number;
  spent?: string;
  on: boolean;
  mark?: number;
  hover?: HoveredReviewRow;
  open?: () => void;
  unkeep?: () => void;
  unkeepTip?: string;
  nests?: readonly Nest[];
}

/** One row reported by a single request thread to the unified beta edits column. */
export interface RailRow {
  /** Unique within its thread (e.g. `editKey(e)` or `call/${n}`). */
  key: string;
  /** Earlier row keys within this thread that this row replaced (e.g. previous versions or rejected edits). */
  was?: readonly string[];
  threadId: string;
  /** Chronological index of the request thread (oldest = 0, newest = N - 1). */
  threadOrder: number;
  /** Sort timestamp on the working cut. */
  at: number;
  /** Displayed clock timestamp (e.g. reviewRange.start while flagged and waiting, else `at`). */
  displayAt: number;
  /** Where its marker lights on the timeline while hovering. */
  mark?: number;
  hover?: HoveredReviewRow;
  /** Which list this thread places the row in before cross-request combining. */
  place: RowPlace;
  /** Displayed row words. */
  label: string;
  /** Raw edit label (`edit.label`) for cross-request matching when `reason && summary` overrides `label`. */
  rawLabel?: string;
  /** Specific edit kind (`edit.kind`) for cross-request compatibility. */
  editKind?: EditKind;
  /** Working-cut timeline stretch for cross-request matching. */
  stretch?: TimeRange;
  /** All clip IDs touched by this edit's ops, and subset on overlay/caption tracks above the base video track. */
  clipIds?: readonly string[];
  overlayClipIds?: readonly string[];
  /** Continuous B-roll section ID on the current timeline (`null` when checked and no active B-roll plays here). */
  brollSectionId?: string | null;
  /** Full timeline range of the active continuous B-roll section, when known from the timeline. */
  brollSectionRange?: TimeRange;
  /** True when multiple contiguous B-roll edits combined into one continuous section row. */
  continuousBroll?: boolean;
  /** Whether this row can combine across requests with another edit touching the same clip or exact stretch. */
  combinable?: boolean;
  /** Trailing value text ("−1.2 s", "Graphic", "Kept", "Rejected", "Check"); undefined when hidden generic "Edit". */
  value?: string;
  /** Trailing status word ("Revising…", "Up next", "Queued", "Needs your answer", "Revised"). */
  word?: string;
  /** Decision label shown in Done ("Kept", "Done", "Rejected"). */
  decision?: string;
  needs: boolean;
  asks: boolean;
  isAskingCurrent: boolean;
  pending: boolean;
  busy: boolean;
  revised: boolean;
  decided: boolean;
  rejected: boolean;
  skipped: boolean;
  /** Whether this row counts toward the amber Needs review badge. */
  countsAsNeed: boolean;
  /** Whether a nested request under this row waits on the editor (stopped early or asking). */
  hasNeedNest: boolean;
  isCall?: boolean;
  /** True when this row belongs to a dialogue pass (used to name cut batches "N Dialogue Cuts"). */
  isDialoguePass?: boolean;
  /** AI-authored group title saved directly on the Change by the editing agent. */
  batchTitle?: string;
  /** Shared change description for expanding or AI-summarizing batched edit names. */
  batchContext?: string;
  /** What the editor asked in this row's request thread (used as context for AI batch summaries). */
  requestText?: string;
  /** Short editorial reason for this edit (used as context for AI batch summaries). */
  reason?: string;
  /** True while this row's request is still actively running (delays AI batch summarization until settled). */
  threadWorking?: boolean;
  isMarker?: boolean;
  on: boolean;
  version: number;
  fresh?: boolean;
  spent?: string;
  tipText?: string;
  tipMeta?: string;
  tipDetail?: string;
  /** Seconds removed when this row is a cut (used to sum removed time on grouped `+N` cut rows). */
  removedSeconds?: number;
  ariaLabel?: string;
  logControl: "open-pass-item" | "open-edit";
  logLabel: string;
  open?: () => void;
  /** Every applied edit this row represents, used for Keep, Unkeep, and Keep all. */
  members: readonly RailEditMember[];
  /** Custom unkeep handler for waiting pass calls. */
  unkeepCall?: () => void;
  unkeepTip?: string;
  hadCheck?: boolean;
  nests: readonly Nest[];
  /** Pass moment expansion within a single thread. */
  moment?: {
    key: string;
    more: string;
    unfolded: boolean;
    toggle: () => void;
    subRows: readonly RailSubRow[];
  };
  callIndex?: number;
  editRef?: Omit<ThreadEdit, "at">;
}

/** A unified row rendered in one of the four beta edit lists (either one row or several combined across requests). */
export interface UnifiedRailRow extends RailRow {
  /** Globally unique key across the rail. */
  key: string;
  section: RailSection;
  sourceOrder: number;
  /** Newest request index among all rows combined into this row (drives newest-request-first ordering in Confident edits). */
  latestThreadOrder: number;
  /** All thread IDs contributing to this row (for Show → jumping and flashing). */
  threadIds: readonly string[];
  /** Underlying single-thread rows in chronological order (oldest first, newest last). */
  rows: readonly RailRow[];
  /** When several same-request safe or kept edits of the same kind collapse into one row, the individual unified rows in timeline order (length >= 2). */
  batch?: readonly UnifiedRailRow[];
  /** Deterministic cache key for an AI-generated summary of this collapsed batch. */
  batchSummaryKey?: string;
  /** Structured input for requesting an AI summary of this collapsed batch when one isn't cached yet. */
  batchSummaryInput?: BatchSummaryItem;
  /** Thread-qualified earlier keys carried for `ReviewLinger` when a row changes key across rejection/re-synthesis. */
  was?: readonly string[];
  /** Set when this row is briefly held in the section it just left before moving to Working or Done. */
  lingerFrom?: HeldFrom;
  /** True while the row is fading and collapsing out at the end of its linger window. */
  leaving?: boolean;
  /** True briefly right after a row finishes lingering and arrives in Working or Done. */
  arriving?: boolean;
}

export interface RailDisplayView {
  sections: Record<RailSection, readonly UnifiedRailRow[]>;
  working: number;
  done: number;
  findByKey(key: string): UnifiedRailRow | undefined;
  sectionOf(key: string): RailSection | undefined;
}

export interface RailView {
  sections: Record<RailSection, readonly UnifiedRailRow[]>;
  display: RailDisplayView;
  need: number;
  forYouRows: number;
  optional: number;
  working: number;
  done: number;
  pastHour: boolean;
  findByKey(key: string): UnifiedRailRow | undefined;
  findOpen(): UnifiedRailRow | undefined;
  findForEdit(threadId: string, ref: EditRef): UnifiedRailRow | undefined;
  findForCall(threadId: string, callIndex: number): UnifiedRailRow | undefined;
  lowRiskParts(): { threadId: string; edits: Omit<ThreadEdit, "at">[] }[];
}

/**
 * What one request reports to the unified beta edits column.
 * `rows` feeds the unified time-ordered lists; bare count fields remain supported for count-only callers/tests.
 */
export interface RailInfo {
  you: number;
  optional: number;
  working: number;
  done: number;
  threadOrder?: number;
  rows?: readonly RailRow[];
  /** True once this thread's live edit list has settled (so initial load does not trigger row lingering). */
  listLoaded?: boolean;
  openFirst?(): void;
  openLast?(): void;
  openFirstLow?(): void;
  openLastLow?(): void;
  /** The edits of the request's low-risk rows, every place of each: what Keep all keeps. */
  lowRiskEdits?(): Omit<ThreadEdit, "at">[];
  /** Live located edits reported by this thread so question headers can name the exact edit. */
  edits?: readonly Omit<ThreadEdit, "at">[];
}

const SAME_STRETCH = 0.05;
const NEAR_START = 1.0;

const normLabel = (text?: string) => text?.trim().toLowerCase().replace(/\s+/g, " ") || "";

function kindFamily(kind?: EditKind): string | undefined {
  if (!kind || kind === "other") return undefined;
  if (kind === "audio" || kind === "dip" || kind === "voice") return "sound";
  if (kind === "graphic" || kind === "broll" || kind === "overlay" || kind === "zoom" || kind === "reframe") return "picture";
  return kind;
}

function compatibleFamily(a?: EditKind, b?: EditKind): boolean {
  const fa = kindFamily(a), fb = kindFamily(b);
  return !fa || !fb || fa === fb;
}

function sharesAny(a?: readonly string[], b?: readonly string[]): boolean {
  return !!a?.length && !!b?.length && a.some(id => b.includes(id));
}

function sameStretch(a?: TimeRange, b?: TimeRange): boolean {
  return !!a && !!b && Math.abs(a.start - b.start) <= SAME_STRETCH && Math.abs(a.end - b.end) <= SAME_STRETCH;
}

function stretchOverlap(a?: TimeRange, b?: TimeRange): number {
  return !a || !b ? 0 : Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

const isActiveRow = (row: RailRow) => row.needs || row.asks || row.pending || row.hasNeedNest;

function isContinuousBrollRow(row: RailRow): boolean {
  return !!row.combinable && !row.rejected && !row.skipped && !row.isCall && !row.isMarker
    && row.editKind === "broll" && row.brollSectionId !== null;
}

/** Whether two B-roll rows belong to the same continuous B-roll section (no gap back to the main picture). */
function sameContinuousBroll(a: RailRow, b: RailRow): boolean {
  if (!isContinuousBrollRow(a) || !isContinuousBrollRow(b)) return false;
  if (a.brollSectionId && b.brollSectionId) return a.brollSectionId === b.brollSectionId;
  if (a.brollSectionId || b.brollSectionId) return false;
  return stretchesContiguous(a.stretch, b.stretch, BROLL_CONTIGUOUS_GAP);
}

function brollSectionTipDetail(group: readonly RailRow[]): string | undefined {
  const ordered = [...group].sort((a, b) => a.at - b.at || b.threadOrder - a.threadOrder);
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of ordered) {
    const names = row.members.length > 1
      ? row.members.map(m => ((m.edit.reason && m.edit.summary) || m.edit.label).trim())
      : [(row.rawLabel ?? row.label).trim()];
    for (const name of names) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(name);
    }
  }
  if (labels.length <= 1) return undefined;
  if (labels.length <= 3) return labels.join("\n");
  return `${labels[0]}\n${labels[1]}\nand ${labels.length - 2} more`;
}

function pickContinuousBrollLead<T extends RailRow & { sourceOrder: number }>(group: readonly T[]): T {
  const asks = group.filter(r => r.asks);
  const needs = group.filter(r => r.needs);
  const pending = group.filter(r => r.pending);
  const needNest = group.filter(r => r.hasNeedNest);
  const pool = asks.length ? asks : needs.length ? needs : pending.length ? pending : needNest.length ? needNest : group;
  return [...pool].sort((a, b) => a.at - b.at || b.threadOrder - a.threadOrder || a.sourceOrder - b.sourceOrder)[0]!;
}

/** Whether an earlier request's edit (`prev`) and a later request's edit (`next`) modify the same underlying edit. */
function rowsMatch(prev: RailRow, next: RailRow): boolean {
  // 1. Both touch the same overlay or caption clip (handles repositioned, re-rendered, extended, or shifted graphics).
  if (sharesAny(prev.overlayClipIds, next.overlayClipIds) && compatibleFamily(prev.editKind, next.editKind)) return true;

  const prevLabel = normLabel(prev.rawLabel);
  const nextLabel = normLabel(next.rawLabel);
  const sameRawLabel = prevLabel !== "" && prevLabel === nextLabel;

  // 2. Exact same timeline stretch (within ~1 frame).
  if (sameStretch(prev.stretch, next.stretch)) {
    const bothHaveClips = !!prev.clipIds?.length && !!next.clipIds?.length;
    const sharedClip = sharesAny(prev.clipIds, next.clipIds);
    if (bothHaveClips && !sharedClip) return sameRawLabel;
    if (sameRawLabel) return true;
    if (sharedClip && compatibleFamily(prev.editKind, next.editKind)) return true;
    if (prev.editKind && prev.editKind !== "other" && prev.editKind === next.editKind) return true;
  }

  // 3. Same edit label + compatible kind + overlapping or nearby stretch (handles retimed edits without ops).
  if (sameRawLabel && compatibleFamily(prev.editKind, next.editKind) && prev.stretch && next.stretch) {
    const distinctOverlays = !!prev.overlayClipIds?.length && !!next.overlayClipIds?.length && !sharesAny(prev.overlayClipIds, next.overlayClipIds);
    if (!distinctOverlays && (stretchOverlap(prev.stretch, next.stretch) > SAME_STRETCH || Math.abs(prev.stretch.start - next.stretch.start) <= NEAR_START)) {
      return true;
    }
  }
  return false;
}

const placeToSection = (place: RowPlace): RailSection => place === "optional" ? "low" : place;

const isDecisionWord = (value?: string) => value === "Kept" || value === "Done" || value === "Rejected";

function synthesizeRow(group: readonly (RailRow & { sourceOrder: number })[]): UnifiedRailRow {
  if (group.length === 1) {
    const only = group[0]!;
    const key = `${only.threadId}:${only.key}`;
    const was = only.was?.length
      ? [...new Set(only.was.map(w => `${only.threadId}:${w}`).filter(k => k !== key))]
      : undefined;
    return {
      ...only,
      key,
      was: was?.length ? was : undefined,
      section: placeToSection(only.place),
      latestThreadOrder: only.threadOrder,
      threadIds: [only.threadId],
      rows: [only],
    };
  }
  // Group is already in chronological order (oldest first, newest last).
  const stretches = group.map(r => r.stretch).filter((s): s is TimeRange => !!s);
  const unionStretch: TimeRange | undefined = stretches.length
    ? { start: Math.min(...stretches.map(s => s.start)), end: Math.max(...stretches.map(s => s.end)) }
    : undefined;
  const distinctBrollSpans = stretches.length > 1 && stretches.some(s => !sameStretch(s, stretches[0]!));
  const distinctOverlayClips = new Set(group.flatMap(r => r.overlayClipIds ?? [])).size > 1;
  const continuousBroll = group.some(r => r.continuousBroll)
    || (group.filter(isContinuousBrollRow).length >= 2 && (distinctBrollSpans || distinctOverlayClips || group.some(r => !!r.brollSectionId)));
  const lead = continuousBroll
    ? pickContinuousBrollLead(group)
    : group.find(r => r.asks)
      ?? group.find(r => r.needs)
      ?? group.find(r => r.pending)
      ?? group.find(r => r.hasNeedNest)
      ?? group.at(-1)!;
  const place: RowPlace = group.some(r => r.needs || r.asks || r.hasNeedNest) ? "you"
    : group.some(r => r.pending) ? "working"
    : group.every(r => r.decided || r.rejected) ? "done"
    : "optional";
  const section = placeToSection(place);
  const decided = place === "done" && group.every(r => r.decided);
  const decision = decided ? (group.every(r => r.isMarker) ? "Done" : "Kept") : undefined;
  const askingRow = group.find(r => r.asks);
  const pendingRow = group.find(r => r.pending);
  const word = askingRow?.word ?? pendingRow?.word ?? lead.word;
  const isSpecificValue = (v?: string) => !!v && !isDecisionWord(v) && v !== "Edit";
  const isSpecificKind = (k?: EditKind) => !!k && k !== "other";
  const editKind = continuousBroll
    ? "broll" as const
    : isSpecificKind(lead.editKind)
      ? lead.editKind
      : [...group].reverse().find(r => isSpecificKind(r.editKind))?.editKind ?? lead.editKind;
  const kindValue = continuousBroll
    ? "B-roll"
    : isSpecificValue(lead.value)
      ? lead.value
      : [...group].reverse().find(r => isSpecificValue(r.value))?.value
        ?? (lead.value && !isDecisionWord(lead.value) ? lead.value : [...group].reverse().find(r => r.value && !isDecisionWord(r.value))?.value);
  const value = place === "done" ? (decision ?? lead.value) : kindValue;
  const members: RailEditMember[] = [];
  const seenMembers = new Set<string>();
  for (const row of group) {
    for (const member of row.members) {
      const mk = `${member.threadId}:${editKey(member.edit)}`;
      if (seenMembers.has(mk)) continue;
      seenMembers.add(mk);
      members.push(member);
    }
  }
  const key = `${lead.threadId}:${lead.key}`;
  const was = [...new Set(group.flatMap(r => [
    `${r.threadId}:${r.key}`,
    ...(r.was ?? []).map(w => `${r.threadId}:${w}`),
  ]).filter(k => k !== key))];
  const mergedClipIds = [...new Set(group.flatMap(r => r.clipIds ?? []))];
  const mergedOverlayIds = [...new Set(group.flatMap(r => r.overlayClipIds ?? []))];
  const sectionStart = continuousBroll ? (unionStretch?.start ?? Math.min(...group.map(r => r.at))) : undefined;
  const brollTipMeta = continuousBroll
    ? [
      "B-roll",
      unionStretch && unionStretch.end > unionStretch.start ? lengthLabel(unionStretch.end - unionStretch.start) : undefined,
      decided ? (decision ?? "Kept") : undefined,
    ].filter(Boolean).join(" · ")
    : undefined;
  const brollTipDetail = continuousBroll ? brollSectionTipDetail(group) : undefined;
  return {
    ...lead,
    key,
    was: was.length ? was : undefined,
    ...(sectionStart !== undefined && { at: sectionStart, displayAt: sectionStart, mark: sectionStart }),
    ...(continuousBroll && unionStretch && { stretch: unionStretch }),
    ...(continuousBroll && { continuousBroll: true }),
    ...(mergedClipIds.length > 0 && { clipIds: mergedClipIds }),
    ...(mergedOverlayIds.length > 0 && { overlayClipIds: mergedOverlayIds }),
    place,
    section,
    sourceOrder: lead.sourceOrder,
    latestThreadOrder: Math.max(...group.map(r => r.threadOrder)),
    threadIds: [...new Set(group.map(r => r.threadId))],
    rows: group,
    editKind,
    value,
    word,
    decision,
    needs: group.some(r => r.needs),
    asks: group.some(r => r.asks),
    isAskingCurrent: group.some(r => r.isAskingCurrent),
    pending: group.some(r => r.pending),
    busy: group.some(r => r.busy),
    revised: !group.some(r => r.pending) && group.some(r => r.revised),
    decided,
    rejected: false,
    skipped: false,
    countsAsNeed: group.some(r => r.countsAsNeed),
    hasNeedNest: group.some(r => r.hasNeedNest),
    isDialoguePass: lead.isDialoguePass || group.some(r => r.isDialoguePass),
    batchTitle: lead.batchTitle ?? [...group].reverse().find(r => r.batchTitle)?.batchTitle,
    batchContext: lead.batchContext ?? [...group].reverse().find(r => r.batchContext)?.batchContext,
    requestText: lead.requestText ?? [...group].reverse().find(r => r.requestText)?.requestText,
    reason: lead.reason ?? [...group].reverse().find(r => r.reason)?.reason,
    threadWorking: group.some(r => r.threadWorking),
    on: group.some(r => r.on),
    version: Math.max(...group.map(r => r.version)),
    fresh: group.some(r => r.fresh),
    spent: lead.spent ?? [...group].reverse().find(r => r.spent)?.spent,
    tipMeta: brollTipMeta ?? lead.tipMeta ?? [...group].reverse().find(r => r.tipMeta)?.tipMeta,
    tipDetail: brollTipDetail ?? lead.tipDetail ?? [...group].reverse().find(r => r.tipDetail)?.tipDetail,
    removedSeconds: lead.removedSeconds ?? [...group].reverse().find(r => r.removedSeconds !== undefined)?.removedSeconds,
    hadCheck: group.some(r => r.hadCheck),
    members,
    nests: group.flatMap(r => r.nests),
  };
}

const byVideoTime = (a: UnifiedRailRow, b: UnifiedRailRow) =>
  a.at - b.at
  || a.displayAt - b.displayAt
  || (a.threadId === b.threadId ? a.sourceOrder - b.sourceOrder : b.threadOrder - a.threadOrder)
  || a.key.localeCompare(b.key);

/** Confident edits surface newest requests first so newly generated batches appear immediately at the top, ordered by video time within each request. */
const byNewestRequestThenTime = (a: UnifiedRailRow, b: UnifiedRailRow) =>
  b.latestThreadOrder - a.latestThreadOrder
  || a.at - b.at
  || a.displayAt - b.displayAt
  || a.sourceOrder - b.sourceOrder
  || a.key.localeCompare(b.key);

const BATCH_TITLE_PLURAL: Partial<Record<EditKind, string>> = {
  cut: "Cuts",
  restore: "Passages Put Back",
  insert: "Inserts",
  audio: "Audio Edits",
  dip: "Music Dips",
  voice: "Voice Cleanups",
  zoom: "Zooms",
  reframe: "Reframes",
  text: "Text Edits",
  broll: "B-roll Shots",
  overlay: "Overlays",
  graphic: "Graphics",
  speed: "Speed Changes",
  transition: "Transitions",
  split: "Split Edits",
};

const DIALOGUE_KIND_PLURAL: Record<NonNullable<ReturnType<typeof cutKindOfRow>>, [title: string, words: string]> = {
  pause: ["Pause Cuts", "pauses"],
  filler: ["Filler Word Cuts", "filler words"],
  retake: ["False Start Cuts", "false starts"],
  coaching: ["Crew Note Cuts", "crew notes"],
};

const KIND_GENERIC_WORDS: Partial<Record<EditKind, readonly string[]>> = {
  cut: ["cut", "cuts"],
  restore: ["put back", "restore", "passage put back", "passages put back"],
  insert: ["insert", "inserts"],
  audio: ["audio", "audio edit", "audio edits", "sound", "sound fix", "sound fixes"],
  dip: ["music dip", "music dips", "dip", "dips"],
  voice: ["voice cleanup", "voice cleanups", "voice"],
  zoom: ["zoom", "zooms"],
  reframe: ["reframe", "reframes"],
  text: ["text", "text edit", "text edits"],
  broll: ["b-roll", "b-roll shot", "b-roll shots", "broll"],
  overlay: ["overlay", "overlays"],
  graphic: ["graphic", "graphics"],
  speed: ["speed", "speed change", "speed changes"],
  transition: ["transition", "transitions"],
  split: ["split", "split edit", "split edits"],
};

const GENERIC_BATCH_ITEM_LABELS = new Set(["cut", "cuts", "edit", "edits"]);
const GENERIC_TIMED_LABEL = /^(?:cut|edit)\s+at\s+[\d:.]+$/i;
const QUOTE_START = /^[“"‘']/;
const MAX_INLINE_BATCH_ITEMS = 3;

function rowIsCut(row: UnifiedRailRow): boolean {
  return !!row.editRef?.beforeCut || row.editKind === "cut"
    || row.rows.some(r => !!r.editRef?.beforeCut || r.editKind === "cut");
}

function isGenericForKind(text: string, kind?: EditKind): boolean {
  const cleaned = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!cleaned || GENERIC_BATCH_ITEM_LABELS.has(cleaned) || GENERIC_TIMED_LABEL.test(cleaned)) return true;
  const words = kind ? KIND_GENERIC_WORDS[kind] : undefined;
  return !!words && words.includes(cleaned);
}

function cleanBatchItemName(row: UnifiedRailRow, isCutBatch: boolean, kind?: EditKind): string | undefined {
  const raw = row.rawLabel?.trim();
  const preferred = raw && !isGenericForKind(raw, kind) ? raw : row.label.trim();
  let cleaned = preferred.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  if (!cleaned || isGenericForKind(cleaned, kind)) return undefined;
  if (isCutBatch) {
    const stripped = cleaned.replace(/^cut(?:\s+out)?\s+(?:a\s+|an\s+)?/i, "").trim();
    if (stripped) cleaned = stripped;
  }
  return isGenericForKind(cleaned, kind) ? undefined : cleaned;
}

function sharedRawBatchContext(ordered: readonly UnifiedRailRow[]): string | undefined {
  const contexts = ordered.map(r => r.batchContext?.trim()).filter((v): v is string => !!v);
  if (!contexts.length) return undefined;
  return new Set(contexts).size === 1 ? contexts[0] : undefined;
}

function cleanBatchContext(raw: string, count: number, isCutBatch: boolean, kind?: EditKind): string | undefined {
  const sentence = cutSummary(raw).split(/(?<=[.!?])\s/u, 1)[0]!.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  if (!sentence) return undefined;
  let text = sentence;
  if (isCutBatch) text = text.replace(/^(?:cut(?:\s+out)?|remove(?:d)?)\s+/i, "").trim();
  const leadingCount = new RegExp(`^${count}\\s+(?!(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|f|frame|frames|%)\\b)`, "i");
  text = text.replace(leadingCount, "").trim();
  if (!text || isGenericForKind(text, kind) || /^(?:made|added|applied)\s+\d+\s+/i.test(text)) return undefined;
  return text;
}

function batchTotalRemoved(ordered: readonly UnifiedRailRow[], isCutBatch: boolean): number {
  if (!isCutBatch) return 0;
  return ordered.reduce((sum, item) => {
    if (item.removedSeconds !== undefined && item.removedSeconds > 0) return sum + item.removedSeconds;
    const bc = item.editRef?.beforeCut;
    return sum + (bc ? Math.max(0, bc.removed.end - bc.removed.start) : 0);
  }, 0);
}

function batchableRow(row: UnifiedRailRow, section: "low" | "done"): boolean {
  if (row.isCall || row.isMarker || row.rejected || row.skipped || row.moment) return false;
  if (row.needs || row.asks || row.pending || row.hasNeedNest) return false;
  if (row.version > 0 || row.members.length === 0) return false;
  if (section === "done" && !row.decided) return false;
  return true;
}

function batchBucket(row: UnifiedRailRow): string {
  const threadKey = `${row.latestThreadOrder}:${row.threadId}`;
  if (rowIsCut(row)) return `${threadKey}:cut`;
  if (row.editKind && row.editKind !== "other") return `${threadKey}:kind:${row.editKind}`;
  const changeId = row.editRef?.changeId ?? row.members.at(-1)?.edit.changeId;
  return changeId ? `${threadKey}:change:${changeId}` : `${threadKey}:key:${row.key}`;
}

/** Short count + kind heading for a collapsed batch (e.g. "110 Dialogue Cuts", "3 Graphics", "2 Cuts"). */
export function batchBaseName(items: readonly UnifiedRailRow[]): string {
  const first = items[0]!;
  const count = items.length;
  if (rowIsCut(first)) {
    if (items.some(r => r.isDialoguePass)) {
      const kinds = items.map(r => cutKindOfRow(r.label));
      if (kinds.every(Boolean) && new Set(kinds).size === 1) {
        return `${count} ${DIALOGUE_KIND_PLURAL[kinds[0]!]![0]}`;
      }
      return `${count} Dialogue Cuts`;
    }
    return `${count} Cuts`;
  }
  const noun = (first.editKind && BATCH_TITLE_PLURAL[first.editKind]) ?? "Edits";
  return `${count} ${noun}`;
}

/**
 * Expanded human-readable group name for a collapsed batch, combining its count and kind with what is inside
 * (e.g. "110 Dialogue Cuts · −4:12", "2 Cuts: music bed, wrap", "3 Graphics: Opus title, Fable title, Haiku title").
 */
export function batchLabel(items: readonly UnifiedRailRow[], totalRemoved?: number): string {
  const first = items[0]!;
  const isCutBatch = rowIsCut(first);
  const kind: EditKind | undefined = isCutBatch ? "cut" : first.editKind;
  const base = batchBaseName(items);
  const removed = totalRemoved ?? batchTotalRemoved(items, isCutBatch);

  // Dialogue passes avoid leaking one random speech quote into the batch name; show cut length or cut kinds instead.
  if (isCutBatch && items.some(r => r.isDialoguePass)) {
    if (removed > 0) return `${base} · ${formatRemovedSeconds(removed)}`;
    const kinds = items.map(r => cutKindOfRow(r.label));
    if (kinds.every(Boolean)) {
      const distinctKinds = [...new Set(kinds as NonNullable<ReturnType<typeof cutKindOfRow>>[])];
      if (distinctKinds.length > 1) return `${base}: ${distinctKinds.map(k => DIALOGUE_KIND_PLURAL[k][1]).join(", ")}`;
    }
    return base;
  }

  // Prefer concise names from the edits actually inside this batch.
  const distinctItems: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = cleanBatchItemName(item, isCutBatch, kind);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    distinctItems.push(name);
  }
  const quoteFlood = isCutBatch && items.length >= 4 && distinctItems.length > 0 && distinctItems.every(s => QUOTE_START.test(s));
  if (distinctItems.length > 0 && !quoteFlood) {
    const preview = distinctItems.length <= MAX_INLINE_BATCH_ITEMS
      ? distinctItems.join(", ")
      : `${distinctItems.slice(0, MAX_INLINE_BATCH_ITEMS).join(", ")}…`;
    return `${base}: ${preview}`;
  }

  // When individual items only have generic names ("Cut", "Edit") or are a large quote list, fall back to the shared change summary.
  const rawContext = sharedRawBatchContext(items);
  const context = rawContext ? cleanBatchContext(rawContext, items.length, isCutBatch, kind) : undefined;
  if (context) return `${base}: ${context}`;

  if (isCutBatch && removed > 0) return `${base} · ${formatRemovedSeconds(removed)}`;
  return base;
}

/** Quiet preview lines under a batch's hover tooltip showing what edits are inside it. */
function batchTooltipDetail(ordered: readonly UnifiedRailRow[]): string | undefined {
  const labels = ordered.map(r => r.label.trim()).filter(Boolean);
  if (!labels.length) return undefined;
  const distinct = [...new Set(labels)];
  if (distinct.length === 1) return GENERIC_BATCH_ITEM_LABELS.has(distinct[0]!.toLowerCase()) ? undefined : distinct[0];
  if (labels.length <= 3) return labels.join("\n");
  return `${labels[0]}\n${labels[1]}\nand ${labels.length - 2} more`;
}

const MAX_SUMMARY_SAMPLES = 15;

function hashBatchKey(payload: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
  }
  return `bs_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function sampleEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.min(items.length - 1, Math.round((i * (items.length - 1)) / (max - 1)));
    out.push(items[idx]!);
  }
  return out;
}

function buildBatchSummaryInput(ordered: readonly UnifiedRailRow[], isCutBatch: boolean, totalRemoved: number): BatchSummaryItem {
  const first = ordered[0]!;
  const isDialoguePass = isCutBatch && ordered.some(r => r.isDialoguePass);
  const kind = isCutBatch ? "cut" : (first.editKind && first.editKind !== "other" ? first.editKind : undefined);
  const request = ordered.find(r => r.requestText?.trim())?.requestText?.trim().slice(0, 400);
  const descriptions = [...new Set(
    ordered.map(r => r.batchContext?.trim()).filter((v): v is string => !!v).map(d => cutSummary(d).trim().slice(0, 300)).filter(Boolean),
  )].slice(0, 6);
  const breakdown: Record<string, number> = {};
  for (const item of ordered) {
    const dk = cutKindOfRow(item.label);
    if (!dk) continue;
    const word = DIALOGUE_KIND_PLURAL[dk][1];
    breakdown[word] = (breakdown[word] ?? 0) + 1;
  }
  const samples = sampleEvenly(ordered, MAX_SUMMARY_SAMPLES).map(item => ({
    label: (item.label || item.rawLabel || "").trim().slice(0, 200),
    ...(item.reason?.trim() ? { reason: item.reason.trim().slice(0, 240) } : {}),
  }));
  const roundedRemoved = totalRemoved > 0 ? Math.round(totalRemoved * 10) / 10 : undefined;
  const payload = {
    ...(kind && { kind }),
    ...(isDialoguePass && { isDialoguePass: true }),
    count: ordered.length,
    ...(roundedRemoved !== undefined && { removedSeconds: roundedRemoved }),
    ...(request && { request }),
    ...(descriptions.length && { descriptions }),
    ...(Object.keys(breakdown).length && { breakdown }),
    samples,
  };
  return { key: hashBatchKey(JSON.stringify(payload)), ...payload };
}

function sharedBatchTitle(ordered: readonly UnifiedRailRow[]): string | undefined {
  const titles = ordered.map(r => r.batchTitle?.trim());
  if (!titles.length || titles.some(t => !t)) return undefined;
  return new Set(titles).size === 1 ? titles[0] : undefined;
}

/**
 * Collapse repeated safe or kept edits of the same kind within a request into one grouped row named by its AI summary
 * (from cached server summaries or `Change.batchTitle`), falling back to a concise count, kind, and context label
 * while waiting or offline. Flagged, revising, rejected, marker, and revised (`v2`) edits stay individual.
 */
function collapseSectionBatches(
  rows: readonly UnifiedRailRow[],
  section: "low" | "done",
  batchSummaries: Readonly<Record<string, string>> = {},
): UnifiedRailRow[] {
  const unkeptBuckets = new Set<string>();
  const leavingStatesByBucket = new Map<string, Set<boolean>>();
  if (section === "low") {
    for (const row of rows) {
      if (!batchableRow(row, section)) continue;
      const bucket = batchBucket(row);
      if (!row.decided) unkeptBuckets.add(bucket);
      else {
        let states = leavingStatesByBucket.get(bucket);
        if (!states) { states = new Set(); leavingStatesByBucket.set(bucket, states); }
        states.add(!!row.leaving);
      }
    }
  }
  const byBucket = new Map<string, UnifiedRailRow[]>();
  const passthrough: UnifiedRailRow[] = [];
  for (const row of rows) {
    if (!batchableRow(row, section)) {
      passthrough.push(row);
      continue;
    }
    const baseBucket = batchBucket(row);
    // Keep lingering kept rows separate from unkept rows (and separate from rows with a different fade phase),
    // while preserving the exact `batch:low:${baseBucket}` key when the entire batch is kept together so the DOM node fades cleanly in place.
    let bucket = baseBucket;
    if (section === "low" && row.decided) {
      if (unkeptBuckets.has(baseBucket)) bucket = `${baseBucket}:kept`;
      if ((leavingStatesByBucket.get(baseBucket)?.size ?? 0) > 1) bucket = `${bucket}:${row.leaving ? "leaving" : "held"}`;
    }
    const list = byBucket.get(bucket);
    if (list) list.push(row);
    else byBucket.set(bucket, [row]);
  }
  const result: UnifiedRailRow[] = [...passthrough];
  for (const [bucket, items] of byBucket) {
    if (items.length === 1) {
      result.push(items[0]!);
      continue;
    }
    const ordered = [...items].sort(byVideoTime);
    const first = ordered[0]!;
    const active = ordered.find(r => r.on);
    const members: RailEditMember[] = [];
    const seenMembers = new Set<string>();
    for (const item of ordered) {
      for (const m of item.members) {
        const mk = `${m.threadId}:${editKey(m.edit)}`;
        if (seenMembers.has(mk)) continue;
        seenMembers.add(mk);
        members.push(m);
      }
    }
    const isCutBatch = rowIsCut(first);
    const totalRemoved = batchTotalRemoved(ordered, isCutBatch);
    const base = batchBaseName(ordered);
    const summaryInput = buildBatchSummaryInput(ordered, isCutBatch, totalRemoved);
    const aiTitle = batchSummaries[summaryInput.key]?.trim() || undefined;
    const authoredTitle = sharedBatchTitle(ordered);
    const label = aiTitle ?? authoredTitle ?? batchLabel(ordered, totalRemoved);
    const metaParts: string[] = [];
    if (isCutBatch && totalRemoved > 0) metaParts.push(`Cut · ${formatRemovedSeconds(totalRemoved)}`);
    else if (aiTitle || authoredTitle) metaParts.push(base);
    if (section === "done" || first.decided) metaParts.push("Kept");
    const tipMeta = metaParts.length > 0 ? metaParts.join(" · ") : undefined;
    const rawContext = sharedRawBatchContext(ordered);
    const contextDetail = rawContext ? cutSummary(rawContext).trim() : undefined;
    const tipDetail = batchTooltipDetail(ordered) ?? (contextDetail && contextDetail !== base ? contextDetail : undefined);
    const needsAi = !aiTitle && !authoredTitle && !ordered.some(r => r.threadWorking);
    const leaving = ordered.every(r => !!r.leaving);
    const arriving = ordered.every(r => !!r.arriving);
    const lingerFrom = first.lingerFrom && ordered.every(r => r.lingerFrom === first.lingerFrom) ? first.lingerFrom : undefined;
    result.push({
      ...first,
      key: `batch:${section}:${bucket}`,
      label,
      threadIds: [...new Set(ordered.flatMap(r => r.threadIds))],
      rows: ordered.flatMap(r => r.rows),
      members,
      on: !!active,
      fresh: ordered.some(r => r.fresh),
      hadCheck: ordered.some(r => r.hadCheck),
      open: (active ?? first).open,
      tipText: aiTitle ?? authoredTitle ?? base,
      tipMeta,
      tipDetail,
      unkeepTip: section === "done" && !lingerFrom ? `Unkeep all ${ordered.length}` : first.unkeepTip,
      batch: ordered,
      batchSummaryKey: summaryInput.key,
      ...(needsAi && { batchSummaryInput: summaryInput }),
      ...(lingerFrom && { lingerFrom }),
      ...(leaving && { leaving: true }),
      ...(arriving && { arriving: true }),
    });
  }
  return result.sort(section === "low" ? byNewestRequestThenTime : byVideoTime);
}

const rowEditCount = (row: UnifiedRailRow) => row.batch ? row.batch.length : 1;

/** Combine structured thread reports into pre-batch unified rows. */
function synthesizeUnifiedRows(infos: ReadonlyMap<string, RailInfo>): UnifiedRailRow[] {
  const allRows: (RailRow & { sourceOrder: number })[] = [];
  for (const info of infos.values()) {
    if (!info.rows?.length) continue;
    info.rows.forEach((row, sourceOrder) => allRows.push({ ...row, sourceOrder }));
  }

  // Group in chronological thread order so earlier edits seed groups and later requests combine into them.
  allRows.sort((a, b) => a.threadOrder - b.threadOrder || a.sourceOrder - b.sourceOrder);

  const groups: { rows: (RailRow & { sourceOrder: number })[] }[] = [];
  for (const row of allRows) {
    if (!row.combinable) {
      groups.push({ rows: [row] });
      continue;
    }
    // Contiguous B-roll edits belonging to the same continuous B-roll section always collapse into one line item,
    // even within the same request or when multiple shots are flagged, and merge transitively when a middle shot bridges them.
    if (isContinuousBrollRow(row)) {
      const brollMatches: { rows: (RailRow & { sourceOrder: number })[] }[] = [];
      for (const candidate of groups) {
        if (!candidate.rows[0]!.combinable) continue;
        if (candidate.rows.some(prev => sameContinuousBroll(prev, row))) brollMatches.push(candidate);
      }
      if (brollMatches.length) {
        const target = brollMatches[0]!;
        for (let k = 1; k < brollMatches.length; k++) {
          const extra = brollMatches[k]!;
          target.rows.push(...extra.rows);
          const idx = groups.indexOf(extra);
          if (idx >= 0) groups.splice(idx, 1);
        }
        target.rows.push(row);
        target.rows.sort((a, b) => a.threadOrder - b.threadOrder || a.sourceOrder - b.sourceOrder);
        continue;
      }
    }
    let match: { rows: (RailRow & { sourceOrder: number })[] } | undefined;
    for (let i = groups.length - 1; i >= 0; i--) {
      const candidate = groups[i]!;
      if (!candidate.rows[0]!.combinable) continue;
      if (candidate.rows.some(r => r.threadId === row.threadId)) continue;
      if (candidate.rows.some(isActiveRow) && isActiveRow(row)) continue;
      if (candidate.rows.some(prev => rowsMatch(prev, row))) {
        match = candidate;
        break;
      }
    }
    if (match) match.rows.push(row);
    else groups.push({ rows: [row] });
  }

  return groups.map(group => synthesizeRow(group.rows));
}

export interface RailLingerLookup {
  of(key: string): { from: HeldFrom; leaving: boolean } | undefined;
  arrived?: ReadonlySet<string>;
}

/**
 * Combine cross-request edits that modify the same clip/stretch and sort every section of the beta edits column into
 * one unified timeline-ordered list (never stacked by chat request). `sections` holds pure logical placement (used for
 * keyboard stepping, Keep-next, and Keep all); `display` holds the visual lists where rows briefly pause and fade out
 * in their previous section before moving cleanly into Working or Done without appearing twice.
 */
export function buildUnifiedRail(
  infos: ReadonlyMap<string, RailInfo>,
  batchSummaries: Readonly<Record<string, string>> = {},
  lingerState?: RailLingerLookup,
): RailView {
  const hasStructured = [...infos.values()].some(info => info.rows !== undefined);
  const sections: Record<RailSection, UnifiedRailRow[]> = { you: [], low: [], working: [], done: [] };
  const byKey = new Map<string, UnifiedRailRow>();

  if (!hasStructured) {
    let need = 0, optional = 0, working = 0, done = 0;
    for (const info of infos.values()) {
      need += info.you;
      optional += info.optional;
      working += info.working;
      done += info.done;
    }
    return {
      sections,
      display: {
        sections,
        working,
        done,
        findByKey: () => undefined,
        sectionOf: () => undefined,
      },
      need, forYouRows: need, optional, working, done, pastHour: false,
      findByKey: () => undefined,
      findOpen: () => undefined,
      findForEdit: () => undefined,
      findForCall: () => undefined,
      lowRiskParts: () => [],
    };
  }

  const unifiedRows = synthesizeUnifiedRows(infos);
  const dispRaw: Record<RailSection, UnifiedRailRow[]> = { you: [], low: [], working: [], done: [] };
  const sectionByKey = new Map<string, RailSection>();

  let pastHour = false;
  for (const unified of unifiedRows) {
    sections[unified.section].push(unified);
    if (Math.floor(Math.max(0, unified.displayAt)) >= 3600) pastHour = true;

    const held = lingerState?.of(unified.key);
    const heldIn: RailSection | undefined = !held ? undefined
      : held.from === "done" ? (unified.place === "working" ? "done" : undefined)
      : (unified.place === "working" || unified.place === "done") ? (held.from === "optional" ? "low" : "you")
      : undefined;
    const dispSec = heldIn ?? unified.section;
    const arriving = !heldIn && (dispSec === "working" || dispSec === "done") && !!lingerState?.arrived?.has(unified.key);
    const dispRow: UnifiedRailRow = heldIn
      ? { ...unified, lingerFrom: held!.from, leaving: held!.leaving }
      : arriving ? { ...unified, arriving: true } : unified;
    dispRaw[dispSec].push(dispRow);
    sectionByKey.set(unified.key, dispSec);
  }

  sections.you.sort(byVideoTime);
  sections.low = collapseSectionBatches(sections.low, "low", batchSummaries);
  sections.working.sort(byVideoTime);
  sections.done = collapseSectionBatches(sections.done, "done", batchSummaries);

  dispRaw.you.sort(byVideoTime);
  dispRaw.low = collapseSectionBatches(dispRaw.low, "low", batchSummaries);
  dispRaw.working.sort(byVideoTime);
  dispRaw.done = collapseSectionBatches(dispRaw.done, "done", batchSummaries);

  const orderedSections: readonly UnifiedRailRow[][] = [sections.you, sections.low, sections.working, sections.done];
  for (const list of orderedSections) for (const row of list) byKey.set(row.key, row);

  const dispByKey = new Map<string, UnifiedRailRow>();
  for (const sec of ["you", "low", "working", "done"] as const) {
    for (const row of dispRaw[sec]) {
      dispByKey.set(row.key, row);
      sectionByKey.set(row.key, sec);
      if (row.batch) for (const item of row.batch) sectionByKey.set(item.key, sec);
    }
  }

  return {
    sections,
    display: {
      sections: dispRaw,
      working: dispRaw.working.length,
      done: dispRaw.done.reduce((sum, r) => sum + rowEditCount(r), 0),
      findByKey: key => dispByKey.get(key),
      sectionOf: key => sectionByKey.get(key),
    },
    need: sections.you.filter(r => r.countsAsNeed).length,
    forYouRows: sections.you.length,
    optional: sections.low.reduce((sum, r) => sum + rowEditCount(r), 0),
    working: sections.working.length,
    done: sections.done.reduce((sum, r) => sum + rowEditCount(r), 0),
    pastHour,
    findByKey: key => byKey.get(key),
    findOpen: () => {
      for (const list of orderedSections) {
        const found = list.find(r => r.on || r.moment?.subRows.some(s => s.on));
        if (found) return found;
      }
      return undefined;
    },
    findForEdit: (threadId, ref) => {
      for (const list of orderedSections) {
        const found = list.find(r => r.members.some(m => m.threadId === threadId && matchesEdit(m.edit, ref)));
        if (found) return found;
      }
      return undefined;
    },
    findForCall: (threadId, callIndex) => {
      for (const list of orderedSections) {
        const found = list.find(r => r.isCall && r.threadId === threadId && r.callIndex === callIndex);
        if (found) return found;
      }
      return undefined;
    },
    lowRiskParts: () => {
      const byThread = new Map<string, Omit<ThreadEdit, "at">[]>();
      const seen = new Set<string>();
      for (const row of sections.low) {
        for (const member of row.members) {
          const mk = `${member.threadId}:${editKey(member.edit)}`;
          if (seen.has(mk)) continue;
          seen.add(mk);
          const list = byThread.get(member.threadId);
          if (list) list.push(member.edit);
          else byThread.set(member.threadId, [member.edit]);
        }
      }
      return [...byThread.entries()].map(([threadId, edits]) => ({ threadId, edits }));
    },
  };
}

function rowSignature(row: RailRow): string {
  return JSON.stringify([
    row.key, row.threadOrder, row.at, row.displayAt, row.mark ?? null, row.place,
    row.label, row.rawLabel ?? null, row.editKind ?? null,
    row.stretch ? [row.stretch.start, row.stretch.end] : null,
    row.clipIds ?? null, row.overlayClipIds ?? null, row.brollSectionId ?? null,
    row.brollSectionRange ? [row.brollSectionRange.start, row.brollSectionRange.end] : null,
    !!row.continuousBroll, !!row.combinable,
    row.value ?? null, row.word ?? null, row.decision ?? null,
    row.needs, row.asks, row.isAskingCurrent, row.pending, row.busy, row.revised,
    row.decided, row.rejected, row.skipped, row.countsAsNeed, row.hasNeedNest,
    !!row.isCall, !!row.isDialoguePass, row.batchTitle ?? null, row.batchContext ?? null, row.requestText ?? null, row.reason ?? null, !!row.threadWorking, !!row.isMarker, row.on, row.version, !!row.fresh,
    row.spent ?? null, row.tipText ?? null, row.tipMeta ?? null, row.tipDetail ?? null, row.removedSeconds ?? null, row.ariaLabel ?? null,
    row.logControl, row.logLabel, !!row.open, !!row.unkeepCall, row.unkeepTip ?? null, !!row.hadCheck,
    row.callIndex ?? null,
    row.members.map(m => [m.threadId, editKey(m.edit), m.canUnkeep]),
    row.nests.map(n => [n.key, !!n.needs, n.version ?? ""]),
    row.moment ? [
      row.moment.key, row.moment.more, row.moment.unfolded,
      row.moment.subRows.map(s => [
        s.key, s.label, s.title ?? null, s.tipMeta ?? null, s.tipDetail ?? null, s.value ?? null, s.word ?? null,
        s.decided, s.needs, s.asks, s.busy, s.revised, s.version, s.spent ?? null,
        s.on, s.mark ?? null, !!s.open, !!s.unkeep, s.unkeepTip ?? null,
        s.nests?.map(n => [n.key, !!n.needs, n.version ?? ""]) ?? null,
      ]),
    ] : null,
  ]);
}

function infoSignature(info: RailInfo): string {
  const editsCount = info.edits?.length ?? 0;
  if (!info.rows) return `${info.you}|${info.optional}|${info.working}|${info.done}|${editsCount}`;
  return `${info.threadOrder ?? 0}|${info.listLoaded !== false ? 1 : 0}|${editsCount}|${info.rows.map(rowSignature).join("\n")}`;
}

/**
 * The column of edits beside the chat is one unified list per section for the whole video: each request reports its
 * rows (`report`), and the store combines overlapping cross-request edits, sorts every section by video time, and holds
 * recently acted-on rows briefly in place before smoothly moving them to Working or Done without duplicates.
 */
export class RailStore {
  private hosts = new Map<string, HTMLElement>();
  private refs = new Map<string, (el: HTMLElement | null) => void>();
  private infos = new Map<string, RailInfo>();
  private signatures = new Map<string, string>();
  private linger = new ReviewLinger();
  private lowShown = false;
  private doneShown = false;
  private prevHeldKeys = new Set<string>();
  private arrived = new Map<string, ReturnType<typeof setTimeout>>();
  private batchSummaries: Readonly<Record<string, string>> = {};
  private cachedView?: RailView;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor() {
    this.linger.subscribe(() => this.onLingerChange());
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.cachedView = undefined; this.version++; for (const listener of this.listeners) listener(); }

  /** Whether Safe edits in Needs review is currently expanded (so acted-on safe edits linger in place). */
  setLowOpen(open: boolean) {
    if (this.lowShown === open) return;
    this.lowShown = open;
    this.syncLinger();
    this.cachedView = undefined;
  }

  /** Whether the Done section at the foot of the rail is currently expanded (so revisions sent from Done linger in place). */
  setDoneOpen(open: boolean) {
    if (this.doneShown === open) return;
    this.doneShown = open;
    this.cachedView = undefined;
  }

  private clearArrived(key: string) {
    const timer = this.arrived.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.arrived.delete(key);
  }

  private markArrived(key: string) {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    this.clearArrived(key);
    this.arrived.set(key, setTimeout(() => {
      this.arrived.delete(key);
      this.changed();
    }, ARRIVE_MS));
  }

  private syncLinger() {
    const hasStructured = [...this.infos.values()].some(info => info.rows !== undefined);
    if (!hasStructured) return;
    const unifiedRows = synthesizeUnifiedRows(this.infos);
    const tracked = unifiedRows
      .filter(u => u.isCall || u.rows.some(r => this.infos.get(r.threadId)?.listLoaded !== false))
      .map(u => ({ key: u.key, place: u.place, was: u.was, busy: u.busy }));
    this.linger.track(tracked, this.lowShown, this.doneShown);
    const nextHeld = new Set<string>();
    for (const row of tracked) if (this.linger.of(row.key)) nextHeld.add(row.key);
    this.prevHeldKeys = nextHeld;
    for (const key of [...this.arrived.keys()]) {
      if (this.linger.of(key) || !unifiedRows.some(u => u.key === key && (u.place === "working" || u.place === "done"))) {
        this.clearArrived(key);
      }
    }
  }

  private onLingerChange() {
    const nextHeld = new Set<string>();
    for (const key of this.prevHeldKeys) {
      if (this.linger.of(key)) nextHeld.add(key);
      else this.markArrived(key);
    }
    this.prevHeldKeys = nextHeld;
    this.changed();
  }

  resetLinger() {
    this.linger.dispose();
    for (const timer of this.arrived.values()) clearTimeout(timer);
    this.arrived.clear();
    this.prevHeldKeys.clear();
    this.changed();
  }

  dispose() {
    this.linger.dispose();
    for (const timer of this.arrived.values()) clearTimeout(timer);
    this.arrived.clear();
    this.prevHeldKeys.clear();
  }

  /** Legacy portal host lookup kept for backwards compatibility. */
  host(section: RailSection, threadId: string) { return this.hosts.get(`${section}/${threadId}`) ?? null; }
  /** Legacy portal slot ref kept for backwards compatibility. */
  ref(section: RailSection, threadId: string) {
    const key = `${section}/${threadId}`;
    let ref = this.refs.get(key);
    if (!ref) {
      ref = el => {
        if (el ? this.hosts.get(key) === el : !this.hosts.has(key)) return;
        if (el) this.hosts.set(key, el); else this.hosts.delete(key);
        this.changed();
      };
      this.refs.set(key, ref);
    }
    return ref;
  }

  /** A request reports its rows and edits. With nothing, it has left. */
  report(threadId: string, info?: RailInfo) {
    if (!info) {
      this.signatures.delete(threadId);
      if (this.infos.delete(threadId)) {
        this.syncLinger();
        this.changed();
      }
      return;
    }
    const nextSig = infoSignature(info);
    const prevSig = this.signatures.get(threadId);
    // Always keep the latest callbacks/closures, invalidating any cached view without notifying unless data changed.
    this.infos.set(threadId, info);
    this.cachedView = undefined;
    if (prevSig !== nextSig) {
      this.signatures.set(threadId, nextSig);
      this.syncLinger();
      this.changed();
    }
  }

  info(threadId: string) { return this.infos.get(threadId); }

  /** Apply AI-generated titles for collapsed edit batches, notifying subscribers only when titles change. */
  setBatchSummaries(next?: Readonly<Record<string, string>>) {
    const incoming = next ?? {};
    const prev = this.batchSummaries;
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(incoming);
    if (prevKeys.length === nextKeys.length && nextKeys.every(k => prev[k] === incoming[k])) return;
    this.batchSummaries = incoming;
    this.changed();
  }

  view(): RailView {
    return (this.cachedView ??= buildUnifiedRail(this.infos, this.batchSummaries, {
      of: key => {
        const held = this.linger.of(key);
        if (!held) return undefined;
        if (held.from === "optional" && !this.lowShown) return undefined;
        if (held.from === "done" && !this.doneShown) return undefined;
        return held;
      },
      arrived: this.arrived.size ? new Set(this.arrived.keys()) : undefined,
    }));
  }

  total(section: Exclude<RailSection, "low"> | "optional") {
    const v = this.view();
    return section === "you" ? v.need : v[section];
  }
}

export const ReviewRailContext = createContext<RailStore | undefined>(undefined);

const never = () => () => {};
const zero = () => 0;
/** The column of edits, when the page has one: a request reports its rows there and does not draw them in the chat. */
export function useReviewRail() {
  const store = useContext(ReviewRailContext);
  useSyncExternalStore(store?.subscribe ?? never, store?.snapshot ?? zero, store?.snapshot ?? zero);
  return store;
}
