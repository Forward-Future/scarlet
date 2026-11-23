import { AGENT_LABEL, beginRevision, ScarletApiError, isProjectEditTask, queueAdmission, type RunChoice, type AgentId, type Task, type ApproveResponse } from "@scarlet/shared";
import { appliedCutReview, canApproveSpots, clipEnd, withHandles, describeDiff, diffTimelines, formatTimecode, newId, planApply, timelineDuration, TimelineOp, type Change } from "@scarlet/timeline";
import { reviewCuts } from "./cutReview";
import { plausibleEdit } from "./simulatedEdit";
import type { MockStore } from "./store";
import { agentAuthor } from "./tasks";
import { now, sleep } from "./util";

/** Simulated agent run: claim → log lines → propose change → renders → ready → done. */
export async function runTask(store: MockStore, task: Task, opts: { fromVersion?: string; description: string; noteIds?: string[]; supersedes?: Change; previewOnly?: boolean }) {
  const isCancelled = () => task.state === "cancelled";
  await sleep(600);
  // Use the same claim order as the queue tray. The mock stores its tasks newest first.
  while (task.state === "queued" && ((task.rewordingUntil && Date.parse(task.rewordingUntil) > Date.now())
    || (isProjectEditTask(task) && (store.projectById(task.projectId).editingPaused
      || !queueAdmission([...store.db.tasks].reverse(), store.db.changes, id => store.db.changes.find(change => change.id === id))(task))))) await sleep(300);
  if (isCancelled()) return;
  if (store.failWithoutHost(task)) return;
  const fromVersion = opts.fromVersion && store.db.timelines[opts.fromVersion] ? opts.fromVersion : store.projectById(task.projectId).head ?? "";
  store.updateTask(task, { state: "claimed" });
  await sleep(700);
  if (isCancelled()) return;
  store.updateTask(task, { state: "running", startedAt: now() });
  store.pushEvent(task, "log", `Starting ${AGENT_LABEL[task.agent]}${task.model ? ` (${task.model})` : ""} with project context and ${store.db.skills.filter((s) => s.enabled).length} skills`);
  await sleep(1400);
  if (isCancelled()) return;
  store.pushEvent(task, "tool", `transcript.get granularity=word${task.context.time !== undefined ? ` around=${task.context.time.toFixed(2)}` : ""}`);
  await sleep(1400);
  if (isCancelled()) return;
  store.pushEvent(task, "log", "I’m checking the timeline before preparing your edit.", { kind: "editor_progress" });
  await sleep(opts.previewOnly ? 1200 : 1550);
  if (isCancelled()) return;

  const base = store.db.timelines[fromVersion];
  if (!base) {
    store.failTask(task, "Project has no timeline yet. Upload media first.");
    return;
  }
  const { target, ops, after } = plausibleEdit(base, store.db.media[task.projectId], task.context.time);
  after.version = newId("ver");
  after.parent = base.version;
  after.createdAt = now();
  store.db.timelines[after.version] = after;
  const fps = store.projectById(task.projectId).settings.fps;
  const diff = diffTimelines(base, after, fps);
  const ranges = diff.ranges.length ? diff.ranges : [{ start: target?.timelineIn ?? 0, end: target ? clipEnd(target) : Math.min(3, timelineDuration(after)) }];
  // One before/after pair per spot, with the same 1.5 s handles the engine uses.
  const spots = diff.spots.length ? diff.spots : ranges.map((r) => ({ after: r, before: r }));
  const change: Change = { id: newId("chg"), projectId: task.projectId, fromVersion: base.version, toVersion: after.version, description: opts.description, author: agentAuthor(task), noteIds: opts.noteIds ?? [], ranges, state: "ready", renders: spots.map((sp) => ({ range: withHandles(sp.after, 1.5, diff.durationAfter), beforeRange: withHandles(sp.before, 1.5, diff.durationBefore), before: null, after: null })), taskId: task.id, threadId: task.context.threadId ?? task.id, ops: ops as unknown as Array<Record<string, unknown>> | undefined, createdAt: now(), updatedAt: now() };
  change.canApproveSpots = canApproveSpots(base, ops, ranges, fps);
  store.db.changes.unshift(change);
  store.refreshCounts(task.projectId);
  store.pushEvent(task, "tool", `timeline.propose description="${opts.description.slice(0, 60)}" → ${change.id}`);
  store.pushEvent(task, "change", `Proposed change: ${describeDiff(diff, (s) => formatTimecode(s, fps)).join("; ") || opts.description}`, { changeId: change.id });
  task.changeIds = [...task.changeIds, change.id];
  store.emitChange(change);
  if (opts.supersedes?.state === "revising") {
    opts.supersedes.state = "rejected";
    opts.supersedes.updatedAt = now();
    store.emitChange(opts.supersedes);
  }
  const result = opts.previewOnly ? change : (await applyChange(store, change.id)).change;
  if (isCancelled()) return;
  store.updateTask(task, { state: "done", summary: result.description, finishedAt: now() });
}

export async function applyChange(store: MockStore, changeId: string, spots?: number[], restoredCuts?: number[]): Promise<ApproveResponse> {
  const change = store.changeById(changeId);
  const project = store.projectById(change.projectId);
  if (change.state === "approved") {
    if (restoredCuts && [...restoredCuts].sort().join(",") !== change.restoredCuts?.slice().sort().join(",")) {
      throw new Error("This proposal was already approved with different choices.");
    }
    return { change, project, outcome: "applied" };
  }
  const head = project.head ?? change.fromVersion;
  if (head === change.toVersion && spots && !change.ranges.every((_, i) => spots.includes(i))) {
    throw new ScarletApiError(400, "spots_unsupported", "All spots are already present in the current edit");
  }
  const from = store.db.timelines[change.fromVersion];
  const to = store.db.timelines[change.toVersion];
  const headTl = store.db.timelines[head];
  let target = change.toVersion;
  let outcome: ApproveResponse["outcome"] = "applied";
  if (restoredCuts) {
    if (head !== change.fromVersion || change.state !== "ready") throw new Error("This pass wasn’t applied because the video changed since Scarlet made it: ask Scarlet to redo the pass on the video as it is now.");
    const { review, draft } = await reviewCuts(store, changeId, restoredCuts);
    if (!draft || !review) throw new Error("No individually restorable cuts.");
    change.appliedReview = appliedCutReview(review, restoredCuts);
    target = draft.version;
  } else if (from && to && headTl && head !== change.toVersion) {
    const plan = planApply({ from, to, head: headTl, ops: change.ops as TimelineOp[] | undefined, spots, changeRanges: change.ranges, fps: project.settings.fps });
    if (plan.kind === "conflict") {
      if (plan.spotsUnsupported) throw new ScarletApiError(400, "spots_unsupported", `Can't approve spots one by one: ${plan.reason}.`);
      const agent = (change.author.id as AgentId | undefined) ?? "claude";
      const task = store.makeTask(project.id, { kind: "revise", agent, model: change.author.model, instruction: `Redo on the current edit: ${change.description}`, context: { changeId, version: head, threadId: change.threadId ?? change.id, message: "Redo on the current edit" } });
      // As in the engine, the redo is Scarlet's own: the chat carries it on under the request that made the suggestion.
      task.createdBy = { type: "scarlet", name: "Scarlet" };
      Object.assign(change, beginRevision(change, task), { error: `Sent back: ${plan.reason}`, updatedAt: now() });
      void runTask(store, task, { fromVersion: head, description: change.description, supersedes: change });
      store.emitChange(change);
      store.log(project.id, "change.sent_back", `“${change.description}” couldn’t be merged (${plan.reason}); it went back to ${change.author.name}`, { changeId: change.id });
      return { change, project, outcome: "sent_back", reason: plan.reason, task };
    }
    if (plan.kind !== "fast-forward") {
      target = newId("ver");
      store.db.timelines[target] = { ...plan.timeline, version: target, parent: head, createdAt: now() };
      outcome = plan.kind;
    }
  }
  change.state = "approved";
  change.appliedVersion = target;
  change.appliedOnto = head;
  change.approvedSpots = outcome === "partial" ? spots : undefined;
  change.restoredCuts = restoredCuts;
  change.decidedBy = store.human();
  change.updatedAt = now();
  project.head = target;
  project.updatedAt = now();
  store.summary(project.id).head = target;
  const versions = (store.db.versions[project.id] ??= []);
  const tl = store.db.timelines[target];
  for (const v of versions) v.isHead = false;
  versions.push({ version: target, parent: head, name: tl?.name ?? "Main", author: change.author, changeId: change.id, description: outcome === "partial" ? `${change.description} (${spots!.length} of ${change.ranges.length})` : change.description, duration: tl ? timelineDuration(tl) : 0, isHead: true, createdAt: now() });
  for (const n of store.db.notes) {
    if (change.noteIds.includes(n.id) && n.state !== "resolved") {
      n.state = "resolved";
      n.updatedAt = now();
      store.emit({ type: "note.updated", projectId: project.id, note: { ...n } });
    }
  }
  store.refreshCounts(project.id);
  store.emitChange(change);
  store.emitProject(project.id);
  store.log(project.id, "change.approved", outcome === "partial" ? `${store.currentUser().name} approved ${spots!.length} of ${change.ranges.length} spots of “${change.description}”` : `${store.currentUser().name} approved “${change.description}”${outcome === "rebased" ? " (merged into the latest edit)" : ""}`, { changeId: change.id, outcome });
  return { change, project, outcome };
}

export function retryAttempt(store: MockStore, task: Task, body: RunChoice, action: "resume" | "retry") {
  const run = body.agent ? { agent: body.agent, model: body.model, effort: body.effort, serviceTier: body.serviceTier } : {};
  const retry = store.makeTask(task.projectId, { ...task, ...run, context: { ...task.context, threadId: task.context.threadId ?? task.id } });
  Object.assign(retry, { createdBy: task.createdBy, fast: body.agent ? body.fast : task.fast, startsBeforeCalls: task.startsBeforeCalls,
    stagedCutRevision: task.stagedCutRevision });
  if (action === "resume") retry.resumeRootId = task.resumeRootId ?? task.id;
  return retry;
}

export function runRetry(store: MockStore, task: Task) {
  const proposal = task.kind === "revise" ? store.db.changes.find(c => c.id === task.context.changeId && c.projectId === task.projectId) : undefined;
  if (proposal && proposal.state !== "approved" && proposal.state !== "revising") {
    Object.assign(proposal, beginRevision(proposal, task), { updatedAt: now() });
    store.emitChange(proposal);
  }
  void runTask(store, task, { description: task.context.message ?? task.instruction, noteIds: task.context.noteIds, supersedes: proposal,
    previewOnly: store.chatLayouts && task.resumeRootId === "task_running" });
}

export function stopTask(store: MockStore, task: Task, retryTaskId?: string) {
  store.updateTask(task, { state: "cancelled", finishedAt: now(), retryTaskId });
  store.pushEvent(task, "log", "Cancelled by user");
}
