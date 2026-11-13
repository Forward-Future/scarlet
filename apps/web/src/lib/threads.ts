import { taskDialogueOperation, matchesEdit, namedTimelineEdits, noteThread, queueWait, DialogueScanPage, requestText, taskRecoveryAction, taskWasStopped, type Task, type TaskEvent, type Thread, type ThreadEdit } from "@scarlet/shared";
import { clock } from "./format";
import { groupEditMessages } from "./groupEditMessages";
import { dialogueReceipt, mergeRanges, reviewReasons, type TimeRange, type Author, type Change, type Note } from "@scarlet/timeline";
import { appliedEditSummary, cutSummary } from "../components/review/cutReviewDetails";
import { compactActivity, editConfirmation, isDialogueScanTool, pendingMediaWaits, taskActivityLabel, taskChatText, TRANSCRIPT_WAIT, waitingFor } from "./taskActivity";

export { buildThreads, requestText, type Thread } from "@scarlet/shared";

export interface InlineEdit { end: number; phrase: string; change: Change; spot: number }
export interface EditDetail { text: string; change?: Change; edits?: InlineEdit[]; excerpt?: string }
export interface RetryAction { taskId: string; label: "Resume agent" | "Retry edit" }
export interface ProgressEntry {
  kind: "progress"; taskId: string; at: string; text: string; edits?: InlineEdit[]; excerpt?: string;
  summary?: string;
  scan?: { mediaId: string; end: number; seconds: number; total: number; updatedAt: string };
}

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
  | { kind: "request"; at: string; text: string; author: Author; voice?: boolean; revisionLabel?: string; queueStatus?: string }
  // `replyTo` is the run a closing reply answers. It draws after that request's block and goes where the block goes.
  // `onNote` marks what Scarlet wrote back on the editor's note, as distinct from the message it closed the request with.
  | { kind: "agent"; at: string; text: string; author: Author; change?: Change; fullText?: string; replyTo?: string; onNote?: boolean }
  | ProgressEntry
  | { kind: "question"; at: string; text: string; task: Task; answered: boolean }
  | { kind: "answer"; at: string; text: string }
  | { kind: "change"; at: string; change: Change; attempt: number; text: string; details?: EditDetail[]; activity?: ProgressEntry[]; delivery?: FirstCutDelivery }
  | { kind: "firstCut"; at: string; delivery: FirstCutDelivery }
  | { kind: "system"; at: string; text: string; tone?: "ok" | "warn" | "bad"; action?: RetryAction });

const FIRST_CUT_INSTRUCTION = "Make a first cut from this project’s footage and send it to me for review.";

/** The last page ends on the last word, short of the recording's length: the same half second the run's steps allow. */
function scanComplete(scan: { seconds: number; total: number }) {
  return scan.seconds >= scan.total - 0.5;
}

const ACTIVE = new Set<Task["state"]>(["queued", "claimed", "running"]);
/**
 * Scarlet's own redo of a suggestion. Applied after the video had moved on, the suggestion no longer fit, so the engine
 * asks for it again on the video as it is now. The editor didn't ask for it: it carries on the request that made the
 * suggestion, and its task's words ("Redo on the current edit") are the engine's, never shown.
 */
export const isRedo = (task: Task) => task.kind === "revise" && task.createdBy.type === "scarlet";
/** What Scarlet says about a suggestion it is to make again: while the redo waits its turn, then once Scarlet is on it. */
const REDO_WAITS = "The video changed while this suggestion was waiting. I’ll redo it on the video as it is now.";
const REDOING = "The video changed while this suggestion was waiting. I’m redoing it on the video as it is now.";
const legacyInterruption = "The agent was interrupted after saving its proposed changes. You can review them here.";
const ts = (x?: string) => Date.parse(x ?? "") || 0;

export interface ThreadGroups {
  needsYou: Thread[];
  working: Thread[];
  /** Approved edits, newest first. */
  done: Thread[];
  /** Other closed threads. */
  closed: Thread[];
}

/** Needs you: questions first, then oldest first. Working: newest first. Done: approved edits, newest first. */
export function groupThreads(threads: Thread[]): ThreadGroups {
  const needsYou = threads
    .filter((t) => t.status === "needs_you")
    .sort((a, b) => Number(b.needs === "question") - Number(a.needs === "question") || Number(a.needs === "failed") - Number(b.needs === "failed") || ts(a.updatedAt) - ts(b.updatedAt));
  const working = threads.filter((t) => t.status === "working").sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  const finished = threads.filter((t) => t.status === "done" || t.status === "closed").sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
  const done = finished.filter((t) => t.status === "done");
  const closed = finished.filter((t) => t.status === "closed");
  return { needsYou, working, done, closed };
}

/** Case-insensitive search over what was asked, what the agent said, and every attempt. */
export function matchesThread(t: Thread, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [t.title, ...t.tasks.map((x) => `${requestText(x)} ${x.summary ?? ""}`), ...t.changes.map((c) => c.description)].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Find the thread containing a task, change or thread id (for links like ?item=chg_…). */
export function threadFor(threads: Thread[], id: string | null | undefined): Thread | undefined {
  if (!id) return undefined;
  return threads.find((t) => t.id === id || t.tasks.some((x) => x.id === id) || t.changes.some((c) => c.id === id));
}

/** Resolve explicit word-to-spot links from saved or streaming messages, scoped to this task. */
function inlineEdits(text: string, refs: unknown, task: Task, changes: Change[]): InlineEdit[] | undefined {
  if (!Array.isArray(refs)) return;
  const result: InlineEdit[] = [];
  let offset = 0;
  for (const ref of refs) {
    if (!ref || typeof ref.phrase !== "string" || !ref.phrase || !Number.isInteger(ref.spot)) continue;
    const change = changes.find(c => c.id === ref.changeId && (c.taskId === task.id || task.changeIds.includes(c.id)));
    if (!change || change.state === "failed") continue;
    const named = namedTimelineEdits(change);
    if (!(named ?? change.ranges)[ref.spot]) continue;
    // A cut-by-cut review may replace a whole-proposal range with entirely new joins.
    if (change.appliedReview) continue;
    const spot = change.appliedWindows && change.approvedSpots ? change.approvedSpots.indexOf(ref.spot) : ref.spot;
    if (spot < 0 || (change.appliedWindows && !named && !change.appliedWindows[spot])) continue;
    const at = text.indexOf(ref.phrase, offset);
    if (at < 0) continue;
    offset = at + ref.phrase.length;
    result.push({ end: offset, phrase: ref.phrase, change, spot });
  }
  return result.length ? result : undefined;
}

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
    const preparing = ACTIVE.has(task.state) || task.state === "waiting_for_user" ||
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
  const overlaps = (a: TimeRange, b: TimeRange) => a.start < b.end && a.end > b.start;
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
      found = staged.findIndex(r => overlaps(r, cut!) && carried.some(kept => kept.start >= r.start && kept.end <= r.end));
    }
    const at = found >= 0 ? found : index;
    const moved = staged[at];
    if (!moved || !overlaps(moved, cut)) return { note };
    change = next; index = at; cut = moved;
  }
  const mine = edits.filter(e => e.beforeCut && [e, ...e.previous].some(ref => ref.changeId === change!.id));
  const edit = mine.find(e => same(e.beforeCut!.removed, cut!)) ?? mine.find(e => overlaps(e.beforeCut!.removed, cut!));
  return edit ? { note, edit } : { note, changeId: change.id, call: index };
}

/** What a queued request shows: Scarlet runs one request at a time in a project, so it says what it is waiting for. */
export function queueLabel(task: Task, tasks: readonly Task[], changes: readonly Change[], isDialoguePass: (task: Task) => boolean): string | undefined {
  const wait = queueWait(task, tasks, changes);
  if (!wait) return undefined;
  switch (wait.kind) {
    case "question": return "Queued · Waiting for your answer on the earlier edit";
    case "run": return isDialoguePass(wait.task) ? "Queued · After the dialogue pass" : "Queued · After the current edit";
    case "ahead": return `Queued · ${wait.count} ${wait.count === 1 ? "request" : "requests"} ahead`;
    // The pass's card in the chat says what it waits for.
    case "review": return "Queued";
  }
}

/** Saved conversation entries in chronological order, with the active task's work tracked separately. */
export function threadConversation(thread: Thread, notes: Note[], events: Record<string, TaskEvent[]> = {}, firstCuts?: Map<string, FirstCutDelivery>, timelineEdits?: ThreadEdit[],
  /** Why a queued request is waiting, across the whole project (queueLabel). Without it, only this thread is considered. */
  queue?: (task: Task) => string | undefined) {
  const out: ThreadEntry[] = [];
  /** `transcripts`: recordings whose transcripts the live line is waiting for, so it can show their progress. */
  let live: { text: string; entry: ProgressEntry; transcripts?: string[] } | undefined;
  const currentEdit = thread.question ?? thread.active;
  // The live line is the running request's. A run picked up after an interruption is a later task than a request that
  // was already waiting in its thread, so it isn't the thread's first in line.
  const running = thread.tasks.find(t => t.state === "running");
  let queuedFollowUps = 0;
  const dialogueTasks = new Set(thread.changes.filter(c => dialogueReceipt(c)).map(c => c.taskId));
  const attempt = new Map(thread.changes.map((c, i) => [c.id, i + 1]));
  for (const t of thread.tasks) {
    const start = out.length;
    const waiting = t.state === "queued" && currentEdit && t.id !== currentEdit.id;
    if (waiting) queuedFollowUps++;
    const author = t.createdBy;
    const requested = t.context.message === "Make first cut" && t.instruction.startsWith(FIRST_CUT_INSTRUCTION)
      ? t.instruction.slice(FIRST_CUT_INSTRUCTION.length).trim() : requestText(t);
    if (t.resumeRootId) out.push({ kind: "system", at: t.createdAt ?? "", text: "Edit resumed." });
    // Scarlet's redo of a suggestion has no words of its own here: the suggestion says what is happening to it, below.
    else if (author.type === "scarlet") { if (!isRedo(t)) out.push({ kind: "system", at: t.createdAt ?? "", text: requested, tone: "warn" }); }
    else if (requested && requested !== "Make first cut") {
      const revisionLabel = revisionTarget(t, thread.changes);
      let queueStatus = queue && t.state === "queued" ? queue(t) : undefined;
      if (!queue && waiting) {
        if (queuedFollowUps > 1) queueStatus = `Queued · ${queuedFollowUps} edits ahead`;
        else if (thread.question) queueStatus = "Queued · Waiting for your answer on the earlier edit";
        else queueStatus = firstCuts?.has(currentEdit.id) ? "Queued · After the dialogue edit" : "Queued · After the current edit";
      }
      out.push({ kind: "request", at: t.createdAt ?? "", text: requested, author, revisionLabel, queueStatus });
    }
    const taskEvents = events[t.id] ?? [];
    const pending = t.state === "waiting_for_user" ? taskEvents.findLast(ev => ev.type === "question" && ev.text === t.question) : undefined;
    // Only the last transient status can survive the replay. Historical tools
    // aren't conversation entries and need no labels of their own.
    const transient = t.state === "running" && taskEvents.findLast(ev =>
      (ev.type === "tool" || ev.type === "answer" || ev.type === "change" || (ev.type === "log" && !(ev.data?.kind === "editor_progress" && ev.text.trim()))) &&
      !!taskActivityLabel(ev));
    const scans = new Map<string, { entry: ProgressEntry; start: number; ranges: TimeRange[] }>();
    // A call that only collects a transcript or analysis still being prepared reads as waiting for it.
    const waits = pendingMediaWaits(taskEvents);
    const reviewCounters = new Map<string, { count: number; entry: ProgressEntry }>();
    let current: ProgressEntry | undefined;
    for (const ev of taskEvents) {
      if (ev.type === "log" && ev.data?.kind === "editor_progress" && ev.text.trim()) {
        const text = ev.text.trim();
        const entry: ProgressEntry = { kind: "progress", taskId: t.id, at: ev.at ?? t.createdAt ?? "", text };
        const result = ev.data.scanPage ? DialogueScanPage.safeParse(ev.data.scanPage) : undefined;
        if (!result?.success) entry.summary = compactActivity(ev) ?? (text.length <= 48 ? text : "Editing");
        if (result?.success) {
          const page = result.data;
          const key = JSON.stringify([page.mediaId, page.end]);
          const scan = scans.get(key) ?? { entry, start: page.from, ranges: [] };
          if (!scans.has(key)) {
            out.push(scan.entry);
            current = scan.entry;
          }
          scans.set(key, scan);
          scan.start = Math.min(scan.start, page.from);
          if (page.to !== undefined) {
            scan.ranges = mergeRanges([...scan.ranges, { start: page.from, end: page.to }]);
          }
          const seconds = scan.ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
          const total = page.end - scan.start;
          if (seconds !== scan.entry.scan?.seconds || total !== scan.entry.scan?.total) {
            scan.entry.scan = { mediaId: page.mediaId, end: page.end, seconds, total, updatedAt: entry.at };
          }
        } else if (typeof ev.data.reviewCounter === "string" && typeof ev.data.count === "number") {
          const previous = reviewCounters.get(ev.data.reviewCounter);
          if (!previous || ev.data.count > previous.count) {
            if (previous) Object.assign(previous.entry, entry);
            else out.push(entry);
            current = previous?.entry ?? entry;
            reviewCounters.set(ev.data.reviewCounter, { count: ev.data.count, entry: current });
          }
        } else {
          entry.edits = inlineEdits(text, ev.data.edits, t, thread.changes);
          if (entry.edits && typeof ev.data.excerpt === "string") entry.excerpt = ev.data.excerpt.trim().slice(0, 280);
          out.push(entry);
          if (!entry.edits || ev.data.activity) current = entry;
        }
      } else if (ev === transient) {
        const text = taskActivityLabel(ev, scans.size > 0, waits);
        if (text) {
          const scanTool = isDialogueScanTool(ev);
          current = { kind: "progress", taskId: t.id, at: ev.at ?? t.createdAt ?? "", text,
            summary: scanTool && scans.size ? text : (waitingFor(ev, waits) ? "Waiting" : compactActivity(ev)) ?? text };
          if (scanTool) {
            const input = ev.data?.input;
            const mediaId = input && typeof input === "object" && "mediaId" in input ? input.mediaId : undefined;
            const from = input && typeof input === "object" && "from" in input ? input.from : 0;
            // Reading an unfinished page joins the same scan. Reading saved pages is separate work.
            for (const scan of scans.values()) {
              if (scan.entry.scan && scan.entry.scan.mediaId === mediaId && typeof from === "number" &&
                  from >= scan.start && from < scan.entry.scan.end && !scan.ranges.some(r => from >= r.start && from < r.end)) {
                current = scan.entry;
                break;
              }
            }
          }
        }
      }
      if (ev.type === "question") out.push({ kind: "question", at: ev.at ?? t.createdAt ?? "", text: ev.text, task: t, answered: ev !== pending });
      if (ev.type === "answer") out.push({ kind: "answer", at: ev.at ?? t.createdAt ?? "", text: ev.text });
    }
    if (t === running && current) {
      let text = current.text;
      if (current.scan) {
        const scanning = [...scans.values()].some(s => s.entry.scan && !scanComplete(s.entry.scan));
        text = scanning ? "Scanning dialogue" : "Preparing edits…";
      }
      const transcripts = [...waits].flatMap(key => key.startsWith("transcript/") ? [key.slice("transcript/".length)] : []);
      live = text === TRANSCRIPT_WAIT && transcripts.length ? { entry: current, text, transcripts } : { entry: current, text };
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
    const pendingReply = task && (task.state === "waiting_for_user" || ACTIVE.has(task.state));
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
      out.push({ kind: "change", taskId: task?.id, at: at ?? "", change: c, attempt: attempt.get(c.id) ?? 1, text });
      const completion = editConfirmation(summary, request, "full");
      if (task && completion && completion !== text && (timelineEdits || (c.state === "approved" && finalSummary))) {
        out.push({ kind: "agent", at: task.finishedAt ?? task.createdAt ?? "", text: completion, change: c, replyTo: task.id,
          author: { type: "agent", id: task.agent, name: task.agent, model: task.model } });
      }
    }
    // Applied after the video had moved on, a suggestion goes back to Scarlet to be made again. It says so once, in
    // Scarlet's words, under the request that made it, for as long as the redo waits or runs: why it wasn't applied
    // and what happens to it. What the redo makes, or how it ended, takes the line's place.
    const redo = thread.tasks.find(t => isRedo(t) && t.context.changeId === c.id && (ACTIVE.has(t.state) || t.state === "waiting_for_user"));
    if (redo) out.push({ kind: "agent", taskId: task?.id, at: redo.createdAt ?? c.updatedAt ?? "", text: redo.state === "queued" && !redo.startedAt ? REDO_WAITS : REDOING,
      author: { type: "agent", id: redo.agent, name: redo.agent, model: redo.model } });
    for (const feedback of notes.filter(n => n.changeId === c.id)) {
      // The note's own words are what its request was sent as. A reply to it is Scarlet's, and never part of them.
      const words = noteThread(feedback).text;
      if (thread.tasks.some(t => t.context.noteIds?.includes(feedback.id) && requestText(t) === words)) continue;
      out.push({ kind: "request", at: feedback.createdAt ?? c.updatedAt ?? "", text: words, author: feedback.author, voice: !!feedback.voiceTranscript });
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
  return { entries: timelineEdits ? groupEditMessages(out, thread, timelineEdits) : out, live, queuedFollowUps };
}
