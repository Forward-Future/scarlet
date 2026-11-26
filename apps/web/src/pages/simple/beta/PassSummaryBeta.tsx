import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { clipRange, type Change, type Clip, type TimeRange, type Timeline, type Track } from "@scarlet/timeline";
import { matchesEdit, REVISED_CHECK, type EditRef, type ThreadEdit } from "@scarlet/shared";
import { ThreadAction } from "../../../components/review/ThreadEdits";
import { asksEditor, editGroups, revisionWord, useAdding, useCanUnkeep, useRejecting, useReviewed, useRevising, waitingPassRows, waitingRows } from "../../../components/review/threadEditState";
import { editKindWord, editRowWord } from "../../../lib/editKind";
import { listMoments, type Moment } from "../../../lib/editMoments";
import { callRowTooltip, changeForEdit, cutRemovedSeconds, decidedCallRowTooltip, editRowTooltip, momentRowTooltip, type RowTooltipInfo } from "../../../lib/editRowTooltip";
import { lengthLabel, plural } from "../../../lib/format";
import { editKey, unkeepEdits } from "../../../lib/keptEdits";
import { madeSentence, type SentencePart } from "../../../lib/madeSentence";
import { decidedPassCalls, rejectedCallRef } from "../../../lib/passCalls";
import { inListOrder, rowPlace, tabShown, type ListOrder, type ReviewLinger, type RowPlace } from "./reviewTabsBeta";
import { isRecheck, type Thread } from "../../../lib/threads";
import { useKeepSelectedInView } from "../../../lib/uiHooks";
import { recordUndo } from "../../../lib/undo";
import { useProjectStore } from "../../../stores/project";
import { useShownCut } from "../../../stores/shownCut";
import { useReviewRail, type RailEditMember, type RailRow, type RailSubRow } from "../railStore";
import { callRowKey, isWorking, letGo, listedBefore, noNests, noRejected, noSpent, type ChatActions, type HoveredReviewRow, type Nest, type PassList, type Spent } from "../types";

interface SpotClips {
  clipIds: string[];
  overlayClipIds: string[];
}

function safeClipRange(clip: Clip | undefined): TimeRange | undefined {
  if (!clip) return undefined;
  try { return clipRange(clip); } catch { return undefined; }
}

/**
 * Map each applied edit in a thread to the clip IDs (and overlay/caption clip IDs) touched by its ops.
 * For multi-edit changes, assigns each op to the single edit with highest IoU so adjacent clips (e.g. a shifted graphic
 * overlapping a neighbour's earlier span) stay cleanly separated.
 */
function editClipIdsBySpot(changes: readonly Change[], edits: readonly Omit<ThreadEdit, "at">[], timeline: Timeline | null | undefined): Map<string, SpotClips> {
  const result = new Map<string, { clipIds: Set<string>; overlayClipIds: Set<string> }>();
  if (!edits.length) return new Map();
  const baseVideo = timeline?.tracks.find(t => t.kind === "video")?.id;
  const clipMap = new Map<string, { clip: Clip; trackId: string; trackKind: Track["kind"]; range?: TimeRange }>();
  if (timeline) {
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clipMap.has(clip.id)) continue;
        clipMap.set(clip.id, { clip, trackId: track.id, trackKind: track.kind, range: safeClipRange(clip) });
      }
    }
  }
  const byChangeId = new Map(changes.map(c => [c.id, c]));
  const addClipToEdit = (key: string, clipId: string, overlay: boolean) => {
    let bucket = result.get(key);
    if (!bucket) { bucket = { clipIds: new Set(), overlayClipIds: new Set() }; result.set(key, bucket); }
    bucket.clipIds.add(clipId);
    if (overlay) bucket.overlayClipIds.add(clipId);
  };
  const assignForChange = (change: Change, changeEdits: readonly Omit<ThreadEdit, "at">[]) => {
    const ops = (change.ops ?? []) as Record<string, unknown>[];
    if (!ops.length) return;
    const addedTracks = new Map<string, Track["kind"]>();
    for (const op of ops) {
      const track = op.op === "addTrack" ? op.track as Partial<Track> | undefined : undefined;
      if (track?.id && track.kind) addedTracks.set(track.id, track.kind);
    }
    const trackKindOf = (trackId?: string) => !trackId ? undefined
      : addedTracks.get(trackId) ?? timeline?.tracks.find(t => t.id === trackId)?.kind;
    for (const op of ops) {
      let clipId: string | undefined;
      let trackId: string | undefined;
      let opRange: TimeRange | undefined;
      let clipLabel: string | undefined;
      if (op.op === "addClip") {
        const clip = op.clip as Clip | undefined;
        if (!clip?.id) continue;
        clipId = clip.id;
        const info = clipMap.get(clipId);
        trackId = typeof op.trackId === "string" ? op.trackId : info?.trackId;
        opRange = info?.range ?? safeClipRange(clip);
        clipLabel = clip.label ?? info?.clip.label;
      } else if (op.op === "updateClip" || op.op === "moveClip" || op.op === "removeClip") {
        if (typeof op.clipId !== "string") continue;
        clipId = op.clipId;
        const info = clipMap.get(clipId);
        trackId = info?.trackId;
        opRange = info?.range;
        clipLabel = info?.clip.label;
      } else {
        continue;
      }
      const kind = trackKindOf(trackId);
      const isOverlay = !!trackId && trackId !== baseVideo && (kind === "video" || kind === "caption");
      if (changeEdits.length === 1) {
        addClipToEdit(editKey(changeEdits[0]!), clipId, isOverlay);
        continue;
      }
      let target: Omit<ThreadEdit, "at"> | undefined;
      if (opRange) {
        let bestIoU = 0;
        for (const edit of changeEdits) {
          const inter = Math.min(opRange.end, edit.range.end) - Math.max(opRange.start, edit.range.start);
          if (inter <= 0.05) continue;
          const union = Math.max(opRange.end, edit.range.end) - Math.min(opRange.start, edit.range.start);
          const iou = union > 0 ? inter / union : 0;
          if (iou > bestIoU) { bestIoU = iou; target = edit; }
        }
      }
      if (!target && clipLabel) {
        const norm = clipLabel.trim().toLowerCase();
        const matches = changeEdits.filter(e => e.label.trim().toLowerCase() === norm);
        if (matches.length === 1) target = matches[0];
      }
      if (target) addClipToEdit(editKey(target), clipId, isOverlay);
    }
  };
  const editsByChange = new Map<string, Omit<ThreadEdit, "at">[]>();
  for (const edit of edits) {
    const list = editsByChange.get(edit.changeId);
    if (list) list.push(edit); else editsByChange.set(edit.changeId, [edit]);
  }
  for (const [changeId, changeEdits] of editsByChange) {
    const change = byChangeId.get(changeId);
    if (change) assignForChange(change, changeEdits);
  }
  for (const edit of edits) {
    const key = editKey(edit);
    if (result.has(key) || !edit.previous.length) continue;
    for (let i = edit.previous.length - 1; i >= 0 && !result.has(key); i--) {
      const prevChange = byChangeId.get(edit.previous[i]!.changeId);
      if (prevChange) assignForChange(prevChange, [edit]);
    }
  }
  return new Map([...result.entries()].map(([k, v]) => [k, { clipIds: [...v.clipIds], overlayClipIds: [...v.overlayClipIds] }]));
}

/**
 * A finished request with one result opens its edit on the timeline. A collection opens a list to choose from. Closed,
 * either is a link after the sentence (`place` "inline"): See edit for one, See both or See all for several, and the
 * edits so far while Scarlet works. Open, a finished collection's list is under its tab, in the row where Needs review,
 * Working and Done sit when there is something to review (`place` "tab"), and the tab pressed again closes it. Each
 * place draws only its own. The word counts the rows the list opens (`rows`), a rejected edit's too: See both is for two.
 */
function EditResultLink({ thread, actions, single, rows, count, soFar, list: [open, setOpen], reveal, place, column }: {
  thread: Thread; actions: ChatActions; single?: EditRef; rows: number; count: number; soFar?: boolean; list: PassList; reveal(): void; place: "inline" | "tab";
  /** The rows are in the column of edits, not under this link: a request's one edit keeps its link whatever is open there. */
  column?: boolean;
}) {
  const expanded = open === "all";
  const current = !!single && !!actions.showing && matchesEdit(actions.showing, single);
  const one = !!single && (column || !expanded || current);
  const tab = !column && expanded && !one && !soFar;
  if (tab !== (place === "tab")) return null;
  const label = rows === 2 ? "See both" : "See all";
  if (tab) return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab" aria-pressed title="Hide the edits" onClick={letGo(() => setOpen(undefined))}>{label}</button>
  </div>;
  if (single && one) {
    const toggleEdit = () => {
      if (!current) return actions.openEdit(thread, single);
      setOpen(undefined);
      actions.stopShowing();
    };
    return <button type="button" className="simple-pass-toggle" aria-current={current || undefined}
      title={current ? "Close this edit (Esc)" : "Show on the timeline"} onClick={letGo(toggleEdit)}>{current ? "Close edit" : "See edit"}</button>;
  }
  if (!soFar) return <button type="button" className="simple-pass-toggle" aria-expanded={false} title="Show the edits in order"
    onClick={letGo(() => { reveal(); setOpen("all"); })}>{label}</button>;
  return <button type="button" className="simple-pass-toggle" data-so-far aria-expanded={expanded}
    title={expanded ? "Hide the edits" : "Show the edits Scarlet has made so far, in order"}
    onClick={letGo(() => { if (!expanded) reveal(); setOpen(expanded ? undefined : "all"); })}>{expanded ? "Hide" : `See ${count} ${count === 1 ? "edit" : "edits"} so far`}</button>;
}

/**
 * A list the editor opens is brought into view. The conversation sits at its latest message, so a list opened on the
 * last request grows downward, under the message box, and the click would seem to do nothing. Only a press asks for
 * it: a list that is open already when its block is drawn again moves nothing.
 */
function useReveal(open: unknown) {
  const host = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current) return;
    asked.current = false;
    if (open) {
      const rows = host.current?.querySelector(".simple-pass-list, .simple-edits");
      // When a row is already selected, useKeepSelectedInView keeps it in view; otherwise bring the first row in.
      if (rows && !rows.querySelector('[aria-current="true"]')) rows.querySelector(":scope > li > button")?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open]);
  return [host, () => { asked.current = true; }] as const;
}

/** What a request changed in the video: one sentence, its figures in bold, and on the same line the link that opens its edits. */
function Made({ parts, link }: { parts: readonly SentencePart[]; link?: ReactNode }) {
  if (!parts.length) return null;
  return <p className="simple-made-line"><span className="simple-made">{parts.map((part, i) => typeof part === "string" ? part : <b key={i}>{part.strong}</b>)}</span>{link}</p>;
}

/** One row of a pass's lists: an edit, a call, a rejected edit or a call decided before the pass applied. */
interface PassRow {
  key: string;
  /** The row by its first version, which a revision or a rejection doesn't change. */
  id: string;
  /** The rows this one took the place of: an edit's earlier versions. */
  was?: string[];
  at: number;
  displayAt: number;
  /** Where its marker lights on the timeline while the pointer is over the row. */
  mark?: number;
  hover?: HoveredReviewRow;
  label: string;
  /** The order a call reached the editor in, never shown; 0 for any other row. */
  n: number;
  callIndex?: number;
  num?: number;
  state?: string;
  decision?: string;
  value?: string;
  word?: string;
  revised: boolean;
  rejected: boolean;
  skipped: boolean;
  forYou: boolean;
  onlyForYou: boolean;
  busy: boolean;
  pending: boolean;
  needs: boolean;
  /** Scarlet stopped work on it to ask the editor something: the row waits on them again, and says Needs your answer. */
  asks: boolean;
  sentBack: boolean;
  decided: boolean;
  version: number;
  title?: string;
  on: boolean;
  open?: () => void;
  /** Take back Keep on this row from its hover control. */
  unkeep?: () => void;
  unkeepTip?: string;
  fresh: boolean;
  /** Structured hover tooltip content for the beta edits rail. */
  tip?: RowTooltipInfo;
  /** Seconds removed when this row is a cut (used to sum removed time on grouped `+N` rows). */
  removedSeconds?: number;
}

/** A row as a list draws it: one edit or call, or a moment, with the tab it is under. */
interface Entry {
  key: string;
  row: PassRow;
  members?: PassRow[];
  more?: string;
  moment?: string;
  unfolded?: boolean;
  place: RowPlace;
  at: number;
  num?: number;
}

/**
 * What a dialogue pass made, as its block in the chat. Its rows are drawn in the column of edits beside the chat
 * (`useReviewRail`, which SimpleWorkspaceBeta always provides), every list at once: Needs review with open calls and
 * flagged edits, the edits Scarlet didn't flag under Safe edits, Working with the rows Scarlet has, and Done every
 * decided row, each by its time, edits that play as one change on one row. A row opens its edit or call in the card on
 * the timeline. In the chat the block is one sentence on what the pass applied, See edit when it made one, and a
 * request about a cut or edit with no row (`nests`). `aside` is what the run used, when that shows.
 */
export function PassSummary({ projectId, thread, threadOrder = 0, edits, rejected = noRejected, actions, aside, list: listState, listedNeed, working, nests = noNests, spent = noSpent, lastOpen: heldOpen, listLoaded, askingRowKey }: { projectId: string; thread: Thread; threadOrder?: number; edits: Omit<ThreadEdit, "at">[];
  /** Edits the editor rejected: out of the video, each keeps a row in the list of every edit, with a × and "Rejected". */
  rejected?: Omit<ThreadEdit, "at">[];
  actions: ChatActions; aside?: ReactNode; list: PassList; listedNeed: RefObject<Set<string>>; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** The edit last opened, held by the turn: see `ThreadResult`. `linger` is the chat's held rows, which the column doesn't use. */
  linger?: ReviewLinger; lastOpen?: RefObject<string | undefined>;
  /** The engine's list of the request's edits has come: before then a row may move only because the list arrived. */
  listLoaded?: boolean;
  /** The row key whose question is currently displayed over the message box, so it lights up. */
  askingRowKey?: string }) {
  const reviewed = useReviewed(projectId, thread);
  const canUnkeep = useCanUnkeep(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const adding = useAdding(thread);
  const [open, setOpen] = listState;
  const [host, reveal] = useReveal(open);
  // The column of edits beside the chat, where the rows are drawn.
  const rail = useReviewRail()!;
  const { timeline } = useShownCut();
  const media = useProjectStore(s => s.current?.media);
  const fps = useProjectStore(s => s.current?.project.settings.fps);
  const threadChanges = useMemo(() => [...thread.changes, ...thread.flagged ?? []], [thread.changes, thread.flagged]);
  const clipsBySpot = useMemo(() => editClipIdsBySpot(threadChanges, edits, timeline), [threadChanges, edits, timeline]);
  const editByKey = useMemo(() => new Map(edits.map(e => [editKey(e), e])), [edits]);
  const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
  const openCalls = pass?.calls.filter(c => c.state === "open").length ?? 0;
  // Calls the editor decided before the pass applied are rows of Done: approved cuts link to their applied edit row,
  // and skipped calls (or approved keep proposals) are decided rows of their own.
  const { decidedCallEditKeys, decidedCallRows } = useMemo(
    () => decidedPassCalls(pass ? undefined : thread, edits, rejected),
    [pass, thread, edits, rejected],
  );
  const isForYouEdit = (e: Omit<ThreadEdit, "at">) => !!e.check || decidedCallEditKeys.has(editKey(e));
  const isForYouRejected = (e: Omit<ThreadEdit, "at">) => !!e.wasCheck || decidedCallEditKeys.has(editKey(e)) || listedBefore(listedNeed.current, e);
  // What waits on the editor: an open call and a flagged edit not yet kept. One sent back for revision waits on Scarlet,
  // until its request stops to ask the editor something: then it is their turn again.
  const need = waitingPassRows(pass?.calls, edits, isForYouEdit, { reviewed, revising });
  const tab = tabShown(open);
  // While the pass makes its final check of the finished cut, the fixes it applies are marked New in the list: nothing
  // else tells them from the cuts that went in before (2026-11-14).
  const rerun = working ? thread.tasks.find(t => !!t.repeatAudit?.returns && !!t.startedAt && isWorking(t.state)) : undefined;
  const fresh = useMemo(() => new Set(rerun ? thread.changes.filter(c => c.taskId === rerun.id && (c.createdAt ?? "") >= rerun.startedAt!).map(c => c.id) : []),
    [rerun, thread.changes]);
  // Edits that overlap on the timeline exactly are one row, a moment. Its own edits open under it on a press of
  // "+ 4 edits", and fold again on the next.
  const moments = useMemo(() => listMoments(edits), [edits]);
  const totalRows = edits.length + (pass?.calls.length ?? 0);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const single = !working && !pass?.running && totalRows === 1 ? edits[0] : undefined;
  // A single preview follows the open card. An explicitly opened list keeps the timeline on the whole pass.
  const fullList = open === "all" && edits.length > 0;
  // Beside the column of edits there is no list of every edit to open: one left open from the line that used to open
  // the edits Scarlet didn't flag lets go.
  useEffect(() => { if (open === "all") setOpen(undefined); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // A line mounted with its list already open is the same list, moved with its request between the conversation and
  // the place above the message box. It leaves the timeline where it is, so an edit of another request the editor has
  // open stays open. The list has the timeline back when that edit closes.
  const moved = useRef(fullList);
  useEffect(() => {
    if (!fullList) { moved.current = false; return; }
    actions.listOpen(thread.id, true, moved.current);
    return () => { actions.listOpen(thread.id, false); actions.lightMark(); };
  }, [fullList, thread.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A pass that has only just begun has nothing to sum up yet. Its rows appear with its first calls, or once it is done.
  // Every hook runs before the early return below so hooks stay stable when rows arrive.
  const empty = !edits.length && !pass && !decidedCallRows.length && !rejected.length;
  const count = edits.length || pass?.cuts || 0;
  // While Scarlet is still on a pass that has asked about no cut, nothing needs the editor. The block is the pass's
  // stages then: no count of the cuts staged so far, which would sit still between its parts, and nothing to schedule.
  const quiet = !!pass?.running && !pass.calls.length;
  // Every call is made but the pass isn't applied: it applies now or, while Scarlet still checks, when it finishes.
  // Under revision it waits for the revised cut to come back as a call. Before Scarlet has checked any staged cut there
  // is nothing to schedule: its calls haven't arrived. Only its calls hold it: a cut it already applied that asks for a
  // look is kept on its own card, and waits there whether or not the rest of the pass has gone in.
  const waiting = pass && !quiet && !openCalls && !pass.scheduled && !pass.revising && !pass.unchecked;
  const showing = actions.showing, listening = actions.listening;
  const rows: PassRow[] = [
    ...edits.map((e): PassRow => {
      const key = editKey(e);
      const forYou = isForYouEdit(e);
      const seen = reviewed(e);
      // A revision on its way: the row says so until the new version lands, whether or not the editor had kept the
      // edit. A cut the pass applied through its calls counts as kept, so a guard on that left its row as it was.
      const sent = revising(e);
      // One that came back revised with no reason from Scarlet says so until it is kept, as any other list's row does.
      const revised = e.check === REVISED_CHECK && !seen && !sent;
      const needs = !!e.check && !seen && !sent;
      const asks = asksEditor(sent);
      const sentBack = !!e.check && !seen && !!sent;
      // Ticked once the editor has kept it: any edit kept, an approved pass call, or a cut that went in with the pass
      // through its calls. That is what Keep's next row, the watch and the timeline's dots go by, so the tick agrees
      // with them (the editor's call, 2026-11-23).
      const decided = !needs && !sent && (seen || decidedCallEditKeys.has(key));
      const decision = decided ? (e.marker ? "Done" : "Kept") : undefined;
      // Where it stands while Scarlet is actively working on it (Revising…, Up next, Queued, Needs your answer).
      // Once revised, v2 sits beside the title and the row keeps its type tag on the right.
      const word = sent ? revisionWord(sent, { rejecting: rejecting(e), adding: adding(e), nextQueuedId: actions.nextQueuedId }) : undefined;
      const at = (e as ThreadEdit).at ?? e.range.start;
      const displayAt = (!seen && !sent ? e.reviewRange?.start : undefined) ?? at;
      const unkeepable = decided && !e.marker && canUnkeep(e) && !(!e.check && decidedCallEditKeys.has(key));
      const label = (e.reason && e.summary) || e.label;
      const version = e.previous.length ? e.previous.length + 1 : 0;
      const editChange = changeForEdit(thread, e.changeId);
      const removed = !!e.beforeCut || e.kind === "cut" ? cutRemovedSeconds(e, editChange) : undefined;
      const tip = editRowTooltip(e, { change: editChange, timeline, media, fps, version, status: word ?? decision });
      return { key, id: editKey(e.previous[0] ?? e), was: e.previous.map(editKey),
        at, displayAt, mark: displayAt, hover: { threadId: thread.id, editKey: key },
        label, n: 0, num: undefined,
        state: word ?? decision ?? (version ? `v${version}` : undefined), decision, value: editRowWord(e), word, revised, rejected: false, skipped: false,
        forYou, onlyForYou: false,
        // Scarlet is on that revision now, so its word moves; one still waiting its turn sits still.
        busy: !!sent && isWorking(sent.state), pending: !!sent, needs, asks, sentBack, decided,
        version, title: revised || e.reason ? undefined : e.check,
        on: !!showing && matchesEdit(showing, e), open: () => actions.openEdit(thread, e),
        ...(unkeepable && {
          unkeep: () => {
            actions.lightMark();
            unkeepEdits(projectId, thread.id, [e]);
            recordUndo({ kind: "unkeep", word: "Unkeep", projectId, threadId: thread.id, refs: [e], name: label });
          },
          unkeepTip: "Move back to Needs review",
        }),
        fresh: fresh.has(e.changeId), tip, removedSeconds: removed };
    }),
    // A call goes by its time, as on its card and in the box's tag.
    ...(pass?.calls ?? []).map((c): PassRow => {
      const callWord = c.state === "revising" ? (revisionWord(c.run, { recheck: !!c.run && isRecheck(c.run), nextQueuedId: actions.nextQueuedId }) ?? "Revising…") : undefined;
      const tip = callRowTooltip({ summary: c.summary, reason: c.reason, tag: c.tag, length: c.length, state: c.state, version: c.version, earlier: c.earlier, word: callWord });
      return { key: callRowKey(c), id: callRowKey(c), at: c.start, displayAt: c.start, mark: c.at,
        hover: { threadId: thread.id, call: c.index },
        label: c.summary, n: c.n, callIndex: c.index, num: undefined, needs: c.state === "open", asks: c.state === "revising" && asksEditor(c.run), sentBack: c.state === "revising",
        decided: c.state === "approved" || c.state === "skipped", skipped: c.state === "skipped",
        decision: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : undefined,
        state: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? (c.version > 1 ? `v${c.version}` : undefined),
        value: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : callWord ?? c.tag,
        busy: c.state === "revising" && isWorking(c.run?.state), pending: c.state === "revising",
        version: c.version > 1 ? c.version : 0, title: c.earlier && `v${c.version - 1}: ${c.earlier.reason ?? "Scarlet’s earlier version."}${c.earlier.note ? `\nYou: “${c.earlier.note}”` : ""}`,
        on: listening?.changeId === pass!.change.id && listening.index === c.index, word: undefined, revised: false, rejected: false,
        forYou: true, onlyForYou: false, fresh: false, tip, removedSeconds: c.tag === "Cut" ? c.length : undefined,
        ...(c.state === "approved" && !pass!.deciding && pass!.unkeepCall && {
          unkeep: () => { actions.lightMark(); pass!.unkeepCall!(c.index); },
          unkeepTip: "Move back to Needs review",
        }),
        // A call sent back opens from its row in Working, as an edit sent back does: its card says where its revision
        // stands, and ↑ ↓ then step through Working's rows.
        open: () => pass!.openCall(c.index) };
    }),
    // An edit the editor rejected is out of the video. Its row stays in Done, with a × where a kept one has its tick
    // and "Rejected" where it said how much it took.
    ...rejected.map((e): PassRow => {
      const forYou = isForYouRejected(e);
      const key = editKey(e);
      const editChange = changeForEdit(thread, e.changeId);
      const tip = editRowTooltip(e, { change: editChange, timeline, media, fps });
      return { key, id: editKey(e.previous[0] ?? e), was: e.previous.map(editKey), at: e.range.start, displayAt: e.range.start, mark: undefined,
        hover: { threadId: thread.id, editKey: key },
        label: e.label, n: 0, num: undefined, state: "Rejected", decision: "Rejected",
        value: "Rejected", word: undefined, revised: false, rejected: true, skipped: false,
        forYou, onlyForYou: false, busy: false, pending: false, needs: false, asks: false, sentBack: false, decided: false, version: 0,
        title: undefined, on: !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)),
        open: () => actions.openEdit(thread, e), fresh: false, tip };
    }),
    // Calls decided before the pass applied that produced no applied edit (skipped cuts, or approved keep proposals).
    // A rejected one opens as a rejected edit's row does: lit, on the timeline where it was, with its note and Rejected.
    ...decidedCallRows.map((c): PassRow => {
      const ref = rejectedCallRef(c.changeId, c.index);
      const tip = decidedCallRowTooltip(c);
      return { key: c.key, id: c.key, at: c.at, displayAt: c.at, mark: undefined,
        hover: undefined,
        label: c.label, n: 0, num: undefined,
        state: c.approved ? "Kept" : "Rejected", decision: c.approved ? "Kept" : "Rejected",
        value: c.approved ? "Kept" : "Rejected", word: undefined,
        revised: false, rejected: !c.approved, skipped: false, forYou: true, onlyForYou: true, busy: false, pending: false, needs: false, asks: false, sentBack: false,
        decided: c.approved, version: 0, title: undefined, on: !c.approved && !!showing && matchesEdit(showing, ref),
        open: c.approved ? undefined : () => actions.openEdit(thread, ref), fresh: false, tip };
    }),
  ].sort((a, b) => a.at - b.at);
  // The pass's calls and the edits that ask for a look: while any of them is listed the pass has something to say.
  const calls = pass ? rows.filter(r => r.n > 0 || r.forYou) : [];
  // Rows go by moments, at the time of the first of its edits. The moment's row stands for all of them: ticked once
  // they're all kept, Revising… while Scarlet is on one (or Up next / Queued while one waits its turn), and lit while
  // the moment is open. Its own edits show only once it is unfolded, or while one of them is open on its own, each
  // without a time: they all play in the moment's stretch. An edit that asks for a look and a call stay one a row.
  const momentOf = new Map<string, Moment<Omit<ThreadEdit, "at">>>();
  for (const m of moments) if (m.edits.length > 1) for (const e of m.edits) momentOf.set(editKey(e), m);
  const byKey = new Map(rows.map(row => [row.key, row]));
  // A request that itself waits on the editor (a question, or one that stopped early) keeps its row in Needs review.
  const asks = new Set(nests.flatMap(nest => nest.needs ? [nest.key] : []));
  const placeOf = (r: PassRow): RowPlace => r.needs || r.asks ? "you" : r.pending ? "working" : r.decided || r.rejected || r.onlyForYou ? "done" : "optional";
  const entries: Entry[] = [];
  const momentsDrawn = new Set<string>();
  for (const row of rows) {
    const moment = momentOf.get(row.key);
    if (!moment) { entries.push({ key: row.key, row, place: asks.has(row.key) ? "you" : placeOf(row), at: row.at, num: row.num }); continue; }
    if (momentsDrawn.has(moment.key)) continue;
    momentsDrawn.add(moment.key);
    const members = moment.members.flatMap(e => {
      const member = byKey.get(editKey(e));
      // One of its edits opened on its own from here is that edit alone: Keep and Revise are about it.
      return member ? [{ ...member, on: member.on && !!actions.showingSingle, open: member.open && (() => actions.openEdit(thread, e, undefined, true)) }] : [];
    });
    const main = byKey.get(moment.key) ?? row;
    const others = moment.edits.filter(e => e !== moment.main);
    const sent = members.find(m => m.asks) ?? members.find(m => m.busy) ?? members.find(m => m.word === "Up next") ?? members.find(m => m.pending);
    const more = others.length === 1 ? `+ ${(others[0]!.beforeCut ? "cut" : editKindWord(others[0] as ThreadEdit)?.toLowerCase()) ?? "1 edit"}` : `+ ${others.length} edits`;
    const allDecided = members.every(m => m.decided);
    const unkeepMembers = allDecided ? moment.edits.filter(e => !e.marker && canUnkeep(e) && !(!e.check && decidedCallEditKeys.has(editKey(e)))) : [];
    const momentRange = { start: Math.min(...moment.edits.map(e => e.range.start)), end: Math.max(...moment.edits.map(e => e.range.end)) };
    const momentTip = momentRowTooltip(main.label, members.map(m => ({ label: m.label, value: m.value, kind: m.tip?.meta })), momentRange, sent?.word ?? (allDecided ? main.decision ?? "Kept" : undefined));
    entries.push({ key: main.key, row: { ...main, displayAt: Math.min(...members.map(m => m.displayAt)), on: main.on && !actions.showingSingle,
      decided: allDecided, decision: allDecided ? main.decision ?? "Kept" : undefined, word: sent?.word ?? main.word, asks: !!sent?.asks, busy: !sent?.asks && members.some(m => m.busy),
      revised: !sent && members.some(m => m.revised), pending: members.some(m => m.pending),
      unkeep: unkeepMembers.length > 0 ? () => {
        actions.lightMark();
        unkeepEdits(projectId, thread.id, unkeepMembers);
        recordUndo({ kind: "unkeep", word: "Unkeep", projectId, threadId: thread.id, refs: unkeepMembers, name: main.label });
      } : undefined,
      unkeepTip: unkeepMembers.length > 0 ? "Move back to Needs review" : undefined,
      was: members.flatMap(m => m.was ?? []), title: members.map(m => m.label).join("\n"), tip: momentTip }, members, more, moment: moment.key,
      unfolded: unfolded.has(moment.key) || members.some(m => m.on),
      place: members.some(m => asks.has(m.key)) ? "you" : rowPlace(members, { waits: m => m.needs || m.asks, sent: m => m.pending, kept: m => m.decided }),
      at: Math.min(...members.map(m => m.at)) });
  }
  // Needs review, Working and Done are all in the column at once, so a kept or sent-back edit moves straight there
  // without lingering where it was.
  const inPlace = (place: RowPlace) => entries.filter(e => e.place === place);
  // Every list goes by time, as its rows lead with their times.
  const order: ListOrder = { numbers: false };
  const optional = inPlace("optional");
  // The column's lists, top to bottom.
  const drawn = (["you", "optional", "working", "done"] as const).map(id => ({ id, rows: inListOrder(inPlace(id), order) }));
  for (const list of drawn) if (list.id === "you") for (const { row } of list.rows) if (row.forYou) listedNeed.current.add(row.key);
  // An edit or a call opened from somewhere else (the timeline, ⌘Z) shows the list that holds it: Working or Done, as
  // Needs review and Safe edits are always on screen. The same one still open when the block is mounted anew, between
  // the conversation and the place above the message box, leaves the lists as they were.
  const onEntry = entries.find(e => e.row.on || e.members?.some(m => m.on));
  const ownOpen = useRef<string>(undefined);
  const lastOpen = heldOpen ?? ownOpen;
  const openId = onEntry?.row.id;
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!onEntry || openId === was) return;
    const at = onEntry.place;
    const shown = tab === "you" ? at === "you" || at === "optional" : at === tab;
    if (!shown) setOpen(at === "you" || at === "optional" ? undefined : at);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  // What it came to, once Scarlet is done, while calls still wait too: what it applied so far, with the link that opens
  // every edit after it. Until its cuts are applied, a pass that finished with no call to make says how many it has ready.
  // The edits the sentence would name are said by their rows while the lists on screen have one for each of them.
  const named = (e: Omit<ThreadEdit, "at">) => !e.beforeCut && !e.marker && !e.elsewhere;
  const keysOf = ({ row, members }: Entry) => [row.key, ...members?.map(m => m.key) ?? []];
  const onScreen = new Set(drawn.flatMap(list => list.rows.flatMap(keysOf)));
  const rowsName = edits.filter(named).every(e => onScreen.has(editKey(e)));
  const made: SentencePart[] | undefined = edits.length ? working ? undefined : madeSentence(edits, lengthLabel, true, rowsName)
    : calls.length || quiet || decidedCallRows.length || rejected.length ? undefined : [{ strong: plural(count, "cut") }, " ready."];
  // Folded, a request about any of the moment's edits sits under the moment's row; unfolded, under its edit's.
  const under = ({ row, members, unfolded: momentOpen }: Entry) => nests.filter(nest => nest.key === row.key || (!momentOpen && !!members?.some(m => m.key === nest.key)));
  const fold = (key: string) => setUnfolded(was => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  // The list follows the cut or edit that's open, so stepping with arrows or Keep never leaves its row out of sight.
  let selectedKey: string | undefined;
  if (!empty) {
    scan: for (const list of drawn) {
      let before = 0;
      for (const entry of list.rows) {
        const { row, members, unfolded: momentOpen } = entry;
        if (row.on) { selectedKey = `${list.id}:${before}:${row.key}`; break scan; }
        before += 1 + under(entry).length;
        if (momentOpen && members) for (const m of members) {
          if (m.on) { selectedKey = `${list.id}:${before}:member:${m.key}`; break scan; }
          before += 1 + nests.filter(nest => nest.key === m.key && m.key !== row.key).length;
        }
      }
    }
  }
  useKeepSelectedInView(host, selectedKey, ".simple-pass-list [aria-current=\"true\"]");
  // Report structured rows to the unified beta edits column so every section sorts by video time and combines
  // cross-request edits touching the same clip or stretch.
  const railRows: RailRow[] | undefined = empty ? undefined : entries.map((entry): RailRow => {
    const { row, members: entryMembers, more, moment: momentKey, unfolded: momentOpen, place } = entry;
    const isCall = row.n > 0;
    const singleEdit = !isCall && !row.rejected && !row.onlyForYou && !momentKey ? editByKey.get(row.key) : undefined;
    const singleChange = singleEdit ? changeForEdit(thread, singleEdit.changeId) : undefined;
    const momentEdits = momentKey ? moments.find(m => m.key === momentKey)?.edits : undefined;
    const rowEdits = momentEdits ?? (singleEdit ? [singleEdit] : []);
    const railMembers: RailEditMember[] = rowEdits.map(e => ({
      threadId: thread.id,
      edit: e,
      canUnkeep: !e.marker && canUnkeep(e) && !(!e.check && decidedCallEditKeys.has(editKey(e))),
    }));
    const spotClips = singleEdit ? clipsBySpot.get(editKey(singleEdit)) : undefined;
    const combinable = !!singleEdit && !singleEdit.beforeCut && (singleEdit as ThreadEdit).at === undefined
      && singleEdit.kind !== "cut" && !singleEdit.marker && railMembers.length > 0;
    const rowNests = under(entry);
    const countsAsNeed = isCall ? (row.needs || row.asks) : (row.needs || (row.forYou && row.asks));
    const hasNeedNest = rowNests.some(n => !!n.needs);
    const tipText = row.tip?.tip ?? (momentKey && row.title ? row.title : row.label);
    const tipMeta = row.tip?.meta;
    const tipDetail = row.tip ? row.tip.detail : (!momentKey && row.title && row.title !== row.label ? row.title : undefined);
    const subRows: RailSubRow[] | undefined = more && momentKey && entryMembers ? entryMembers.map(m => ({
      key: m.key, label: m.label, title: m.title, tipMeta: m.tip?.meta, tipDetail: m.tip?.detail, value: m.value, word: m.word, decided: m.decided, needs: m.needs,
      asks: m.asks, busy: m.busy, revised: m.revised, version: m.version, spent: spent.get(m.key), on: m.on,
      mark: m.mark, hover: m.hover, open: m.open, unkeep: m.unkeep, unkeepTip: m.unkeepTip,
      nests: nests.filter(nest => nest.key === m.key && m.key !== row.key),
    })) : undefined;
    return {
      key: row.key,
      was: row.was,
      threadId: thread.id,
      threadOrder,
      at: entry.at,
      displayAt: row.displayAt,
      mark: row.mark,
      hover: row.hover,
      place,
      label: row.label,
      rawLabel: singleEdit?.label,
      editKind: singleEdit?.kind,
      stretch: singleEdit?.range,
      clipIds: spotClips?.clipIds,
      overlayClipIds: spotClips?.overlayClipIds,
      combinable,
      value: row.value,
      word: row.word,
      decision: row.decision,
      needs: row.needs,
      asks: row.asks,
      isAskingCurrent: !!askingRowKey && askingRowKey === row.key,
      pending: row.pending,
      busy: row.busy,
      revised: row.revised,
      decided: row.decided,
      rejected: row.rejected,
      skipped: row.skipped,
      countsAsNeed,
      hasNeedNest,
      isCall,
      isDialoguePass: true,
      batchTitle: singleChange?.batchTitle?.trim() || undefined,
      batchContext: singleChange?.description?.trim() || undefined,
      requestText: thread.title?.trim() || undefined,
      reason: singleEdit?.reason?.trim() || undefined,
      threadWorking: !!working,
      isMarker: !!singleEdit?.marker,
      on: row.on,
      version: row.version,
      fresh: row.fresh,
      spent: spent.get(row.key),
      tipText,
      tipMeta,
      tipDetail,
      removedSeconds: row.removedSeconds,
      logControl: "open-pass-item",
      logLabel: momentKey ? "Moment" : "Pass item",
      open: row.open,
      members: railMembers,
      unkeepCall: isCall ? row.unkeep : undefined,
      unkeepTip: row.unkeepTip,
      hadCheck: rowEdits.some(e => !!e.check),
      nests: rowNests,
      ...(subRows && momentKey && more && { moment: { key: momentKey, more, unfolded: !!momentOpen, toggle: () => fold(momentKey), subRows } }),
      callIndex: row.callIndex,
      editRef: singleEdit,
    };
  });
  useEffect(() => {
    rail.report(thread.id, empty ? undefined : {
      you: need, optional: optional.length, working: inPlace("working").length, done: inPlace("done").length,
      threadOrder, rows: railRows, edits, listLoaded,
    });
  });
  useEffect(() => () => { rail.report(thread.id); }, [rail, thread.id]);
  if (empty) return null;
  // A request whose row is under a list is drawn there, under that row, and nowhere else. One about a cut or edit with
  // no row at all still shows, under what the pass made.
  const placed = new Set(entries.flatMap(keysOf));
  const soFar = (!!working || !!pass?.running) && !made;
  const canSeeAll = edits.length > 0;
  const seeProps = { thread, actions, single, rows: totalRows + rejected.length, count: totalRows, soFar, list: listState, reveal, column: true };
  // A request's one edit keeps its See edit link; the column holds every other row.
  const seeEvery = single && canSeeAll ? <EditResultLink {...seeProps} place="inline" /> : null;
  return <div ref={host} className="simple-pass" role="group" aria-label="Dialogue pass" data-thread={thread.id}>
    {made && <Made parts={made} link={seeEvery} />}
    {/* A request about a cut or edit that has no row still shows, under what the pass made. */}
    {nests.filter(nest => !placed.has(nest.key)).map(nest => nest.node)}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      {/* The pass goes in once its calls are decided and Scarlet finishes checking. */}
      {waiting && pass.deciding && <span className="simple-pass-ok">Applying…</span>}
      <span className="req-right">{aside}</span>
    </div>
    {/* Only a failed apply offers Retry, after the reason. */}
    {pass?.error && <p className="simple-error" role="alert">{pass.error}
      {waiting && !pass.deciding && <button type="button" className="simple-link req-recover" onClick={pass.apply}>Retry</button>}</p>}
  </div>;
}

/**
 * What any other request made, as its block in the chat: one sentence, See edit when it made one, and a request about
 * an edit with no row (`nests`). Its rows are in the column of edits, as a pass's are: Needs review lists the flagged
 * edits not yet decided, Safe edits the ones Scarlet didn't flag, Working the ones sent back and Done the ones kept or
 * rejected. Edits of one name that overlap exactly are one row.
 */
export function ThreadResult({ projectId, thread, threadOrder = 0, edits, rejected, actions, aside, working, nests = noNests, spent = noSpent, list, listedNeed, lastOpen: heldOpen, listLoaded, askingRowKey }: { projectId: string; thread: Thread; threadOrder?: number; edits: Omit<ThreadEdit, "at">[]; rejected?: Omit<ThreadEdit, "at">[]; actions: ChatActions;
  aside?: ReactNode; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** Which list is open and what Needs review has listed, held by the turn: the block is mounted anew when it moves
   *  between the conversation and the place above the message box, and a list the editor opened must not close then,
   *  nor turn into another. `lastOpen` is the edit last opened. `wasShowing` and `linger` are the chat's, which the
   *  column doesn't use. */
  list: PassList; listedNeed: RefObject<Set<string>>; wasShowing?: RefObject<boolean>; linger?: ReviewLinger; lastOpen?: RefObject<string | undefined>;
  /** The engine's list of the request's edits has come: see `PassSummary`. */
  listLoaded?: boolean;
  /** The row key whose question is currently displayed over the message box, so it lights up. */
  askingRowKey?: string }) {
  const reviewed = useReviewed(projectId, thread);
  const canUnkeep = useCanUnkeep(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const adding = useAdding(thread);
  const [open, setOpen] = list;
  const [host, reveal] = useReveal(open);
  const rail = useReviewRail()!;
  const { timeline } = useShownCut();
  const media = useProjectStore(s => s.current?.media);
  const fps = useProjectStore(s => s.current?.project.settings.fps);
  const threadChanges = useMemo(() => [...thread.changes, ...thread.flagged ?? []], [thread.changes, thread.flagged]);
  const clipsBySpot = useMemo(() => editClipIdsBySpot(threadChanges, edits, timeline), [threadChanges, edits, timeline]);
  const gone = rejected ?? noRejected;
  // An edit open on the timeline: the one that's open, or one that opens with it when none is.
  const showing = actions.showing;
  const shownEdit = showing && edits.find(e => matchesEdit(showing, e));
  // Edits of one name that overlap exactly are one edit, on one row of the list: Needs review counts the rows that wait.
  const groups = useMemo(() => editGroups(edits), [edits]);
  // So does one sent back whose request has stopped to ask the editor something: it is their turn again.
  const need = useMemo(() => waitingRows(edits, { reviewed, revising }), [edits, reviewed, revising]);
  const tab = tabShown(open);
  // Where each row is: every edit and every rejected one is in exactly one list. A request that itself waits on the
  // editor (a question, or one that stopped early) keeps its row in Needs review. Working and Done are right below,
  // so a decided or sent-back edit moves there at once.
  const asks = new Set(nests.flatMap(nest => nest.needs ? [nest.key] : []));
  const rowOf = new Map<string, string>(), placeOf = new Map<string, RowPlace>();
  const tracked: { key: string; place: RowPlace }[] = [];
  for (const { members } of groups) {
    const row = members.map(m => m.edit), key = editKey(row[0]!);
    const place = row.some(e => asks.has(editKey(e))) ? "you"
      : rowPlace(row, { waits: e => asksEditor(revising(e)) || (!!e.check && !reviewed(e) && !revising(e)), sent: e => !!revising(e), kept: e => reviewed(e) });
    for (const e of row) rowOf.set(editKey(e), key);
    placeOf.set(key, place);
    tracked.push({ key, place });
  }
  for (const e of gone) {
    const key = editKey(e);
    rowOf.set(key, key);
    placeOf.set(key, "done");
    tracked.push({ key, place: "done" });
  }
  const place = (e: Omit<ThreadEdit, "at">) => placeOf.get(rowOf.get(editKey(e)) ?? "");
  const onScreen = (e: Omit<ThreadEdit, "at">) => { const at = place(e); return tab === "you" ? at === "you" || at === "optional" : at === tab; };
  const countOf = (at: RowPlace) => tracked.filter(row => row.place === at).length;
  const single = !working && groups.length === 1 ? shownEdit ?? edits[0] : undefined;
  // An edit opened from somewhere else (the timeline, ⌘Z) shows the list that holds it: Needs review for one that
  // waits, Working for one sent back, Done for one decided. One opened from the list, stepped to or moved on to is in
  // the list shown already.
  const openEdit = showing && (shownEdit ?? gone.find(e => matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)));
  const openId = openEdit ? editKey(openEdit.previous[0] ?? openEdit) : undefined;
  const ownOpen = useRef<string>(undefined);
  const lastOpen = heldOpen ?? ownOpen;
  useEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = openId;
    if (!openEdit || openId === was) return;
    const at = place(openEdit);
    const shown = tab === "you" ? at === "you" || at === "optional" : at === tab;
    if (shown) { if (at === "you") setOpen(o => o ?? "need"); }
    else if (at) setOpen(at === "you" ? "need" : at === "optional" ? undefined : at);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  // There is no list of every edit to open: one left open from the line that used to open the edits Scarlet didn't
  // flag lets go, as they are listed under Safe edits.
  useEffect(() => { if (open === "all") setOpen(undefined); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (tab === "you") {
    for (const edit of edits) if (place(edit) === "you") listedNeed.current.add(editKey(edit));
    for (const edit of gone) if (place(edit) === "you") listedNeed.current.add(editKey(edit));
  }
  // The edits the sentence would name are said by their rows while the lists on screen have one for each of them.
  const rowsName = edits.every(e => e.beforeCut || e.marker || e.elsewhere || onScreen(e));
  const made = useMemo(() => {
    if (working) return undefined;
    const said = madeSentence(edits, lengthLabel, false, rowsName);
    // A request that only flagged an edit another one made has made nothing to say.
    return said.length ? said : undefined;
  }, [working, edits, rowsName]);
  // A request about an edit with a row is drawn under that row in the column and nowhere else.
  const listed = new Set(rowOf.keys());
  const canSeeAll = open === "all" || edits.length > 0;
  const seeProps = { thread, actions, single, rows: groups.length + gone.length, count: groups.length, soFar: working && !made, list, reveal, column: true };
  const seeEvery = single && canSeeAll ? <EditResultLink {...seeProps} place="inline" /> : null;
  const optional = countOf("optional");
  const railRows: RailRow[] | undefined = !edits.length && !gone.length ? undefined : [
    ...groups.map(({ members }): RailRow => {
      const rowEdits = members.map(m => m.edit);
      const waiting = (e: Omit<ThreadEdit, "at">) => !!e.check && !reviewed(e) && !revising(e);
      const asking = (e: Omit<ThreadEdit, "at">) => asksEditor(revising(e));
      const openHere = showing?.rejected ? undefined : rowEdits.find(e => !!showing && matchesEdit(showing, e));
      const shown = openHere ?? rowEdits.find(asking) ?? rowEdits.find(waiting) ?? rowEdits[0]!;
      const key = editKey(shown);
      const rowNests = rowEdits.flatMap(e => nests.filter(n => n.key === editKey(e)));
      const hasNeedNest = rowNests.some(n => !!n.needs);
      const rowTabPlace = placeOf.get(editKey(rowEdits[0]!)) ?? "optional";
      const on = !!openHere;
      const isKept = rowEdits.every(e => reviewed(e));
      const revisingNow = revising(shown) ?? rowEdits.map(revising).find(r => !!r && isWorking(r.state)) ?? rowEdits.map(revising).find(Boolean);
      const isRevising = !!revisingNow;
      const busy = !!revisingNow && isWorking(revisingNow.state);
      const word = revisionWord(revisingNow, { rejecting: rowEdits.some(rejecting), adding: rowEdits.some(adding), nextQueuedId: actions.nextQueuedId });
      const asks = asksEditor(revisingNow);
      const revised = shown.check === REVISED_CHECK && !reviewed(shown) && !isRevising;
      const decided = isKept && !isRevising;
      const decision = decided ? (shown.marker ? "Done" : "Kept") : undefined;
      const needs = !asks && !isRevising && rowEdits.some(waiting);
      const countsAsNeed = rowEdits.some(e => asksEditor(revising(e)) || (!!e.check && !reviewed(e) && !revising(e)));
      const at = Math.min(...rowEdits.map(e => (e as ThreadEdit).at ?? e.range.start));
      const displayAt = (!reviewed(shown) && !isRevising ? shown.reviewRange?.start : undefined) ?? ((shown as ThreadEdit).at ?? shown.range.start);
      const value = rowTabPlace === "done" ? decision : editRowWord(shown);
      const label = (shown.reason && shown.summary) || shown.label;
      const checkTitle = revised || shown.reason ? undefined : shown.check;
      const version = rowEdits.length === 1 && shown.previous.length ? shown.previous.length + 1 : 0;
      const spentText = rowEdits.map(e => spent.get(editKey(e))).find(Boolean);
      const isAskingCurrent = !!askingRowKey && rowEdits.some(e => editKey(e) === askingRowKey);
      const combinable = !shown.beforeCut && (shown as ThreadEdit).at === undefined && shown.kind !== "cut" && !shown.marker;
      const stretch: TimeRange = {
        start: Math.min(...rowEdits.map(e => e.range.start)),
        end: Math.max(...rowEdits.map(e => e.range.end)),
      };
      const allClipIds = new Set<string>();
      const allOverlayIds = new Set<string>();
      for (const e of rowEdits) {
        const sc = clipsBySpot.get(editKey(e));
        if (!sc) continue;
        for (const id of sc.clipIds) allClipIds.add(id);
        for (const id of sc.overlayClipIds) allOverlayIds.add(id);
      }
      const railMembers: RailEditMember[] = rowEdits.map(e => ({
        threadId: thread.id,
        edit: e,
        canUnkeep: !e.marker && canUnkeep(e),
      }));
      const shownChange = changeForEdit(thread, shown.changeId);
      const removed = !!shown.beforeCut || shown.kind === "cut" ? cutRemovedSeconds(shown, shownChange) : undefined;
      const rowTip = editRowTooltip(shown, {
        change: shownChange,
        timeline,
        media,
        fps,
        places: rowEdits.length,
        version,
        status: word ?? decision,
      });
      return {
        key,
        was: rowEdits.flatMap(e => e.previous.map(editKey)),
        threadId: thread.id,
        threadOrder,
        at,
        displayAt,
        mark: displayAt,
        hover: { threadId: thread.id, editKey: key },
        place: rowTabPlace,
        label,
        rawLabel: shown.label,
        batchTitle: shownChange?.batchTitle?.trim() || undefined,
        batchContext: shownChange?.description?.trim() || undefined,
        requestText: thread.title?.trim() || undefined,
        reason: shown.reason?.trim() || undefined,
        threadWorking: !!working,
        editKind: shown.kind,
        stretch,
        clipIds: allClipIds.size ? [...allClipIds] : undefined,
        overlayClipIds: allOverlayIds.size ? [...allOverlayIds] : undefined,
        combinable,
        value,
        word,
        decision,
        needs,
        asks,
        isAskingCurrent,
        pending: isRevising,
        busy,
        revised,
        decided,
        rejected: false,
        skipped: false,
        countsAsNeed,
        hasNeedNest,
        isMarker: !!shown.marker,
        on,
        version,
        spent: spentText,
        tipText: rowTip.tip,
        tipMeta: rowTip.meta,
        tipDetail: rowTip.detail ?? checkTitle,
        removedSeconds: removed,
        logControl: "open-edit",
        logLabel: "Edit",
        open: () => actions.openEdit(thread, shown),
        members: railMembers,
        hadCheck: rowEdits.some(e => !!e.check),
        nests: rowNests,
        editRef: shown,
      };
    }),
    ...gone.map((e): RailRow => {
      const key = editKey(e);
      const rowNests = nests.filter(n => n.key === key);
      const on = !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing));
      const goneTip = editRowTooltip(e, { change: changeForEdit(thread, e.changeId), timeline, media, fps });
      return {
        key,
        was: e.previous.map(editKey),
        threadId: thread.id,
        threadOrder,
        at: e.range.start,
        displayAt: e.range.start,
        mark: undefined,
        hover: { threadId: thread.id, editKey: key },
        place: "done",
        label: e.label,
        rawLabel: e.label,
        combinable: false,
        value: "Rejected",
        word: undefined,
        decision: "Rejected",
        needs: false,
        asks: false,
        isAskingCurrent: false,
        pending: false,
        busy: false,
        revised: false,
        decided: false,
        rejected: true,
        skipped: false,
        countsAsNeed: false,
        hasNeedNest: rowNests.some(n => !!n.needs),
        on,
        version: 0,
        tipText: goneTip.tip,
        tipMeta: goneTip.meta,
        tipDetail: goneTip.detail,
        logControl: "open-edit",
        logLabel: "Rejected edit",
        open: () => actions.openEdit(thread, e),
        members: [],
        nests: rowNests,
        editRef: e,
      };
    }),
  ];
  useEffect(() => {
    rail.report(thread.id, !edits.length && !gone.length ? undefined : {
      you: need, optional, working: countOf("working"), done: countOf("done"),
      threadOrder, rows: railRows, edits, listLoaded,
    });
  });
  useEffect(() => () => { rail.report(thread.id); }, [rail, thread.id]);
  return <div ref={host} className="simple-pass" role="group" aria-label="Edits" data-thread={thread.id}>
    {made && <Made parts={made} link={seeEvery} />}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      <span className="req-right">{aside}
        {/* Undo these edits and File this thread have no place in the chat for now. What they reported still shows. */}
        <ThreadAction projectId={projectId} thread={thread} edits={edits} onPlay={ref => actions.openEdit(thread, ref)} menuOnly menu={false} /></span>
    </div>
    {nests.filter(nest => !listed.has(nest.key)).map(nest => nest.node)}
  </div>;
}
