import { taskDialogueOperation, matchesEdit, noteThread, DialogueScanPage, requestText, taskRecoveryAction, taskWasStopped, type Task, type TaskEvent, type Thread, type ThreadEdit } from "@scarlet/shared";
import { clock } from "./format";
import { cutSummary, dialogueReceipt, mergeRanges, rangesOverlap, reviewReasons, type TimeRange, type Author, type Change, type Note } from "@scarlet/timeline";
import { appliedEditSummary } from "../components/review/cutReviewDetails";
import { editConfirmation, taskChatText } from "./taskActivity";
import { runIsActive } from "./taskRun";

export { buildThreads, type Thread } from "@scarlet/shared";

interface RetryAction { taskId: string; label: "Resume agent" | "Retry edit" }
interface ProgressEntry { kind: "progress"; taskId: string; at: string; text: string }

export interface FirstCutDelivery {
  task: Task;
  appliedChangeIds: string[];
  state: "preparing" | "ready" | "unfinished";
  version?: string;
  change?: Change;
}

export function appliedPassCuts(delivery: FirstCutDelivery, edits: ThreadEdit[]) {
  return edits.filter(edit => edit.beforeCut && [edit, ...edit.previous].some(ref => delivery.appliedChangeIds.includes(ref.changeId)));
}

export type ThreadEntry = { taskId?: string } & (
  | { kind: "request"; at: string; text: string; author: Author; revisionLabel?: string }
  // `replyTo` is the run a closing reply answers. It draws after that request's block and goes where the block goes.
  // `onNote` marks what Scarlet wrote back on the editor's note, as distinct from the message it closed the request with.
  | { kind: "agent"; at: string; text: string; author: Author; change?: Change; fullText?: string; replyTo?: string; onNote?: boolean }
  | ProgressEntry
  | { kind: "question"; at: string; text: string; task: Task; answered: boolean }
  | { kind: "answer"; at: string; text: string }
  | { kind: "change"; at: string; change: Change; text: string }
  | { kind: "firstCut"; at: string; delivery: FirstCutDelivery }
  | { kind: "system"; at: string; text: string; tone?: "ok" | "warn" | "bad"; action?: RetryAction });

const FIRST_CUT_INSTRUCTION = "Make a first cut from this project’s footage and send it to me for review.";

/**
 * Scarlet's own redo of a suggestion. Applied after the video had moved on, the suggestion no longer fit, so the engine
 * asks for it again on the video as it is now. The editor didn't ask for it: it carries on the request that made the
 * suggestion, and its task's words ("Redo on the current edit") are the engine's, never shown.
 */
export const isRedo = (task: Task) => task.kind === "revise" && task.createdBy.type === "scarlet" && !task.cutConflict;
/**
 * Scarlet's recheck of a call the editor approved: the footage in its passage changed before the pass could go in, so
 * the engine sends that one cut back. It is a request about that cut, drawn under its row like a revision, and not a
 * redo of the request that saved the pass (2026-11-14: rechecks chained under an earlier "keep" and showed every
 * reply since).
 */
export const isRecheck = (task: Task) => task.kind === "revise" && task.createdBy.type === "scarlet" && !!task.cutConflict?.approved;
/** Why Scarlet is rechecking an approved cut, in place of the editor's words a revision has. */
const RECHECK_WORDS = "The footage here changed after you approved it. Rechecking the cut.";
/** What Scarlet says about a suggestion it is to make again: while the redo waits its turn, then once Scarlet is on it. */
const REDO_WAITS = "The video changed while this suggestion was waiting. I’ll redo it on the video as it is now.";
const REDOING = "The video changed while this suggestion was waiting. I’m redoing it on the video as it is now.";
const legacyInterruption = "The agent was interrupted after saving its proposed changes. You can review them here.";
const ts = (x?: string) => Date.parse(x ?? "") || 0;

function taskForChange(tasks: Task[], change: Change) {
  return tasks.find(t => t.id === change.taskId) ?? tasks.find(t => t.changeIds.includes(change.id));
}

/** The dialogue pass delivers one complete timeline, even when it saves setup and cuts separately. */
export function firstCutDeliveries(thread: Thread): Map<string, FirstCutDelivery> {
  const results = new Map<string, FirstCutDelivery>();
  for (const task of thread.tasks) {
    if (task.context.end !== undefined || task.context.editIndex !== undefined || task.context.cutIndex !== undefined ||
        taskDialogueOperation(task) !== "first-cut") continue;
    const root = task.resumeRootId ?? task.id;
    const attempts = thread.tasks.filter(t => (t.resumeRootId ?? t.id) === root);
    const last = attempts.at(-1)!;
    if (last !== task) continue;
    // The engine can save the applied cuts and an optional draft within the same millisecond.
    const order = new Map(attempts.flatMap(t => t.changeIds).map((id, index) => [id, index]));
    const changes = thread.changes.filter(c => taskForChange(attempts, c)).sort((a, b) =>
      ts(a.createdAt) - ts(b.createdAt) || (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
    const change = changes.findLast(c => c.state === "approved" || c.state === "ready");
    const lastChange = changes.at(-1);
    const preparing = runIsActive(task) ||
      (task.state === "done" && (lastChange?.state === "rendering" || lastChange?.state === "proposed"));
    const finished = task.state === "done" && !task.interrupted && task.summary !== legacyInterruption &&
      lastChange?.state !== "failed" && lastChange?.state !== "revising";
    const version = change?.appliedVersion ?? change?.toVersion ?? lastChange?.fromVersion ?? task.context.version;
    const hasDialogueCuts = change && (change.cutReasons?.length || change.appliedReview || change.ops?.some(op => op.op === "rippleDelete"));
    const canWatch = preparing ? hasDialogueCuts : change || finished;
    const delivery: FirstCutDelivery = { task, change, appliedChangeIds: changes.filter(c => c.state === "approved").map(c => c.id),
      state: preparing ? "preparing" : finished && version ? "ready" : "unfinished",
      version: canWatch ? version : undefined };
    for (const attempt of attempts) results.set(attempt.id, delivery);
  }
  return results;
}

/**
 * What a request revised, in the words the box showed before sending: "the cut at 2:29". An applied edit reads as its
 * row in the request's list does, when `edits` has it: at the time the row shows, and as a cut when it took footage out.
 * The request's own time is where the passage around the edit starts, which for a cut is before the cut itself.
 */
export function revisionTarget(task: Task, changes: readonly Change[], edits?: readonly (Omit<ThreadEdit, "at"> & { at?: number })[]) {
  const { changeId, cutIndex, editIndex, time } = task.context;
  if (!changeId) return undefined;
  const at = time !== undefined ? ` at ${clock(time)}` : "";
  if (cutIndex !== undefined) return `the cut${at}`;
  if (editIndex !== undefined) {
    const edit = edits?.find(e => matchesEdit(e, { changeId, spot: editIndex }));
    return edit ? `the ${edit.beforeCut ? "cut" : "edit"} at ${clock(edit.at ?? edit.range.start)}` : `the edit${at}`;
  }
  const change = changes.find(c => c.id === changeId);
  if (change?.intent === "suggestion") return change.cutReasons?.length ? "the whole dialogue pass" : "the suggestion";
  return "the whole edit";
}

type ListedEdit = Omit<ThreadEdit, "at">;

/**
 * A pass's staged cuts as its review numbers them. Staged cuts that touch leave no footage between them, so the review
 * lists them as one cut, and every call, note and saved choice goes by that numbering.
 */
export function stagedCuts(pass: Pick<Change, "cutReasons">): TimeRange[] {
  // The engine names a call's cut by the same merge, so the two never number them differently.
  return mergeRanges((pass.cutReasons ?? []).map(({ start, end }) => ({ start, end })));
}

/**
 * The one cut or edit a request was about, as it stands now, so the request's card can say what it did there and open
 * it on the timeline. A revised cut keeps its index through later revisions of the pass; a cut named in one part of a
 * running pass is found again in the next by its range. `note` is Scarlet's note on the cut as this request left it.
 * `edit` is the applied edit; without one, `call` is the cut's index in `changeId`, the pass that now holds it.
 * With the thread's `tasks`, the pass is also followed through a revision sent from one of its cuts' cards: that one
 * leaves the pass it revised marked as revising, with nothing on it that names the pass it made.
 */
export function requestTarget(task: Task, made: Change | undefined, changes: readonly Change[], edits: readonly ListedEdit[], tasks: readonly Task[] = []):
  { note?: string; edit?: ListedEdit; changeId?: string; call?: number } | undefined {
  const { changeId, cutIndex, editIndex } = task.context;
  if (!changeId) return undefined;
  if (editIndex !== undefined) {
    const edit = edits.find(e => matchesEdit(e, { changeId, spot: editIndex }));
    return edit && { edit };
  }
  let change = made ?? changes.find(c => c.id === changeId);
  // A request numbers its cut as the review does, where staged cuts that touch are one cut. `call` is that number too.
  let cut = cutIndex === undefined ? undefined : change && stagedCuts(change)[cutIndex];
  if (!change || !cut || cutIndex === undefined) return undefined;
  // Such a cut carries the note of each staged cut in it, as its call does.
  const note = made ? reviewReasons(made, [{ removed: cut }])[0]?.join(" ") || undefined : undefined;
  const same = (a: TimeRange, b: TimeRange) => Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05;
  let index = cutIndex;
  // The pass that took a pass's place: the one named on it, or the one a revision of one of its cuts made from it.
  const after = (pass: Change) => changes.find(c => c.id === pass.replacedBy) ?? changes.find(c => c.id !== pass.id && !!c.cutReasons
    && tasks.some(t => t.id === c.taskId && t.kind === "revise" && t.context.changeId === pass.id && t.context.cutIndex !== undefined));
  for (let hops = 0; hops < 500; hops++) {
    const next = after(change);
    if (!next?.cutReasons) break;
    const staged = stagedCuts(next);
    let found = staged.findIndex(r => same(r, cut!));
    if (found < 0) {
      // The pass's next part can stage a cut that touches this one, and the review then lists the two as one. That cut
      // holds a staged cut with this one's range, or with the range of a staged cut this one was made of.
      const ranges = [cut, ...(change.cutReasons ?? []).filter(r => r.start >= cut!.start && r.end <= cut!.end)];
      const carried = next.cutReasons.filter(r => ranges.some(range => same(r, range)));
      found = staged.findIndex(r => rangesOverlap(r, cut!) && carried.some(kept => kept.start >= r.start && kept.end <= r.end));
    }
    const at = found >= 0 ? found : index;
    const moved = staged[at];
    if (!moved || !rangesOverlap(moved, cut)) return { note };
    change = next; index = at; cut = moved;
  }
  const mine = edits.filter(e => e.beforeCut && [e, ...e.previous].some(ref => ref.changeId === change!.id));
  const edit = mine.find(e => same(e.beforeCut!.removed, cut!)) ?? mine.find(e => rangesOverlap(e.beforeCut!.removed, cut!));
  return edit ? { note, edit } : { note, changeId: change.id, call: index };
}

/** Saved conversation entries in chronological order. */
export function threadConversation(thread: Thread, notes: Note[], events: Record<string, TaskEvent[]> = {}, firstCuts?: Map<string, FirstCutDelivery>) {
  const out: ThreadEntry[] = [];
  const dialogueTasks = new Set(thread.changes.filter(c => dialogueReceipt(c)).map(c => c.taskId));
  const attempt = new Map(thread.changes.map((c, i) => [c.id, i + 1]));
  for (const t of thread.tasks) {
    const start = out.length;
    const author = t.createdBy;
    const requested = t.context.message === "Make first cut" && t.instruction.startsWith(FIRST_CUT_INSTRUCTION)
      ? t.instruction.slice(FIRST_CUT_INSTRUCTION.length).trim() : requestText(t);
    if (t.resumeRootId) out.push({ kind: "system", at: t.createdAt ?? "", text: "Edit resumed." });
    // Scarlet's redo of a suggestion has no words of its own here: the suggestion says what is happening to it, below.
    else if (author.type === "scarlet") { if (!isRedo(t)) out.push({ kind: "system", at: t.createdAt ?? "", text: isRecheck(t) ? RECHECK_WORDS : requested, tone: "warn" }); }
    else if (requested && requested !== "Make first cut") {
      out.push({ kind: "request", at: t.createdAt ?? "", text: requested, author, revisionLabel: revisionTarget(t, thread.changes) });
    }
    const taskEvents = events[t.id] ?? [];
    const pending = t.state === "waiting_for_user" ? taskEvents.findLast(ev => ev.type === "question" && ev.text === t.question) : undefined;
    const scans = new Set<string>();
    const reviewCounters = new Map<string, { count: number; entry: ProgressEntry }>();
    for (const ev of taskEvents) {
      if (ev.type === "log" && ev.data?.kind === "editor_progress" && ev.text.trim()) {
        const entry: ProgressEntry = { kind: "progress", taskId: t.id, at: ev.at ?? t.createdAt ?? "", text: ev.text.trim() };
        const result = ev.data.scanPage ? DialogueScanPage.safeParse(ev.data.scanPage) : undefined;
        if (result?.success) {
          const key = JSON.stringify([result.data.mediaId, result.data.end]);
          if (!scans.has(key)) {
            scans.add(key);
            out.push(entry);
          }
        } else if (typeof ev.data.reviewCounter === "string" && typeof ev.data.count === "number") {
          const previous = reviewCounters.get(ev.data.reviewCounter);
          if (!previous || ev.data.count > previous.count) {
            if (previous) Object.assign(previous.entry, entry);
            else out.push(entry);
            reviewCounters.set(ev.data.reviewCounter, { count: ev.data.count, entry: previous?.entry ?? entry });
          }
        } else {
          out.push(entry);
        }
      }
      if (ev.type === "question") out.push({ kind: "question", at: ev.at ?? t.createdAt ?? "", text: ev.text, task: t, answered: ev !== pending });
      if (ev.type === "answer") out.push({ kind: "answer", at: ev.at ?? t.createdAt ?? "", text: ev.text });
    }
    if (t.state === "waiting_for_user" && t.question && !pending) {
      out.push({ kind: "question", at: t.startedAt ?? t.createdAt ?? "", text: t.question, task: t, answered: false });
    }
    const hasEdit = thread.changes.some(c => c.taskId === t.id || t.changeIds.includes(c.id));
    if (hasEdit && t.state === "done" && t.summary === legacyInterruption) {
      out.push({ kind: "system", at: t.finishedAt ?? t.createdAt ?? "", text: "Scarlet was interrupted after saving changes.", tone: "warn" });
    }
    // A dialogue pass's summary is Scarlet's receipt of what it saved. What Scarlet said as it finished is its reply.
    if (t.state === "done" && (t.reply || !hasEdit)) {
      const reply = taskChatText(t, t.reply || t.summary);
      const full = editConfirmation(reply, requested, "full");
      if (full) {
        const text = editConfirmation(reply, requested) ?? full;
        out.push({ kind: "agent", at: t.finishedAt ?? t.createdAt ?? "", text, fullText: full === text ? undefined : full,
          author: { type: "agent", id: t.agent, name: t.agent, model: t.model } });
      }
    }
    if (t.state === "failed" || t.state === "cancelled") {
      const stopped = t.state === "cancelled";
      const recovery = taskRecoveryAction(t, hasEdit);
      // A request can be picked up again while nothing else in its thread is under way, and it is the last thing asked
      // there. One about a single cut or edit isn't held to being the last: a pass's thread takes a request for every
      // call, so another call's request would take the action from this one for good. The chat lets it go once a later
      // request about the same cut or edit takes its place. While another request in the thread waits or runs it has no
      // action either: a revision picked up behind another request about the same pass would revise the pass as it
      // stood before that one.
      const aboutOne = t.context.cutIndex !== undefined || t.context.editIndex !== undefined;
      const available = (aboutOne || t === thread.tasks.at(-1)) && !thread.active && !thread.question && !t.retryTaskId && recovery;
      let text = "I couldn’t finish this edit.";
      if (t.agent === "claude" && t.error?.includes("Sandbox required but unavailable")) {
        text = "Claude Code couldn’t start because its required shell sandbox was unavailable.";
      }
      if (t.interrupted) text = hasEdit ? "Scarlet was interrupted after saving changes." : "The edit was interrupted before it finished.";
      // The host stopped the run: its agent went silent ("stalled: … N minutes"), or it reached an optional
      // time cap ("timed out after N minutes", or a bare "timed out" from hosts that stopped every run at 45).
      const quiet = /^stalled\b.*?(\d+) minutes?/.exec(t.error ?? "");
      const limit = /^timed out(?: after (\d+) minutes?)?/.exec(t.error ?? "");
      const kept = hasEdit ? " What it saved is kept." : "";
      if (quiet) text = `Scarlet went quiet for ${quiet[1]} ${quiet[1] === "1" ? "minute" : "minutes"}, so the edit was stopped.${kept}`;
      else if (limit) text = (limit[1] ? `The edit reached its ${limit[1]}-minute limit.` : "The edit ran out of time.") + kept;
      if (stopped) text = "Edit stopped.";
      out.push({ kind: "system", at: t.finishedAt ?? t.createdAt ?? "",
        text, tone: stopped || taskWasStopped(t) ? "warn" : "bad",
        action: available ? { taskId: t.id, label: recovery === "resume" ? "Resume agent" : "Retry edit" } : undefined });
    }
    for (let i = start; i < out.length; i++) out[i]!.taskId = t.id;
  }
  for (const c of thread.changes) {
    if (c.replacedBy) continue;
    const task = taskForChange(thread.tasks, c);
    const pendingReply = task && runIsActive(task);
    const liveDecision = c.state === "ready" && thread.needs === "decision" && thread.active?.id === task?.id && thread.latest?.id === c.id;
    if (c.state === "approved" || liveDecision || (!pendingReply && c.state !== "proposed" && c.state !== "rendering")) {
      const request = task && requestText(task);
      const finalReply = task?.state === "done" && c.id === (task.changeIds.findLast(id => attempt.has(id)) ?? thread.changes.findLast(change => change.taskId === task.id)?.id);
      const summary = finalReply && task.summary !== legacyInterruption ? taskChatText(task) : undefined;
      const finalSummary = task && !dialogueTasks.has(task.id) ? editConfirmation(summary, request) : undefined;
      const description = editConfirmation(cutSummary(c.description), request);
      const text = c.state === "approved" ? appliedEditSummary(c)
        : c.state === "failed" ? "I couldn’t prepare the preview for this edit."
        : dialogueReceipt(c) ?? finalSummary ?? description ?? "I prepared a version for you to review.";
      const at = c.state === "approved" ? c.updatedAt ?? c.createdAt
        : finalReply && ts(task.finishedAt) > ts(c.createdAt) ? task.finishedAt : c.createdAt;
      out.push({ kind: "change", taskId: task?.id, at: at ?? "", change: c, text });
      const completion = editConfirmation(summary, request, "full");
      if (task && completion && completion !== text && c.state === "approved" && finalSummary) {
        out.push({ kind: "agent", at: task.finishedAt ?? task.createdAt ?? "", text: completion, change: c, replyTo: task.id,
          author: { type: "agent", id: task.agent, name: task.agent, model: task.model } });
      }
    }
    // Applied after the video had moved on, a suggestion goes back to Scarlet to be made again. It says so once, in
    // Scarlet's words, under the request that made it, for as long as the redo waits or runs: why it wasn't applied
    // and what happens to it. What the redo makes, or how it ended, takes the line's place.
    const redo = thread.tasks.find(t => isRedo(t) && t.context.changeId === c.id && runIsActive(t));
    if (redo) out.push({ kind: "agent", taskId: task?.id, at: redo.createdAt ?? c.updatedAt ?? "", text: redo.state === "queued" && !redo.startedAt ? REDO_WAITS : REDOING,
      author: { type: "agent", id: redo.agent, name: redo.agent, model: redo.model } });
    for (const feedback of notes.filter(n => n.changeId === c.id)) {
      // The note's own words are what its request was sent as. A reply to it is Scarlet's, and never part of them.
      const words = noteThread(feedback).text;
      if (thread.tasks.some(t => t.context.noteIds?.includes(feedback.id) && requestText(t) === words)) continue;
      out.push({ kind: "request", at: feedback.createdAt ?? c.updatedAt ?? "", text: words, author: feedback.author });
    }
    // A suggestion put away by a decision. Today that is the engine's doing: when the editor applies one of the alternatives
    // Scarlet offered, the others are put away as "Another alternative was chosen". The editor applied something else and
    // never skipped this one, so the line says it wasn't applied, the word the suggestion's own button has (Apply).
    if (c.state === "rejected" && c.decidedBy) out.push({ kind: "system", at: c.updatedAt ?? "", text: `Not applied${c.rejectReason ? `: ${c.rejectReason}` : "."}` });
  }
  for (const delivery of new Set(firstCuts?.values())) {
    const task = delivery.task;
    const at = delivery.state === "preparing" ? task.createdAt ?? ""
      : [task.finishedAt, delivery.change?.updatedAt, task.createdAt].filter(Boolean).sort().at(-1) ?? "";
    out.push({ kind: "firstCut", taskId: task.id, at, delivery });
  }
  // What Scarlet said back about a note of this thread reads as Scarlet's, under the request the note was sent as.
  for (const note of notes) {
    const asked = thread.tasks.find(t => t.context.noteIds?.includes(note.id));
    if (!asked && !thread.changes.some(c => c.id === note.changeId)) continue;
    for (const reply of noteThread(note).replies) {
      out.push({ kind: "agent", taskId: asked?.id, at: reply.createdAt ?? note.updatedAt ?? note.createdAt ?? "", text: reply.text, onNote: true,
        author: reply.author ?? { type: "agent", id: asked?.agent, name: asked?.agent ?? "Scarlet", model: asked?.model } });
    }
  }
  out.sort((a, b) => ts(a.at) - ts(b.at));
  return { entries: out };
}
