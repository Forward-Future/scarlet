import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER, type Task, type TaskPrompt } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { createTask, followUpInstruction, MOST_CLOSING_CHECKS, queueRepeatCheck, saveTask } from "./tasks.js";
import { storeVersion } from "./timeline.js";

let dataDir: string;
let app: ScarletApp;
let project: Project;
let hostId: string;
const editor = { type: "human", name: "Editor" } as const;
const scarlet = { type: "scarlet", name: "Scarlet" } as const;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-lifecycle-"));
  app = createApp({ dataDir, env: {}, log: () => {} });
  project = app.ctx.repos.projects.insert(createProject("Lifecycle fixture"));
  hostId = (await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test",
    agents: ["claude", "codex", "gemini"].map(id => ({ id, installed: true })) })).body.host.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const all = new Headers({ Authorization: `Bearer ${accessToken(app.ctx)}`, ...headers });
  if (body !== undefined) all.set("Content-Type", "application/json");
  const res = await app.app.request("/api" + path, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as T };
}

/** The host's claim of one queued task, or null when it can't be claimed now. */
const claim = async (id: string) => (await api<{ task: Task | null }>("POST", `/hosts/${hostId}/claim`, { taskId: id })).body.task ?? null;
const prompt = async (id: string, fresh = false) => (await api<TaskPrompt>("GET", `/tasks/${id}/prompt${fresh ? "?fresh=1" : ""}`)).body;
const get = (id: string) => app.ctx.repos.tasks.get(id)!;
const attemptOf = (task: Task) => ({ [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: task.startedAt! });
const checksOf = (task: Task, kind: "learning_check" | "area_check") =>
  app.ctx.repos.tasks.select("kind = ? AND json_extract(json, '$.context.checksTaskId') = ?", [kind, task.id], "created_at, rowid");
const quit = (task: Task) => api("POST", `/tasks/${task.id}/complete`, { state: "cancelled", interrupted: true, ifStartedAt: task.startedAt });

/** A request the editor sent, claimed by the host. */
async function request(instruction = "Tighten the intro", agent = "claude", context: Task["context"] = {}) {
  const task = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: agent as Task["agent"], instruction, context, createdBy: editor });
  return (await claim(task.id))!;
}
const dialoguePass = (agent = "claude") => request("Cut the dialogue tight", agent, { dialogueOperation: "first-cut" });

/** A look at one frame that a request asked for. */
const look = (asker: Task, at: number) => createTask(app.ctx, { projectId: asker.projectId, kind: "area_check", agent: asker.agent,
  instruction: `What viewers may see at ${at} s`, context: { checksTaskId: asker.id, areaCheck: { mediaId: "screen", at } }, createdBy: scarlet });

it("tells the closing check the answer to its own question, never the pass's, and every earlier answer when it starts afresh", async () => {
  const task = await dialoguePass();
  await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Keep the cold open?" });
  await api("POST", `/tasks/${task.id}/answer`, { text: "Yes, keep it" });
  const resumed = (await claim(task.id))!;
  // The pass finished with findings on the video as it plays, and went back for its closing check.
  queueRepeatCheck(app.ctx, { ...resumed, reply: "Tightened the dialogue." }, "ver_played");
  await claim(task.id);
  const first = await prompt(task.id);
  expect(first.instruction).toMatch(/^The dialogue pass has saved its editing work/);
  expect(first.instruction).toContain("Editor’s request: Cut the dialogue tight");
  // The pass's answer is with the earlier questions and answers, not told as the check's.
  expect(first.instruction).not.toContain("The editor answered");
  expect(first.systemPrompt).toContain("Keep the cold open?");

  // The check asks a question of its own, from a session its host keeps.
  const checking = get(task.id);
  await api("POST", `/tasks/${task.id}/question`, { startedAt: checking.startedAt, text: "Cut the second restart?", sessionId: "check-session" });
  await api("POST", `/tasks/${task.id}/answer`, { text: "Cut it" });
  await claim(task.id);
  // The session that asked carries on with the answer.
  expect(await prompt(task.id)).toMatchObject({ resumeSession: "check-session", instruction: 'The editor answered: "Cut it"\nContinue the task with that answer.' });
  // Started afresh, the check is told its goal and the answer, and reads both questions with their answers.
  const fresh = await prompt(task.id, true);
  expect(fresh.resumeSession).toBeUndefined();
  expect(fresh.instruction).toMatch(/^The dialogue pass has saved its editing work[\s\S]*\nThe editor answered: Cut it$/);
  expect(fresh.systemPrompt).toContain("# Earlier questions and answers");
  for (const said of ["Keep the cold open?", "Yes, keep it", "Cut the second restart?", "Cut it"]) expect(fresh.systemPrompt).toContain(said);
});

it("carries a pass's closing words and its check's count on through a quit and a pause, and tells the check the editor's words", async () => {
  const task = await dialoguePass();
  queueRepeatCheck(app.ctx, { ...task, reply: "Tightened the dialogue." }, "ver_played");
  // Quit during the check: the attempt that carries on is still the check, with the pass's words.
  await quit((await claim(task.id))!);
  const afterQuit = get(get(task.id).retryTaskId!);
  expect(afterQuit).toMatchObject({ state: "queued", resumeRootId: task.id, reply: "Tightened the dialogue.",
    repeatAudit: { version: "ver_played", returns: 1, totalReturns: 1 } });
  // Paused during the check: the same, and it is told what the editor asked, not Scarlet's account of the run.
  await claim(afterQuit.id);
  expect((await api("POST", `/projects/${project.id}/stop-editing`)).status).toBe(200);
  const afterPause = get(get(afterQuit.id).retryTaskId!);
  expect(afterPause).toMatchObject({ reply: "Tightened the dialogue.", repeatAudit: { returns: 1, totalReturns: 1 } });
  expect(afterPause.instruction).toContain("Resume this interrupted request.");
  await api("POST", `/projects/${project.id}/resume-editing`);
  await claim(afterPause.id);
  const told = await prompt(afterPause.id);
  expect(told.instruction).toMatch(/^The dialogue pass has saved its editing work/);
  expect(told.instruction.split("\n").at(-1)).toBe("Editor’s request: Cut the dialogue tight");

  // The cap stopped it. The editor's own Resume gives the check its full allowance, and keeps the pass's words.
  saveTask(app.ctx, { ...get(afterPause.id), state: "failed", interrupted: true, finishedAt: new Date().toISOString(),
    repeatAudit: { version: "ver_played", remaining: 2, returns: 2, totalReturns: MOST_CLOSING_CHECKS } });
  const again = (await api<{ task: Task }>("POST", `/tasks/${afterPause.id}/retry`, {})).body.task;
  expect(again).toMatchObject({ resumeRootId: task.id, reply: "Tightened the dialogue.", repeatAudit: { returns: 0, totalReturns: 0 } });
});

it("tells a follow-up pass's closing check the request as it was sent, with its thread's earlier requests, never Scarlet's recap", async () => {
  const earlier = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Keep the pauses natural", createdBy: scarlet });
  saveTask(app.ctx, { ...earlier, state: "done", summary: "Left the pauses as they are." });
  // A follow-up is sent with the thread's earlier requests, as the request route builds it.
  const words = "Cut the dialogue tight";
  const sent = followUpInstruction(app.ctx, project.id, earlier.id, words);
  const task = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: sent,
    context: { threadId: earlier.id, message: words, dialogueOperation: "first-cut" }, createdBy: scarlet });
  queueRepeatCheck(app.ctx, (await claim(task.id))!, "ver_played");
  await claim(task.id);
  const check = (await prompt(task.id)).instruction;
  expect(check).toMatch(/^The dialogue pass has saved its editing work/);
  expect(check).toContain(`Editor’s request: ${sent}`);
  expect(check).toContain("- Asked: Keep the pauses natural\n  You replied: Left the pauses as they are.");
  // Resumed after a quit, the check is still told the request as sent, not the account of the run.
  await quit(get(task.id));
  const resumed = get(get(task.id).retryTaskId!);
  await claim(resumed.id);
  const again = (await prompt(resumed.id, true)).instruction;
  expect(again).toContain(`Editor’s request: ${sent}`);
  expect(again).not.toContain("Resume this interrupted request");
});

it("stops a pass's closing check after a few returns in all, even when each return gets somewhere", async () => {
  app.ctx.repos.projects.putMedia(project.id, { id: "cam", name: "Camera", kind: "video", path: "cam.mov", duration: 30 }, "ready");
  const { version } = storeVersion(app.ctx, project.id, timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 20 }]), { parent: null });
  app.ctx.repos.projects.update(project.id, { head: version });
  const task = await dialoguePass();
  const states: string[] = [];
  for (let run = 0; run <= MOST_CLOSING_CHECKS; run++) {
    // Each check fixed one finding and made another: the reading's own count starts again.
    const at = get(task.id);
    saveTask(app.ctx, { ...at, repeatAudit: { ...at.repeatAudit, version, remaining: 1, returns: 0 } });
    const finished = (await api<{ task: Task }>("POST", `/tasks/${task.id}/complete`, { state: "done", ifStartedAt: at.startedAt })).body.task;
    states.push(finished.state);
    if (finished.state === "queued") await claim(task.id);
  }
  expect(states).toEqual([...Array(MOST_CLOSING_CHECKS).fill("queued"), "failed"]);
  expect(get(task.id)).toMatchObject({ interrupted: true, repeatAudit: { totalReturns: MOST_CLOSING_CHECKS } });
  expect(get(task.id).error).toMatch(/^The final check still has/);
});

it("holds a request's read for a rule while editing is paused, and runs it on Resume", async () => {
  const asked = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Always cut the ums", createdBy: editor });
  const [check] = checksOf(asked, "learning_check");
  await api("POST", `/projects/${project.id}/stop-editing`);
  expect(await claim(check!.id)).toBeNull();
  await api("POST", `/projects/${project.id}/resume-editing`);
  expect((await claim(check!.id))?.state).toBe("claimed");
});

it("stops the read for a rule of words the editor took back, under way or not, and keeps it for a request they stopped", async () => {
  // Taken back with ⌘Z while it ran: the check reading it stops, and can offer nothing after.
  const withdrawn = await request("Always cut the ums");
  const check = (await claim(checksOf(withdrawn, "learning_check")[0]!.id))!;
  expect((await api("POST", `/tasks/${withdrawn.id}/cancel?withdrawn=1`)).status).toBe(200);
  expect(get(check.id).state).toBe("cancelled");
  const skill = app.ctx.repos.skills.select("1=1", [], "name ASC").find(s => s.enabled)!;
  const offered = await api("POST", `/projects/${project.id}/tasks/${check.id}/learnings`, { rule: "Cut every um.", skill: skill.name }, attemptOf(check));
  expect(offered.status).toBe(409);
  expect(app.ctx.repos.learnings.count("project_id = ?", [project.id])).toBe(0);
  // Stopped with Stop this edit while it ran: the words stand, and the check reading them carries on.
  const stopped = await request("Keep my pauses under a second");
  const kept = (await claim(checksOf(stopped, "learning_check")[0]!.id))!;
  expect((await api("POST", `/tasks/${stopped.id}/cancel`)).status).toBe(200);
  expect(get(kept.id).state).toBe("claimed");
});

it("reads a request's words for a rule once, not again for its Retry or Resume", async () => {
  const failed = await request("Always cut the ums");
  await api("POST", `/tasks/${failed.id}/complete`, { state: "failed", error: "stalled", ifStartedAt: failed.startedAt });
  const retried = (await api<{ task: Task }>("POST", `/tasks/${failed.id}/retry`, {})).body.task;
  expect(retried.resumeRootId).toBeUndefined();
  expect(checksOf(failed, "learning_check")).toHaveLength(1);
  expect(checksOf(retried, "learning_check")).toHaveLength(0);
  await quit((await claim(retried.id))!);
  expect(checksOf(get(get(retried.id).retryTaskId!), "learning_check")).toHaveLength(0);
});

it("ends the looks a request asked for with it: stopped, paused or finished, and starts a look only while its request works", async () => {
  // Stopped: its looks stop, waiting or under way.
  const stopped = await request("Frame the demo");
  const [waiting, underWay] = [look(stopped, 30), look(stopped, 400)];
  expect((await claim(underWay.id))?.state).toBe("claimed");
  await api("POST", `/tasks/${stopped.id}/cancel`);
  expect([get(waiting.id).state, get(underWay.id).state]).toEqual(["cancelled", "cancelled"]);
  // A look stopped with its request can't set what it found.
  app.ctx.repos.projects.putMedia(project.id, { id: "screen", name: "Screen", kind: "video", path: "screen.mov", duration: 600 }, "ready");
  const set = await api<{ error: { code: string } }>("POST", `/projects/${project.id}/media/screen/show-area`, { set: [{ at: 400, area: [0, 0, 1, 1] }] }, attemptOf(get(underWay.id)));
  expect(set).toMatchObject({ status: 409, body: { error: { code: "inactive_task_attempt" } } });

  // Paused: the same.
  const paused = await request("Frame the demo");
  const pausedLook = look(paused, 30);
  await api("POST", `/projects/${project.id}/stop-editing`);
  expect(get(pausedLook.id).state).toBe("cancelled");
  // A request stopped or put back in line asks for no more looks.
  const asked = await api<{ error: { code: string } }>("POST", `/projects/${project.id}/media/screen/show-area/ask`, { seconds: [30], taskId: paused.id }, attemptOf(paused));
  expect(asked).toMatchObject({ status: 409, body: { error: { code: "inactive_task_attempt" } } });
  await api("POST", `/projects/${project.id}/resume-editing`);
  await api("POST", `/tasks/${get(paused.id).retryTaskId}/cancel`);

  // A look whose request is waiting its turn, or on the editor, doesn't start until the request works again.
  const queued = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Frame the demo", createdBy: scarlet });
  const early = look(queued, 30);
  expect(await claim(early.id)).toBeNull();
  const working = (await claim(queued.id))!;
  expect((await claim(early.id))?.state).toBe("claimed");
  const later = look(working, 300);
  await api("POST", `/tasks/${queued.id}/question`, { startedAt: working.startedAt, text: "Which window?" });
  expect(await claim(later.id)).toBeNull();
  // Finished, it leaves no look waiting to start; one under way finishes, since what it finds is kept.
  await api("POST", `/tasks/${queued.id}/answer`, { text: "The browser" });
  const back = (await claim(queued.id))!;
  await api("POST", `/tasks/${queued.id}/complete`, { state: "done", ifStartedAt: back.startedAt });
  expect([get(early.id).state, get(later.id).state]).toEqual(["claimed", "cancelled"]);
});

it("tells a resumed attempt where its run stands when it starts, not when it was put back in line", async () => {
  const task = await request("Mark the chapters");
  const ts = new Date().toISOString();
  const change = { id: "chg_chapters", projectId: project.id, fromVersion: "ver_a", toVersion: "ver_b", description: "Chapter markers",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "ready", renders: [], taskId: task.id, createdAt: ts, updatedAt: ts };
  app.ctx.repos.changes.put(change as unknown as Change);
  await quit(task);
  const resumed = get(get(task.id).retryTaskId!);
  expect(resumed.instruction).toContain("Saved change chg_chapters [ready]");
  // While it waited its turn, the editor approved what the run had saved.
  app.ctx.repos.changes.put({ ...app.ctx.repos.changes.get(change.id)!, state: "approved" });
  await claim(resumed.id);
  const told = await prompt(resumed.id, true);
  expect(told.instruction).toContain("Saved change chg_chapters [approved]");
  expect(told.instruction).not.toContain("[ready]");
});

it("carries a paused run on in its CLI session on the same model, and a run the editor stopped in none", async () => {
  const task = await request("Tighten the intro");
  await api("POST", `/tasks/${task.id}/events`, { startedAt: task.startedAt, type: "log", text: "Claude Code session started", data: { kind: "init", sessionId: "session-1" } });
  const ts = new Date().toISOString();
  app.ctx.repos.changes.put({ id: "chg_intro", projectId: project.id, fromVersion: "ver_a", toVersion: "ver_b", description: "Tighter intro",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "ready", renders: [], taskId: task.id,
    createdAt: ts, updatedAt: ts } as unknown as Change);
  const stopped = (await api<{ tasks: Task[] }>("POST", `/projects/${project.id}/stop-editing`)).body.tasks;
  const prior = stopped.find(t => t.id === task.id)!;
  const next = stopped.find(t => t.resumeRootId === task.id)!;
  // The host keeps the session's files for the attempt that carries on in it.
  expect(prior).toMatchObject({ state: "cancelled", retryTaskId: next.id, sessionCarriesOn: true });
  expect(next).toMatchObject({ state: "queued", resumesAfterProjectStop: true, session: { agent: "claude", id: "session-1" } });
  // While editing was paused, the editor kept what the run had saved.
  app.ctx.repos.changes.put({ ...app.ctx.repos.changes.get("chg_intro")!, state: "approved" });
  await api("POST", `/projects/${project.id}/resume-editing`);
  await claim(next.id);
  const resumed = await prompt(next.id);
  expect(resumed.resumeSession).toBe("session-1");
  // The session carries on, told of the pause and where the run stands now: it never had the recap.
  expect(resumed.instruction).toMatch(/^The editor paused editing while you were working on this request, and has resumed it\.[^\n]*\n\nTighten the intro\n\nResume this interrupted request\./);
  expect(resumed.instruction).toContain("Saved change chg_intro [approved]");
  // The host found no such session: the recap goes to a fresh one.
  expect((await prompt(next.id, true)).instruction).toContain("Resume this interrupted request.");

  // Stop this edit ends the run and its session, and Resume starts a session of its own.
  await api("POST", `/tasks/${next.id}/cancel`);
  expect(get(next.id).sessionCarriesOn).toBeUndefined();
  const afterStop = (await api<{ task: Task }>("POST", `/tasks/${next.id}/retry`, {})).body.task;
  expect(afterStop.session).toBeUndefined();
  expect(get(next.id).sessionCarriesOn).toBeUndefined();
  await api("POST", `/tasks/${afterStop.id}/cancel`);

  // Cut short by a quit, a run carries on in its session as after a pause.
  const cutShort = await request("Trim the outro");
  saveTask(app.ctx, { ...get(cutShort.id), session: { agent: "claude", id: "session-2" } });
  await quit(cutShort);
  expect(get(cutShort.id).sessionCarriesOn).toBe(true);
  expect(get(get(cutShort.id).retryTaskId!).session).toEqual({ agent: "claude", id: "session-2" });
  await api("POST", `/tasks/${get(cutShort.id).retryTaskId}/cancel`);
  // Picked up on another model, a run starts a session of its own, and the one it left isn't kept for it.
  const quitAgain = await request("Add a title");
  saveTask(app.ctx, { ...get(quitAgain.id), session: { agent: "claude", id: "session-3" } });
  saveTask(app.ctx, { ...get(quitAgain.id), state: "failed", interrupted: true, finishedAt: new Date().toISOString() });
  const opus = (await api<{ task: Task }>("POST", `/tasks/${quitAgain.id}/retry`, { agent: "claude", model: "opus" })).body.task;
  expect(opus).toMatchObject({ model: "opus" });
  expect(opus.session).toBeUndefined();
  expect(get(quitAgain.id).sessionCarriesOn).toBeUndefined();

  // A harness Scarlet doesn't resume carries no session on, paused or not.
  await api("POST", `/tasks/${opus.id}/cancel`);
  const gemini = await request("Add captions", "gemini");
  saveTask(app.ctx, { ...get(gemini.id), session: { agent: "gemini", id: "session-4" } });
  await api("POST", `/projects/${project.id}/stop-editing`);
  expect(get(gemini.id).sessionCarriesOn).toBeUndefined();
  expect(get(get(gemini.id).retryTaskId!).session).toBeUndefined();
});

it("tells a look at a frame nothing of the video's timeline or skills, and a request about one staged cut no whole diff", async () => {
  const { version } = storeVersion(app.ctx, project.id, timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 20 }]), { parent: null });
  app.ctx.repos.projects.update(project.id, { head: version });
  const asker = await request("Frame the demo");
  const frame = look(asker, 30);
  await claim(frame.id);
  const versions = vi.spyOn(app.ctx.repos.versions, "get");
  const skills = vi.spyOn(app.ctx.repos.skills, "select");
  expect((await prompt(frame.id)).systemPrompt).toContain("30");
  expect(versions).not.toHaveBeenCalled();
  expect(skills).not.toHaveBeenCalled();

  // A staged cut's revision isn't shown the pass's whole diff, so it is never laid out for it.
  const ts = new Date().toISOString();
  app.ctx.repos.changes.put({ id: "chg_staged", projectId: project.id, fromVersion: "ver_gone", toVersion: "ver_gone_too", description: "Dialogue pass",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "ready", renders: [], createdAt: ts, updatedAt: ts } as unknown as Change);
  const lines: string[] = [];
  app.ctx.log = line => lines.push(line);
  const revision = createTask(app.ctx, { projectId: project.id, kind: "revise", agent: "claude", instruction: "Later",
    context: { changeId: "chg_staged", cutIndex: 0, time: 12 }, createdBy: scarlet });
  expect((await prompt(revision.id)).systemPrompt).toContain("Change chg_staged [ready]");
  expect(versions.mock.calls.some(([, version]) => version === "ver_gone" || version === "ver_gone_too")).toBe(false);
  expect(lines.filter(line => line.includes("without its diff"))).toEqual([]);
});

it("launches every request with its harness's own tools, a dialogue pass included, and a side check without", async () => {
  const OUTSIDE = "Scarlet refused {tool}: it reaches outside your task folder. Keep your files in the task folder, and read the project's footage and the video through Scarlet's tools. Carry on.";
  for (const agent of ["gemini", "claude", "codex"] as const) {
    for (const context of [{}, { dialogueOperation: "first-cut" as const }]) {
      const task = createTask(app.ctx, { projectId: project.id, kind: "edit", agent, instruction: "Show the article where I mention it", context, createdBy: scarlet });
      const launched = await api<TaskPrompt>("GET", `/tasks/${task.id}/prompt?workDir=${encodeURIComponent("/work/t/artifacts")}`).then(r => r.body);
      expect([launched.workspace, launched.refusedTool], agent).toEqual([true, OUTSIDE]);
      // The prompt says what the run has, and that B-roll and graphics are the editor's to ask for.
      expect(launched.systemPrompt).toContain("a shell, sandboxed to this task's folder");
      expect(launched.systemPrompt).toContain("B-roll and graphics are made when the editor asked for them, in their words or in a skill of theirs, never on your own initiative.");
    }
  }
  const asker = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "gemini", instruction: "Frame the demo", createdBy: scarlet });
  const aside = await prompt(look(asker, 4).id);
  expect([aside.workspace, aside.refusedTool]).toEqual([undefined,
    "Scarlet refused {tool}: only Scarlet's own tools (the scarlet MCP server) run here, with no shell or file tools. Carry on with the request using Scarlet's tools."]);
  expect(aside.systemPrompt).not.toContain("sandboxed");
});
