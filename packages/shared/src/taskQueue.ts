/** Project edit queue ordering, admission policy, and wait-reason computation. */
import { isAsideTask, type Task } from "./api.js";
import type { Change } from "@scarlet/timeline";

export const IN_PROGRESS_STATES = new Set<string>(["claimed", "running", "waiting_for_user"]);
export const PENDING_STATES = new Set<string>(["queued", ...IN_PROGRESS_STATES]);

export type QueueTask = Pick<Task, "id" | "projectId" | "kind" | "state" | "createdAt" | "resumeRootId" | "queueSequence" | "startsBeforeCalls" | "resumesAfterProjectStop"> & {
  context: Pick<Task["context"], "branch" | "changeId" | "threadId" | "cutIndex" | "editIndex">;
};

type EditLineage = Pick<Change, "id" | "timelineEdits">;

/**
 * What the queue reads of a change: whether it is a pass waiting on the editor, and which run and thread made it.
 * Only how many cut reasons a pass has matters, so the engine can read the count instead of every reason.
 */
export type QueueChange = Pick<Change, "id" | "projectId" | "taskId" | "threadId" | "state" | "intent"> & {
  cutReasons?: { readonly length: number };
};

export type QueueWait =
  | { kind: "question"; task: Task }
  | { kind: "run"; task: Task }
  | { kind: "ahead"; count: number }
  | { kind: "review"; change: Change };

/** A run that was interrupted carries on under a new task. Both are the same run. */
export function sameRun(a: Task, b: Task | undefined): boolean {
  return !!b && (a.resumeRootId ?? a.id) === (b.resumeRootId ?? b.id);
}

/** True when `task` edits the project's video (not transcription or an aside task). */
export const editsVideo = (task: Pick<QueueTask, "kind">): boolean => task.kind !== "transcribe" && !isAsideTask(task);

/**
 * A dialogue pass whose staged cuts still need the editor. A request built on the edit before those cuts are
 * decided could block applying them, so new requests wait for it, except ones about the pass itself. A pass with one
 * cut sent back for revision is still open while that revision is queued or running: an earlier request let through
 * then would move the edit on, and the revision would be refused as out of date. Once the revision has run, its new
 * version is the pass that waits. The version it replaced stays marked as revising, and holds nothing.
 */
export function openDialogueReview(change: QueueChange, tasks: readonly QueueTask[]): boolean {
  if (change.intent !== "suggestion" || !change.cutReasons?.length) return false;
  return change.state === "ready"
    || (change.state === "revising" && tasks.some(t => t.projectId === change.projectId && PENDING_STATES.has(t.state) && t.context.changeId === change.id));
}

/** A reply in the pass's thread or a revision of it works on the pass, so the pass doesn't hold it back. */
export function aboutChange(task: QueueTask, change: Pick<QueueChange, "id" | "threadId">): boolean {
  return (task.context.threadId ?? task.id) === change.threadId || task.context.changeId === change.id;
}

/** The dialogue passes waiting on the editor on a request's branch. */
function reviewIndex<C extends QueueChange>(tasks: readonly QueueTask[], changes: readonly C[]) {
  const makers = new Map(tasks.map(task => [task.id, task]));
  const byBranch = new Map<string, C[]>();
  const key = (projectId: string, branch?: string) => JSON.stringify([projectId, branch]);
  for (const change of changes) {
    const maker = change.taskId ? makers.get(change.taskId) : undefined;
    if (!maker || !openDialogueReview(change, tasks)) continue;
    const branch = key(change.projectId, maker.context.branch);
    const reviews = byBranch.get(branch);
    if (reviews) reviews.push(change);
    else byBranch.set(branch, [change]);
  }
  return (task: QueueTask): readonly C[] => byBranch.get(key(task.projectId, task.context.branch)) ?? [];
}

/**
 * A pass a run is still making: the run saved it, and every earlier save it took the place of, as a pass does part by
 * part. A request about a call of a pass that already waited saves the pass again under its own run, in place of the
 * one another run staged. That pass waited on the editor before the request began and waits on them still.
 */
function stillMaking(pass: Change, run: Task, tasks: readonly Task[], changes: readonly Change[], hops = 0): boolean {
  if (!sameRun(run, tasks.find(t => t.id === pass.taskId))) return false;
  return hops > 50 || changes.every(c => c.replacedBy !== pass.id || !c.cutReasons?.length || stillMaking(c, run, tasks, changes, hops + 1));
}

/**
 * The one cut or edit a request is about, when it is about one, as a key two requests share exactly when they are about
 * the same thing. Undefined for a request about the whole video.
 *
 * - A call of a pass (`cutIndex`): `["call", thread, cutIndex]`. Every version of a pass is saved in the pass's thread,
 *   and a revision of one call saves the whole pass again under a new id, so the thread names the pass across its versions.
 * - An applied edit (`editIndex`), revised or undone from its card or from the list of the request that flagged it:
 *   `["edit", changeId, spot]` of the edit's first version. A revision is a new change whose edit `replaces` the one it
 *   revised, so with `changes` the chain is followed back to where the edit was first made; requests about it then name
 *   the same edit whichever version they were sent about, and whichever thread they were sent from.
 *
 * The engine and tray both use this lineage to decide which edits can run together.
 */
export function requestTargetKey(task: QueueTask, changes: readonly EditLineage[] = []): string | undefined {
  return targetKey(task, lineageOf(changes));
}

function targetKey(task: QueueTask, changeById: (id: string) => EditLineage | undefined): string | undefined {
  const { changeId, cutIndex, editIndex, threadId } = task.context;
  if (!changeId || (cutIndex === undefined && editIndex === undefined)) return undefined;
  if (cutIndex !== undefined) return JSON.stringify(["call", threadId ?? task.id, cutIndex]);
  let at = { changeId, spot: editIndex! };
  for (let hops = 0; hops < 50; hops++) {
    const back = changeById(at.changeId)?.timelineEdits?.[at.spot]?.replaces;
    if (!back) break;
    at = back;
  }
  return JSON.stringify(["edit", at.changeId, at.spot]);
}

/**
 * Whether two requests in a project must take turns. Requests about different cuts or edits work at once, an agent on
 * each, and so does a request about one applied edit beside a request about the whole video, such as the pass that
 * made it: an applied edit's revision is replayed onto the video as it is when it lands, through the footage, and a
 * save that meets footage another request changed since it read the video isn't applied (`notApplied`, or a pass
 * part's `cut_changed`), so its agent reads the passage again and is told when the editor asked for what changed it.
 * A call's revision saves into its pass, so it takes turns with any request in the pass's thread (the run still
 * making the pass, or a reply to it) and works beside a request about the whole video in another thread. Two requests
 * about the whole video, and two about the same cut or edit, keep the order they were asked in. What counts as the
 * same cut or edit comes from requestTargetKey.
 */
function takeTurns(a: QueueTask, aKey: string | undefined, b: QueueTask, bKey: string | undefined): boolean {
  if (aKey !== undefined && bKey !== undefined) return aKey === bKey;
  if (aKey === undefined && bKey === undefined) return true;
  const [one, key, whole] = aKey !== undefined ? [a, aKey, b] : [b, bKey!, a];
  const [kind] = JSON.parse(key) as ["call" | "edit", ...unknown[]];
  return kind === "call" && threadOfRequest(one) === threadOfRequest(whole);
}

/** The thread a request belongs to; a resumed run keeps its first run's thread. */
const threadOfRequest = (task: QueueTask) => task.context.threadId ?? task.resumeRootId ?? task.id;

/** A request about one applied edit, which the calls of a pass waiting on the editor don't hold back. */
const aboutAppliedEdit = (key: string | undefined) => key !== undefined && (JSON.parse(key) as unknown[])[0] === "edit";

/**
 * The order requests were asked in. A resumed run keeps the place of the run it continues. Requests saved in the same
 * millisecond keep the order the engine saved them in (`queueSequence`, its row number). A task the engine didn't
 * number, as the demo's are, follows the numbered ones of its millisecond, in the order the snapshot lists them: row
 * numbers and positions in a list are never compared with each other.
 */
function inLine(tasks: readonly QueueTask[]) {
  type Place = { createdAt: string; sequence?: number; index: number };
  const positions = new Map<string, Place>(tasks.map(({ id, createdAt, queueSequence }, index) =>
    [id, { createdAt: createdAt ?? "", sequence: queueSequence, index }]));
  const compare = (x: Place, y: Place) => x.createdAt !== y.createdAt ? (x.createdAt < y.createdAt ? -1 : 1)
    : (x.sequence === undefined ? 1 : 0) - (y.sequence === undefined ? 1 : 0)
      || (x.sequence ?? 0) - (y.sequence ?? 0) || x.index - y.index;
  const place = (task: QueueTask) => {
    const attempt = positions.get(task.id) ?? { createdAt: task.createdAt ?? "", sequence: task.queueSequence, index: tasks.length };
    const root = task.resumeRootId ? positions.get(task.resumeRootId) : undefined;
    return { original: root ?? attempt, attempt };
  };
  return (a: QueueTask, b: QueueTask) => {
    const x = place(a), y = place(b);
    return Number(!!b.resumesAfterProjectStop) - Number(!!a.resumesAfterProjectStop)
      || compare(x.original, y.original) || compare(x.attempt, y.attempt);
  };
}

/** Each change by its id, to follow an edit back through its revisions. */
function lineageOf(changes: readonly EditLineage[]) {
  const byId = new Map(changes.map(change => [change.id, change]));
  return (id: string) => byId.get(id);
}

function queuePolicy<T extends QueueTask, C extends QueueChange>(tasks: readonly T[], changes: readonly C[],
  lookup: (id: string) => EditLineage | undefined) {
  const reviews = reviewIndex(tasks, changes);
  const order = inLine(tasks);
  const edits = tasks.filter(editsVideo);
  const active = edits.filter(task => IN_PROGRESS_STATES.has(task.state));
  const queued = edits.filter(task => task.state === "queued").sort(order);
  const keys = new Map<T, string | undefined>();
  const keyOf = (task: T) => {
    if (!keys.has(task)) keys.set(task, targetKey(task, lookup));
    return keys.get(task);
  };
  const others = (task: T, other: T) => task.id !== other.id && task.projectId === other.projectId
    && takeTurns(task, keyOf(task), other, keyOf(other));
  // A pass's calls hold back requests built on the video before they're decided. An applied edit's revision isn't one:
  // the pass's cuts are anchored in the footage and carry onto the video it leaves, one at a time, as the editor's own
  // put-backs do, and a cut whose footage it changed goes back to Scarlet for a new look.
  const holding = (task: T) => task.startsBeforeCalls || aboutAppliedEdit(keyOf(task)) ? []
    : reviews(task).filter(change => !aboutChange(task, change));
  const ahead = (task: T, prior: T) => others(task, prior) && order(prior, task) < 0
    && !reviews(task).some(change => aboutChange(task, change) && !aboutChange(prior, change));
  const running = (task: T) => active.find(other => others(task, other));
  const blocker = (task: T, remaining: readonly T[] = queued) => {
    const run = running(task);
    if (run) return { reason: run.state === "waiting_for_user" ? "question" : "active_run", id: run.id } as const;
    const review = holding(task)[0];
    if (review) return { reason: "review", id: review.id } as const;
    const prior = remaining.find(other => ahead(task, other));
    return prior ? { reason: "earlier_request", id: prior.id } as const : undefined;
  };

  return { active, queued, holding, ahead, running, blocker,
    canClaim: (task: T, remaining?: readonly T[]) => blocker(task, remaining) === undefined };
}

/**
 * Whether the engine may start a queued request now. The engine loads only pending tasks, their chronological roots
 * and the makers of open reviews, and the columns of each change the queue reads; `lookup` reads an edit's lineage
 * only for a request about an applied edit.
 */
export function queueAdmission(tasks: readonly QueueTask[], changes: readonly QueueChange[], lookup: (id: string) => EditLineage | undefined) {
  const policy = queuePolicy(tasks, changes, lookup);
  return policy.canClaim;
}

/** The first reason admission would hold this request, using the same policy as the editor's queue. */
export function queueBlocker(tasks: readonly QueueTask[], changes: readonly QueueChange[], lookup: (id: string) => EditLineage | undefined) {
  return queuePolicy(tasks, changes, lookup).blocker;
}

/** A pass being staged is described as a run while Scarlet is making it. */
function heldBy(reviews: readonly Change[], active: readonly Task[], tasks: readonly Task[], changes: readonly Change[]): Change | undefined {
  return reviews.find(change => !active.some(run => stillMaking(change, run, tasks, changes)));
}

/**
 * Why each queued request hasn't started, for one snapshot of a project's tasks and changes. The rules are worked out
 * once for the snapshot, so asking about every queued request costs one pass, not one per request.
 */
export function queueWaits(tasks: readonly Task[], changes: readonly Change[]): (task: Task) => QueueWait | undefined {
  const policy = queuePolicy(tasks, changes, lineageOf(changes));
  const answers = new Map<Task, QueueWait | undefined>();
  const wait = (task: Task): QueueWait | undefined => {
    if (task.state !== "queued" || !editsVideo(task)) return undefined;
    const running = policy.running(task);
    if (running?.state === "waiting_for_user") return { kind: "question", task: running };
    const active = policy.active.filter(other => other.projectId === task.projectId);
    const open = policy.holding(task);
    const review = heldBy(open, active, tasks, changes);
    if (running) return review ? { kind: "review", change: review } : { kind: "run", task: running };
    const ahead = policy.queued.filter(prior => policy.ahead(task, prior)).length;
    if (ahead) return { kind: "ahead", count: ahead };
    if (review) return { kind: "review", change: review };
    const making = active.find(run => open.some(change => stillMaking(change, run, tasks, changes)));
    return making ? { kind: "run", task: making } : undefined;
  };
  return task => {
    if (!answers.has(task)) answers.set(task, wait(task));
    return answers.get(task);
  };
}

/** Why a queued request hasn't started. To ask about several requests in one snapshot, use queueWaits. */
export function queueWait(task: Task, tasks: readonly Task[], changes: readonly Change[]): QueueWait | undefined {
  return queueWaits(tasks, changes)(task);
}

/** Work eligible beside an active edit comes first, followed by the order once active work finishes. */
export function queueOrder(tasks: readonly Task[], changes: readonly Change[]): Task[] {
  const policy = queuePolicy(tasks, changes, lineageOf(changes));
  let waiting = policy.queued;
  const order: Task[] = [];
  for (;;) {
    const next = waiting.find(task => policy.canClaim(task, waiting)) ?? waiting.find(task => {
      const active = policy.active.filter(other => other.projectId === task.projectId);
      return !heldBy(policy.holding(task), active, tasks, changes) && !waiting.some(prior => policy.ahead(task, prior));
    });
    if (!next) return [...order, ...waiting];
    order.push(next);
    waiting = waiting.filter(task => task.id !== next.id);
  }
}
