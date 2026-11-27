import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { brollSectionForEdit, isAddRequest, isRejectRequest, matchesEdit, stretchesContiguous, threadEditList, type BrollSection, type EditRef, type Task, type Thread, type ThreadEdit } from "@scarlet/shared";
import type { TimeRange } from "@scarlet/timeline";
import { requestThreadEdits, useThreadEditKey } from "./threadEditRequest";
import { reviewKey, useKeptEdits } from "../../lib/keptEdits";
import { samePlace } from "../../lib/editMoments";
import { isActiveTask, isWorkingTask } from "../../lib/taskRun";
import { useProjectStore } from "../../stores/project";
import { useShownCutStore } from "../../stores/shownCut";

export type ListedEdit = Omit<ThreadEdit, "at">;

/**
 * A thread's edits as the timeline numbers them: the engine's list for the working cut, which leaves out
 * undone, superseded, and no-op work. The thread's raw saved list only stands in when there is no working cut yet
 * or the engine read failed — never while the first engine read is still in flight. With no thread, none.
 *
 * `needed`: whether the list is read again when the working cut moves. Every request in the chat lists its edits, and
 * each new working cut would read them all again. One out of view keeps the list it last read, and reads it again
 * once it is needed: in view, above the message box, or on the timeline. Its first read is always made, and so is
 * one after the request's own edits or flags change. `located` is the engine's list for the working cut as it is
 * now, so a list kept from an earlier one has none.
 */
export function useThreadEdits(projectId: string, thread: Thread | undefined, needed = true) {
  // Located on the working cut on screen, which holds while the video plays: the engine's list for a newer one waits.
  const head = useShownCutStore(s => s.head);
  const media = useProjectStore(s => s.current?.media);
  const projectChanges = useProjectStore(s => s.current?.changes);
  // An edit another request made counts here once this request flagged it.
  const applied = !!thread?.changes.some(c => c.state === "approved") || !!thread?.flagged?.length;
  const key = useThreadEditKey(projectId, head, thread);
  const [loaded, setLoaded] = useState<{ key: string; threadId: string; edits?: ThreadEdit[] }>();
  // The read last asked for. While the list isn't needed it stays the one asked for, so nothing is read again,
  // unless the request itself changed: only a new working cut is waited out.
  const own = useThreadEditKey(projectId, null, thread);
  const asked = useRef<{ key: string; own: string }>(undefined);
  const wanted = needed || asked.current?.own !== own ? key : asked.current.key;
  useEffect(() => {
    if (!head || !applied || !thread) return;
    asked.current = { key, own };
    let live = true;
    requestThreadEdits(key, projectId, thread.id).then(({ edits, version }) => {
      if (live && version === head) setLoaded({ key, threadId: thread.id, edits });
    }, () => {
      // The saved list stands in, but only when there is no list of this request's from the engine already: that one
      // is numbered as the timeline is, and a read that failed once, as while the engine restarts, must not swap it
      // for the saved list, which counts differently.
      if (live) setLoaded(had => had?.threadId === thread.id && had.edits ? had : { key, threadId: thread.id });
    });
    return () => { live = false; };
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a new list loads, keep the engine's numbering and the flags the editor saw. A flagged edit shows while its
  // request still works: "N need you" counts it from the moment it lands.
  const shown = useRef<{ key: string; edits: ListedEdit[] }>(undefined);
  const current = loaded?.key === key;
  const previous = loaded && loaded.threadId === thread?.id && shown.current?.key === loaded.key ? shown.current.edits : undefined;
  // Out of view, the engine's last list stands even when it arrived after the working cut had moved on.
  const kept = !needed && loaded?.threadId === thread?.id ? loaded?.edits : undefined;
  const resolved = current ? loaded.edits : previous ?? kept;
  // Only fall back to the raw saved list when there is no working cut yet or the engine read failed. While the
  // initial engine read is still in flight, stay empty so stale/undone/no-op edits never flash and disappear.
  const failed = !!thread && loaded?.threadId === thread.id && loaded.edits === undefined;
  const fallback = !head || failed;
  const saved = useMemo(() => thread && !resolved && fallback ? threadEditList(thread, media, projectChanges) : noEdits, [thread, media, projectChanges, resolved, fallback]);
  const edits = resolved ?? (fallback ? saved : noEdits);
  useEffect(() => { if (current && loaded.edits) shown.current = { key, edits }; }, [current, loaded, key, edits]);
  // An edit the editor rejected is out of the video: it is no edit to open, count or mark, only a row that says so.
  const live = useMemo(() => edits.filter(e => !e.rejected), [edits]);
  const rejected = useMemo(() => edits.filter(e => e.rejected), [edits]);
  const located = useMemo(() => applied && current ? loaded.edits?.filter(e => !e.rejected) : undefined, [applied, current, loaded]);
  return { listed: applied ? live : noEdits, rejected: applied ? rejected : noEdits, located, settled: !applied || !head || current, head };
}

export const noEdits: ListedEdit[] = [];

type PressedAdd = { id: string; threadId: string; changeId: string; spot: number; state: "queued" };

/**
 * Adds the editor pressed whose request hasn't reached the project yet. Each counts as queued from the press, so the
 * card can go on at once and a quick run of A presses adds every to-do: none waits on the one before, and the next
 * edit in line is never one already pressed.
 */
const usePressedAdds = create<{ adds: PressedAdd[] }>(() => ({ adds: [] }));
let pressedCount = 0;

/** Counts an Add as on its way from the press. The returned function takes it off once its request is in, or failed. */
export function pressAdd(threadId: string, changeId: string, spot: number) {
  const id = `pressed-add-${++pressedCount}`;
  usePressedAdds.setState(s => ({ adds: [...s.adds, { id, threadId, changeId, spot, state: "queued" }] }));
  return () => usePressedAdds.setState(s => ({ adds: s.adds.filter(add => add.id !== id) }));
}

function usePressedAddsOf(thread: Thread | undefined) {
  const adds = usePressedAdds(s => s.adds);
  return useMemo(() => adds.filter(add => add.threadId === thread?.id), [adds, thread?.id]);
}

/** The requests about one edit each that are queued or running, `only` the ones it picks. */
function editRequestsOnTheirWay(thread: Thread | undefined, only?: (task: Thread["tasks"][number]) => boolean) {
  return (thread?.tasks ?? []).flatMap(t => isActiveTask(t.state) && (!only || only(t)) && t.context.changeId && t.context.editIndex !== undefined
    ? [{ id: t.id, changeId: t.context.changeId, spot: t.context.editIndex, state: t.state }] : []);
}

/** Whether the request on its way for an edit is the editor's rejection of it, so its row says Rejecting… and not Revising…. */
export function useRejecting(thread: Thread | undefined) {
  return useMemo(() => {
    const pending = editRequestsOnTheirWay(thread, isRejectRequest);
    return (edit: ListedEdit) => pending.some(ref => matchesEdit(edit, ref));
  }, [thread]);
}

/** Whether the request on its way for a to-do is the editor's Add, so its row says Adding… and not Revising…. */
export function useAdding(thread: Thread | undefined) {
  const pressed = usePressedAddsOf(thread);
  return useMemo(() => {
    const pending = [...editRequestsOnTheirWay(thread, isAddRequest), ...pressed];
    return (edit: ListedEdit) => pending.some(ref => matchesEdit(edit, ref));
  }, [thread, pressed]);
}

/** Whether the editor has reviewed an edit: kept here, or decided cut by cut when the pass was applied. */
export function useReviewed(projectId: string, thread: Thread | undefined) {
  const kept = useKeptEdits(projectId, thread);
  return useMemo(() => {
    const decided = new Set(thread?.changes.filter(c => c.state === "approved" && (c.appliedReview || c.approvedSpots)).map(c => c.id));
    // A pass decided cut by cut was reviewed as it was applied, not a doubt raised about one of its edits since,
    // nor what a later save asks of a cut it moved.
    return (edit: EditRef & { recheck?: string; reviewRef?: EditRef }) =>
      kept.has(reviewKey(edit)) || (!edit.recheck && !edit.reviewRef && decided.has(edit.changeId));
  }, [kept, thread]);
}

/** Whether the editor can take back their Keep on an edit: kept directly, not permanently decided by an applied pass. */
export function useCanUnkeep(projectId: string, thread: Thread | undefined) {
  const kept = useKeptEdits(projectId, thread);
  return useMemo(() => {
    const decided = new Set(thread?.changes.filter(c => c.state === "approved" && (c.appliedReview || c.approvedSpots)).map(c => c.id));
    return (edit: EditRef & { recheck?: string; reviewRef?: EditRef; marker?: boolean }) =>
      !edit.marker && kept.has(reviewKey(edit)) && (!!edit.recheck || !!edit.reviewRef || !decided.has(edit.changeId));
  }, [kept, thread]);
}

/**
 * Whether a request about an edit is queued or running: the editor asked Scarlet to revise or undo it, so the edit
 * no longer waits for them. Once the request finishes, its new version carries its own flag; if it fails, the edit
 * needs a look again. It answers with that request's id and state, so a row can tell Scarlet at work from a request
 * still waiting its turn: the one Scarlet is on, when there are several.
 */
export function useRevising(thread: Thread | undefined) {
  const pressed = usePressedAddsOf(thread);
  return useMemo(() => {
    const pending = [...editRequestsOnTheirWay(thread), ...pressed];
    return (edit: ListedEdit) => {
      let first: (typeof pending)[number] | undefined;
      for (const ref of pending) if (matchesEdit(edit, ref)) {
        if (isWorkingTask(ref.state)) return { id: ref.id, state: ref.state };
        first ??= ref;
      }
      return first ? { id: first.id, state: first.state } : undefined;
    };
  }, [thread, pressed]);
}

/** What a row ends on while Scarlet has stopped work on its cut or edit to ask the editor something: the words its card uses. */
export const NEEDS_ANSWER = "Needs your answer";

/** Whether the request on its way for a cut or an edit has stopped to ask the editor a question: its row waits on them again. */
export const asksEditor = (run: { state: Task["state"] } | undefined) => run?.state === "waiting_for_user";

/**
 * The word on a row whose edit or cut has a request with Scarlet: "Revising…", "Rejecting…" or, for a to-do Scarlet
 * was asked to add, "Adding…" once Scarlet has started on it ("Rechecking…" when Scarlet sent an approved cut back to itself), "Up next" while it is next in line in the queue, and "Queued" while it waits behind other work
 * or while editing is paused. While that request waits on the editor's answer it is "Needs your answer": the row isn't
 * busy, it is their turn (2026-11-23), and it reads Revising… again once they answer.
 */
export function revisionWord(run: { id: string; state: Task["state"] } | undefined, { rejecting = false, adding = false, recheck = false, nextQueuedId }: { rejecting?: boolean; adding?: boolean; recheck?: boolean; nextQueuedId?: string } = {}) {
  if (!run) return undefined;
  if (run.state === "queued") return nextQueuedId && run.id === nextQueuedId ? "Up next" : "Queued";
  if (asksEditor(run)) return NEEDS_ANSWER;
  return rejecting ? "Rejecting…" : adding ? "Adding…" : recheck ? "Rechecking…" : "Revising…";
}

/**
 * Where a request's rejected edits stand among the ones still in the video, and the number each of those goes by in
 * the chat's list and on the timeline's dots: its place among every edit of the request in the video's order, the
 * rejected ones counted too. So an edit keeps its number when another is rejected (1, ×, 3), and a rejected row shows
 * none (2026-11-23). `slot` is how many edits in the video come before a rejected one. Edits at the very same time
 * keep the order they were saved in.
 */
export function listPlaces<T extends ListedEdit>(thread: Pick<Thread, "changes"> | undefined, edits: readonly T[], rejected: readonly ListedEdit[] = noEdits) {
  const savedAt = new Map(thread?.changes.map((change, i) => [change.id, i]));
  const at = (edit: ListedEdit) => (edit as ThreadEdit).at ?? edit.range.start;
  // A revision, and the engine's put-back of a rejected edit, stand where the edit they replaced was first saved.
  const saved = (edit: ListedEdit) => { const first = edit.previous[0] ?? edit; return (savedAt.get(first.changeId) ?? savedAt.size) * 1e6 + first.spot; };
  const slots = new Map(rejected.map(gone => {
    const next = edits.findIndex(edit => at(gone) < at(edit) || (at(gone) === at(edit) && saved(gone) < saved(edit)));
    return [gone, next < 0 ? edits.length : next] as const;
  }));
  const slot = (gone: ListedEdit) => slots.get(gone) ?? edits.length;
  const ahead = edits.map((_, i) => rejected.reduce((n, gone) => n + (slot(gone) <= i ? 1 : 0), 0));
  return {
    slot,
    /** The edit's number. One that isn't in the list has none. */
    number: (edit: T) => { const i = edits.indexOf(edit); return i < 0 ? undefined : i + 1 + ahead[i]!; },
    /** How many numbers the request has given out: its edits in the video and the rejected ones. */
    total: edits.length + rejected.length,
    /** The rejected edits in the order their rows go. */
    gone: [...rejected].sort((a, b) => slot(a) - slot(b) || at(a) - at(b) || saved(a) - saved(b)),
  };
}

type WaitsOn<T> = { reviewed(edit: T): boolean; revising(edit: T): { state: Task["state"] } | undefined };

/**
 * How many rows of a request's Needs review list wait on the editor: the number on its Needs review tab, and on its band while
 * the request is folded. A flagged edit waits until it is kept or sent back, and again while the request it was sent
 * back with has stopped to ask the editor something. An edit made in several places is one row.
 */
export function waitingRows<T extends ListedEdit>(edits: readonly T[], { reviewed, revising }: WaitsOn<T>, brollSections?: readonly BrollSection[] | null): number {
  return editGroups(edits, brollSections).filter(group => group.members.some(({ edit }) => asksEditor(revising(edit)) || (!!edit.check && !reviewed(edit) && !revising(edit)))).length;
}

/**
 * The same for a dialogue pass, whose Needs review list has a row for each call and each edit: the calls still open, the
 * flagged edits that wait, and any call or edit whose request has stopped to ask the editor something.
 */
export function waitingPassRows<T extends ListedEdit>(calls: readonly { state: string; run?: { state: Task["state"] } }[] | undefined, edits: readonly T[],
  _forYou: (edit: T) => boolean, { reviewed, revising }: WaitsOn<T>): number {
  return (calls?.filter(call => call.state === "open" || (call.state === "revising" && asksEditor(call.run))).length ?? 0)
    + edits.filter(edit => (!!edit.check && !reviewed(edit) && !revising(edit)) || asksEditor(revising(edit))).length;
}

/**
 * The distinct edits in a list. Edits combine into one row when they share a label and overlap on the timeline
 * exactly, or when contiguous B-roll edits belong to one continuous B-roll section. Cuts, non-B-roll flagged edits,
 * and spots marked for the editor always stay one row each.
 */
export function editGroups<T extends ListedEdit>(
  edits: readonly T[],
  brollSections?: readonly BrollSection[] | null,
): { label: string; members: { edit: T; i: number }[]; continuousBroll?: boolean; stretch?: TimeRange }[] {
  type Group = { label: string; members: { edit: T; i: number }[]; brollSectionId?: string; isBroll?: boolean; stretch?: TimeRange };
  const groups: Group[] = [];
  const isContinuousBroll = (edit: T) => !edit.beforeCut && !edit.marker && !edit.rejected && edit.kind === "broll";
  edits.forEach((edit, i) => {
    if (isContinuousBroll(edit)) {
      const section = brollSections ? brollSectionForEdit(brollSections, edit.range) : undefined;
      const canMerge = brollSections ? !!section : edit.range.end > edit.range.start;
      if (canMerge) {
        const matching: Group[] = [];
        for (const g of groups) {
          if (!g.isBroll) continue;
          const matches = brollSections
            ? g.brollSectionId === section!.id
            : g.members.some(m => stretchesContiguous(m.edit.range, edit.range));
          if (matches) matching.push(g);
        }
        if (matching.length) {
          const target = matching[0]!;
          for (let k = 1; k < matching.length; k++) {
            const extra = matching[k]!;
            target.members.push(...extra.members);
            const idx = groups.indexOf(extra);
            if (idx >= 0) groups.splice(idx, 1);
          }
          target.members.push({ edit, i });
          target.members.sort((a, b) => a.i - b.i);
          target.stretch = {
            start: Math.min(...target.members.map(m => m.edit.range.start)),
            end: Math.max(...target.members.map(m => m.edit.range.end)),
          };
          return;
        }
        groups.push({
          label: edit.label,
          members: [{ edit, i }],
          brollSectionId: section?.id,
          isBroll: true,
          stretch: edit.range,
        });
        return;
      }
    }
    const alone = !!edit.beforeCut || !!edit.check || !!edit.marker;
    const group = alone ? undefined : groups.findLast(g => {
      if (g.isBroll) return false;
      const first = g.members[0]!.edit;
      return !first.beforeCut && !first.check && !first.marker && first.label === edit.label && samePlace(first, edit);
    });
    if (group) { group.members.push({ edit, i }); return; }
    groups.push({ label: edit.label, members: [{ edit, i }] });
  });
  return groups.map(({ label, members, isBroll, stretch }) => ({
    label,
    members,
    ...(isBroll && members.length > 1 ? { continuousBroll: true, stretch } : {}),
  }));
}
