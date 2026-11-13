import { useEffect, useMemo, useRef, useState } from "react";
import { matchesEdit, type EditRef, type Thread, type ThreadEdit } from "@scarlet/shared";
import { errorMessage } from "../../lib/client";
import { requestThreadEdits, useReviewableEditFlags, useThreadEditKey } from "./threadEditRequest";
import { useUiStore, type AgentContext } from "../../stores/ui";
import { editGroups } from "./ThreadEdits";
import { originalReviewRef } from "../../lib/editReviews";
import { editMoments } from "./EditReferences";
import { appliedPassCuts, type FirstCutDelivery } from "../../lib/threads";

const empty: ThreadEdit[] = [];
/** Only project/thread/version-matched markers can start playback. Ignore replies from a previous view. */
export function useThreadTimeline(projectId: string, head: string | null, thread: Thread | undefined, passes: Map<string, FirstCutDelivery> | undefined, passFocused: boolean) {
  const key = useThreadEditKey(projectId, head, thread);
  const [result, setResult] = useState<{ key: string; edits?: ThreadEdit[]; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<{ owner: string; ref: EditRef; request: number }>();
  const owner = JSON.stringify([projectId, thread?.id]);
  useEffect(() => { setPicked(undefined); }, [owner]);
  useEffect(() => {
    if (!head || !thread) return;
    let live = true;
    requestThreadEdits(key, projectId, thread.id).then(({ edits, version }) => {
      if (live) setResult(version === head ? { key, edits } : { key, error: "The project timeline has changed. Refresh the edit markers." });
    }, error => { if (live) setResult({ key, error: errorMessage(error) }); });
    return () => { live = false; };
  }, [key, attempt]);
  const current = key === result?.key ? result : undefined;
  // While the markers load again for a new working cut, the list that was showing stays: an open edit's card doesn't
  // blink out and come back, and its listen isn't played again. A list that failed to load shows nothing.
  const last = useRef<{ owner: string; edits: ThreadEdit[] }>(undefined);
  const edits = useReviewableEditFlags(thread, current?.edits ?? (!current && !!head && last.current?.owner === owner ? last.current.edits : empty));
  if (current?.edits) last.current = { owner, edits };
  else if (current?.error) last.current = undefined;
  const selected = picked?.owner === owner ? edits.find(e => matchesEdit(e, picked.ref)) : undefined;
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
  const reviewRefs = useMemo(() => {
    const refs = new Map<ThreadEdit, EditRef>();
    for (const row of rows) {
      const ref = originalReviewRef(row);
      for (const edit of row) refs.set(edit, ref);
    }
    return refs;
  }, [rows]);
  const replyTarget = (edit: ThreadEdit): AgentContext => ({
    changeId: edit.changeId, editIndex: edit.spot, reviewRef: reviewRefs.get(edit), editNumber: edits.indexOf(edit) + 1,
    version: head ?? undefined, time: edit.range.start, end: edit.range.end, clipIds: [], label: edit.label,
  });
  return { edits, rows, selected, chosen, originalChange: cutChange || (selected && originalChangeFor(selected)), cutReview, framingFor, framing: selected && framingFor(selected), selectedTarget: selected && replyTarget(selected), threadId: thread?.id, request: picked?.request ?? 0,
    error: current?.error, loading: !!head && !!thread && !current,
    retry: () => { setResult(undefined); setAttempt(n => n + 1); },
    choose: (edit: ThreadEdit, origin: "timeline" | "chat" = "timeline") => {
      const ui = useUiStore.getState();
      // Timeline selections explicitly target the reply. Chat previews preserve a draft already in progress.
      if (origin === "timeline" || !ui.agentDraft.trim()) ui.setAgentContext(ui.agentDraft.trim() ? replyTarget(edit) : null);
      setPicked(prev => ({ owner, ref: { changeId: edit.changeId, spot: edit.spot }, request: (prev?.request ?? 0)+1 }));
    },
    clear: () => setPicked(undefined),
  };
}
