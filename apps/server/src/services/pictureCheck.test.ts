import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { proposeChange } from "./changes.js";
import { createTask } from "./tasks.js";

// The verbatim scan of a recording. Transcription itself is not under test here.
const scan = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("./dialogueDetections.js", async original => {
  const actual = await original<typeof import("./dialogueDetections.js")>();
  return { ...actual, dialogueDetector: (ctx: Parameters<typeof actual.dialogueDetector>[0]) => ({ ...actual.dialogueDetector(ctx), detect: scan.detect }) };
});

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-picture-check-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Pictures"));
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

async function check(task: Task, version: string, body: Record<string, unknown> = {}, status = 200) {
  const { startedAt } = workspace.ctx.repos.tasks.get(task.id)!;
  const response = await workspace.app.request(`/api/projects/${project.id}/tasks/${task.id}/repeat-audit`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json", "X-Scarlet-Task": task.id, "X-Scarlet-Task-Started-At": startedAt! },
    body: JSON.stringify({ version, ...body }) });
  expect(response.status).toBe(status);
  return response.json();
}

async function complete(task: Task, summary: string) {
  const response = await workspace.app.request(`/api/tasks/${task.id}/complete`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json" }, body: JSON.stringify({ state: "done", summary }) });
  return (await response.json()).task as Task;
}

// A camera flash between two stretches of screen, and the camera back while the screen still showed what was talked
// about: both were reported on a pass's saves on project 88 and left as they were (2026-11-21). The closing check counts
// them until the pass changes the picture there or keeps them with its reason.
const flash = { id: "picture-brief:cam@506.9", kind: "brief", from: 298, to: 298.45, shows: ["cam-2"], before: ["screen-1"], after: ["screen-2"] };
const off = { id: "picture-off:screen:voz:1017", kind: "offPicture", from: 303.3, to: 316.4, mediaId: "screen", unchanged: true,
  said: "make these one line", reads: [{ from: 303.25, to: 306.13, said: "make these one line and put the disabled ones below the active ones" }] };

it("counts the pictures the check lists until each is kept with its reason", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 15, 0]]);
  const found = await check(task, version, { pictures: { version, findings: [flash, off] } });
  expect(found).toMatchObject({ version, remaining: 2, pictures: [flash, off] });
  expect(ctx.repos.tasks.get(task.id)?.repeatAudit).toMatchObject({ version, remaining: 2, noFindings: false });
  // The pass ends with them outstanding, and goes back for its closing check.
  expect((await complete(task, "Framed the demos.")).state).toBe("queued");
  start(task);
  const kept = await check(task, version, { keep: [{ id: off.id, reason: "He turns to camera to land the point." }], pictures: { version, findings: [flash, off] } });
  expect(kept).toMatchObject({ remaining: 1, pictures: [flash] });
  // A keep holds when the same finding is read again.
  expect(await check(task, version, { pictures: { version, findings: [flash, off] } })).toMatchObject({ remaining: 1, pictures: [flash] });
  // Once the picture there changes, the check no longer lists it, and the pass finishes.
  expect(await check(task, version, { pictures: { version, findings: [off] } })).toMatchObject({ remaining: 0 });
  expect((await complete(task, "Framed the demos.")).state).toBe("done");
});

it("refuses pictures read on another version, and a keep that names none of the findings", async () => {
  const { ctx } = workspace;
  recording("voz");
  ctx.repos.settings.update({ transcription: { language: "es" } });
  const task = pass();
  const version = assemble(task, [["one", "voz", 0, 15, 0]]);
  await check(task, version, { pictures: { version: "elsewhere", findings: [flash] } }, 409);
  await check(task, version, { keep: [{ id: "picture-off:screen:voz:9", reason: "Kept." }], pictures: { version, findings: [flash] } }, 400);
});
