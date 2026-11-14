import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER, taskPlan, type Task, type TaskEvent, type TaskPrompt, type WsEvent } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { PLAN_STEPS } from "@scarlet/mcp/prompt";
import { createTask, pairQuestionsAndAnswers } from "./tasks.js";
import { learningCheckContext } from "./learnings.js";

let dataDir: string;
let app: ScarletApp;
let project: Project;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-tasks-"));
  app = createApp({ dataDir, env: {}, log: () => {} });
  project = app.ctx.repos.projects.insert(createProject("Prompt fixture"));
});
afterEach(async () => {
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers = new Headers({ Authorization: `Bearer ${accessToken(app.ctx)}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const res = await app.app.request("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as T };
}

async function claimed(agent = "claude", instruction = "Tighten the intro", context?: Record<string, unknown>): Promise<Task> {
  // Each run gets its own project: a project runs one request at a time, and these runs overlap.
  const { body: { project: own } } = await api<{ project: { id: string } }>("POST", "/projects", { name: "Prompt fixture" });
  const { body } = await api<{ task: Task }>("POST", `/projects/${own.id}/tasks`, { kind: "edit", agent, instruction, ...(context && { context }) });
  const { body: { host } } = await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test", agents: [{ id: agent, installed: true }] });
  const { body: { task } } = await api<{ task: Task }>("POST", `/hosts/${host.id}/claim`, { taskId: body.task.id });
  return task;
}

it("builds the one prompt every host uses, with answers in the system prompt for a fresh run", async () => {
  const task = await claimed();
  const workDir = "/work/tasks-v2/abc/artifacts";
  const first = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt?workDir=${encodeURIComponent(workDir)}`)).body;
  expect(first.instruction).toBe("Tighten the intro");
  expect(first.resumeSession).toBeUndefined();
  expect(first.systemPrompt).toContain("# You are editing a video in Scarlet");
  // Claude runs without file tools, so the prompt leaves out the artifact directory; Codex can write there.
  expect(first.systemPrompt).not.toContain("Your task artifact directory");
  const codex = await claimed("codex");
  expect((await api<TaskPrompt>("GET", `/tasks/${codex.id}/prompt?workDir=${encodeURIComponent(workDir)}`)).body.systemPrompt)
    .toContain(`Your task artifact directory is: ${workDir}`);
  expect(first.systemPrompt).toContain('Project "Prompt fixture"');
  // Stock workflows are read on demand.
  expect(first.systemPrompt).toMatch(/## dialogue-pass\n\n[^\n]*\n\nRead this workflow when it applies using skills_list/);

  // The MCP server posts the question without a session. Answers without one replay in the system prompt only.
  expect((await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Keep the cold open?" })).body).toEqual({ waiting: true });
  await api("POST", `/tasks/${task.id}/answer`, { text: "Yes, keep it" });
  const fresh = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  expect(fresh.resumeSession).toBeUndefined();
  expect(fresh.instruction).toBe("Tighten the intro");
  expect(fresh.systemPrompt).toContain("# Earlier questions and answers");
  expect(fresh.systemPrompt).toContain('The editor answered: "Yes, keep it"');
  expect((await api("GET", `/tasks/${task.id}/prompt?workDir=a%0Ab`)).status).toBe(400);
});

it("names the agent in a project's history as the interface does, never by its id or its model's", async () => {
  const { body: { project: own } } = await api<{ project: { id: string } }>("POST", "/projects", { name: "History fixture" });
  const { body: { host } } = await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test", agents: [{ id: "claude", installed: true }] });
  const ask = async (instruction: string) => {
    const { body } = await api<{ task: Task }>("POST", `/projects/${own.id}/tasks`, { kind: "edit", agent: "claude", model: "opus", instruction });
    await api("POST", `/hosts/${host.id}/claim`, { taskId: body.task.id });
    return body.task;
  };
  const first = await ask("Tighten the intro");
  await api("POST", `/tasks/${first.id}/complete`, { state: "done" });
  const second = await ask("Add captions");
  await api("POST", `/tasks/${second.id}/complete`, { state: "failed", error: "stalled" });
  const third = await ask("Reframe the demo");
  await api("POST", `/tasks/${third.id}/complete`, { state: "cancelled" });
  const { body: { activity } } = await api<{ activity: { summary: string }[] }>("GET", `/projects/${own.id}/activity`);
  const me = app.ctx.repos.users.primary()!.name;
  // Entries written in the same millisecond come back in either order.
  expect(activity.map(a => a.summary).sort()).toEqual([
    `${me} asked Claude Code: “Tighten the intro”`, "Claude Code finished “Tighten the intro”",
    `${me} asked Claude Code: “Add captions”`, "Claude Code couldn’t finish “Add captions”: stalled",
    `${me} asked Claude Code: “Reframe the demo”`, "Claude Code stopped working on “Reframe the demo”",
  ].sort());
});

it("keeps a typed shortcut out of the CLI's own slash commands, and the editor's words as typed", async () => {
  const task = await claimed("claude", " /first-cut-dialogue ");
  const prompt = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  // Claude Code would read a first message of "/first-cut-dialogue" as a command it doesn't have, and tell the model so.
  expect(prompt.instruction).toBe("The editor's request: /first-cut-dialogue");
  expect(prompt.systemPrompt).toContain("## Instruction\n/first-cut-dialogue");
});

it("resumes the Claude session that asked, with just the answer", async () => {
  const task = await claimed("claude");
  await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Which take?" });
  // The host's confirmation names the CLI thread.
  expect((await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Which take?", sessionId: "thread-1" })).body).toEqual({ waiting: true });
  expect(app.ctx.repos.tasks.get(task.id)?.session).toEqual({ agent: "claude", id: "thread-1" });
  // While waiting, there is nothing to resume yet.
  expect((await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body.resumeSession).toBeUndefined();

  await api("POST", `/tasks/${task.id}/answer`, { text: "The second take" });
  const resumed = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  expect(resumed).toMatchObject({ resumeSession: "thread-1", instruction: 'The editor answered: "The second take"\nContinue the task with that answer.' });
  expect(resumed.systemPrompt).not.toContain("# Earlier questions and answers");
  const fallback = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt?fresh=1`)).body;
  expect(fallback.resumeSession).toBeUndefined();
  expect(fallback.systemPrompt).toContain("The second take");

  // The host's confirmation can arrive after the editor already answered.
  const quick = await claimed("claude");
  await api("POST", `/tasks/${quick.id}/question`, { startedAt: quick.startedAt, text: "Which take?" });
  await api("POST", `/tasks/${quick.id}/answer`, { text: "First" });
  expect((await api("POST", `/tasks/${quick.id}/question`, { startedAt: quick.startedAt, text: "Which take?", sessionId: "thread-2" })).body).toEqual({ waiting: false });
  expect((await api<TaskPrompt>("GET", `/tasks/${quick.id}/prompt`)).body.resumeSession).toBe("thread-2");

  // A later question from a run without a session clears the stale one.
  const { body: { host } } = await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test", agents: [{ id: "claude", installed: true }] });
  const again = (await api<{ task: Task }>("POST", `/hosts/${host.id}/claim`, { taskId: task.id })).body.task;
  await api("POST", `/tasks/${task.id}/question`, { startedAt: again.startedAt, text: "And the outro?", sessionId: null });
  expect(app.ctx.repos.tasks.get(task.id)?.session).toBeUndefined();
});

it("never resumes Codex, whose sessions would show in the user's Codex app", async () => {
  const task = await claimed("codex");
  await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Which take?", sessionId: "thread-1" });
  await api("POST", `/tasks/${task.id}/answer`, { text: "The second take" });
  const prompt = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  expect(prompt.resumeSession).toBeUndefined();
  expect(prompt.systemPrompt).toContain("The second take");
});

it("rejects editing requests for the api agent, which no host runs", async () => {
  const res = await api<{ error: { code: string } }>("POST", `/projects/${project.id}/tasks`, { kind: "edit", agent: "api", instruction: "Cut it" });
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("agent_unavailable");
});

it("tells a learning check where in the video the request was about, on the player's clock past an hour", () => {
  const about = (time: number) => {
    const asked = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Add a title here", context: { time },
      createdBy: { type: "human", name: "Editor" } });
    const check = createTask(app.ctx, { projectId: project.id, kind: "learning_check", agent: "claude", instruction: "Add a title here",
      context: { checksTaskId: asked.id }, createdBy: { type: "human", name: "Editor" } });
    return learningCheckContext(app.ctx, check).about;
  };
  expect(about(125.9)).toBe("They said it about the moment at 2:05 in the video.");
  expect(about(3599)).toBe("They said it about the moment at 59:59 in the video.");
  expect(about(3600)).toBe("They said it about the moment at 1:00:00 in the video.");
  expect(about(4503)).toBe("They said it about the moment at 1:15:03 in the video.");
});

it("pairs questions with the answers that followed", () => {
  expect(pairQuestionsAndAnswers([
    { type: "log", text: "x" }, { type: "question", text: "q1" }, { type: "answer", text: "a1" }, { type: "question", text: "q2" },
  ])).toEqual([{ question: "q1", answer: "a1" }]);
});

it("records the agent's plan each time its harness changes it, and nothing else", async () => {
  const task = await claimed("codex");
  const steps = (...states: string[]) => states.map((state, i) => ({ text: `Step ${i + 1}`, state }));
  const post = (data: unknown, text = "") => api<{ error?: { code: string } }>("POST", `/tasks/${task.id}/events`, { type: "plan", text, data, startedAt: task.startedAt });
  const plans = async () => (await api<{ task: Task; events: TaskEvent[] }>("GET", `/tasks/${task.id}`)).body.events.filter(e => e.type === "plan");
  const seen: string[] = [];
  const heard = (m: WsEvent) => { if (m.type === "task.event" && m.event.type === "plan") seen.push(m.event.text); };
  app.ctx.bus.on("ws", heard);

  // The plan as Codex first reports it: each step, and whether it is finished.
  expect((await post({ steps: steps("pending", "pending", "pending") })).status).toBe(200);
  // Codex says the same plan again as its turn ends. Only a change is recorded.
  await post({ steps: steps("pending", "pending", "pending") });
  await post({ steps: steps("done", "in_progress", "pending"), extra: "ignored" });
  const recorded = await plans();
  expect(recorded.map(e => e.text)).toEqual(["[ ] Step 1\n[ ] Step 2\n[ ] Step 3", "[x] Step 1\n[>] Step 2\n[ ] Step 3"]);
  expect(recorded[1]!.data).toEqual({ steps: steps("done", "in_progress", "pending") });
  expect(seen).toEqual(recorded.map(e => e.text));
  // A plan is evidence about the run, not something it did: the task is working, and nothing else about it changed.
  const { body } = await api<{ task: Task; events: TaskEvent[] }>("GET", `/tasks/${task.id}`);
  expect(body.task).toMatchObject({ state: "running", changeIds: [], question: null });
  expect(taskPlan(body.events)).toEqual(steps("done", "in_progress", "pending"));

  // Steps Scarlet can't read are refused, so the chat never shows a list it made up.
  for (const bad of [undefined, { steps: "three" }, { steps: [{ text: "Step 1", state: "started" }] }, { steps: [{ text: " ", state: "pending" }] }]) {
    const refused = await post(bad);
    expect([refused.status, refused.body.error?.code]).toEqual([400, "invalid_plan"]);
  }
  expect(await plans()).toHaveLength(2);

  // The agent cleared its plan: that is recorded too, and the run has none.
  await post({ steps: [] });
  expect((await plans()).at(-1)!.text).toBe("Plan cleared");
  expect(taskPlan((await api<{ events: TaskEvent[] }>("GET", `/tasks/${task.id}`)).body.events)).toBeUndefined();
  // A run picked up after the editor's answer starts without the plan it had before the question.
  await post({ steps: steps("done", "pending") });
  await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Keep the cold open?" });
  await api("POST", `/tasks/${task.id}/answer`, { text: "Yes" });
  expect(taskPlan((await api<{ events: TaskEvent[] }>("GET", `/tasks/${task.id}`)).body.events)).toBeUndefined();
  app.ctx.bus.off("ws", heard);
});

it("launches no run with a to-do tool unless SCARLET_AGENT_CAPS turns one on, and then never a pass or a request about one cut", async () => {
  const told = async (task: Task) => (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  // The chat shows what Scarlet is doing this moment, not a plan, so no harness is given its to-do tool or asked for steps.
  for (const agent of ["claude", "codex"] as const) {
    const prompt = await told(await claimed(agent));
    expect(prompt.plan, agent).toBeUndefined();
    expect(prompt.systemPrompt, agent).not.toContain("# Your steps");
  }
  // Turned on where the engine runs, a request with no stages of Scarlet's is launched with it and asked to lay out its steps.
  app.ctx.options.env = { SCARLET_AGENT_CAPS: '{"plan":true}' };
  expect((await told(await claimed("codex"))).plan).toBe(true);
  const edit = await claimed();
  const on = await told(edit);
  expect(on.plan).toBe(true);
  expect(on.systemPrompt).toContain(PLAN_STEPS);
  // A dialogue pass and a request about one staged cut are launched and told exactly as before, even then.
  for (const task of [await claimed("claude", "/first-cut-dialogue"), await claimed("claude", "Start it later.", { cutIndex: 1 })]) {
    const prompt = await told(task);
    expect(prompt.plan, task.instruction).toBeUndefined();
    expect(prompt.systemPrompt, task.instruction).not.toContain("# Your steps");
  }
  // The tool and the ask go together: apart from the ask, the run is told the same, word for word.
  app.ctx.options.env = {};
  const plain = await told(edit);
  expect(on.systemPrompt.replace(`\n\n${PLAN_STEPS}`, "")).toBe(plain.systemPrompt);
});

it("logs a run starting, asking and being answered, without what was asked or answered", async () => {
  const task = await claimed();
  const lines: string[] = [];
  app.ctx.log = line => lines.push(line);
  const said = () => lines.filter(line => line.startsWith("[task]"));
  const event = (body: object) => api("POST", `/tasks/${task.id}/events`, { ...body, startedAt: task.startedAt });
  // The first thing a claimed run reports is that it started. What it reports after that is no change of state.
  await event({ type: "log", text: "Reading the transcript" });
  await event({ type: "log", text: "Looking at 0:12" });
  expect(said()).toEqual([`[task] ${task.id} claimed → running`]);
  const { startedAt } = app.ctx.repos.tasks.get(task.id)!;
  await api("POST", `/tasks/${task.id}/question`, { startedAt, text: "Keep the cold open about the merger?" });
  await api("POST", `/tasks/${task.id}/answer`, { text: "Yes, but lose the name of the buyer" });
  expect(said().slice(1)).toEqual([
    `[task] ${task.id} running → waiting_for_user: asked the editor a question`,
    `[task] ${task.id} waiting_for_user → queued: the editor answered`,
  ]);
  expect(said().join("\n")).not.toMatch(/merger|buyer|transcript/);

  // A run that asks before it has reported anything goes straight from claimed to waiting.
  const eager = await claimed();
  lines.length = 0;
  await api("POST", `/tasks/${eager.id}/question`, { startedAt: eager.startedAt, text: "Which take?" });
  expect(said()).toEqual([`[task] ${eager.id} claimed → waiting_for_user: asked the editor a question`]);
});

it("still hands over the prompt for a revision whose edit can no longer be laid out, and logs what is missing", async () => {
  const { body: { change } } = await api<{ change: { id: string; toVersion: string } }>("POST", `/projects/${project.id}/changes`,
    { description: "Add label", ops: [{ op: "addMarker", marker: { id: "marker", time: 0, text: "Start" } }] });
  const { body: { task } } = await api<{ task: Task }>("POST", `/changes/${change.id}/revise`, { text: "Move it later" });
  const lines: string[] = [];
  app.ctx.log = line => lines.push(line);
  const whole = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  expect(lines.filter(line => line.includes("without its diff"))).toEqual([]);
  // The version the edit made is gone from the library.
  app.ctx.db.prepare("DELETE FROM timeline_versions WHERE project_id = ? AND version = ?").run(project.id, change.toVersion);
  const partial = await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`);
  expect(partial.status).toBe(200);
  expect(partial.body.systemPrompt).toContain("Add label");
  expect(partial.body.systemPrompt.length).toBeLessThanOrEqual(whole.systemPrompt.length);
  expect(lines.filter(line => line.startsWith("[task]"))).toEqual([expect.stringMatching(new RegExp(`^\\[task\\] ${task.id} is told about ${change.id} without its diff: .+ not found$`))]);
});

it("changes a waiting request's words, holding it from starting while they're open, and tells the agent them as if asked so", async () => {
  const send = async (instruction: string, threadId?: string) =>
    (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { kind: "edit", agent: "claude", instruction, ...(threadId && { context: { threadId } }) })).body.task;
  const first = await send("Tighten the intro");
  const followUp = await send("Make it shorter", first.id);
  const later = await send("And add a title", first.id);
  const { body: { host } } = await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test", agents: [{ id: "claude", installed: true }] });
  // Each request's learning check runs beside the queue. These claims are for the requests themselves.
  const claim = async () => {
    for (;;) {
      const { task } = (await api<{ task: Task | null }>("POST", `/hosts/${host.id}/claim`, {})).body;
      if (task?.kind !== "learning_check") return task;
    }
  };

  // While the editor changes the first request's words, nothing starts: not it, and not the requests behind it.
  expect((await api<{ task: Task }>("POST", `/tasks/${first.id}/hold`, { on: true })).body.task.rewordingUntil).toBeDefined();
  expect(await claim()).toBeNull();
  await api("POST", `/tasks/${first.id}/hold`, { on: false });
  // A hold the app stopped renewing lapses by itself.
  await api("POST", `/tasks/${first.id}/hold`, { on: true });
  app.ctx.repos.tasks.put({ ...app.ctx.repos.tasks.get(first.id)!, rewordingUntil: new Date(Date.now() - 1000).toISOString() });
  expect((await claim())?.id).toBe(first.id);
  // A request Scarlet began has no words left to change.
  expect((await api("POST", `/tasks/${first.id}/hold`, { on: true })).status).toBe(409);
  expect((await api("POST", `/tasks/${first.id}/reword`, { text: "Cut the intro" })).status).toBe(409);

  // A follow-up still waiting is told the thread as it was before it, then its new words.
  await api("POST", `/tasks/${followUp.id}/hold`, { on: true });
  const reworded = (await api<{ task: Task }>("POST", `/tasks/${followUp.id}/reword`, { text: "  Make it half as long  " })).body.task;
  expect(reworded.context.message).toBe("Make it half as long");
  expect(reworded.instruction).toContain("- Asked: Tighten the intro");
  expect(reworded.instruction).not.toContain("Make it shorter");
  expect(reworded.instruction).not.toContain(later.context.message);
  expect(reworded.instruction.endsWith("Now: Make it half as long")).toBe(true);
  // Saving lets the hold go, and it keeps its place in line.
  expect(reworded.rewordingUntil).toBeUndefined();
  expect(reworded.createdAt).toBe(followUp.createdAt);
  // The new words are read for a standing rule, and the check that was reading the old ones stops.
  const checks = app.ctx.repos.tasks.select("kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [followUp.id], "created_at ASC, rowid ASC");
  expect(checks.map(c => [c.instruction, c.state])).toEqual([["Make it shorter", "cancelled"], ["Make it half as long", "queued"]]);
  expect((await api("POST", `/tasks/${followUp.id}/reword`, { text: "  " })).status).toBe(400);
  // A request Scarlet made itself is told more than the words shown for it, so they aren't the editor's to change.
  const own = createTask(app.ctx, { projectId: project.id, kind: "revise", agent: "claude", instruction: "Redo this change on the current edit: \"Add label\".",
    context: { threadId: first.id, message: "Redo on the current edit" }, createdBy: { type: "scarlet", name: "Scarlet" } });
  expect((await api("POST", `/tasks/${own.id}/hold`, { on: true })).status).toBe(409);
  expect((await api("POST", `/tasks/${own.id}/reword`, { text: "Do something else" })).status).toBe(409);
  expect(app.ctx.repos.tasks.get(own.id)!.instruction).toBe("Redo this change on the current edit: \"Add label\".");
});

it("rewords a waiting revision of a change and its note, keeping what it says about the cut", async () => {
  const { body: { change } } = await api<{ change: { id: string } }>("POST", `/projects/${project.id}/changes`,
    { description: "Add label", ops: [{ op: "addMarker", marker: { id: "marker", time: 0, text: "Start" } }] });
  const { body: { task } } = await api<{ task: Task }>("POST", `/changes/${change.id}/revise`, { text: "Move it later", voiceTranscript: "move it later" });
  const { body: { task: reworded } } = await api<{ task: Task }>("POST", `/tasks/${task.id}/reword`, { text: "Move it to the end" });
  expect(reworded.instruction).toBe(task.instruction.replace("Move it later", "Move it to the end"));
  expect(reworded.context.message).toBe("Move it to the end");
  const note = app.ctx.repos.notes.get(task.context.noteIds![0]!)!;
  expect(note.text).toBe("Move it to the end");
  expect(note.voiceTranscript).toBeUndefined();
});

it("rewords a waiting new edit at a point and its note, so the agent is asked only the new words", async () => {
  const { body: { task } } = await api<{ task: Task }>("POST", `/projects/${project.id}/notes`,
    { time: 12, text: "Cut the cough at the start", voiceTranscript: "um cut the cough uh at the start", assignTo: "claude" });
  expect(task.kind).toBe("note");
  const before = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body.systemPrompt;
  expect(before).toContain("Cut the cough at the start");
  const { body: { task: reworded } } = await api<{ task: Task }>("POST", `/tasks/${task.id}/reword`, { text: "Tighten the pause after the laugh" });
  expect(reworded.instruction).toBe("Tighten the pause after the laugh");
  const note = app.ctx.repos.notes.get(task.context.noteIds![0]!)!;
  expect(note.text).toBe("Tighten the pause after the laugh");
  expect(note.voiceTranscript).toBeUndefined();
  const prompt = (await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt`)).body;
  expect(prompt.systemPrompt).toContain("Tighten the pause after the laugh");
  expect(JSON.stringify(prompt)).not.toMatch(/cough/);
});

it("runs the skills a waiting request's new words name, and not the old words' skills", async () => {
  const { body: { task } } = await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`,
    { kind: "edit", agent: "claude", instruction: "/first-cut-dialogue tighten it", context: { skillIds: ["skl_dialogue"] } });
  const { body: { task: other } } = await api<{ task: Task }>("POST", `/tasks/${task.id}/reword`, { text: "/broll add some cutaways", skillIds: ["skl_broll"] });
  expect(other.context.skillIds).toEqual(["skl_broll"]);
  expect(app.ctx.repos.tasks.get(task.id)!.context.skillIds).toEqual(["skl_broll"]);
  // Words that name no skill run none.
  const { body: { task: plain } } = await api<{ task: Task }>("POST", `/tasks/${task.id}/reword`, { text: "Just add some cutaways" });
  expect(plain.context.skillIds).toBeUndefined();
  expect((await api("POST", `/tasks/${task.id}/reword`, { text: "/broll again", skillIds: [""] })).status).toBe(400);
});

it("says what quitting would stop, in every project: the edits under way and waiting their turn, and exports", async () => {
  const underWay = async () => (await api<{ edits: number; queued: number; exports: number }>("GET", "/under-way")).body;
  expect(await underWay()).toEqual({ edits: 0, queued: 0, exports: 0 });
  const running = await claimed();
  // The next request in that project waits its turn, as does one in another project.
  await api("POST", `/projects/${running.projectId}/tasks`, { kind: "edit", agent: "claude", instruction: "Add captions" });
  await api("POST", `/projects/${project.id}/tasks`, { kind: "edit", agent: "claude", instruction: "Trim the ending" });
  // An export renders. A preview of the cut is nothing the editor would lose.
  const render = { projectId: project.id, version: "v1", key: "key", kind: "full", path: null, progress: 0.4, range: null } as const;
  app.ctx.repos.renders.put({ ...render, id: "export", state: "running", export: { name: "Cut.mp4", ticket: 1, owner: crypto.randomUUID() } });
  app.ctx.repos.renders.put({ ...render, id: "preview", state: "running" });
  // A project in the trash runs nothing: its requests wait for Restore.
  const { body: { project: trashed } } = await api<{ project: { id: string } }>("POST", "/projects", { name: "Trashed fixture" });
  await api("POST", `/projects/${trashed.id}/tasks`, { kind: "edit", agent: "claude", instruction: "Add music" });
  await api("DELETE", `/projects/${trashed.id}`);
  expect(await underWay()).toEqual({ edits: 1, queued: 2, exports: 1 });
  // A request asking the editor something waits for them, and so does the request behind it. An export that has
  // finished is done.
  await api("POST", `/tasks/${running.id}/question`, { startedAt: running.startedAt, text: "Keep the cold open?" });
  app.ctx.repos.renders.put({ ...render, id: "export", state: "done", export: { name: "Cut.mp4", ticket: 1, owner: crypto.randomUUID() } });
  expect(await underWay()).toEqual({ edits: 0, queued: 1, exports: 0 });
});

it("resumes a run its engine's crash cut short, until crashes keep cutting it short, and a run Scarlet quit on every time", async () => {
  const { body: { host } } = await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test", agents: [{ id: "claude", installed: true }] });
  // Each attempt is claimed and cut short; the next is the attempt Scarlet resumed it as, if any.
  const cutShort = async (task: Task, engineLost: boolean) => {
    const { body: { task: claimed } } = await api<{ task: Task }>("POST", `/hosts/${host.id}/claim`, { taskId: task.id });
    await api("POST", `/tasks/${task.id}/complete`, { state: "cancelled", interrupted: true, ifStartedAt: claimed.startedAt, ...(engineLost && { engineLost }) });
    const ended = app.ctx.repos.tasks.get(task.id)!;
    expect(ended).toMatchObject({ state: "failed", interrupted: true });
    return ended.retryTaskId ? app.ctx.repos.tasks.get(ended.retryTaskId)! : undefined;
  };
  const ask = async (instruction: string) => (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, { kind: "edit", agent: "claude", instruction })).body.task;
  // A run whose own work crashes the engine each time: reported by the host started for the next engine, it carries
  // on twice, then waits for the editor rather than crashing the engine for ever.
  let attempt: Task | undefined = await ask("Cut the pauses");
  for (const expected of [true, true, false]) {
    attempt = await cutShort(attempt!, true);
    expect(!!attempt).toBe(expected);
  }
  // Scarlet quitting never costs the editor a pass, however often.
  attempt = await ask("Add captions");
  for (let quits = 0; quits < 4; quits++) {
    attempt = await cutShort(attempt!, false);
    expect(attempt?.state).toBe("queued");
  }
});

it("finds a run's attempts among its own project's tasks, not by reading every project's", async () => {
  const run = await claimed("claude", "Mark the chapters");
  const prepare = vi.spyOn(app.ctx.db, "prepare");
  // The run saves an edit, the editor stops it, and Scarlet resumes it; the resumed attempt saves again and finishes.
  const save = async (task: Task, id: string) => {
    const headers = { Authorization: `Bearer ${accessToken(app.ctx)}`, "Content-Type": "application/json", [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: task.startedAt! };
    const res = await app.app.request(`/api/projects/${task.projectId}/changes`, { method: "POST", headers, body: JSON.stringify({ intent: "requested", skipRender: true,
      description: "Mark a chapter", ops: [{ op: "addMarker", marker: { id, time: 0, kind: "chapter", text: "Chapter", resolved: false } }] }) });
    expect(res.status).toBe(201);
  };
  await save(run, "first");
  await api("POST", `/tasks/${run.id}/cancel`);
  const { body: { task: queued } } = await api<{ task: Task }>("POST", `/tasks/${run.id}/retry`, {});
  expect(queued.resumeRootId).toBe(run.id);
  const { body: { host } } = await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test", agents: [{ id: "claude", installed: true }] });
  const { body: { task: resumed } } = await api<{ task: Task }>("POST", `/hosts/${host.id}/claim`, { taskId: queued.id });
  await save(resumed, "again");
  expect((await api<{ task: Task }>("POST", `/tasks/${resumed.id}/complete`, { state: "done", ifStartedAt: resumed.startedAt })).body.task.state).toBe("done");
  // The staged-call check on each save, putting away a stale save, and the resumed run's earlier passes on finishing.
  const lookups = [...new Set(prepare.mock.calls.map(([sql]) => sql))].filter(sql => sql.includes("SELECT id FROM tasks WHERE"));
  expect(lookups).toHaveLength(3);
  const scans = lookups.filter(sql => (app.ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .some(({ detail }) => /^SCAN tasks\b/.test(detail)));
  expect(scans).toEqual([]);
});
