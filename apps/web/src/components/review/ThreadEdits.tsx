import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { historyLineage } from "@scarlet/timeline";
import { isRejectRequest, matchesEdit, threadEditList, threadRevision, isThreadDone, REJECT_MESSAGE, REVISED_CHECK, ScarletApiError, type EditRef, type Task, type Thread, type ThreadEdit, type VersionSummary } from "@scarlet/shared";
import { recordEditReview, requestPosition } from "../../lib/editReviews";
import { errorMessage } from "../../lib/client";
import { requestThreadEdits, useThreadEditKey } from "./threadEditRequest";
import { removedSeconds } from "../../lib/format";
import { editRowWord } from "../../lib/editKind";
import { editKey, keepEdits, reviewKey, useKeptEdits } from "../../lib/keptEdits";
import { useProjectStore } from "../../stores/project";
import { useShownCutStore } from "../../stores/shownCut";
import { Dropdown, MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { useHotkeys } from "../../lib/hotkeys";
import { useAgentAvailability } from "../agent/AgentChip";
import type { AgentContext } from "../../stores/ui";

/** What Scarlet is asked to do when the editor rejects an edit the engine can't put back itself. One × is one edit. */
export function rejectInstruction(target: Pick<AgentContext, "editNumber" | "label">) {
  const which = [target.editNumber && `edit ${target.editNumber}`, target.label && `“${target.label}”`].filter(Boolean).join(", ");
  return `The editor rejected ${which || "this edit"}. Put back exactly what it changed and leave every other edit as it is.`;
}

/** An edit as the engine needs it to put back what it changed: where it is in the video now and, for a cut, what it took out. */
export type RejectedEdit = Parameters<ReturnType<typeof useProjectStore.getState>["rejectEdits"]>[2][number];

/**
 * Reject an applied edit: a small × after Keep on its card, named "Reject edit" on hover, as a call's × skips it.
 * Wherever the engine knows exactly what the edit changed it goes back there, at once and with no model: a cut's
 * footage, a look an edit gave its clips, a whole request's only edit (`edits`, located on the version `editsOn`). An
 * edit the engine can't put back itself, or one a later edit changed, is a request to Scarlet to put back just that
 * edit, with the same agent and the same target as typing it would. On a moment's card it is the edit the card is
 * named for, never the whole moment. The editor pressed the × and wrote nothing, so that request reads "Reject edit" under its edit's
 * tag, in the chat and in the queue; what Scarlet is asked to do is the instruction, which is for the agent.
 */
export function RejectEdit({ projectId, thread, target, edits, editsOn, onEngine, onSent }: { projectId: string; thread: Thread; target: AgentContext;
  edits?: RejectedEdit[]; editsOn?: string;
  /** The engine is asked to put the edit back (`true`), or didn't after all (`false`): the video may change under the card meanwhile. */
  onEngine?(asked: boolean): void;
  onSent(sent: { task?: Task; version?: string }): void }) {
  const { effective, unavailableReason } = useAgentAvailability();
  const createTask = useProjectStore(s => s.createTask);
  const rejectEdits = useProjectStore(s => s.rejectEdits);
  const head = useProjectStore(s => s.current?.project.head ?? undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function reject() {
    // One request per press: pressed again while the first is on its way, it sends nothing more.
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (edits?.length && editsOn && editsOn === head) {
        onEngine?.(true);
        try {
          const version = await rejectEdits(thread.id, editsOn, edits);
          recordEditReview(projectId, target, "undo");
          onSent({ version });
          return;
        } catch (e) {
          onEngine?.(false);
          // The engine says when an edit isn't its to put back, or the video moved on meanwhile: Scarlet is asked then.
          if (!(e instanceof ScarletApiError) || e.status !== 409) throw e;
        }
      }
      if (!effective) { setError(unavailableReason); return; }
      const task = await createTask(projectId, { kind: "edit", ...effective, instruction: rejectInstruction(target),
        context: { version: head, ...requestPosition(target), threadId: thread.id, message: REJECT_MESSAGE } });
      recordEditReview(projectId, target, "undo");
      onSent({ task });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  // X rejects it, as it does a call: the same key on every card.
  useHotkeys(event => {
    if (busy || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "x") return;
    event.preventDefault();
    void reject();
  });
  return <>
    {error && <span className="simple-error" role="alert">{error}</span>}
    <button type="button" className="edit-card-icon edit-card-reject" data-log-control="reject-edit" aria-label="Reject edit" aria-busy={busy || undefined}
      aria-keyshortcuts="X" title={busy ? "Rejecting…" : "Reject edit (X)"} disabled={busy} onClick={e => { if (e.detail) e.currentTarget.blur(); void reject(); }}><Icon name="x" size={12} /></button>
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
export function EditVersion({ n, title, hover }: { n: number; title?: string;
  /** A hover for a mark inside a row's button, which takes no focus of its own. */
  hover?: string }) {
  return <small className="edit-version" title={title ?? hover} tabIndex={title ? 0 : undefined}>v{n}</small>;
}

type ListedEdit = Omit<ThreadEdit, "at">;

/**
 * A thread's edits as the timeline numbers them: the engine's list for the working cut, which leaves out
 * undone work, and the thread's own saved list until that arrives. With no thread, none.
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
  const saved = useMemo(() => thread ? threadEditList(thread, media) : [], [thread, media]);
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
  const edits = (current ? loaded.edits : previous ?? kept) ?? saved;
  useEffect(() => { if (current && loaded.edits) shown.current = { key, edits }; }, [current, loaded, key, edits]);
  // An edit the editor rejected is out of the video: it is no edit to open, count or mark, only a row that says so.
  const live = useMemo(() => edits.filter(e => !e.rejected), [edits]);
  const rejected = useMemo(() => edits.filter(e => e.rejected), [edits]);
  const located = useMemo(() => applied && current ? loaded.edits?.filter(e => !e.rejected) : undefined, [applied, current, loaded]);
  return { listed: applied ? live : noEdits, rejected: applied ? rejected : noEdits, located, head };
}

const noEdits: ListedEdit[] = [];

/** Whether the request on its way for an edit is the editor's rejection of it, so its row says Rejecting… and not Revising…. */
export function useRejecting(thread: Thread | undefined) {
  return useMemo(() => {
    const pending = (thread?.tasks ?? []).flatMap(t => PENDING_TASK.has(t.state) && isRejectRequest(t) && t.context.changeId && t.context.editIndex !== undefined
      ? [{ changeId: t.context.changeId, spot: t.context.editIndex }] : []);
    return (edit: ListedEdit) => pending.some(ref => matchesEdit(edit as ThreadEdit, ref));
  }, [thread]);
}

/** The × a rejected edit's row leads with, where a kept one has its tick. */
export function RejectedMark() {
  return <span className="simple-pass-tick is-rejected" role="img" aria-label="Rejected"><Icon name="x" size={10} /></span>;
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
 * A row plays its edit, whose details and decisions sit in its card on top of the timeline. Pressed again, the open row
 * plays its edit again. `under` is what sits directly under an edit's row: a request about that one edit that hasn't
 * left the chat. With `only`, the list is just the edits it picks, such as the ones that need the editor, each with
 * the number it has in the whole list.
 */
export function ThreadEdits({ projectId, thread, edits, rejected = noEdits, showing, onPlay, onHover, under, only, spent }: {
  projectId: string; thread: Thread; edits: ListedEdit[]; showing?: ThreadEdit;
  /** Edits the editor rejected, which are out of the video: each keeps a row where it was, with a × and "Rejected". */
  rejected?: ListedEdit[];
  onPlay(ref: EditRef): void; onHover?(ref?: EditRef): void; under?(edit: ListedEdit): ReactNode[]; only?(edit: ListedEdit): boolean;
  /** What the requests about an edit took, for the hover of the word its row ends on: their time and, when those show, tokens. */
  spent?(edit: ListedEdit): string | undefined;
}) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const opened = useRef<HTMLButtonElement>(null);
  // A rejected edit that's open is its own row: the edit that took its place in the video's order isn't lit for it.
  const open = showing?.rejected ? -1 : edits.findIndex(edit => !!showing && matchesEdit(showing, edit));
  const openKey = open >= 0 ? editKey(edits[open]!) : undefined;
  // ← → and Keep move to another edit, so keep the open one in view.
  useEffect(() => { opened.current?.scrollIntoView?.({ block: "nearest" }); }, [openKey]);
  if (!edits.length && !rejected.length) return null;
  // An edit made in several places is one row. It stands for the place that's open, else the first one asking for a
  // look, else the first.
  const rows = editGroups(edits).filter(({ members }) => !only || members.some(m => only(m.edit))).map(({ members }) => {
    const waiting = (m: { edit: ListedEdit }) => !!m.edit.check && !reviewed(m.edit) && !revising(m.edit);
    const shown = members.find(m => m.i === open) ?? members.find(waiting) ?? members[0]!;
    // An edit made in several places keeps its first number, so the list reads 1, 2, 5 and doesn't renumber as places are kept.
    return { ...shown, n: members[0]!.i + 1, places: members.length, needs: members.filter(waiting).length, allKept: members.every(m => reviewed(m.edit)),
      nested: under ? members.flatMap(m => under(m.edit)) : [], took: spent ? members.flatMap(m => spent(m.edit) ?? [])[0] : undefined };
  });
  // In the list of every edit, a rejected one keeps its place in the video's order, after the edits before it.
  const gone = only ? [] : [...rejected].sort((a, b) => a.range.start - b.range.start);
  // A press shows it again: where it was on the timeline, with its note, over the video as it plays without it.
  const goneAfter = (from: number, to: number) => gone.filter(e => e.range.start >= from && e.range.start < to).map(e => {
    // Lit for the edit it was, too, while that one is still on its card, leaving.
    const on = !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing));
    return <li key={editKey(e)}><button type="button" className={on ? "simple-edit is-rejected is-on" : "simple-edit is-rejected"} aria-current={on || undefined}
      data-log-control="open-edit" data-log-label="Rejected edit" aria-label={`${e.label}, rejected`}
      onClick={event => { if (event.detail) event.currentTarget.blur(); onPlay(e); }}>
      <span className="edit-badge is-rejected" aria-hidden="true"><Icon name="x" size={9} /></span>
      <span className="simple-edit-title">{e.label}</span>
      <span className="simple-edit-value">Rejected</span>
    </button></li>;
  });
  return <ol className="simple-edits" aria-label={only ? "Edits that need you" : "Edits in this thread"}>
    {goneAfter(-Infinity, rows[0]?.edit.range.start ?? Infinity)}
    {rows.map(({ edit, i, n, places, needs, allKept, nested, took }, at) => {
      const on = i === open;
      const isKept = places > 1 ? allKept : reviewed(edit);
      // A revision on its way takes the edit off the editor's list until it comes back. Its row says so whether or not
      // the editor had kept the edit: the edit they kept is on its way out (2026-11-10).
      const revisingNow = revising(edit), isRevising = !!revisingNow;
      // Scarlet is on that revision now, so the row's word moves. One waiting its turn sits still.
      const busy = revisingNow === "claimed" || revisingNow === "running";
      const version = edit.previous.length ? edit.previous.length + 1 : 0;
      // A cut says how much came out; any other edit says what it did, or in how many places.
      const value = places > 1 ? `${places} places` : removedLabel(edit) ?? editRowWord(edit);
      const check = places > 1 ? needs > 0 : !!edit.check && !isRevising;
      const title = (edit.reason && edit.summary) || edit.label;
      // One that came back revised with no reason from Scarlet says so on its row until it is kept: its card has no
      // sentence for that.
      const revised = edit.check === REVISED_CHECK && !reviewed(edit) && !isRevising;
      return <Fragment key={editKey(edit)}><li><button type="button" ref={on ? opened : undefined} aria-current={on || undefined} data-log-control="open-edit" data-log-label="Edit"
        // Clicked, the row lets go of the focus (WebView2 leaves it there), or Space would press the row again and start
        // the edit over, instead of playing the video.
        className={on ? "simple-edit is-on" : "simple-edit"} onClick={e => { if (e.detail) e.currentTarget.blur(); onPlay(edit); }}
        onPointerEnter={() => onHover?.(edit)} onPointerLeave={() => onHover?.()}
        // Why an edit asks for a look is on its card, in Scarlet's sentence. Its row keeps to the amber number and says
        // the reason on hover, as a pass's row does.
        title={revised || edit.reason ? undefined : edit.check}
        aria-label={`Edit ${n}: ${title}${places > 1 ? `, ${places} places` : ""}${isRevising ? ", revising" : isKept ? ", kept" : check ? ", check" : ""}`}>
        <EditBadge n={n} kept={isKept} check={check} />
        <span className="simple-edit-title">{title}{version > 0 && places === 1 && <EditVersion n={version} hover={took} />}</span>
        {/* What the row ends on says on hover what the requests about this edit took: their time and tokens, nothing else. */}
        {value && <span className="simple-edit-value" title={took}>{value}</span>}
        {isRevising ? <span className={busy ? "simple-edit-check is-kept working-text" : "simple-edit-check is-kept"} title={took}>{rejecting(edit) ? "Rejecting…" : "Revising…"}</span>
          : revised && <span className="simple-edit-check" title={took}>{edit.check}</span>}
      </button>{nested}</li>{goneAfter(edit.range.start, rows[at + 1]?.edit.range.start ?? Infinity)}</Fragment>;
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
