import { Hono } from "hono";
import { z } from "zod/v3";
import { AgentId, ApproveLearningRequest, EditSkillRequest, ReviseLearningRequest, SkillSlug, SuggestLearningRequest, TaskSkillDraft, UpsertSkillRequest, skillEditTarget, skillTaskTarget, type Learning, type Skill } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { requestAttempt, requireActiveAttempt } from "../services/taskAttempt.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assistantSkills, createSkill, deleteSkill, latestSkillEdit, reviseSkillContent, skillEdits, updateSkill } from "../services/skills.js";
import { createTask, FINISHED_TASK, saveTask } from "../services/tasks.js";
import { approveLearning, declineLearning, openLearnings, requireApprovedLearningEdit, reviseLearning, suggestLearning } from "../services/learnings.js";
import { actorFor, agentName, logActivity, quote } from "../services/activity.js";
import { jsonBody, requireProjectHeader } from "./util.js";

export function skillRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  function requireSkill(skillId: string): Skill {
    const skill = ctx.repos.skills.get(skillId);
    if (!skill) throw notFound(`skill ${skillId}`);
    return skill;
  }

  r.get("/skills", (c) => {
    const projectId = c.req.query("projectId");
    const skills = ctx.repos.skills.select("1=1", [], "name ASC");
    const view = c.req.query("view");
    if (view === "prompt" || view === "assistant") {
      const taskId = c.req.query("taskId");
      const task = taskId ? ctx.repos.tasks.get(taskId) : null;
      if (taskId && (!task || task.projectId !== projectId)) throw notFound("task in this project");
      return c.json({ skills: assistantSkills(skills, task?.context.skillIds, view === "prompt") });
    }
    return c.json({ skills });
  });

  r.post("/skills", async (c) => {
    const body = await jsonBody(c, UpsertSkillRequest);
    return c.json({ skill: ctx.db.transaction(() => createSkill(ctx, c.var.user, body), "immediate")() }, 201);
  });

  r.get("/skills/:skillId", (c) => {
    const skill = requireSkill(c.req.param("skillId"));
    return c.json({ skill, versions: ctx.repos.skillVersions.list(skill.id), edits: skillEdits(ctx, skill.id) });
  });

  r.put("/skills/:skillId", async (c) => {
    requireSkill(c.req.param("skillId"));
    const body = await jsonBody(c, UpsertSkillRequest.partial());
    // Reread after the body arrives: an overlapping save would otherwise be overwritten and reuse its version number.
    return c.json({ skill: ctx.db.transaction(() => updateSkill(ctx, c.var.user, requireSkill(c.req.param("skillId")), body), "immediate")() });
  });

  r.delete("/skills/:skillId", (c) => {
    // The activity entry and the rows go together, so a failed removal doesn't log a deletion.
    ctx.db.transaction(() => deleteSkill(ctx, requireSkill(c.req.param("skillId")), c.var.user), "immediate")();
    return c.json({});
  });

  // The editor describes a change and an agent rewrites the skill. Agent runs belong to a project, so this one
  // borrows the project worked on last. It reads and changes nothing there, and stays out of its conversation and queue.
  r.post("/skills/:skillId/edit", async (c) => {
    const body = await jsonBody(c, EditSkillRequest);
    const user = c.var.user;
    const task = ctx.db.transaction(() => {
      const skill = requireSkill(c.req.param("skillId"));
      const running = latestSkillEdit(ctx, skill.id);
      if (running && !FINISHED_TASK.has(running.state)) throw conflict("skill_edit_running", "Scarlet is already revising this skill");
      const home = ctx.db.prepare("SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1").get() as { id: string } | undefined;
      if (!home) throw conflict("no_project", "Create a project first. Scarlet runs its requests from one.");
      const task = createTask(ctx, {
        projectId: home.id,
        kind: "skill_edit",
        agent: body.agent ?? ctx.settings().defaultAgent,
        model: body.model,
        effort: body.effort,
        fast: body.fast,
        serviceTier: body.serviceTier,
        instruction: body.prompt,
        context: { skillId: skill.id },
        createdBy: actorFor(user),
      });
      logActivity(ctx, { projectId: null, actor: actorFor(user), type: "skill.edit_requested",
        summary: `${user.name} asked ${agentName(task.agent)} to change the skill ${quote(skill.name)}: ${quote(body.prompt, 120)}`, data: { skillId: skill.id, taskId: task.id } });
      return task;
    }, "immediate")();
    return c.json({ task }, 201);
  });

  r.post("/projects/:id/tasks/:taskId/skill-edit", async (c) => {
    const body = await jsonBody(c, TaskSkillDraft.extend({ skillId: z.string(), hostId: z.string() }).strict());
    const projectId = c.req.param("id");
    const skill = ctx.db.transaction(() => {
      const task = ctx.repos.tasks.get(c.req.param("taskId"));
      if (!task || task.projectId !== projectId) throw notFound("skill task");
      const target = skillEditTarget(task, projectId);
      if (!target || task.createdBy.id !== c.var.user.id || target.skillId !== body.skillId || target.hostId !== body.hostId) {
        throw forbidden("This task is not authorized to change this skill");
      }
      requireActiveAttempt(ctx, requestAttempt(c.req.raw), projectId, task.id);
      const skill = requireSkill(target.skillId);
      // The model supplies prose. Scarlet owns the name, the rest of the header and the version history.
      const content = reviseSkillContent(skill, body);
      // A lost response may be sent again.
      if (task.resultSkillId && skill.content === content) return skill;
      if (task.context.learningId) {
        if (task.resultSkillId) throw conflict("learning_already_saved", "This task has already saved the approved rule.");
        const learning = requireLearning(projectId, task.context.learningId);
        if (learning.state !== "saving" || learning.skillId !== skill.id) throw conflict("learning_settled", "This rule is no longer approved for this skill.");
        requireApprovedLearningEdit(skill, body, learning);
      }
      const saved = updateSkill(ctx, c.var.user, skill, { description: body.description, content },
        { author: { type: "agent", id: task.agent, name: task.agent, model: task.model } });
      saveTask(ctx, { ...task, resultSkillId: saved.id });
      return saved;
    }, "immediate")();
    return c.json({ skill });
  });

  // Learnings: rules an agent picked up from the editor's requests. Nothing changes until the editor approves one.
  function requireLearning(projectId: string, learningId: string): Learning {
    requireProjectHeader(ctx, projectId);
    const learning = ctx.repos.learnings.get(learningId);
    if (!learning || learning.projectId !== projectId) throw notFound(`learning ${learningId}`);
    return learning;
  }

  r.get("/projects/:id/learnings", (c) => {
    const projectId = c.req.param("id");
    requireProjectHeader(ctx, projectId);
    return c.json({ learnings: openLearnings(ctx, projectId) });
  });

  r.post("/projects/:id/tasks/:taskId/learnings", async (c) => {
    const body = await jsonBody(c, SuggestLearningRequest);
    const projectId = c.req.param("id");
    requireProjectHeader(ctx, projectId);
    const result = ctx.db.transaction(() => {
      const task = ctx.repos.tasks.get(c.req.param("taskId"));
      if (!task || task.projectId !== projectId) throw notFound("task in this project");
      requireActiveAttempt(ctx, requestAttempt(c.req.raw), projectId, task.id);
      const { learning, skill } = suggestLearning(ctx, task, body);
      return { learning, skill: { id: skill.id, name: skill.name } };
    }, "immediate")();
    return c.json(result, 201);
  });

  r.patch("/projects/:id/learnings/:learningId", async (c) => {
    const body = await jsonBody(c, ReviseLearningRequest);
    const learning = ctx.db.transaction(() =>
      reviseLearning(ctx, requireLearning(c.req.param("id"), c.req.param("learningId")), c.var.user, body), "immediate")();
    return c.json({ learning });
  });

  r.post("/projects/:id/learnings/:learningId/approve", async (c) => {
    const body = await jsonBody(c, ApproveLearningRequest);
    const learning = ctx.db.transaction(() =>
      approveLearning(ctx, requireLearning(c.req.param("id"), c.req.param("learningId")), c.var.user, body), "immediate")();
    return c.json({ learning });
  });

  r.post("/projects/:id/learnings/:learningId/decline", (c) => {
    const learning = ctx.db.transaction(() =>
      declineLearning(ctx, requireLearning(c.req.param("id"), c.req.param("learningId")), c.var.user), "immediate")();
    return c.json({ learning });
  });

  r.post("/skills/from-change", async (c) => {
    const body = await jsonBody(c, z.object({ changeId: z.string(), name: SkillSlug, agent: AgentId.optional() }));
    const change = ctx.repos.changes.get(body.changeId);
    if (!change) throw notFound(`change ${body.changeId}`);
    requireProjectHeader(ctx, change.projectId);
    if (change.state !== "approved") throw conflict("change_not_approved", "Choose an approved change to learn from");
    if (ctx.repos.skills.select("name = ?", [body.name]).length) throw conflict("skill_exists", "A skill with that name already exists");
    const user = c.var.user;
    const approvedVersion = change.appliedVersion ?? change.toVersion;
    const task = createTask(ctx, {
      projectId: change.projectId,
      kind: "skill_from_change",
      agent: body.agent ?? ctx.settings().defaultAgent,
      instruction: `Write a SKILL.md named "${body.name}" that captures how change ${change.id} was made, so it can be repeated on other projects. Read change_get and timeline_get for the approved version ${approvedVersion}. When only some spots were approved, use only those edits. Call skill_save_from_change with a short description and reusable Markdown instructions to save the requested skill.`,
      context: { changeId: change.id, version: approvedVersion, skillName: body.name },
      createdBy: actorFor(user),
    });
    return c.json({ task }, 201);
  });

  r.post("/projects/:id/tasks/:taskId/skill", async (c) => {
    const body = await jsonBody(c, TaskSkillDraft.extend({ changeId: z.string(), hostId: z.string() }).strict());
    const projectId = c.req.param("id");
    const skill = ctx.db.transaction(() => {
      requireProjectHeader(ctx, projectId);
      const task = ctx.repos.tasks.get(c.req.param("taskId"));
      if (!task || task.projectId !== projectId) throw notFound("skill task");
      const target = skillTaskTarget(task, projectId);
      if (!target || task.createdBy.id !== c.var.user.id || target.changeId !== body.changeId || target.hostId !== body.hostId) {
        throw forbidden("This task is not authorized to save this skill");
      }
      requireActiveAttempt(ctx, requestAttempt(c.req.raw), projectId, task.id);
      const change = ctx.repos.changes.get(target.changeId);
      if (change?.projectId !== projectId || change.state !== "approved" || (change.appliedVersion ?? change.toVersion) !== task.context.version) {
        throw conflict("change_not_approved", "The original change is no longer approved at the requested version");
      }
      // The model supplies prose. Scarlet owns the frontmatter, destination and provenance.
      const content = `---\nname: ${target.name}\ndescription: ${JSON.stringify(body.description)}\n---\n\n${body.instructions}\n`;
      if (task.resultSkillId) {
        const existing = ctx.repos.skills.get(task.resultSkillId);
        if (existing?.content === content && existing.name === target.name && existing.scope === "team") return existing;
        throw conflict("skill_already_saved", "This task has already saved its skill");
      }
      const result = createSkill(ctx, c.var.user, { name: target.name, description: body.description, content, scope: "team" }, { source: `change:${change.id}` });
      saveTask(ctx, { ...task, resultSkillId: result.id });
      return result;
    }, "immediate")();
    return c.json({ skill }, 201);
  });

  return r;
}
