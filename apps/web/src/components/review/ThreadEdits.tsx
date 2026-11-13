import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { historyLineage } from "@scarlet/timeline";
import { matchesEdit, threadEditList, threadRevision, isThreadDone, REVISED_CHECK, type EditRef, type Thread, type ThreadEdit, type VersionSummary } from "@scarlet/shared";
import { recordEditReview, requestPosition } from "../../lib/editReviews";
import { errorMessage } from "../../lib/client";
import { requestThreadEdits, useReviewableEditFlags, useThreadEditKey } from "./threadEditRequest";
import { removedSeconds } from "../../lib/format";
import { editKindWord } from "../../lib/editKind";
import { editKey, keepEdits, useKeptEdits } from "../../lib/keptEdits";
import { useProjectStore } from "../../stores/project";
import { Dropdown, MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { useAgentAvailability } from "../agent/AgentChip";
import { useHotkeys } from "../../lib/hotkeys";
import type { AgentContext } from "../../stores/ui";

/** What Scarlet is asked to do when the editor undoes one edit of a change that made several. */
export function undoInstruction(target: Pick<AgentContext, "editNumber" | "label">) {
  const which = [target.editNumber && `edit ${target.editNumber}`, target.label && `“${target.label}”`].filter(Boolean).join(", ");
  return `Undo ${which || "this edit"}. Put back exactly what this edit changed and leave every other edit as it is.`;
}

/**
 * Undo one edit: a small icon on the edit's card, named "Undo edit (U)" on hover, with U as its key. The engine can
 * only revert a whole change, so this sends Scarlet a revision of just that edit, with the same agent and the same
 * target as typing the request would. The editor pressed Undo and wrote nothing, so the request reads "Undo" under
 * its edit's tag, in the chat and in the queue; what Scarlet is asked to do is the instruction, which is for the agent.
 */
export function UndoEdit({ projectId, thread, target, onSent }: { projectId: string; thread: Thread; target: AgentContext; onSent(): void }) {
  const { effective, unavailableReason } = useAgentAvailability();
  const createTask = useProjectStore(s => s.createTask);
  const head = useProjectStore(s => s.current?.project.head ?? undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function undo() {
    // One request per press: U held down, or pressed again while the first is on its way, sends nothing more.
    if (busy) return;
    if (!effective) { setError(unavailableReason); return; }
    setBusy(true);
    setError("");
    try {
      await createTask(projectId, { kind: "edit", ...effective, instruction: undoInstruction(target),
        context: { version: head, ...requestPosition(target), threadId: thread.id, message: "Undo" } });
      recordEditReview(projectId, target, "undo");
      onSent();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useHotkeys(event => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "u") return;
    event.preventDefault();
    void undo();
  });
  return <>
    {error && <span className="simple-error" role="alert">{error}</span>}
    <button type="button" className="edit-card-icon edit-card-undo" aria-label="Undo edit" aria-keyshortcuts="U" aria-busy={busy || undefined}
      title={busy ? "Undoing…" : "Undo edit (U)"} disabled={busy} onClick={() => void undo()}><Icon name="undo" size={14} /></button>
  </>;
}

/**
 * The edit's number, as on the timeline; amber while it asks for a look. Once reviewed it fills and widens
 * to carry a check beside the number, so approving even a lone edit reads as a change of shape.
 */
export function EditBadge({ n, kept, check }: { n: number; kept?: boolean; check?: boolean }) {
  return <span className={`edit-badge${kept ? " is-kept" : check ? " is-check" : ""}`} aria-hidden="true">
    {n}{kept && <Icon name="check" size={9} />}</span>;
}

/**
 * Which version an edit or a call is on once it has been revised: "v2". One mark, the same after a row's words in
 * either kind of list and before the note on a call's card. `title` is what hovering it says.
 */
export function EditVersion({ n, title }: { n: number; title?: string }) {
  return <small className="edit-version" title={title} tabIndex={title ? 0 : undefined}>v{n}</small>;
}

type ListedEdit = Omit<ThreadEdit, "at">;

/**
 * A thread's edits as the timeline numbers them: the engine's list for the working cut, which leaves out
 * undone work, and the thread's own saved list until that arrives. With no thread, none.
 */
export function useThreadEdits(projectId: string, thread: Thread | undefined): ListedEdit[] {
  const head = useProjectStore(s => s.current?.project.head ?? null);
  const saved = useMemo(() => thread ? threadEditList(thread) : [], [thread]);
  const applied = !!thread?.changes.some(c => c.state === "approved");
  const key = useThreadEditKey(projectId, head, thread);
  const [loaded, setLoaded] = useState<{ key: string; threadId: string; edits?: ThreadEdit[] }>();
  useEffect(() => {
    if (!head || !applied || !thread) return;
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
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a new list loads, keep the engine's numbering and the flags the editor saw. Finishing a task can arrive
  // before the read for its final version, which may have replaced one of its earlier flagged edits.
  const shown = useRef<{ key: string; edits: ListedEdit[] }>(undefined);
  const current = loaded?.key === key;
  const previous = loaded && loaded.threadId === thread?.id && shown.current?.key === loaded.key ? shown.current.edits : undefined;
  const edits = useReviewableEditFlags(thread, (current ? loaded.edits : previous) ?? saved);
  useEffect(() => { if (current && loaded.edits) shown.current = { key, edits }; }, [current, loaded, key, edits]);
  return applied ? edits : [];
}

/** Whether the editor has reviewed an edit: kept here, or decided cut by cut when the pass was applied. */
export function useReviewed(projectId: string, thread: Thread | undefined) {
  const kept = useKeptEdits(projectId, thread?.id);
  return useMemo(() => {
    const decided = new Set(thread?.changes.filter(c => c.state === "approved" && (c.appliedReview || c.approvedSpots)).map(c => c.id));
    return (edit: EditRef) => kept.has(editKey(edit)) || decided.has(edit.changeId);
  }, [kept, thread]);
}

const PENDING_TASK = new Set(["queued", "claimed", "running", "waiting_for_user"]);

/**
 * Whether a request about an edit is queued or running: the editor asked Scarlet to revise or undo it, so the edit
 * no longer waits for them. Once the request finishes, its new version carries its own flag; if it fails, the edit
 * needs a look again. It answers with where that request stands, so a row can tell Scarlet at work from a request
 * still waiting its turn: the one Scarlet is on, when there are several.
 */
export function useRevising(thread: Thread | undefined) {
  return useMemo(() => {
    const pending = (thread?.tasks ?? []).flatMap(t => PENDING_TASK.has(t.state) && t.context.changeId && t.context.editIndex !== undefined
      ? [{ changeId: t.context.changeId, spot: t.context.editIndex, state: t.state }] : []);
    return (edit: ListedEdit) => {
      let first: (typeof pending)[number] | undefined;
      for (const ref of pending) if (matchesEdit(edit, ref)) {
        if (ref.state === "claimed" || ref.state === "running") return ref.state;
        first ??= ref;
      }
      return first?.state;
    };
  }, [thread]);
}

/**
 * The distinct edits in a list. One request can make the same edit in many places ("Camera full screen" in twelve
 * stretches): those share a name and read as one edit with a count of places. Cuts stay one each, since each removes
 * its own words.
 */
export function editGroups<T extends ListedEdit>(edits: readonly T[]): { label: string; members: { edit: T; i: number }[] }[] {
  const groups: { label: string; members: { edit: T; i: number }[] }[] = [];
  const named = new Map<string, number>();
  edits.forEach((edit, i) => {
    const at = edit.beforeCut ? undefined : named.get(edit.label);
    if (at !== undefined) { groups[at]!.members.push({ edit, i }); return; }
    if (!edit.beforeCut) named.set(edit.label, groups.length);
    groups.push({ label: edit.label, members: [{ edit, i }] });
  });
  return groups;
}

function removedLabel(edit: ListedEdit) {
  return edit.beforeCut ? removedSeconds(edit.beforeCut.removed.end - edit.beforeCut.removed.start) : undefined;
}

/**
 * One list per thread, at its end, always current: a revision updates its edit's row in place and
 * new edits join the list. Every edit is listed, however many: the link that opens the list opens all of it.
 * It is a list of rows as a pass's is, each led by its edit's number where a pass's row has its time.
 * A row plays its edit, whose details and decisions sit in the strip under the player. Pressed again, the open row
 * plays its edit again. `under` is what sits directly under an edit's row: a request about that one edit that hasn't
 * left the chat. With `only`, the list is just the edits it picks, such as the ones that need the editor, each with
 * the number it has in the whole list.
 */
export function ThreadEdits({ projectId, thread, edits, showing, onPlay, onHover, under, only }: {
  projectId: string; thread: Thread; edits: ListedEdit[]; showing?: ThreadEdit;
  onPlay(ref: EditRef): void; onHover?(ref?: EditRef): void; under?(edit: ListedEdit): ReactNode[]; only?(edit: ListedEdit): boolean;
}) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const opened = useRef<HTMLButtonElement>(null);
  const open = edits.findIndex(edit => !!showing && matchesEdit(showing, edit));
  const openKey = open >= 0 ? editKey(edits[open]!) : undefined;
  // ← → and Keep move to another edit, so keep the open one in view.
  useEffect(() => { opened.current?.scrollIntoView?.({ block: "nearest" }); }, [openKey]);
  if (!edits.length) return null;
  // An edit made in several places is one row. It stands for the place that's open, else the first one asking for a
  // look, else the first.
  const rows = editGroups(edits).filter(({ members }) => !only || members.some(m => only(m.edit))).map(({ members }) => {
    const waiting = (m: { edit: ListedEdit }) => !!m.edit.check && !reviewed(m.edit) && !revising(m.edit);
    const shown = members.find(m => m.i === open) ?? members.find(waiting) ?? members[0]!;
    // An edit made in several places keeps its first number, so the list reads 1, 2, 5 and doesn't renumber as places are kept.
    return { ...shown, n: members[0]!.i + 1, places: members.length, needs: members.filter(waiting).length, allKept: members.every(m => reviewed(m.edit)),
      nested: under ? members.flatMap(m => under(m.edit)) : [] };
  });
  return <ol className="simple-edits" aria-label={only ? "Edits that need you" : "Edits in this thread"}>
    {rows.map(({ edit, i, n, places, needs, allKept, nested }) => {
      const on = i === open;
      const isKept = places > 1 ? allKept : reviewed(edit);
      // A revision on its way takes the edit off the editor's list until it comes back. Its row says so whether or not
      // the editor had kept the edit: the edit they kept is on its way out (2026-11-10).
      const revisingNow = revising(edit), isRevising = !!revisingNow;
      // Scarlet is on that revision now, so the row's word moves. One waiting its turn sits still.
      const busy = revisingNow === "claimed" || revisingNow === "running";
      const version = edit.previous.length ? edit.previous.length + 1 : 0;
      // A cut says how much came out; any other edit says what it did, or in how many places.
      const value = places > 1 ? `${places} places` : removedLabel(edit) ?? editKindWord(edit);
      const check = places > 1 ? needs > 0 : !!edit.check && !isRevising;
      // One that came back revised with no reason from Scarlet says so on its row until it is kept: its card has no
      // sentence for that.
      const revised = edit.check === REVISED_CHECK && !reviewed(edit) && !isRevising;
      return <li key={editKey(edit)}><button type="button" ref={on ? opened : undefined} aria-current={on || undefined}
        // Clicked, the row lets go of the focus (WebView2 leaves it there), or Space would press the row again and start
        // the edit over, instead of playing the video.
        className={on ? "simple-edit is-on" : "simple-edit"} onClick={e => { if (e.detail) e.currentTarget.blur(); onPlay(edit); }}
        onPointerEnter={() => onHover?.(edit)} onPointerLeave={() => onHover?.()}
        // Why an edit asks for a look is on its card, in Scarlet's sentence. Its row keeps to the amber number and says
        // the reason on hover, as a pass's row does.
        title={revised ? undefined : edit.check}
        aria-label={`Edit ${n}: ${edit.label}${places > 1 ? `, ${places} places` : ""}${isRevising ? ", revising" : isKept ? ", kept" : check ? ", check" : ""}`}>
        <EditBadge n={n} kept={isKept} check={check} />
        <span className="simple-edit-title">{edit.label}{version > 0 && places === 1 && <EditVersion n={version} />}</span>
        {value && <span className="simple-edit-value">{value}</span>}
        {isRevising ? <span className={busy ? "simple-edit-check is-kept working-text" : "simple-edit-check is-kept"}>Revising…</span>
          : revised && <span className="simple-edit-check">{edit.check}</span>}
      </button>{nested}</li>;
    })}
  </ol>;
}

const histories = new WeakMap<VersionSummary[], { head: string | null; result: ReturnType<typeof historyLineage> }>();

/** Every thread in the conversation shares the same immutable version history. */
function sharedLineage(versions: VersionSummary[], head: string | null) {
  const cached = histories.get(versions);
  if (cached?.head === head) return cached.result;
  const result = historyLineage(versions, head);
  histories.set(versions, { head, result });
  return result;
}

/**
 * The thread's one action: review the edits Scarlet flagged that haven't been kept. Unflagged edits are done, so
 * there's nothing to press once the flagged ones are reviewed. Undo and filing the thread live in its menu.
 */
export function ThreadAction({ projectId, thread, edits, onPlay, menuOnly, menu = true }: { projectId: string; thread: Thread; edits: ListedEdit[]; onPlay(ref: EditRef): void;
  /** Just the menu and what it reports, for a card whose row already counts what needs the editor. */
  menuOnly?: boolean;
  /** Without the menu, only what it reports is left: Filed, Undone. */
  menu?: boolean }) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const completed = useProjectStore(s => s.current?.project.completedThreads);
  const setThreadDone = useProjectStore(s => s.setThreadDone);
  const historyEdit = useProjectStore(s => s.historyEdit);
  const head = useProjectStore(s => s.current?.project.head ?? null);
  const versions = useProjectStore(s => s.current?.versions);
  const historyRevision = useProjectStore(s => s.current?.historyRevision);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const applied = thread.changes.filter(c => c.state === "approved").map(c => c.appliedVersion ?? c.toVersion);
  // The store drops a list that was on its way when the head moved, as it does after an undo, and leaves the list
  // unset as it was. The history's revision is what changes then, so the list is asked for again.
  useEffect(() => {
    if (applied.length && !versions) void useProjectStore.getState().loadVersions().catch(() => {});
  }, [applied.length, versions, historyRevision]);
  const lineage = versions && sharedLineage(versions, head);
  // Every applied change in the thread that the working cut still contains, newest first.
  const undoable = lineage ? applied.filter(v => lineage.lineage.has(v) && !lineage.undone.has(v)).reverse() : [];
  const undone = !!lineage && applied.length > 0 && applied.every(v => lineage.undone.has(v));
  if ((!edits.length && !undoable.length && !undone) || thread.status === "working" || thread.active || thread.question) return null;
  if (isThreadDone(thread, completed)) return <div className="simple-action is-done">{menuOnly ? "Filed" : "Filed."}</div>;
  if (!menu && !undoing && !undone && !error) return null;
  const left = edits.filter(e => e.check && !reviewed(e) && !revising(e));
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await task(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const done = () => run(() => setThreadDone(thread.id, true, threadRevision(thread)));
  const undoAll = () => run(async () => {
    setUndoing(true);
    try { for (const version of undoable) await historyEdit(version, "revert"); } finally { setUndoing(false); }
  });
  return <div className={menuOnly ? "simple-action is-menu" : "simple-action"}>
    {!menuOnly && left.length > 0 && <button type="button" className="simple-action-main" disabled={busy} onClick={() => onPlay(left[0]!)}>
      <Icon name="play" size={11} />{`Review ${left.length} flagged`}</button>}
    {menu && <Dropdown label="More for this thread" above width={210}
      button={<span className="simple-action-more" title="More"><Icon name="more" size={14} /></span>}>
      {close => <>
        {undoable.length > 0 && <MenuItem disabled={busy} onClick={() => { close(); void undoAll(); }}>Undo these edits</MenuItem>}
        <MenuItem onClick={() => { close(); if (left.length) keepEdits(projectId, thread.id, left); void done(); }}>File this thread</MenuItem>
      </>}
    </Dropdown>}
    {undoing && <span className="simple-link-quiet" role="status">Working…</span>}
    {undone && <span className="simple-link-quiet">Undone</span>}
    {error && <span className="simple-error" role="alert">{error}</span>}
  </div>;
}
