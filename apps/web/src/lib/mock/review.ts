import { beginRevision, restoredReviewState, splitAgentTarget, ScarletApiError, type AgentId, type CreateNoteRequest, type ReviseRequest, type Task } from "@scarlet/shared";
import { newId, type Note } from "@scarlet/timeline";
import { runTask } from "./runs";
import type { MockStore } from "./store";
import { restoreUnreplacedProposal } from "./tasks";
import { now } from "./util";

export function unapproveChange(store: MockStore, changeId: string) {
  const change = store.changeById(changeId);
  const project = store.projectById(change.projectId);
  const applied = change.appliedVersion ?? change.toVersion;
  if (change.state !== "approved") throw new ScarletApiError(409, "invalid_state", "Only approved changes can be undone");
  if (project.head !== applied) throw new ScarletApiError(409, "not_latest", "Other changes were approved after this one. Restore an earlier version from the Changelog instead.");
  project.head = change.appliedOnto ?? change.fromVersion;
  store.summary(project.id).head = project.head;
  const versions = store.db.versions[project.id] ?? [];
  store.db.versions[project.id] = versions.filter((v) => v.version !== applied || v.changeId !== change.id);
  for (const v of store.db.versions[project.id]!) v.isHead = v.version === project.head;
  change.state = "ready";
  change.appliedVersion = undefined;
  change.appliedOnto = undefined;
  change.approvedSpots = undefined;
  change.restoredCuts = undefined;
  change.appliedReview = undefined;
  change.updatedAt = now();
  store.refreshCounts(project.id);
  store.emitChange(change);
  store.emitProject(project.id);
  store.log(project.id, "change.undone", `${store.currentUser().name} undid the approval of “${change.description}”`, { changeId: change.id });
  return { change, project };
}

export function rejectChange(store: MockStore, changeId: string, reason?: string) {
  const change = store.changeById(changeId);
  if (change.state === "approved") throw new ScarletApiError(409, "invalid_state", "Cannot reject an approved change");
  if (change.state === "rejected") return { change };
  change.rejectedFrom = change.state;
  change.state = "rejected";
  change.decidedBy = store.human();
  change.rejectReason = reason;
  change.updatedAt = now();
  store.refreshCounts(change.projectId);
  store.emitChange(change);
  store.log(change.projectId, "change.rejected", `${store.currentUser().name} rejected “${change.description}”${reason ? `: “${reason}”` : ""}`, { changeId: change.id });
  return { change };
}

export function reopenChange(store: MockStore, changeId: string) {
  const change = store.changeById(changeId);
  if (change.state !== "rejected") throw new ScarletApiError(409, "invalid_state", "Only a rejected edit can be reopened.");
  change.state = restoredReviewState(change, change.rejectedFrom, id => store.db.renders.find(r => r.id === id)?.state);
  restoreUnreplacedProposal(store.db, change);
  change.rejectedFrom = undefined;
  change.decidedBy = undefined;
  change.rejectReason = undefined;
  change.updatedAt = now();
  store.refreshCounts(change.projectId);
  store.emitChange(change);
  store.log(change.projectId, "change.reopened", "Reopened for review", { changeId });
  return { change };
}

export function reviseChange(store: MockStore, changeId: string, body: ReviseRequest) {
  const change = store.changeById(changeId);
  if (change.state === "approved") throw new ScarletApiError(409, "invalid_state", "Cannot revise an approved change");
  const { agent, model } = body.assignTo ? splitAgentTarget(body.assignTo)
    : { agent: change.author.type === "agent" ? change.author.id : "claude", model: change.author.model };
  const note: Note = { id: newId("note"), projectId: change.projectId, version: body.position?.version ?? change.toVersion, time: body.position?.time ?? change.ranges[0]?.start ?? 0, end: body.position ? body.position.end : change.ranges[0]?.end, clipIds: body.position?.clipIds ?? [], text: body.text, voiceTranscript: body.voiceTranscript, author: store.human(), assignedTo: body.assignTo ?? agent, changeId, state: "in_progress", createdAt: now(), updatedAt: now() };
  store.db.notes.unshift(note);
  const task = store.makeTask(change.projectId, { kind: "revise", agent: agent as AgentId, model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.text, context: { skillIds: body.skillIds, version: change.fromVersion, ...body.position, changeId, noteIds: [note.id], threadId: change.threadId ?? change.id, message: body.text } });
  Object.assign(change, beginRevision(change, task), { noteIds: [...change.noteIds, note.id], updatedAt: now() });
  void runTask(store, task, { fromVersion: change.fromVersion, description: `Revised: ${body.text}`, noteIds: [note.id], supersedes: change });
  store.refreshCounts(change.projectId);
  store.emitChange(change);
  store.log(change.projectId, "change.revise_requested", `${store.currentUser().name} asked for a new version of “${change.description}”: “${body.text}”`, { changeId: change.id, threadId: change.threadId });
  return { change, note, task };
}

export function createNote(store: MockStore, projectId: string, body: CreateNoteRequest) {
  const project = store.projectById(projectId);
  const note: Note = { id: newId("note"), projectId, version: body.version ?? project.head ?? "draft", time: body.time, end: body.end, clipIds: body.clipIds ?? [], text: body.text, voiceTranscript: body.voiceTranscript, author: store.human(), assignedTo: body.assignTo, changeId: body.changeId, state: body.assignTo ? "in_progress" : "open", createdAt: now(), updatedAt: now() };
  store.db.notes.unshift(note);
  let task: Task | undefined;
  if (body.assignTo) {
    const { agent, model } = splitAgentTarget(body.assignTo);
    task = store.makeTask(projectId, { kind: "note", agent: agent as AgentId, model, effort: body.effort, serviceTier: body.serviceTier, instruction: body.text, context: { skillIds: body.skillIds, version: note.version, noteIds: [note.id], time: body.time, end: body.end, clipIds: body.clipIds } });
    void runTask(store, task, { fromVersion: project.head ?? "", description: body.text, noteIds: [note.id] });
  }
  store.refreshCounts(projectId);
  return { note, task };
}
