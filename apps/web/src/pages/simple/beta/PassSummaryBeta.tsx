import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { clipRange, type Change, type Clip, type TimeRange, type Timeline, type Track } from "@scarlet/timeline";
import { matchesEdit, REVISED_CHECK, type ThreadEdit } from "@scarlet/shared";
import { ThreadAction } from "../../../components/review/ThreadEdits";
import { asksEditor, revisionWord } from "../../../components/review/threadEditState";
import { editRowWord } from "../../../lib/editKind";
import { changeForEdit, cutRemovedSeconds, editRowTooltip } from "../../../lib/editRowTooltip";
import { lengthLabel } from "../../../lib/format";
import { editKey } from "../../../lib/keptEdits";
import { madeSentence } from "../../../lib/madeSentence";
import { inListOrder, tabShown, type ListOrder, type ReviewLinger, type RowPlace } from "./reviewTabsBeta";
import { type Thread } from "../../../lib/threads";
import { useKeepSelectedInView } from "../../../lib/uiHooks";
import { useProjectStore } from "../../../stores/project";
import { useWorkingModel } from "../../../lib/workingModel";
import { useShownCut } from "../../../stores/shownCut";
import { EditResultLink, entryKeys, Made, namedEdit, nestsUnder, passEntries, passMade, selectedRowKey, useListOpen, usePassFacts, useReveal, useThreadFacts, threadRowPlaces, type Entry } from "../passRows";
import { useReviewRail, type RailEditMember, type RailRow, type RailSubRow } from "../railStore";
import { isWorking, noNests, noRejected, noSpent, type ChatActions, type Nest, type PassList, type Spent } from "../types";

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
  const facts = usePassFacts({ projectId, thread, edits, rejected, actions, listedNeed, working });
  const { canUnkeep, pass, decidedCallEditKeys, need, moments, totalRows, fold, single, empty, waiting } = facts;
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
  const tab = tabShown(open);
  // A single preview follows the open card. An explicitly opened list keeps the timeline on the whole pass.
  const fullList = open === "all" && edits.length > 0;
  // Beside the column of edits there is no list of every edit to open: one left open from the line that used to open
  // the edits Scarlet didn't flag lets go.
  useEffect(() => { if (open === "all") setOpen(undefined); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useListOpen(actions, thread.id, fullList);
  // Every row is drawn, in the column, where a call sent back opens from its row in Working as an edit sent back does:
  // its card says where its revision stands, and ↑ ↓ then step through Working's rows.
  const { calls, entries } = passEntries(facts, { projectId, thread, edits, rejected, actions, nests },
    { drawRows: true, backToReview: true, openRevising: true, rail: { timeline, media, fps } });
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
  // What it came to, with See edit after it for a request's one edit. The edits the sentence would name are said by
  // their rows, every one of which is in the column.
  const onScreen = new Set(drawn.flatMap(list => list.rows.flatMap(entryKeys)));
  const rowsName = edits.filter(namedEdit).every(e => onScreen.has(editKey(e)));
  const made = passMade(facts, edits, rejected, calls, working, rowsName);
  const under = (entry: Entry) => nestsUnder(nests, entry);
  useKeepSelectedInView(host, !empty ? selectedRowKey(drawn, nests) : undefined, ".simple-pass-list [aria-current=\"true\"]");
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
  const placed = new Set(entries.flatMap(entryKeys));
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
      {waiting && pass?.deciding && <span className="simple-pass-ok">Applying…</span>}
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
  const facts = useThreadFacts({ projectId, thread, edits, rejected, actions });
  const modelAt = useWorkingModel();
  const { reviewed, canUnkeep, revising, rejecting, adding, gone, showing, shownEdit, groups, need, openEdit, openId } = facts;
  const [open, setOpen] = list;
  const [host, reveal] = useReveal(open);
  const rail = useReviewRail()!;
  const { timeline } = useShownCut();
  const media = useProjectStore(s => s.current?.media);
  const fps = useProjectStore(s => s.current?.project.settings.fps);
  const threadChanges = useMemo(() => [...thread.changes, ...thread.flagged ?? []], [thread.changes, thread.flagged]);
  const clipsBySpot = useMemo(() => editClipIdsBySpot(threadChanges, edits, timeline), [threadChanges, edits, timeline]);
  const tab = tabShown(open);
  // Each row's list. Working and Done are right below, so a decided or sent-back edit moves there at once.
  const { rowOf, placeOf, tracked } = threadRowPlaces(facts, nests);
  const place = (e: Omit<ThreadEdit, "at">) => placeOf.get(rowOf.get(editKey(e)) ?? "");
  const onScreen = (e: Omit<ThreadEdit, "at">) => { const at = place(e); return tab === "you" ? at === "you" || at === "optional" : at === tab; };
  const countOf = (at: RowPlace) => tracked.filter(row => row.place === at).length;
  const single = !working && groups.length === 1 ? shownEdit ?? edits[0] : undefined;
  // An edit opened from somewhere else (the timeline, ⌘Z) shows the list that holds it: Needs review for one that
  // waits, Working for one sent back, Done for one decided. One opened from the list, stepped to or moved on to is in
  // the list shown already.
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
        by: modelAt(revisingNow),
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
