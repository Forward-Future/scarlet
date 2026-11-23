import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Change, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER, type Task, type TaskPrompt } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { appendTaskEvent, createTask, saveTask } from "./tasks.js";
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

/** A head that plays a recording's sound, as a pass's edit does. */
function audibleHead() {
  app.ctx.repos.projects.putMedia(project.id, { id: "cam", name: "Camera", kind: "video", path: "cam.mov", duration: 30 }, "ready");
  const { version } = storeVersion(app.ctx, project.id, timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 20 }]), { parent: null });
  app.ctx.repos.projects.update(project.id, { head: version });
  return version;
}

it("finishes a pass that says it is done as done, with what its repeat check left on record, and sends it back for nothing", async () => {
  const version = audibleHead();
  const task = await dialoguePass();
  // The pass's last check of the video as it plays still lists two findings, and one recording it couldn't read.
  const receipt = { version, remaining: 2, noFindings: false, unavailable: ["Couldn’t check cam: no transcript"], returns: 0 };
  saveTask(app.ctx, { ...get(task.id), state: "running", repeatAudit: receipt });
  const finished = (await api<{ task: Task }>("POST", `/tasks/${task.id}/complete`, { state: "done", summary: "Tightened the dialogue.", ifStartedAt: task.startedAt })).body.task;
  expect(finished).toMatchObject({ state: "done", summary: "Tightened the dialogue.", repeatAudit: receipt });
  expect(finished.error).toBeUndefined();
  expect(finished.interrupted).toBeUndefined();
  // Nothing was queued to check it again: no host is handed the request.
  expect(await claim(task.id)).toBeNull();
  expect(get(task.id).state).toBe("done");
});

it("resumes a stopped pass as an ordinary run, told the recap and never a closing check, and finishes it when it says done", async () => {
  const version = audibleHead();
  const task = await dialoguePass();
  saveTask(app.ctx, { ...get(task.id), state: "running", reply: "Tightened the dialogue.", repeatAudit: { version, remaining: 1, returns: 0 } });
  // Scarlet quit while the pass worked: the attempt that carries on keeps the pass's words and its receipt.
  await quit(get(task.id));
  const resumed = get(get(task.id).retryTaskId!);
  expect(resumed).toMatchObject({ state: "queued", resumeRootId: task.id, reply: "Tightened the dialogue.", repeatAudit: { version, remaining: 1, returns: 0 } });
  await claim(resumed.id);
  const told = await prompt(resumed.id, true);
  expect(told.instruction).toContain("Resume this interrupted request.");
  expect(told.instruction).not.toMatch(/closing check|nothing outstanding/);
  // Said done with the finding still listed, it is done.
  const done = (await api<{ task: Task }>("POST", `/tasks/${resumed.id}/complete`, { state: "done", ifStartedAt: get(resumed.id).startedAt })).body.task;
  expect(done).toMatchObject({ state: "done", repeatAudit: { version, remaining: 1 } });
  expect(await claim(resumed.id)).toBeNull();

  // The editor's own Resume of a pass an earlier engine stopped for findings outstanding is an ordinary run too: the
  // marks of that engine's closing check stay behind, and what the check measured goes on.
  const stopped = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Cut the dialogue tight",
    context: { dialogueOperation: "first-cut" }, createdBy: editor });
  saveTask(app.ctx, { ...get(stopped.id), state: "failed", interrupted: true, finishedAt: new Date().toISOString(), reply: "Tightened the dialogue.",
    error: "The final audio check still has repeats, silences or divided sentences to resolve. Resume to finish checking the saved edit.",
    repeatAudit: { version, remaining: 2, returns: 2, totalReturns: 4, queuedAt: new Date().toISOString() } });
  const again = (await api<{ task: Task }>("POST", `/tasks/${stopped.id}/retry`, {})).body.task;
  expect(again).toMatchObject({ state: "queued", resumeRootId: stopped.id, reply: "Tightened the dialogue.", repeatAudit: { version, remaining: 2, returns: 0 } });
  expect(again.repeatAudit!.totalReturns).toBeUndefined();
  expect(again.repeatAudit!.queuedAt).toBeUndefined();
  await claim(again.id);
  expect((await prompt(again.id)).instruction).toContain("Resume this interrupted request.");

  // A finished pass whose closing check couldn't run under an earlier engine isn't sent back for it.
  const checked = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Cut the dialogue tight",
    context: { dialogueOperation: "first-cut" }, createdBy: editor });
  saveTask(app.ctx, { ...get(checked.id), state: "done", finishedAt: new Date().toISOString(), reply: "Tightened the dialogue.",
    repeatAudit: { version, returns: 1, failed: "unexpected status 401 Unauthorized" } });
  expect((await api("POST", `/tasks/${checked.id}/retry`, {})).status).toBe(409);
  expect(get(checked.id)).toMatchObject({ state: "done" });
  expect(get(checked.id).retryTaskId).toBeUndefined();
});

it("finishes the closing checks an earlier engine left waiting when Scarlet starts, and lets one that asked the editor carry on", async () => {
  const version = "ver_played";
  const earlier = new Date(Date.now() - 60_000).toISOString();
  // Each in a project of its own, so none waits in line behind another.
  const passOfItsOwn = async () => {
    const own = app.ctx.repos.projects.insert(createProject("Closing check"));
    const task = createTask(app.ctx, { projectId: own.id, kind: "edit", agent: "claude", instruction: "Cut the dialogue tight",
      context: { dialogueOperation: "first-cut" }, createdBy: editor });
    return (await claim(task.id))!;
  };
  const sentBack = (over: Partial<Task> = {}) => (task: Task) => saveTask(app.ctx, { ...task, state: "queued", hostId: null, session: undefined, finishedAt: undefined,
    reply: "Tightened the dialogue.", repeatAudit: { version, remaining: 2, returns: 1, totalReturns: 1, queuedAt: new Date().toISOString() }, ...over });
  // Sent back after the pass said done, and not started.
  const waiting = sentBack()(await passOfItsOwn());
  // Sent back, then cut short by a quit while it checked: the attempt that carries on waits in line.
  const cut = sentBack()(await passOfItsOwn());
  await quit((await claim(cut.id))!);
  const carried = get(get(cut.id).retryTaskId!);
  expect(carried).toMatchObject({ state: "queued", repeatAudit: { returns: 1 } });
  // Sent back, and the check asked the editor a question they have answered: it carries on with the answer.
  const answered = sentBack()(await passOfItsOwn());
  const asking = (await claim(answered.id))!;
  await api("POST", `/tasks/${answered.id}/question`, { startedAt: asking.startedAt, text: "Cut the second restart?", sessionId: "check-session" });
  await api("POST", `/tasks/${answered.id}/answer`, { text: "Cut it" });
  // Sent back, and still asking.
  const asked = sentBack()(await passOfItsOwn());
  const asks = (await claim(asked.id))!;
  await api("POST", `/tasks/${asked.id}/question`, { startedAt: asks.startedAt, text: "Keep the cold open?" });
  // Finished, with a closing check that couldn't run.
  const failed = await passOfItsOwn();
  saveTask(app.ctx, { ...get(failed.id), state: "done", startedAt: earlier, finishedAt: new Date().toISOString(), reply: "Saved a tighter cut.",
    repeatAudit: { version, remaining: 1, returns: 1, failed: "unexpected status 401 Unauthorized" } });
  // Another request waiting its turn is no closing check.
  const other = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Add a music bed", createdBy: editor });

  // Scarlet starts again on the same library.
  await app.ctx.close();
  app = createApp({ dataDir, env: {}, log: () => {} });
  for (const id of [waiting.id, carried.id]) {
    expect(get(id)).toMatchObject({ state: "done", reply: "Tightened the dialogue.", repeatAudit: { version, remaining: 2, returns: 1 } });
    expect(get(id).finishedAt).toBeDefined();
  }
  expect(get(answered.id)).toMatchObject({ state: "queued", session: { id: "check-session" } });
  expect(get(asked.id)).toMatchObject({ state: "waiting_for_user", question: "Keep the cold open?" });
  expect(get(failed.id)).toMatchObject({ state: "done", repeatAudit: { version, remaining: 1 } });
  expect(get(failed.id).repeatAudit!.failed).toBeUndefined();
  expect(get(other.id).state).toBe("queued");
  // The answered check resumes its own session with the answer, as any answered run does.
  hostId = (await api<{ host: { id: string } }>("POST", "/hosts/register", { name: "test", platform: "test",
    agents: ["claude", "codex", "gemini"].map(id => ({ id, installed: true })) })).body.host.id;
  await claim(answered.id);
  expect(await prompt(answered.id)).toMatchObject({ resumeSession: "check-session", instruction: 'The editor answered: "Cut it"\nContinue the task with that answer.' });
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

  // A Gemini run carries on in its agy session too.
  await api("POST", `/tasks/${opus.id}/cancel`);
  const gemini = await request("Add captions", "gemini");
  saveTask(app.ctx, { ...get(gemini.id), session: { agent: "gemini", id: "session-4" } });
  await quit(gemini);
  expect(get(gemini.id).sessionCarriesOn).toBe(true);
  expect(get(get(gemini.id).retryTaskId!).session).toEqual({ agent: "gemini", id: "session-4" });
  expect((await prompt(get(gemini.id).retryTaskId!)).resumeSession).toBe("session-4");
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

it("hands off silently when switching models on an answer or on resume-editing, and carries thread Q&A and changes into follow-ups", async () => {
  // 1. Switch model when answering a question: clears old CLI session and gives the new model the structured work recap + Q&A.
  const asking = await request("Tighten the opening and clean up repeats");
  saveTask(app.ctx, { ...get(asking.id), session: { agent: "claude", id: "sess-claude" } });
  const ts = new Date().toISOString();
  app.ctx.repos.changes.put({
    id: "chg_part1", projectId: project.id, taskId: asking.id, threadId: asking.id,
    fromVersion: "ver_0", toVersion: "ver_1", description: "Trimmed opening false start",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "ready", renders: [], createdAt: ts, updatedAt: ts,
  } as unknown as Change);
  appendTaskEvent(app.ctx, get(asking.id), { type: "log", text: "Dialogue scan · cam.mp4", data: { kind: "editor_progress", scanPage: { mediaId: "cam", from: 0, to: 120, end: 300 } } });
  appendTaskEvent(app.ctx, get(asking.id), { type: "log", text: "Trimmed the opening false start.", data: { kind: "editor_progress" } });
  appendTaskEvent(app.ctx, get(asking.id), { type: "question", text: "Should I keep the sigh at 1:12?" });

  const answered = (await api<{ task: Task }>("POST", `/tasks/${asking.id}/answer`, {
    text: "Cut the sigh too.", agent: "codex", model: "gpt-5.4", effort: "high",
  })).body.task;
  expect(answered).toMatchObject({ agent: "codex", model: "gpt-5.4", effort: "high", state: "queued" });
  expect(answered.session).toBeUndefined();

  const handoff = await prompt(asking.id);
  expect(handoff.resumeSession).toBeUndefined();
  expect(handoff.instruction).toContain("Continue this request after the editor’s answer.");
  expect(handoff.instruction).toContain("Trimmed the opening false start.");
  expect(handoff.instruction).toContain("Scanned source seconds on cam: 0–120");
  expect(handoff.instruction).toContain("Saved change chg_part1 [ready]");
  expect(handoff.systemPrompt).toContain("Should I keep the sigh at 1:12?");
  expect(handoff.systemPrompt).toContain("Cut the sigh too.");
  await api("POST", `/tasks/${asking.id}/cancel`);

  // Same-model answer (even with effort change) keeps the CLI session intact.
  const sameModel = await request("Clean up pauses");
  saveTask(app.ctx, { ...get(sameModel.id), model: "opus", session: { agent: "claude", id: "sess-keep" } });
  appendTaskEvent(app.ctx, get(sameModel.id), { type: "question", text: "Tight or natural?" });
  const kept = (await api<{ task: Task }>("POST", `/tasks/${sameModel.id}/answer`, {
    text: "Natural.", agent: "claude", model: "opus", effort: "high",
  })).body.task;
  expect(kept.session).toEqual({ agent: "claude", id: "sess-keep" });
  expect(kept.effort).toBe("high");
  expect((await prompt(sameModel.id)).resumeSession).toBe("sess-keep");
  await api("POST", `/tasks/${sameModel.id}/cancel`);

  // 2. Switch model when resuming paused project editing: updates paused task, clears old session + prior sessionCarriesOn.
  const running = await request("Color match B-cam");
  saveTask(app.ctx, { ...get(running.id), model: "opus", session: { agent: "claude", id: "sess-paused" } });
  await api("POST", `/projects/${project.id}/stop-editing`);
  const pausedId = get(running.id).retryTaskId!;
  expect(get(running.id).sessionCarriesOn).toBe(true);
  expect(get(pausedId).session).toEqual({ agent: "claude", id: "sess-paused" });

  const resumed = (await api<{ tasks: Task[] }>("POST", `/projects/${project.id}/resume-editing`, { agent: "codex", model: "gpt-5.4" })).body.tasks;
  expect(resumed[0]).toMatchObject({ id: pausedId, agent: "codex", model: "gpt-5.4" });
  expect(resumed[0]!.session).toBeUndefined();
  expect(get(running.id).sessionCarriesOn).toBeUndefined();
  expect((await prompt(pausedId)).resumeSession).toBeUndefined();
  await api("POST", `/tasks/${pausedId}/cancel`);

  // 3. Thread follow-up carries prior Q&A decisions, distinct editorial reply, and multiple recent changes across models.
  const first = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", model: "opus", instruction: "Remove dead air", createdBy: scarlet });
  appendTaskEvent(app.ctx, get(first.id), { type: "question", text: "Keep music bed?" });
  appendTaskEvent(app.ctx, get(first.id), { type: "answer", text: "Yes, keep music bed." });
  saveTask(app.ctx, { ...get(first.id), state: "done", summary: "Removed 4 pauses.", reply: "Left breath pauses around the punchline intact.", finishedAt: ts });
  app.ctx.repos.changes.put({
    id: "chg_f0", projectId: project.id, taskId: first.id, threadId: first.id,
    fromVersion: "ver_0", toVersion: "ver_0b", description: "Early draft of opening cut",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "rejected", replacedBy: "chg_f1", renders: [], createdAt: "2026-11-22T00:00:00Z", updatedAt: ts,
  } as unknown as Change);
  app.ctx.repos.changes.put({
    id: "chg_f1", projectId: project.id, taskId: first.id, threadId: first.id,
    fromVersion: "ver_0", toVersion: "ver_1", description: "Cut opening dead air",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "approved", renders: [], createdAt: "2026-11-22T00:00:01Z", updatedAt: ts,
  } as unknown as Change);
  app.ctx.repos.changes.put({
    id: "chg_f2", projectId: project.id, taskId: first.id, threadId: first.id,
    fromVersion: "ver_1", toVersion: "ver_2", description: "Cut mid-roll dead air",
    author: { type: "agent", name: "Claude" }, noteIds: [], timelineEdits: [], ranges: [], state: "ready", renders: [], createdAt: "2026-11-22T00:00:02Z", updatedAt: ts,
  } as unknown as Change);

  const followUp = (await api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, {
    kind: "edit", agent: "codex", model: "gpt-5.4", instruction: "Now tighten the outro too", context: { threadId: first.id },
  })).body.task;
  expect(followUp.instruction).toContain("Asked editor: Keep music bed?");
  expect(followUp.instruction).toContain("Editor answered: Yes, keep music bed.");
  expect(followUp.instruction).toContain("You replied: Removed 4 pauses.");
  expect(followUp.instruction).toContain("Your reply to the editor: Left breath pauses around the punchline intact.");
  expect(followUp.instruction).toContain('Earlier change: "Early draft of opening cut" (replaced by chg_f1, which holds its cuts now; the editor made no decision on it).');
  expect(followUp.instruction).toContain('Earlier change: "Cut opening dead air" (approved).');
  expect(followUp.instruction).toContain('Latest change: "Cut mid-roll dead air" (ready).');
  await api("POST", `/tasks/${followUp.id}/cancel`);

  // 4. Late /question callback from the previous model's host cannot reattach its old session after an answer switches models.
  const raced = createTask(app.ctx, { projectId: project.id, kind: "edit", agent: "claude", model: "opus", instruction: "Trim pauses", createdBy: scarlet });
  const racedStarted = "2026-11-22T01:00:00.000Z";
  saveTask(app.ctx, { ...get(raced.id), state: "running", startedAt: racedStarted });
  // MCP asks first without a sessionId.
  await api("POST", `/tasks/${raced.id}/question`, { startedAt: racedStarted, text: "Keep intro?" });
  expect(get(raced.id).state).toBe("waiting_for_user");
  // Editor rejects api agent, then answers while switching to Codex before Claude's host sends its sessionId.
  expect((await api("POST", `/tasks/${raced.id}/answer`, { text: "Yes", agent: "api" })).status).toBe(400);
  expect((await api("POST", `/tasks/${raced.id}/answer`, { text: "Yes", agent: "codex", model: "gpt-5.4" })).status).toBe(200);
  expect(get(raced.id)).toMatchObject({ state: "queued", agent: "codex", model: "gpt-5.4" });
  expect(get(raced.id).session).toBeUndefined();
  // Claude's host finishes and posts its sessionId with the old startedAt; it must not be attached to Codex.
  await api("POST", `/tasks/${raced.id}/question`, { startedAt: racedStarted, text: "Keep intro?", sessionId: "claude-stale-sess" });
  expect(get(raced.id).session).toBeUndefined();
  expect((await prompt(raced.id)).resumeSession).toBeUndefined();
  await api("POST", `/tasks/${raced.id}/cancel`);

  // 5. Resuming a paused project rejects agent "api" without unpausing editing.
  await api("POST", `/projects/${project.id}/stop-editing`);
  expect((await api("POST", `/projects/${project.id}/resume-editing`, { agent: "api" })).status).toBe(400);
  expect(app.ctx.repos.projects.header(project.id)!.editingPaused).toBe(true);
  expect((await api("POST", `/projects/${project.id}/resume-editing`, {})).status).toBe(200);
});
