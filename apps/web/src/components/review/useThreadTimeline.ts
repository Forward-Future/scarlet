import { useEffect, useMemo, useRef, useState } from "react";
import { matchesEdit, type EditRef, type Thread, type ThreadEdit } from "@scarlet/shared";
import { errorMessage } from "../../lib/client";
import { requestThreadEdits, useThreadEditKey } from "./threadEditRequest";
import { useUiStore, type AgentContext } from "../../stores/ui";
import { useProjectStore } from "../../stores/project";
import { takeUpLatest } from "../../stores/shownCut";
import { editGroups } from "./ThreadEdits";
import { originalReviewRef } from "../../lib/editReviews";
import { editMoments } from "./EditReferences";
import { appliedPassCuts, type FirstCutDelivery } from "../../lib/threads";
import { listMoments, type Moment } from "../../lib/editMoments";

const empty: ThreadEdit[] = [];
/** Only project/thread/version-matched markers can start playback. Ignore replies from a previous view. */
export function useThreadTimeline(projectId: string, head: string | null, thread: Thread | undefined, passes: Map<string, FirstCutDelivery> | undefined, passFocused: boolean) {
  const key = useThreadEditKey(projectId, head, thread);
  const [result, setResult] = useState<{ key: string; edits?: ThreadEdit[]; rejected?: ThreadEdit[]; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  // `single`: one edit of a moment, picked from under its row, and not the moment it is in.
  // `leaving`: the editor rejected it a moment ago. It stays on its card as it was while it leaves the timeline.
  const [picked, setPicked] = useState<{ owner: string; ref: EditRef; request: number; single?: boolean; leaving?: boolean }>();
  const owner = JSON.stringify([projectId, thread?.id]);
  useEffect(() => { setPicked(undefined); }, [owner]);
  useEffect(() => {
    if (!head || !thread) return;
    let live = true;
    requestThreadEdits(key, projectId, thread.id).then(({ edits, version }) => {
      if (!live) return;
      // While the video plays, the working cut on screen holds (`useShownCut`) and the engine answers for the newer one
      // waiting behind it, as when another request of this thread saves an edit. The list on screen stays, with the
      // open edit's card and its listen, until playback stops and the newer working cut comes up and is read. The open
      // edit's own revision is the exception: its card comes back on the new version as it lands.
      if (version !== head && version === useProjectStore.getState().current?.project.head) {
        const open = shownLast.current?.owner === owner ? shownLast.current.edit : undefined;
        const now = open && edits.find(e => !e.rejected && matchesEdit(e, open));
        if (open && now && (now.changeId !== open.changeId || now.spot !== open.spot)) takeUpLatest();
        return;
      }
      // An edit the editor rejected is no longer in the video: it has no dot, no number and no place among the edits to
      // step through. Its row in the chat's list still opens it, to show where it was.
      setResult(version === head ? { key, edits: edits.filter(e => !e.rejected), rejected: edits.filter(e => e.rejected) }
        : { key, error: "The project timeline has changed. Refresh the edit markers." });
    }, error => { if (live) setResult({ key, error: errorMessage(error) }); });
    return () => { live = false; };
  }, [key, attempt]);
  const current = key === result?.key ? result : undefined;
  // While the markers load again for a new working cut, the list that was showing stays: an open edit's card doesn't
  // blink out and come back, and its listen isn't played again. A list that failed to load shows nothing.
  const last = useRef<{ owner: string; edits: ThreadEdit[]; rejected: ThreadEdit[] }>(undefined);
  const edits = current?.edits ?? (!current && !!head && last.current?.owner === owner ? last.current.edits : empty);
  const rejected = current?.rejected ?? (!current && !!head && last.current?.owner === owner ? last.current.rejected : empty);
  if (current?.edits) last.current = { owner, edits, rejected };
  else if (current?.error) last.current = undefined;
  const found = picked?.owner === owner ? edits.find(e => matchesEdit(e, picked.ref)) ?? rejected.find(e => matchesEdit(e, picked.ref)) : undefined;
  // One that is leaving stays the edit it was when the editor rejected it, on the version it was on: the list that
  // comes in without it, a moment later, doesn't close its card or move the timeline under it.
  const shownLast = useRef<{ owner: string; edit: ThreadEdit }>(undefined);
  const leaving = picked?.owner === owner && picked.leaving && shownLast.current?.owner === owner && matchesEdit(shownLast.current.edit, picked.ref)
    ? shownLast.current.edit : undefined;
  const selected = leaving ?? found;
  shownLast.current = selected ? { owner, edit: selected } : undefined;
  // An edit stays chosen while its markers load again, or failed to. Once they're in and it isn't among them, nothing is.
  const chosen = picked?.owner === owner && (!!selected || !current?.edits);
  const cutChange = selected?.beforeCut && thread?.changes.find(c => c.id === selected.changeId);
  const pass = selected && Array.from(passes?.values() ?? []).find(p => [selected, ...selected.previous].some(ref => p.appliedChangeIds.includes(ref.changeId)));
  const cutReview = cutChange ? { cuts: pass ? appliedPassCuts(pass, edits)
    : edits.filter(e => e.beforeCut && e.changeId === cutChange.id) } : undefined;
  function originalChangeFor(edit: ThreadEdit) {
    return thread?.changes.find(c => c.id === (edit.previous[0] ?? edit).changeId);
  }
  function framingFor(edit: ThreadEdit) {
    const change = thread?.changes.find(c => c.id === edit.changeId);
    if (!change?.ops?.length || !change.ops.every(op => op.op === "updateClip" && op.patch &&
        typeof op.patch === "object" && "transform" in op.patch && Object.keys(op.patch).length === 1)) return;
    const original = originalChangeFor(edit);
    if (!original) return;
    const ranges = change.timelineEdits?.map(item => item.range) ?? change.ranges;
    const cue = head === change.toVersion ? editMoments(change.description, ranges).find(m => m.spot === edit.spot && m.cue)?.time : undefined;
    return { beforeVersion: original.appliedOnto ?? original.fromVersion, cue };
  }
  const rows = useMemo(() => passFocused ? edits.map(edit => [edit]) : editGroups(edits).map(g => g.members.map(m => m.edit)), [edits, passFocused]);
  // A pass's list shows its edits as moments: edits that overlap so much they play as one change are one row, named for
  // its main edit, which is the one chosen when the moment is. One of its edits picked on its own is just that edit.
  const moments = useMemo(() => passFocused ? listMoments(edits) : undefined, [edits, passFocused]);
  const momentOf = (edit: ThreadEdit) => moments?.find(m => m.edits.includes(edit));
  const single = !!picked?.single;
  const shownMoment = selected && !single ? momentOf(selected) : undefined;
  const selectedMoment: Moment<ThreadEdit> | undefined = shownMoment && shownMoment.edits.length > 1 && shownMoment.main === selected ? shownMoment : undefined;
  const reviewRefs = useMemo(() => {
    const refs = new Map<ThreadEdit, EditRef>();
    for (const row of rows) {
      const ref = originalReviewRef(row);
      for (const edit of row) refs.set(edit, ref);
    }
    return refs;
  }, [rows]);
  const replyTarget = (edit: ThreadEdit, moment?: Moment<ThreadEdit>): AgentContext => ({
    changeId: edit.changeId, editIndex: edit.spot, reviewRef: reviewRefs.get(edit), editNumber: edits.indexOf(edit) + 1,
    version: head ?? undefined, time: edit.range.start, end: edit.range.end, clipIds: [], label: edit.label,
    // A moment is about all of its edits: its stretch is theirs, and Scarlet is told the others.
    ...moment && { time: Math.min(...moment.edits.map(e => e.range.start)), end: Math.max(...moment.edits.map(e => e.range.end)),
      momentEdits: moment.edits.filter(e => e !== edit).map(e => ({ changeId: e.changeId, spot: e.spot, label: e.label })) },
  });
  return { edits, rejected, rows, selected, chosen, leaving: !!leaving, originalChange: cutChange || (selected && originalChangeFor(selected)), cutReview, framingFor, framing: selected && framingFor(selected), selectedTarget: selected && replyTarget(selected, selectedMoment),
    /** The open edit by itself, also when it is open as the edit its moment is named for. */
    selectedAlone: selected && replyTarget(selected),
    moments, selectedMoment, single, threadId: thread?.id, request: picked?.request ?? 0,
    /** The edits are placed on the working cut that's showing, not the list of the one before it. */
    located: !!current?.edits,
    error: current?.error, loading: !!head && !!thread && !current,
    retry: () => { setResult(undefined); setAttempt(n => n + 1); },
    /**
     * Open an edit. A moment's main edit opens the whole moment, as its row does; any other edit of a moment, or one
     * picked with `single` from under the moment's row, is that edit alone.
     */
    choose: (edit: ThreadEdit, origin: "timeline" | "chat" = "timeline", single = false) => {
      const ui = useUiStore.getState();
      const found = momentOf(edit);
      const moment = !single && found && found.edits.length > 1 && found.main === edit ? found : undefined;
      const alone = !moment && !!found && found.edits.length > 1;
      // Timeline selections explicitly target the reply. Chat previews preserve a draft already in progress.
      if (origin === "timeline" || !ui.agentDraft.trim()) ui.setAgentContext(ui.agentDraft.trim() ? replyTarget(edit, moment) : null);
      setPicked(prev => ({ owner, ref: { changeId: edit.changeId, spot: edit.spot }, request: (prev?.request ?? 0)+1, ...alone && { single: true } }));
    },
    /**
     * The editor rejected the open edit: it holds as it is, on the version it is on, from the press until another is
     * chosen or it is let go. `stay` is for a rejection the engine didn't make after all.
     */
    leave: () => setPicked(prev => prev && { ...prev, leaving: true }),
    stay: () => setPicked(prev => prev?.leaving ? { ...prev, leaving: false } : prev),
    clear: () => setPicked(undefined),
  };
}
