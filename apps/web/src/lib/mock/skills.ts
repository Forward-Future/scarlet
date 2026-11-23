import { AGENT_LABEL, ScarletApiError, SkillSlug, isSkillEdit, ReviseLearningRequest, type ApproveLearningRequest, type EditSkillRequest, type Learning, type AgentId, type Skill, type UpsertSkillRequest } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import { skillFromChangeContent, withEditorRequest, withLearning } from "./skillText";
import type { MockStore } from "./store";
import { agentAuthor } from "./tasks";
import { isFinished, notFound, now, sleep } from "./util";

export function createSkill(store: MockStore, body: UpsertSkillRequest) {
  if (store.db.skills.some(s => s.name === body.name)) throw new ScarletApiError(409, "skill_exists", "A skill with that name already exists");
  const skill: Skill = { id: newId("skl"), name: body.name, description: body.description ?? "", content: body.content, scope: "team", ownerId: null, projectId: null, agents: [], enabled: body.enabled ?? true, version: 1, createdAt: now(), updatedAt: now() };
  store.db.skills.push(skill);
  store.db.skillVersions[skill.id] = [{ version: 1, content: skill.content, author: store.human(), createdAt: now() }];
  store.emit({ type: "skill.updated", skill });
  return { skill };
}

/** The demo has no model: it adds the request to the end of the instructions, as a new version by the agent. */
export function editSkill(store: MockStore, skillId: string, body: EditSkillRequest) {
  store.skillById(skillId);
  if (store.db.tasks.some(t => isSkillEdit(t) && t.context.skillId === skillId && !isFinished(t.state))) {
    throw new ScarletApiError(409, "skill_edit_running", "Scarlet is already revising this skill");
  }
  const home = store.db.projects[0];
  if (!home) throw new ScarletApiError(409, "no_project", "Create a project first. Scarlet runs its requests from one.");
  const task = store.makeTask(home.id, { kind: "skill_edit", agent: body.agent ?? store.db.settings.defaultAgent, model: body.model, effort: body.effort,
    serviceTier: body.serviceTier, instruction: body.prompt, context: { skillId } });
  const isCancelled = () => task.state === "cancelled";
  void (async () => {
    await sleep(600);
    if (isCancelled()) return;
    if (store.failWithoutHost(task)) return;
    store.updateTask(task, { state: "running", startedAt: now() });
    await sleep(2400);
    if (isCancelled()) return;
    const current = store.db.skills.find((s) => s.id === skillId);
    if (!current) {
      store.failTask(task, "The skill was deleted.");
      return;
    }
    current.content = withEditorRequest(current.content, body.prompt);
    current.version += 1;
    current.updatedAt = now();
    (store.db.skillVersions[skillId] ??= []).push({ version: current.version, content: current.content,
      author: agentAuthor(task), createdAt: current.updatedAt, note: body.prompt.trim(), from: "request" });
    store.emit({ type: "skill.updated", skill: { ...current } });
    store.updateTask(task, { state: "done", resultSkillId: skillId, summary: "Added it as a section at the end of the instructions.", finishedAt: now() });
  })();
  return { task: { ...task } };
}

export function updateSkill(store: MockStore, skillId: string, body: Partial<UpsertSkillRequest>) {
  const skill = store.skillById(skillId);
  if (store.db.skills.some(s => s.name === body.name && s.id !== skillId)) throw new ScarletApiError(409, "skill_exists", "A skill with that name already exists");
  const contentChanged = body.content !== undefined && body.content !== skill.content;
  Object.assign(skill, body, { scope: "team", projectId: null, ownerId: null, agents: [], updatedAt: now() });
  if (contentChanged) {
    skill.version += 1;
    // The engine names a save by the parts it changed; the demo says only that the editor changed it.
    (store.db.skillVersions[skillId] ??= []).push({ version: skill.version, content: skill.content, author: store.human(), createdAt: now(), note: "Changed the skill" });
  }
  store.emit({ type: "skill.updated", skill: { ...skill } });
  return { skill };
}

export function skillFromChange(store: MockStore, changeId: string, name: string, agent?: string) {
  const change = store.changeById(changeId);
  store.projectById(change.projectId);
  if (!SkillSlug.safeParse(name).success) throw new ScarletApiError(400, "invalid_skill_name", "Invalid skill name");
  if (change.state !== "approved") throw new ScarletApiError(409, "change_not_approved", "Only approved changes can be saved as skills");
  const teamSkillExists = () => store.db.skills.some((s) => s.scope === "team" && s.name === name);
  if (teamSkillExists()) throw new ScarletApiError(409, "skill_exists", `A team skill named "${name}" already exists`);
  const version = change.appliedVersion ?? change.toVersion;
  const task = store.makeTask(change.projectId, {
    kind: "skill_from_change",
    agent: (agent as AgentId | undefined) ?? store.db.settings.defaultAgent,
    instruction: `Write a SKILL.md named "${name}" capturing change ${changeId}: ${change.description}`,
    context: { changeId, version, skillName: name },
  });
  const isCancelled = () => task.state === "cancelled";
  void (async () => {
    await sleep(800);
    if (isCancelled()) return;
    if (store.failWithoutHost(task)) return;
    store.updateTask(task, { state: "running", startedAt: now() });
    store.pushEvent(task, "tool", `change.get ${changeId}`);
    await sleep(1600);
    if (isCancelled()) return;
    store.pushEvent(task, "log", "Drafting SKILL.md from the approved change");
    await sleep(1800);
    if (isCancelled()) return;
    if (!store.db.projects.some((p) => p.id === task.projectId) || change.state !== "approved" || (change.appliedVersion ?? change.toVersion) !== version) {
      store.failTask(task, "The source change is no longer approved at the requested version.");
      return;
    }
    if (teamSkillExists()) {
      store.failTask(task, `A team skill named "${name}" already exists.`);
      return;
    }
    const content = skillFromChangeContent(name, changeId, change);
    const skill: Skill = { id: newId("skl"), name, description: change.description, content, scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1, createdAt: now(), updatedAt: now(), source: `change:${changeId}` };
    store.db.skills.push(skill);
    store.db.skillVersions[skill.id] = [{ version: 1, content, author: agentAuthor(task), createdAt: now() }];
    store.emit({ type: "skill.updated", skill });
    store.updateTask(task, { state: "done", resultSkillId: skill.id, summary: `Saved skill “${name}” (team scope).`, finishedAt: now() });
  })();
  return { task };
}

function pendingLearning(store: MockStore, projectId: string, learningId: string): Learning {
  const learning = store.db.learnings.find(l => l.id === learningId && l.projectId === projectId);
  if (!learning) throw notFound("Learning");
  if (learning.state !== "suggested") throw new ScarletApiError(409, "learning_settled", `this learning is already ${learning.state}`);
  return learning;
}

/**
 * The demo has no model: the rule takes the place of the first passage it replaces, and the others go, or it goes in
 * at the end of the skill's instructions when it replaces nothing. The skill gets a new version by the agent.
 */
export function approveLearning(store: MockStore, projectId: string, learningId: string, body: ApproveLearningRequest = {}) {
  const learning = pendingLearning(store, projectId, learningId);
  const skill = store.skillById(body.skillId ?? learning.skillId);
  const replaces = skill.id === learning.skillId ? learning.replaces : undefined;
  Object.assign(learning, { skillId: skill.id, replaces, state: "saving", error: undefined });
  store.emitLearning(projectId, learning);
  void (async () => {
    await sleep(1800);
    skill.content = withLearning(skill.content, learning.rule, replaces);
    skill.version += 1;
    skill.updatedAt = now();
    (store.db.skillVersions[skill.id] ??= []).push({ version: skill.version, content: skill.content,
      author: { type: "agent", id: "claude", name: AGENT_LABEL.claude }, createdAt: skill.updatedAt, note: learning.rule, from: "learning" });
    store.emit({ type: "skill.updated", skill: { ...skill } });
    learning.state = "saved";
    store.emitLearning(projectId, learning);
  })();
  return { learning: { ...learning } };
}

export function reviseLearning(store: MockStore, projectId: string, learningId: string, body: ReviseLearningRequest) {
  const learning = pendingLearning(store, projectId, learningId);
  const revised = ReviseLearningRequest.safeParse(body);
  if (!revised.success) throw new ScarletApiError(400, "invalid_request", "A rule is one line of up to 280 characters.");
  Object.assign(learning, { rule: revised.data.rule, error: undefined });
  store.emitLearning(projectId, learning);
  return { learning: { ...learning } };
}

export function declineLearning(store: MockStore, projectId: string, learningId: string) {
  const learning = pendingLearning(store, projectId, learningId);
  learning.state = "declined";
  store.emitLearning(projectId, learning);
  return { learning: { ...learning } };
}
