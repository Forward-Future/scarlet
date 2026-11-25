import { dialogueCommand, AGENT_LABEL, ScarletApiError, isProjectEditTask, sameRun, type PictureMarks, type RunChoice, type CreateTaskRequest, type Task, type TaskAttachment } from "@scarlet/shared";
import type { Project } from "@scarlet/timeline";
import { markRenderDone } from "./renders";
import { runTask, retryAttempt, runRetry, stopTask } from "./runs";
import type { MockStore } from "./store";
import { now, sleep } from "./util";

type AnswerFiles = { attachments: TaskAttachment[]; pictureMarks?: PictureMarks };

export function createTask(store: MockStore, projectId: string, body: CreateTaskRequest) {
  store.projectById(projectId);
  if (body.kind === "skill_from_change") throw new ScarletApiError(400, "use_skill_from_change", "Create skill tasks from an approved change");
  if (body.kind === "skill_edit") throw new ScarletApiError(400, "use_skill_edit", "Ask for a change to a skill from its page");
  if (body.kind === "learning_check") throw new ScarletApiError(400, "not_a_request", "Scarlet starts this check itself, with each request.");
  const followUp = body.context?.threadId;
  store.log(projectId, "request.created", `${store.currentUser().name} asked ${AGENT_LABEL[body.agent]}: “${body.context?.message ?? body.instruction}”${followUp ? " (follow-up)" : ""}`);
  // As the engine does: what the person said is the request itself, unless the app sent their words apart from what
  // it asks of the agent.
  const said = body.context?.message ?? body.instruction;
  const task = store.makeTask(projectId, { kind: body.kind ?? "edit", agent: body.agent, model: body.model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.instruction,
    context: { ...(body.context ?? {}), ...(followUp ? { message: said, asked: said === body.instruction ? undefined : body.instruction } : {}) } });
  void runTask(store, task, { description: body.instruction.length > 90 ? `${body.instruction.slice(0, 87)}…` : body.instruction });
  return { task };
}

export function stopEditing(store: MockStore, id: string) {
  const project = setEditingPaused(store, id, true);
  // Only a run at work is stopped. A question, and an answered run back in line, hold no worker and wait for Continue.
  const active = store.db.tasks.filter(task => task.projectId === id && isProjectEditTask(task)
    && ["claimed", "running"].includes(task.state));
  const tasks = active.flatMap(task => {
    const retry = retryAttempt(store, task, {}, "resume");
    stopTask(store, task, retry.id);
    store.updateTask(retry, { resumesAfterProjectStop: true, cutConflict: task.cutConflict });
    runRetry(store, retry);
    return [{ ...task }, { ...retry }];
  });
  return { project, tasks };
}

export function resumeEditing(store: MockStore, id: string, choice?: RunChoice) {
  const wasPaused = store.projectById(id).editingPaused;
  const project = setEditingPaused(store, id, false);
  const tasks = wasPaused ? store.db.tasks.filter(task => task.projectId === id && task.state === "queued" && task.resumesAfterProjectStop) : [];
  if (choice?.agent) {
    for (const task of tasks) {
      store.updateTask(task, { agent: choice.agent, model: choice.model, effort: choice.effort, fast: choice.fast, serviceTier: choice.serviceTier });
    }
  }
  return { project, tasks: tasks.map(task => ({ ...task })) };
}

function setEditingPaused(store: MockStore, id: string, editingPaused: boolean): Project {
  const project = store.projectById(id);
  if (Boolean(project.editingPaused) === editingPaused) return { ...project };
  project.editingPaused = editingPaused;
  const saved = { ...project };
  store.emit({ type: "project.updated", projectId: id, project: saved });
  return saved;
}

/** The engine's rule: only a request that hasn't begun has words left to change. */
function waitingToReword(store: MockStore, taskId: string): Task {
  const task = store.taskById(taskId);
  if (task.state !== "queued" || task.startedAt || task.resumeRootId) throw new ScarletApiError(409, "already_started", "Scarlet has already started on this request.");
  if (task.createdBy.type !== "human") throw new ScarletApiError(409, "not_yours", "This request is Scarlet’s own, so its words can’t be changed.");
  return task;
}

export function startBeforeCalls(store: MockStore, taskId: string) {
  const task = store.taskById(taskId);
  if (task.state !== "queued") throw new ScarletApiError(409, "already_started", "Scarlet has already started on this request.");
  if (!task.startsBeforeCalls) store.updateTask(task, { startsBeforeCalls: true });
  return { task };
}

export function holdForRewording(store: MockStore, taskId: string, on: boolean) {
  if (!on) {
    const task = store.taskById(taskId);
    if (task.rewordingUntil) store.updateTask(task, { rewordingUntil: undefined });
    return { task };
  }
  const task = waitingToReword(store, taskId);
  store.updateTask(task, { rewordingUntil: new Date(Date.now() + 90_000).toISOString() });
  return { task };
}

export function rewordTask(store: MockStore, taskId: string, text: string, skillIds?: string[]) {
  const task = waitingToReword(store, taskId);
  const said = task.context.message ?? task.instruction;
  const words = text.trim();
  const skills = skillIds?.length ? [...new Set(skillIds)] : undefined;
  const dialogueOperation = dialogueCommand(words, store.db.skills) ?? "none";
  // Reworded, a request the app had worded for the editor, such as an undo, is their own words and nothing else.
  if (task.context.message !== undefined) store.updateTask(task, { instruction: task.context.asked ? words : task.instruction.replace(said, words),
    context: { ...task.context, dialogueOperation, dialogueRange: undefined, message: words, skillIds: skills, asked: undefined }, rewordingUntil: undefined });
  else store.updateTask(task, { instruction: words, context: { ...task.context, dialogueOperation, dialogueRange: undefined, skillIds: skills }, rewordingUntil: undefined });
  for (const note of store.db.notes.filter(n => (task.kind === "revise" || task.kind === "note") && task.context.noteIds?.includes(n.id) && n.text === said)) {
    Object.assign(note, { text: words, voiceTranscript: undefined, updatedAt: now() });
    store.emit({ type: "note.updated", projectId: note.projectId, note: { ...note } });
  }
  store.log(task.projectId, "request.reworded", `${store.currentUser().name} changed a waiting request to: “${words}”`);
  return { task };
}

export function answerTask(store: MockStore, taskId: string, text: string, skillIds?: string[], runWith?: RunChoice, files?: AnswerFiles) {
  const task = store.taskById(taskId);
  if (task.state !== "waiting_for_user") throw new ScarletApiError(409, "not_waiting", "This request isn’t waiting for an answer.");
  if (skillIds?.length) task.context.skillIds = [...new Set([...(task.context.skillIds ?? []), ...skillIds])];
  // Files sent with the answer are kept with the request, as its own are.
  if (files?.attachments.length) {
    const kept = task.context.attachments ?? [];
    task.context = { ...task.context, attachments: [...kept, ...files.attachments.filter(a => !kept.some(k => k.id === a.id))],
      ...(files.pictureMarks && !task.context.pictureMarks && { pictureMarks: files.pictureMarks }) };
  }
  const operation = dialogueCommand(text, store.db.skills);
  if (operation && operation !== task.context.dialogueOperation) {
    task.context = { ...task.context, dialogueOperation: operation, dialogueRange: undefined };
    task.repeatAudit = undefined;
  }
  store.pushEvent(task, "answer", text);
  // An answer given while editing is stopped waits in line for Continue.
  store.updateTask(task, {
    state: "queued",
    question: null,
    ...(runWith?.agent && { agent: runWith.agent, model: runWith.model, effort: runWith.effort, fast: runWith.fast, serviceTier: runWith.serviceTier }),
  });
  void (async () => {
    while (task.state === "queued" && store.projectById(task.projectId).editingPaused) await sleep(300);
    if (task.state !== "queued") return;
    store.updateTask(task, { state: "running" });
    await sleep(1500);
    if ((task.state as Task["state"]) !== "running") return;
    store.pushEvent(task, "log", `Applying your answer: “${text}”`);
    await sleep(1500);
    if ((task.state as Task["state"]) !== "running") return;
    const attempts = store.db.tasks.filter(attempt => sameRun(task, attempt));
    const change = store.db.changes.find(c => attempts.some(attempt => attempt.changeIds.includes(c.id)));
    if (change && change.state === "rendering") {
      const pending = store.db.renders.filter((r) => r.changeId === change.id && r.state !== "done");
      for (const r of pending) {
        markRenderDone(r);
        store.emitRender(r);
      }
      change.state = "ready";
      change.updatedAt = now();
      store.emitChange(change);
    }
    store.updateTask(task, { state: "done", summary: "Lower-third updated per your answer.", finishedAt: now() });
  })();
  return { task };
}
