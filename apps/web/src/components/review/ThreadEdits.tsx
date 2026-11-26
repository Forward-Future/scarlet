import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { historyLineage } from "@scarlet/timeline";
import { AimRow } from "./AimRow";
import { matchesEdit, threadRevision, isThreadDone, ADD_MESSAGE, REJECT_MESSAGE, REVISED_CHECK, ScarletApiError, type EditRef, type Task, type Thread, type ThreadEdit, type VersionSummary } from "@scarlet/shared";
import { recordEditReview, requestPosition } from "../../lib/editReviews";
import { errorMessage } from "../../lib/client";
import { asksEditor, editGroups, listPlaces, noEdits, revisionWord, useAdding, useCanUnkeep, useRejecting, useReviewed, useRevising, type ListedEdit } from "./threadEditState";
import { clock as clockLabel } from "../../lib/format";
import { editRowWord } from "../../lib/editKind";
import { editKey, keepEdits, unkeepEdits } from "../../lib/keptEdits";
import { isWorkingTask } from "../../lib/taskRun";
import { recordUndo } from "../../lib/undo";
import { useProjectStore } from "../../stores/project";
import { Dropdown, MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { blurOnPointerClick, useHotkeys } from "../../lib/hotkeys";
import { ariaKeyShortcut, matchesShortcut, shortKeyLabel, useShortcutsStore } from "../../stores/shortcuts";
import { useKeepSelectedInView } from "../../lib/uiHooks";
import { useAgentAvailability } from "../agent/AgentChip";
import type { AgentContext } from "../../stores/ui";

/** What Scarlet is asked to do when the editor rejects an edit the engine can't put back itself. One × is one edit. */
export function rejectInstruction(target: Partial<Pick<AgentContext, "label" | "time">>) {
  const which = [target.time !== undefined && `the edit at ${clockLabel(target.time)}`, target.label && `“${target.label}”`].filter(Boolean).join(", ");
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
export function RejectEdit({ projectId, thread, target, edits, editsOn, titleOverride, onEngine, onSent }: { projectId: string; thread: Thread; target: AgentContext;
  edits?: RejectedEdit[]; editsOn?: string;
  /** Optional label override (e.g. "Reject just this edit" when inspecting one edit in a grouped batch). */
  titleOverride?: string;
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
  const rejectBinding = useShortcutsStore(s => s.bindings.reject);
  const rejectLabel = shortKeyLabel(rejectBinding);
  // Reject shortcut (X by default), as on a call: the same key on every card.
  useHotkeys(event => {
    if (busy || event.repeat || !matchesShortcut(event, "reject")) return;
    event.preventDefault();
    void reject();
  });
  const baseTitle = titleOverride ?? "Reject edit";
  return <>
    {error && <span className="simple-error" role="alert">{error}</span>}
    <button type="button" className="edit-card-icon edit-card-reject" data-log-control="reject-edit" aria-label={baseTitle} aria-busy={busy || undefined}
      aria-keyshortcuts={ariaKeyShortcut(rejectBinding)} title={busy ? "Rejecting…" : rejectLabel ? `${baseTitle} (${rejectLabel})` : baseTitle} disabled={busy} onClick={e => { blurOnPointerClick(e); void reject(); }}><Icon name="x" size={12} /></button>
  </>;
}

/** What Scarlet is asked to do when the editor presses Add on a to-do: `ask` is what the to-do says to add. */
export function addInstruction(ask?: string) {
  return `The editor asked you to add what this to-do asks for${ask?.trim() ? `: “${ask.trim()}”` : ""}. Make or find it, put it in the video at this spot, and mark the to-do resolved.`;
}

/**
 * Add on a to-do's card: Scarlet is asked to make or find what the to-do says to add and put it in the video there,
 * with the same agent and the same target as typing it would. The editor pressed Add and wrote nothing, so the
 * request reads "Add it" under its to-do's tag, in the chat and in the queue; what Scarlet is told is the instruction.
 */
export function AddTodo({ projectId, thread, target, ask, onSent }: { projectId: string; thread: Thread; target: AgentContext;
  ask?: string; onSent(task: Task): void }) {
  const { effective, unavailableReason } = useAgentAvailability();
  const createTask = useProjectStore(s => s.createTask);
  const head = useProjectStore(s => s.current?.project.head ?? undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add() {
    // One request per press: pressed again while the first is on its way, it sends nothing more.
    if (busy) return;
    if (!effective) { setError(unavailableReason); return; }
    setBusy(true);
    setError("");
    try {
      const task = await createTask(projectId, { kind: "edit", ...effective, instruction: addInstruction(ask),
        context: { version: head, ...requestPosition(target), threadId: thread.id, message: ADD_MESSAGE } });
      recordEditReview(projectId, target, "revise");
      onSent(task);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useHotkeys(event => {
    if (busy || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    void add();
  });
  return <>
    {error && <span className="simple-error" role="alert">{error}</span>}
    <button type="button" className="btn-primary" data-key="A" data-log-control="add-todo" aria-keyshortcuts="A" aria-busy={busy || undefined}
      title="Have Scarlet add it (A)" disabled={busy} onClick={e => { blurOnPointerClick(e); void add(); }}>Add</button>
  </>;
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

/** The × a rejected edit's row leads with, where a kept one has its tick. */
export function RejectedMark() {
  return <span className="simple-pass-tick is-rejected" role="img" aria-label="Rejected"><Icon name="x" size={10} /></span>;
}

/**
 * One list per thread, at its end, always current: a revision updates its edit's row in place and
 * new edits join the list. Every edit is listed, however many: the link that opens the list opens all of it.
 * It is a list of rows as a pass's is, each led by its edit's time.
 * A row plays its edit, whose details and decisions sit in its card on top of the timeline. Pressed again, the open row
 * plays its edit again. `under` is what sits directly under an edit's row: a request about that one edit that hasn't
 * left the chat. With `only`, the list is just the edits it picks, such as the ones that need the editor, each with
 * its time. `label` names such a list, and `leaving` picks the rows that are on their way out of it: decided or sent back a
 * moment ago, they fade before they go.
 */
export function ThreadEdits({ projectId, thread, edits, rejected = noEdits, showing, onPlay, onHover, under, only, spent, nextQueuedId, label, leaving, low, inRail, askingKey }: {
  projectId: string; thread: Thread; edits: ListedEdit[]; showing?: ThreadEdit;
  /** Edits the editor rejected, which are out of the video: each keeps a row where it was, with a × and "Rejected". */
  rejected?: ListedEdit[];
  onPlay(ref: EditRef): void; onHover?(ref?: EditRef): void; under?(edit: ListedEdit): ReactNode[]; only?(edit: ListedEdit): boolean;
  /** What the requests about an edit took, for the hover of the word its row ends on: their time and, when those show, tokens. */
  spent?(edit: ListedEdit): string | undefined;
  /** The queued request Scarlet will take up next, so its edit's row says "Up next" instead of "Queued". */
  nextQueuedId?: string;
  label?: string; leaving?(edit: ListedEdit): boolean;
  /** The rows that are in For you's list only while low risk edits are included: they open into it and close out of it. */
  low?(edit: ListedEdit): boolean;
  /** Drawn inside the beta edits column: use Scarlet's hover tooltip instead of the system title tooltip. */
  inRail?: boolean;
  /** The row key of the edit whose question is currently shown over the message box, so it lights up. */
  askingKey?: string;
}) {
  const reviewed = useReviewed(projectId, thread);
  const canUnkeep = useCanUnkeep(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const adding = useAdding(thread);
  const list = useRef<HTMLOListElement>(null);
  // A rejected edit that's open is its own row: the edit that took its place in the video's order isn't lit for it.
  const open = showing?.rejected ? -1 : edits.findIndex(edit => !!showing && matchesEdit(showing, edit));
  // An edit made in several places is one row. It stands for the place that's open, else the first one asking for a
  // look, else the first.
  const order = listPlaces(thread, edits, rejected);
  const rows = editGroups(edits).filter(({ members }) => !only || members.some(m => only(m.edit))).map(({ members }) => {
    const waiting = (m: { edit: ListedEdit }) => !!m.edit.check && !reviewed(m.edit) && !revising(m.edit);
    // Scarlet stopped work on it to ask the editor something: it is their turn, so it is the place the row stands for.
    const asking = (m: { edit: ListedEdit }) => asksEditor(revising(m.edit));
    const relevant = only ? members.filter(m => only(m.edit)) : members;
    const shown = members.find(m => m.i === open) ?? members.find(asking) ?? members.find(waiting) ?? relevant[0] ?? members[0]!;
    return { ...shown, first: members[0]!.i, places: members.length, needs: members.filter(waiting).length, allKept: relevant.every(m => reviewed(m.edit)),
      unkeepRefs: relevant.filter(m => canUnkeep(m.edit)).map(m => m.edit),
      nested: under ? members.flatMap(m => under(m.edit)) : [], took: spent ? members.flatMap(m => spent(m.edit) ?? [])[0] : undefined };
  });
  // A rejected edit keeps its place in the video's order, in the list of every edit and in Done.
  const gone = only ? order.gone.filter(only) : order.gone;
  /** The rejected rows between two rows of the list: the ones that stood after the edit at `from` and no later than the one at `to`. */
  const goneBetween = (from: number, to: number) => gone.filter(e => order.slot(e) > from && order.slot(e) <= to);
  const firstOf = (at: number) => rows[at]?.first ?? Infinity;
  // ↑ ↓, Keep, tab switches, and rows arriving above can move the selected edit: always keep it in view.
  const mode = label ?? (only ? "need" : "all");
  let selectedKey: string | undefined;
  let before = 0;
  const scanGone = (from: number, to: number) => {
    for (const e of goneBetween(from, to)) {
      if (showing && (matchesEdit(showing, e) || matchesEdit(e, showing))) {
        selectedKey = `${mode}:${before}:rejected:${editKey(e)}`;
        return true;
      }
      before += 1;
    }
    return false;
  };
  if (!scanGone(-1, firstOf(0))) {
    for (let at = 0; at < rows.length; at++) {
      const { edit, i, nested } = rows[at]!;
      if (i === open) { selectedKey = `${mode}:${before}:${editKey(edit)}`; break; }
      before += 1 + nested.length;
      if (scanGone(firstOf(at), firstOf(at + 1))) break;
    }
  }
  useKeepSelectedInView(list, selectedKey);
  if (!edits.length && !rejected.length) return null;
  // A press shows it again: where it was on the timeline, with its note, over the video as it plays without it.
  const goneAfter = (from: number, to: number) => goneBetween(from, to).map(e => {
    // Lit for the edit it was, too, while that one is still on its card, leaving.
    const on = !!showing && (matchesEdit(showing, e) || matchesEdit(e, showing));
    return <li key={editKey(e)} className={leaving?.(e) ? "is-leaving" : undefined}><button type="button" className={on ? "simple-edit is-rejected is-on" : "simple-edit is-rejected"} aria-current={on || undefined}
      data-log-control="open-edit" data-log-label="Rejected edit" aria-label={`${e.label}, rejected`}
      title={inRail ? undefined : e.label} data-row-tip={inRail ? e.label : undefined}
      onClick={event => { blurOnPointerClick(event); onPlay(e); }}>
      <span className="edit-badge is-rejected" aria-hidden="true"><Icon name="x" size={9} /></span>
      <span className="simple-edit-title"><span className="simple-edit-words">{e.label}</span></span>
      <span className="simple-edit-value">Rejected</span>
    </button>
      <AimRow on={on}><span className="edit-badge is-rejected" aria-hidden="true"><Icon name="x" size={9} /></span><span className="composer-aim-words">{e.label}</span></AimRow></li>;
  });
  return <ol ref={list} className="simple-edits" aria-label={label ?? (only ? "Edits that need you" : "Edits in this thread")}>
    {goneAfter(-1, firstOf(0))}
    {rows.map(({ edit, i, places, needs, allKept, unkeepRefs, nested, took }, at) => {
      const on = i === open;
      const isKept = places > 1 ? allKept : reviewed(edit);
      // A revision on its way takes the edit off the editor's list until it comes back. Its row says so whether or not
      // the editor had kept the edit: the edit they kept is on its way out (2026-11-10).
      const revisingNow = revising(edit), isRevising = !!revisingNow;
      // Scarlet is on that revision now, so the row's word moves. One waiting its turn sits still.
      const busy = !!revisingNow && isWorkingTask(revisingNow.state);
      const statusWord = revisionWord(revisingNow, { rejecting: rejecting(edit), adding: adding(edit), nextQueuedId });
      // Scarlet stopped to ask the editor something about it: the row waits on them again, amber, and doesn't shimmer.
      const asks = asksEditor(revisingNow);
      const version = edit.previous.length ? edit.previous.length + 1 : 0;
      const decided = isKept && !isRevising;
      // In For you, a handled edit says how it was decided (Kept, or Done for a marker).
      // Otherwise every edit ends on a consistent word for what it did (Cut, Audio, B-roll, Edit…).
      const value = only && decided ? (edit.marker ? "Done" : "Kept") : editRowWord(edit);
      const check = asks || (places > 1 ? needs > 0 : !!edit.check && !isRevising);
      const title = (edit.reason && edit.summary) || edit.label;
      // One that came back revised with no reason from Scarlet keeps its type tag beside v2 rather than replacing it.
      const revised = edit.check === REVISED_CHECK && !reviewed(edit) && !isRevising;
      const rowTime = clockLabel((edit as ThreadEdit).at ?? edit.range.start);
      const isAskingCurrent = !!askingKey && askingKey === editKey(edit);
      // Every row leads with its time, amber while it asks for a look, as a pass's row does: once kept it asks no more.
      const lead = <span className={asks || (check && !isKept) ? "edit-row-time simple-pass-time is-need" : "edit-row-time simple-pass-time"}>{rowTime}</span>;
      const checkTitle = revised || edit.reason ? undefined : edit.check;
      const isLeaving = !!leaving?.(edit);
      const showUnkeep = decided && !edit.marker && !isLeaving && unkeepRefs.length > 0;
      const unkeepTip = edit.check ? "Move back to For you" : only ? "Move back to safe edits" : "Unkeep";
      return <Fragment key={editKey(edit)}><li className={[isLeaving && "is-leaving", showUnkeep && "has-unkeep"].filter(Boolean).join(" ") || undefined} data-low-risk={low?.(edit) ? "" : undefined}><button type="button" aria-current={on || undefined} data-log-control="open-edit" data-log-label="Edit"
        // Clicked, the row lets go of the focus (WebView2 leaves it there), or Space would press the row again and start
        // the edit over, instead of playing the video.
        className={["simple-edit", on && "is-on", asks && "is-asking", isAskingCurrent && "is-asking-current", !on && only && decided && "is-decided"].filter(Boolean).join(" ")} onClick={e => { blurOnPointerClick(e); onPlay(edit); }}
        onPointerEnter={() => onHover?.(edit)} onPointerLeave={() => onHover?.()}
        // Why an edit asks for a look is on its card, in Scarlet's sentence. Its row keeps to the amber time and says
        // the reason on hover, as a pass's row does. In the edits column Scarlet's own hover tooltip shows the full line.
        title={inRail ? undefined : checkTitle}
        data-row-tip={inRail ? title : undefined}
        data-row-detail={inRail && checkTitle && checkTitle !== title ? checkTitle : undefined}
        aria-label={`${rowTime}: ${title}${statusWord ? `, ${statusWord.replace(/…$/, "").toLowerCase()}` : isKept ? (edit.marker ? ", done" : ", kept") : check ? ", check" : ""}`}>
        {lead}
        <span className="simple-edit-title">{decided && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-edit-words">{title}</span>{version > 0 && places === 1 && <EditVersion n={version} hover={took} />}</span>
        {/* What the row ends on says on hover what the requests about this edit took: their time and tokens, nothing else. */}
        {/* While sent back, the row ends on its live status (Revising…, Up next, Queued, Needs your answer). Once revised,
            v2 sits beside the title and the edit keeps its type tag on the right. */}
        {value && !statusWord && <span className="simple-edit-value" title={took}>{value}</span>}
        {statusWord && <span className={asks ? "simple-edit-check" : busy ? "simple-edit-check is-kept working-text" : "simple-edit-check is-kept"} title={took}>{statusWord}</span>}
      </button>
        {showUnkeep && <span className="simple-row-unkeep"
          onPointerEnter={() => onHover?.(edit)} onPointerLeave={() => onHover?.()}>
          <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
            aria-label={`Unkeep ${title}`} title={unkeepTip}
            onClick={e => {
              blurOnPointerClick(e);
              onHover?.();
              unkeepEdits(projectId, thread.id, unkeepRefs);
              recordUndo({ kind: "unkeep", word: "Unkeep", projectId, threadId: thread.id, refs: unkeepRefs, name: title });
            }}>Unkeep</button>
        </span>}
        <AimRow on={on}>{lead}<span className="composer-aim-words">{title}</span></AimRow>{nested}</li>{goneAfter(firstOf(at), firstOf(at + 1))}</Fragment>;
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
