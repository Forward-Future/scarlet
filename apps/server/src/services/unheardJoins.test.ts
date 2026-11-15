import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { CLASSES, SAMPLE_RATE } from "../transcribe/ctcAlign.js";
import { EmissionFile } from "../transcribe/emissions.js";
import { proposeChange } from "./changes.js";
import { emissionStore } from "./recordingAudio.js";
import { createTask } from "./tasks.js";

// The verbatim scan of a recording the aligner can't read. Transcription itself is not under test here.
const scan = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("./dialogueDetections.js", async original => {
  const actual = await original<typeof import("./dialogueDetections.js")>();
  return { ...actual, dialogueDetector: (ctx: Parameters<typeof actual.dialogueDetector>[0]) => ({ ...actual.dialogueDetector(ctx), detect: scan.detect }) };
});

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-unheard-joins-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Joins"));
  scan.detect.mockReset().mockResolvedValue({ acoustic: [], segments: [] });
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A 20 s recording, with the language its saved transcript names. */
function recording(id: string, language?: string) {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  writeFileSync(join(ctx.paths.media(project.id), `${id}.wav`), "synthetic source");
  ctx.repos.projects.putMedia(project.id, { id, name: id, path: `${id}.wav`, kind: "audio", hasAudio: true, duration: 20 }, "ready");
  if (language) ctx.repos.transcripts.put({ id: `trs_${id}`, projectId: project.id, mediaId: id, language, segments: [] });
}

/** The English reader's measurements for a recording: room tone throughout. */
async function quietEmissions(id: string) {
  const { ctx } = workspace;
  const file = realpathSync(join(ctx.paths.media(project.id), `${id}.wav`));
  const store = (await EmissionFile.open(await emissionStore(ctx, project.id, file), 20 * SAMPLE_RATE))!;
  try { await store.write(0, new Float32Array(store.frames * CLASSES)); } finally { await store.close(); }
}

function start(task: Task) {
  return workspace.ctx.repos.tasks.put({ ...workspace.ctx.repos.tasks.get(task.id)!, state: "running", startedAt: new Date().toISOString() });
}

function pass(instruction = "/first-cut-dialogue", context: Task["context"] = {}) {
  return start(createTask(workspace.ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction, context, createdBy: { type: "human", name: "Editor" } }));
}

type Part = [clipId: string, mediaId: string, sourceIn: number, sourceOut: number, timelineIn: number];
function assemble(task: Task, parts: Part[]) {
  return proposeChange(workspace.ctx, localUser(workspace.ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: parts.map(([id, mediaId, sourceIn, sourceOut, timelineIn]) => ({ op: "addClip" as const, trackId: "a1", clip: { id, kind: "media" as const, mediaId, sourceIn, sourceOut, timelineIn } })) }).change.toVersion;
}

async function check(task: Task, version: string) {
  const { startedAt } = workspace.ctx.repos.tasks.get(task.id)!;
  const response = await workspace.app.request(`/api/projects/${project.id}/tasks/${task.id}/repeat-audit`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json", "X-Scarlet-Task": task.id, "X-Scarlet-Task-Started-At": startedAt! },
    body: JSON.stringify({ version }) });
  expect(response.status).toBe(200);
  return response.json();
}

async function complete(task: Task, summary: string) {
  const response = await workspace.app.request(`/api/tasks/${task.id}/complete`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json" }, body: JSON.stringify({ state: "done", summary }) });
  return (await response.json()).task as Task;
}

const unheard = (mediaId: string, joins = 1, from = 4, to = from) => ({ mediaId, joins, from, to, reason: expect.stringContaining("letter by letter") });

it("returns a join it couldn't hear in a recording the aligner can't read, and doesn't save the check as clear", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 4, 0], ["two", "voz", 8.3, 15, 4]]);
  // The pass ends, and the engine queues its own audio check of what plays.
  expect((await complete(task, "Took out the middle.")).state).toBe("queued");
  start(task);
  const found = await check(task, version);
  expect(found).toMatchObject({ version, heard: 0, remaining: 0, unheardJoins: [unheard("voz")] });
  expect(found.joins).toBeUndefined();
  expect(found.unavailable).toBeUndefined();
  expect(ctx.repos.tasks.get(task.id)?.repeatAudit).toMatchObject({ version, remaining: 0, noFindings: false });
  // Checking the same version again reports the same joins once.
  expect((await check(task, version)).unheardJoins).toEqual([unheard("voz")]);
  // The pass still finishes, and the check's own words about those joins reach the editor.
  expect(await complete(task, "Scarlet couldn't hear the join at 0:04.")).toMatchObject({ state: "done", summary: "Scarlet couldn't hear the join at 0:04." });
});

it("finds nothing unheard in a single uncut recording in a language the aligner can't read", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 15, 0]]);
  const found = await check(task, version);
  expect(found.unheardJoins).toBeUndefined();
  expect(ctx.repos.tasks.get(task.id)?.repeatAudit).toMatchObject({ noFindings: true });
});

it("lists every unheard join of a recording once, by its time", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 4, 0], ["two", "voz", 8.3, 10, 4], ["three", "voz", 12, 15, 5.7]]);
  expect((await check(task, version)).unheardJoins).toEqual([unheard("voz", 2, 4, 5.7)]);
});

it("places a crossfaded join it couldn't hear where timeline_join_audit finds it, in the middle of the overlap", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  // 0.1 s of overlap: timelineJoins in packages/mcp puts this join at 4.05, and timeline_join_audit matches within 2 ms.
  const version = assemble(task, [["one", "voz", 0, 4.1, 0], ["two", "voz", 8.3, 15, 4]]);
  expect((await check(task, version)).unheardJoins).toEqual([unheard("voz", 1, 4.05)]);
});

it("names only the recording it couldn't hear where a recording in another language meets an English one", async () => {
  // The language comes from the saved transcript here. Settings don't name one, so the English recording is read.
  recording("voz", "spanish");
  recording("mic");
  await quietEmissions("mic");
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 4, 0], ["two", "mic", 2, 10, 4]]);
  const found = await check(task, version);
  expect(found.unheardJoins).toEqual([unheard("voz")]);
  expect(found.unavailable).toBeUndefined();
});

it.each(["auto", "en-US"])("hears every join with the language set to %s", async language => {
  const { ctx } = workspace;
  recording("mic");
  await quietEmissions("mic");
  ctx.repos.settings.update({ transcription: { language } });
  const task = pass();
  const version = assemble(task, [["one", "mic", 0, 4, 0], ["two", "mic", 8.3, 15, 4]]);
  const found = await check(task, version);
  expect(found.unheardJoins).toBeUndefined();
  expect(found.unavailable).toBeUndefined();
  expect(scan.detect).not.toHaveBeenCalled();
  expect(ctx.repos.tasks.get(task.id)?.repeatAudit).toMatchObject({ noFindings: true });
});

it("leaves out a join the selection doesn't reach, or cuts short on one side", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const outside = pass("Tighten this", { time: 1, end: 3 });
  // The second join's first part plays on 0.1 s past where the next one starts.
  const version = assemble(outside, [["one", "voz", 0, 4, 0], ["two", "voz", 8.3, 15, 4], ["three", "voz", 0, 4.1, 20], ["four", "voz", 8.3, 15, 24]]);
  expect((await check(outside, version)).unheardJoins).toBeUndefined();
  expect(ctx.repos.tasks.get(outside.id)?.repeatAudit).toMatchObject({ noFindings: true });
  // A selection that ends inside the overlap cuts the part before the join short: that part ends where the selection does.
  expect((await check(pass("Tighten this", { time: 23, end: 24.05 }), version)).unheardJoins).toBeUndefined();
  // The whole join in the selection is reported.
  expect((await check(pass("Tighten this", { time: 3, end: 5 }), version)).unheardJoins).toEqual([unheard("voz")]);
});

it("leaves a join inside a cut staged for review to the review", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 4, 0], ["two", "voz", 8.3, 15, 4]]);
  const staged = await workspace.app.request(`/api/projects/${project.id}/dialogue-cuts`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json", "X-Scarlet-Task": task.id,
      "X-Scarlet-Task-Started-At": ctx.repos.tasks.get(task.id)!.startedAt! },
    body: JSON.stringify({ taskId: task.id, fromVersion: version, description: "Pass", cuts: [{ start: 3, end: 5, review: true, reason: "may be the better take" }] }) });
  expect(staged.status).toBe(201);
  const head = ctx.repos.projects.header(project.id)!.head!;
  const found = await check(task, head);
  expect(found.unheardJoins).toBeUndefined();
  expect(ctx.repos.tasks.get(task.id)?.repeatAudit).toMatchObject({ noFindings: true });
});

it("still fails the pass when the scan of a recording in another language fails", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  scan.detect.mockRejectedValue(new Error("The scan couldn't run."));
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 4, 0], ["two", "voz", 8.3, 15, 4]]);
  const found = await check(task, version);
  expect(found).toMatchObject({ unavailable: [{ mediaId: "voz", reason: "The scan couldn't run." }] });
  expect(found.unheardJoins).toBeUndefined();
  expect(await complete(task, "Done.")).toMatchObject({ state: "failed", interrupted: true });
});
