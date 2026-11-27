import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type Change } from "@scarlet/timeline";
import { ATTEMPT_HEADER, DEFAULT_TASK_MODELS, TASK_HEADER, type AgentAvailability, type AgentHost, type Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import type { Ctx } from "../context.js";
import { handOff, handOffTypes } from "./taskModels.js";
import { startDecisionCheck } from "./learnings.js";
import { followUpInstruction, taskPrompt } from "./taskPrompts.js";
import { appendTaskEvent, cancelTask, completeTask, createTask } from "./tasks.js";
import { claimTask } from "./taskQueue.js";
import { holdProjectEditing, recoverTasks } from "./taskRecovery.js";

let dataDir: string;
let workspace: ScarletApp;
let ctx: Ctx;
const by = { type: "human", name: "Editor" } as const;
const graphics = (model: string) => DEFAULT_TASK_MODELS.map(t => t.id === "motion-graphics" ? { ...t, model } : t);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-task-models-"));
  workspace = createApp({ dataDir, skillsSeedDir: join(dataDir, "empty-seed"), env: {}, log: () => {} });
  ({ ctx } = workspace);
});
afterEach(async () => {
  await ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

function hostWith(agents: AgentAvailability[], seenAgo = 0): AgentHost {
  return ctx.repos.hosts.put({ id: "host", name: "Mac", userId: "user", platform: "darwin", online: true, agents,
    lastSeenAt: new Date(Date.now() - seenAgo).toISOString() });
}
function request(agent: "claude" | "gemini" = "claude", model?: string): Task {
  const project = ctx.repos.projects.insert(createProject("Interview"));
  // Made as the message box sends a new request: the editor's words as its instruction, with no separate message.
  return createTask(ctx, { projectId: project.id, kind: "edit", agent, model, instruction: "Tighten it and add a lower third for Ana at 0:05",
    context: { time: 5 }, createdBy: by });
}
function api(method: string, path: string, body: unknown, headers: Record<string, string>) {
  return workspace.app.request("/api" + path, { method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json", ...headers } });
}

it("starts every editor with Cutting and Motion graphics left with the chat's model, so nothing is handed off", () => {
  expect(ctx.settings().taskModels).toEqual(DEFAULT_TASK_MODELS);
  hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-3-pro"] }]);
  expect(handOffTypes(ctx, request())).toEqual([]);
  // The request's prompt says nothing of other models, and its run has no hand_off.
  expect(taskPrompt(ctx, request()).systemPrompt).not.toContain("Work the editor gives to other models");
});

it("hands off only kinds of work given to another model that is signed in now", () => {
  ctx.repos.settings.update({ taskModels: graphics("gemini:gemini-3-pro") });
  const claude = request("claude");
  expect(handOffTypes(ctx, claude)).toEqual([]);
  hostWith([{ id: "gemini", installed: true, models: ["gemini-3-pro"] }], 10 * 60_000);
  expect(handOffTypes(ctx, claude)).toEqual([]);
  hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-3-pro"] }]);
  expect(handOffTypes(ctx, claude).map(t => [t.name, t.by])).toEqual([["Motion graphics", { agent: "gemini", model: "gemini-3-pro" }]]);
  // A request already on that model does the work itself.
  expect(handOffTypes(ctx, request("gemini", "gemini-3-pro"))).toEqual([]);
  const prompt = taskPrompt(ctx, claude).systemPrompt;
  expect(prompt).toContain("# Work the editor gives to other models");
  expect(prompt).toContain("- Motion graphics, to gemini-3-pro: Titles, lower thirds");
});

it("runs the hand-off beside the request with the editor's model, and its edits join the request with who made them", async () => {
  ctx.repos.settings.update({ taskModels: graphics("gemini:gemini-3-pro") });
  const host = hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-3-pro"], modelLabels: { "gemini-3-pro": "Gemini 3 Pro" } }]);
  const claude = request("claude");
  expect(claimTask(ctx, host, claude.id)?.state).toBe("claimed");
  const brief = "Add a lower third reading “Ana Ruiz, Producer” from 5 s to 9 s.";
  expect(await handOff(ctx, claude.id, { type: "motion graphics", brief }, 0)).toMatchObject({ state: "working", by: { agent: "gemini", model: "gemini-3-pro", label: "Gemini 3 Pro" } });
  const [run] = ctx.repos.tasks.select("kind = 'hand_off'");
  expect(run).toMatchObject({ agent: "gemini", model: "gemini-3-pro", instruction: brief,
    context: { checksTaskId: claude.id, threadId: claude.context.threadId, time: 5, handOff: { typeId: "motion-graphics", name: "Motion graphics", brief } } });
  // Asked again with the same kind and brief, the request waits on the run already at work.
  await handOff(ctx, claude.id, { type: "Motion graphics", brief }, 0);
  expect(ctx.repos.tasks.select("kind = 'hand_off'")).toHaveLength(1);
  // Its prompt is a request's, told it does one part for another model, with the editor's words.
  const prompt = taskPrompt(ctx, run!, { workDir: "/tmp/run" });
  expect(prompt.workspace).toBe(true);
  expect(prompt.systemPrompt).toContain("# You are doing one part of a request");
  expect(prompt.systemPrompt).toContain("What the editor asked: \"Tighten it and add a lower third for Ana at 0:05\"");
  // It starts in a check slot while the request holds its own, and stays out of the project's conversation.
  const claimed = claimTask(ctx, host, undefined, [], undefined, ["gemini"]);
  expect(claimed?.id).toBe(run!.id);
  expect(((await (await workspace.app.request(`/api/projects/${claude.projectId}/tasks`, { headers: { Authorization: `Bearer ${accessToken(ctx)}` } })).json()) as { tasks: Task[] })
    .tasks.map(t => t.id)).toEqual([claude.id]);
  // What it saves is the request's, and says which model made it as the editor's kind of work.
  const saved = await api("POST", `/projects/${claude.projectId}/changes`, { intent: "requested", description: "Lower third for Ana",
    ops: [{ op: "addMarker", marker: { id: "m", time: 5, text: "Ana" } }] }, { [TASK_HEADER]: run!.id, [ATTEMPT_HEADER]: claimed!.startedAt! });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const { change } = await saved.json() as { change: Change };
  expect(change).toMatchObject({ taskId: claude.id, threadId: claude.context.threadId,
    handedOff: { taskId: run!.id, name: "Motion graphics", agent: "gemini", model: "gemini-3-pro" } });
  expect(ctx.repos.tasks.get(claude.id)?.changeIds).toEqual([change.id]);
  completeTask(ctx, ctx.repos.tasks.get(run!.id)!, { state: "done", summary: `Saved ${change.id}: the lower third from 5 s to 9 s.` });
  expect(await handOff(ctx, claude.id, { handoffId: run!.id }, 0)).toEqual({ state: "done", handoffId: run!.id, summary: `Saved ${change.id}: the lower third from 5 s to 9 s.`,
    changeIds: [change.id], by: { agent: "gemini", model: "gemini-3-pro", label: "Gemini 3 Pro" } });
});

it("says plainly when the work is the request's own or its model isn't signed in, and stops a hand-off with its request", async () => {
  const host = hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-3-pro"] }]);
  const claude = request("claude");
  expect(claimTask(ctx, host, claude.id)?.state).toBe("claimed");
  expect(await handOff(ctx, claude.id, { type: "Cutting", brief: "Cut the pauses" }, 0)).toMatchObject({ state: "unavailable" });
  await expect(handOff(ctx, claude.id, { type: "Color", brief: "Grade it" }, 0)).rejects.toThrow(/They have: Cutting, Motion graphics/);
  ctx.repos.settings.update({ taskModels: graphics("codex:gpt-6.2-sol") });
  expect(await handOff(ctx, claude.id, { type: "Motion graphics", brief: "Add a title" }, 0)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("isn't signed in") });
  ctx.repos.settings.update({ taskModels: graphics("gemini:gemini-3-pro") });
  await handOff(ctx, claude.id, { type: "Motion graphics", brief: "Add a title" }, 0);
  const [run] = ctx.repos.tasks.select("kind = 'hand_off'");
  cancelTask(ctx, ctx.repos.tasks.get(claude.id)!);
  expect(ctx.repos.tasks.get(run!.id)?.state).toBe("cancelled");
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])).toBeNull();
});

/** A hand-off at work, as its host claimed it, with one look at a frame its save asked for still waiting to start. */
async function handOffWithLook() {
  ctx.repos.settings.update({ taskModels: graphics("gemini:gemini-3-pro") });
  const host = hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-3-pro"] }]);
  const asked = request("claude");
  const claude = ctx.repos.tasks.put({ ...asked, context: { ...asked.context, message: asked.instruction } });
  claimTask(ctx, host, claude.id);
  await handOff(ctx, claude.id, { type: "Motion graphics", brief: "Add a title" }, 0);
  const run = claimTask(ctx, host, undefined, [], undefined, ["gemini"])!;
  expect(run.kind).toBe("hand_off");
  const look = createTask(ctx, { projectId: run.projectId, kind: "area_check", agent: run.agent, model: run.model, instruction: "What viewers may see of screen.mov at 12 s",
    context: { checksTaskId: run.id, areaCheck: { mediaId: "med_screen", at: 12 } }, createdBy: run.createdBy });
  return { host, claude, run, look };
}

it("leaves no look at a frame waiting once the hand-off that asked for it finishes or is stopped", async () => {
  const done = await handOffWithLook();
  completeTask(ctx, ctx.repos.tasks.get(done.run.id)!, { state: "done", summary: "Added the title." });
  expect(ctx.repos.tasks.get(done.look.id)?.state).toBe("cancelled");
  const stopped = await handOffWithLook();
  cancelTask(ctx, ctx.repos.tasks.get(stopped.run.id)!);
  expect(ctx.repos.tasks.get(stopped.look.id)?.state).toBe("cancelled");
});

it("puts away, as the engine starts, a look or a listen left waiting for a run that is over, and leaves the rest", async () => {
  const { claude, run, look } = await handOffWithLook();
  // Left by an engine that didn't stop a hand-off's looks with it: the hand-off is done and its look still waits.
  ctx.repos.tasks.put({ ...ctx.repos.tasks.get(run.id)!, state: "done", finishedAt: new Date().toISOString() });
  const gone = createTask(ctx, { projectId: run.projectId, kind: "listen_check", agent: "gemini", instruction: "Listen", context: { checksTaskId: "task_gone" }, createdBy: by });
  // The request is still at work, so its own look waits its turn, and a learning check reads the editor's words whether or not their request is over.
  const live = createTask(ctx, { projectId: run.projectId, kind: "area_check", agent: "claude", instruction: "Look", context: { checksTaskId: claude.id, areaCheck: { mediaId: "med_screen", at: 400 } }, createdBy: by });
  const reading = createTask(ctx, { projectId: run.projectId, kind: "learning_check", agent: "claude", instruction: "Read", context: { checksTaskId: run.id }, createdBy: by });
  recoverTasks(ctx, true);
  expect(ctx.repos.tasks.get(look.id)?.state).toBe("cancelled");
  expect(ctx.repos.tasks.get(gone.id)?.state).toBe("cancelled");
  expect(ctx.repos.tasks.get(live.id)?.state).toBe("queued");
  expect(ctx.repos.tasks.get(reading.id)?.state).toBe("queued");
});

it("keeps a hand-off out of what the request's thread is told and out of whose model reads the editor's decisions", async () => {
  ctx.repos.settings.update({ taskModels: graphics("gemini:gemini-3-pro") });
  const host = hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-3-pro"] }]);
  const claude = request("claude", "opus");
  claimTask(ctx, host, claude.id);
  await handOff(ctx, claude.id, { type: "Motion graphics", brief: "Add a lower third for Ana." }, 0);
  const run = claimTask(ctx, host, undefined, [], undefined, ["gemini"])!;
  completeTask(ctx, ctx.repos.tasks.get(run.id)!, { state: "done", summary: "Saved chg_1: the lower third." });
  completeTask(ctx, ctx.repos.tasks.get(claude.id)!, { state: "done", summary: "Tightened it and added Ana's lower third." });
  // The editor's next words in the thread are told what they asked and what Scarlet replied, once.
  const told = followUpInstruction(ctx, claude.projectId, claude.id, "Make the lower third smaller");
  expect(told).toContain("- Asked: Tighten it and add a lower third for Ana at 0:05");
  expect(told).toContain("You replied: Tightened it and added Ana's lower third.");
  expect(told.match(/- Asked:/g)).toHaveLength(1);
  expect(told).not.toContain("Saved chg_1");
  // Their decisions are read for a rule on the chat's model, not the one a kind of work was handed to.
  ctx.repos.skills.put({ id: "skl_look", name: "look", description: "The look", content: "# Look", scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1 });
  for (const check of ctx.repos.tasks.select("kind = 'learning_check' AND state = 'queued'")) cancelTask(ctx, check);
  expect(startDecisionCheck(ctx, claude.projectId, claude.id)).toMatchObject({ kind: "learning_check", agent: "claude", model: "opus", context: { checksTaskId: claude.id } });
});

it("stops a hand-off at work when the editor pauses editing while its request waits on their answer", async () => {
  const { claude, run, look } = await handOffWithLook();
  // The request heard its hand-off was still working, carried on, and asked the editor something.
  appendTaskEvent(ctx, ctx.repos.tasks.get(claude.id)!, { type: "question", text: "Which take of the intro?" } as never);
  expect(ctx.repos.tasks.get(claude.id)?.state).toBe("waiting_for_user");
  holdProjectEditing(ctx, claude.projectId);
  // Nothing edits the video while editing is paused. The request keeps its question, and hears the hand-off was stopped when it next asks.
  expect(ctx.repos.tasks.get(run.id)?.state).toBe("cancelled");
  expect(ctx.repos.tasks.get(look.id)?.state).toBe("cancelled");
  expect(ctx.repos.tasks.get(claude.id)).toMatchObject({ state: "waiting_for_user", question: "Which take of the intro?" });
  expect(await handOff(ctx, claude.id, { handoffId: run.id }, 0)).toMatchObject({ state: "failed", error: "The hand-off was stopped." });
});

it("logs a hand-off's end as the hand-off's, so its request reads as finished once", async () => {
  const { claude, run } = await handOffWithLook();
  // The app sends the editor's words as the request's message, and a hand-off is told them: its end is still its own.
  expect(run.context.message).toBe("Tighten it and add a lower third for Ana at 0:05");
  completeTask(ctx, ctx.repos.tasks.get(run.id)!, { state: "done", summary: "Added the title." });
  completeTask(ctx, ctx.repos.tasks.get(claude.id)!, { state: "done", summary: "Tightened it." });
  const log = ctx.repos.activity.select("project_id = ? AND (type LIKE 'request.%' OR type LIKE 'hand_off.%')", [claude.projectId], "created_at, rowid").map(a => [a.type, a.summary, a.data.taskId]);
  expect(log).toEqual([
    ["hand_off.done", "Gemini finished Motion graphics: “Add a title”", run.id],
    ["request.done", "Claude Code finished “Tighten it and add a lower third for Ana at 0:05”", claude.id],
  ]);
});
