import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipEnd, createProject, type Change, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken, localUser } from "./auth.js";
import { approveChange, proposeChange } from "./services/changes.js";
import { createTask } from "./services/tasks.js";
import { ATTEMPT_HEADER, TASK_HEADER, type Task } from "@scarlet/shared";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-ai-boundary-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Boundary"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function api(method: string, path: string, body?: unknown, attempt?: Pick<Task, "id" | "startedAt">) {
  const headers = new Headers({ Authorization: `Bearer ${accessToken(workspace.ctx)}` });
  if (attempt) {
    headers.set(TASK_HEADER, attempt.id);
    if (attempt.startedAt) headers.set(ATTEMPT_HEADER, attempt.startedAt);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return workspace.app.request("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** A requested dialogue task on a 20 s recording, assembled on the timeline. */
function dialogueTask() {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const queued = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue",
    createdBy: { type: "human", name: "Editor" } });
  const task = ctx.repos.tasks.put({ ...queued, state: "claimed", startedAt: new Date().toISOString() });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  return { task, base };
}

it("stores the dialogue settings with defaults and merges partial updates", async () => {
  const initial = (await (await api("GET", "/settings")).json()).settings;
  expect(initial.dialogue).toEqual({ aiCuts: { pause: "cut", filler: "cut", retake: "cut", coaching: "cut" }, pauseTightness: "natural", crossfadeFrames: 2 });
  const patched = await (await api("PATCH", "/settings", { dialogue: { aiCuts: { filler: "suggest" } } })).json();
  expect(patched.settings.dialogue).toEqual({ aiCuts: { pause: "cut", filler: "suggest", retake: "cut", coaching: "cut" }, pauseTightness: "natural", crossfadeFrames: 2 });
  const tight = await (await api("PATCH", "/settings", { dialogue: { pauseTightness: "tight" } })).json();
  expect(tight.settings.dialogue.aiCuts.filler).toBe("suggest");
  expect(tight.settings.dialogue.pauseTightness).toBe("tight");
  expect((await api("PATCH", "/settings", { dialogue: { aiCuts: { filler: "maybe" } } })).status).toBe(400);
  const off = await (await api("PATCH", "/settings", { dialogue: { crossfadeFrames: 0 } })).json();
  expect(off.settings.dialogue).toMatchObject({ crossfadeFrames: 0, pauseTightness: "tight" });
  expect((await api("PATCH", "/settings", { dialogue: { crossfadeFrames: 1.5 } })).status).toBe(400);
});

it("stages Suggest kinds for the editor, drops Off kinds, and reports both", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ dialogue: { aiCuts: { filler: "suggest", pause: "off" } } });
  const { task, base } = dialogueTask();
  const submitted = await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Tighten the opening", cuts: [
    { start: 1, end: 3, review: false, reason: "Restarted line.", kind: "retake" },
    { start: 5, end: 5.4, review: false, reason: "An um.", kind: "filler" },
    { start: 8, end: 9, review: false, reason: "Long pause.", kind: "pause" },
    { start: 12, end: 13, review: false, reason: "Direction to the camera.", kind: "coaching" },
  ] }, task);
  expect(submitted.status).toBe(201);
  const { changes, editorPreferences } = await submitted.json() as { changes: Change[]; editorPreferences: unknown[] };
  expect(editorPreferences).toEqual([
    { index: 1, kind: "filler", level: "suggest", outcome: "review", start: 5, end: 5.4 },
    { index: 2, kind: "pause", level: "off", outcome: "dropped", start: 8, end: 9 },
  ]);
  expect(changes.map(c => c.state)).toEqual(["approved", "ready"]);
  // The agent's sentence covered cuts the editor kept, so each part gets its own receipt.
  expect(changes[0]!.description).toBe("Removed 3 s across 2 cuts.");
  const applied = ctx.repos.changes.get(changes[0]!.id)!;
  expect(applied.cutReasons).toEqual([{ start: 1, end: 3, reason: "Restarted line.", kind: "retake" }, { start: 12, end: 13, reason: "Direction to the camera.", kind: "coaching" }]);
  const staged = ctx.repos.changes.get(changes[1]!.id)!;
  // On the kept version the filler sits 2 s earlier. The pause is still in the edit.
  expect(staged.cutReasons).toEqual([{ start: 3, end: expect.closeTo(3.4), reason: "An um.", kind: "filler" }]);
  // Only the retake and the direction came out of the working timeline.
  const kept = (await (await api("GET", `/projects/${project.id}/timeline?version=${applied.toVersion}`)).json()).timeline;
  expect(kept.tracks.flatMap((t: { clips: unknown[] }) => t.clips)).toHaveLength(3);

  // A second-pass cut verdict on a Suggest kind still waits for the editor.
  const assess = await api("POST", `/changes/${staged.id}/cut-assessments`, { fromVersion: staged.fromVersion, toVersion: staged.toVersion,
    assessments: [{ index: 0, start: 3, end: staged.cutReasons![0]!.end, verdict: "cut", inspected: true, reason: "Clean filler." }] });
  expect(assess.status).toBe(200);
  expect(await assess.json()).toMatchObject({ total: 1, assessed: 1, needsDecision: 1, heldForEditor: [0] });
  expect(ctx.repos.changes.get(staged.id)!.cutAssessments).toMatchObject([{ index: 0, verdict: "ask", reason: "Clean filler." }]);
});

it("applies dialogue preferences to generic removals, clip trims and replacement timelines before saving a version", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  ctx.repos.settings.update({ dialogue: { aiCuts: { filler: "off" } } });
  const url = `/projects/${project.id}`;
  const timeline = (await (await api("GET", url + "/timeline")).json()).timeline;
  const trimmed = structuredClone(timeline);
  trimmed.tracks.find((t: { id: string }) => t.id === "a1").clips[0].sourceIn = 1;
  const versions = ctx.repos.versions.links(project.id).length;
  for (const proposal of [
    { ops: [{ op: "rippleDelete", start: 0, end: 1 }] },
    { ops: [{ op: "updateClip", clipId: "raw", patch: { sourceIn: 1 } }] },
    { timeline: trimmed },
    { timeline: trimmed, firstCut: true },
    { timeline: trimmed, nonDialogueRemoval: true }, // A full dialogue pass must classify its dialogue removals.
  ]) {
    const response = await api("POST", url + "/changes", { ...proposal, description: "Shorter", intent: "requested", fromVersion: base }, task);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "dialogue_kind_required" } });
  }
  const missingKind = await api("POST", url + "/dialogue-cuts", { fromVersion: base, description: "A cut",
    cuts: [{ start: 1, end: 2, review: false, reason: "A removal" }] }, task);
  expect(missingKind.status).toBe(400);
  expect(ctx.repos.versions.links(project.id)).toHaveLength(versions);
  expect(ctx.repos.projects.get(project.id)?.head).toBe(base);

  // Direct editor changes and an explicit story edit retain their ordinary timeline operations.
  const ops = [{ op: "rippleDelete", start: 1, end: 2 }];
  const direct = await api("POST", url + "/changes", { fromVersion: base, description: "Manual removal", ops, skipRender: true });
  expect(direct.status).toBe(201);
  const story = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Remove the opening scene",
    createdBy: { type: "human", name: "Editor" } });
  const attempt = ctx.repos.tasks.put({ ...story, state: "running", startedAt: new Date().toISOString() });
  expect((await api("POST", url + "/changes", { fromVersion: base, description: "Opening scene", ops, nonDialogueRemoval: true, intent: "requested" }, attempt)).status).toBe(201);
});

it("saves bounded ripple operations on the frames inside the selection, including its shortened end", async () => {
  const { ctx } = workspace;
  const { base } = dialogueTask();
  const range = { start: 1.0005, end: 3.9995 };
  const edit = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Tighten this passage.",
    context: { time: range.start, end: range.end, version: base }, createdBy: { type: "human", name: "Editor" } });
  const task = ctx.repos.tasks.put({ ...edit, state: "running", startedAt: new Date().toISOString() });
  const send = (start: number, end: number) => api("POST", `/projects/${project.id}/changes`, { fromVersion: base,
    intent: "suggestion", description: "Tighten this passage.", ops: [
      { op: "rippleDelete", start: range.start, end: 2 }, { op: "rippleDelete", start, end },
    ] }, task);
  const saved = await send(2.5, 3.0328);
  expect(saved.status).toBe(201);
  expect((await saved.json()).change.ops).toEqual([
    { op: "rippleDelete", start: 31 / 30, end: 2 }, { op: "rippleDelete", start: 2.5, end: 3 },
  ]);
  const outside = await send(2.5, 3.04);
  expect(outside.status).toBe(400);
  expect((await outside.json()).error.code).toBe("cut_scope");
});

it("crossfades each join it applies or stages, keeps the cut where a join can't take one, and fades a join again once its call is made", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const queued = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue",
    createdBy: { type: "human", name: "Editor" } });
  const task = ctx.repos.tasks.put({ ...queued, state: "claimed", startedAt: new Date().toISOString() });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  // Three takes on A1: the second has a fade in the editor put on, and the second and third start where the recording does.
  const clip = (id: string, sourceIn: number, sourceOut: number, timelineIn: number, extra = {}) =>
    ({ op: "addClip", trackId: "a1", clip: { id, kind: "media", mediaId: "mic", timelineIn, sourceIn, sourceOut, ...extra } });
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [clip("a", 10, 16, 0), clip("b", 0, 6, 6, { audioFadeIn: 0.2 }), clip("c", 0, 8, 12)] }).change.toVersion;
  const submitted = await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Tighten", cuts: [
    { start: 2, end: 3, review: false, reason: "Inside a take." },
    { start: 5, end: 6, review: false, reason: "Into the faded take." },
    { start: 11, end: 12, review: false, reason: "Onto a take with nothing recorded before it." },
    { start: 14, end: 15, review: false, reason: "Beside a staged cut." },
    { start: 15, end: 16, review: true, reason: "Maybe." },
    { start: 18, end: 19, review: true, reason: "Maybe too." },
  ] }, task);
  expect(submitted.status).toBe(201);
  const body = await submitted.json() as { changes: Change[]; joinCrossfades: unknown };
  const [applied, staged] = body.changes.map(c => ctx.repos.changes.get(c.id)!);
  // 2 frames at 30 fps: each side reaches a frame into its handle.
  const half = 1 / 30;
  expect(body.joinCrossfades).toEqual({ frames: 2, faded: 3, plain: [
    { version: applied!.toVersion, at: 4, reason: "already has a fade" },
    { version: applied!.toVersion, at: 9, reason: "not enough recorded sound past the cut for the crossfade" },
    { version: applied!.toVersion, at: 11, reason: "meets a cut waiting for review; it gets the crossfade once that cut is decided" },
  ] });
  // The ops are still the removals the plan asked for. The timeline has the fades on top.
  expect(applied!.ops!.every(op => op.op === "rippleDelete")).toBe(true);
  const clips = (version: string) => ctx.repos.versions.get(project.id, version)!.timeline.tracks.find(t => t.id === "a1")!.clips;
  expect(clips(applied!.toVersion)).toMatchObject([
    { timelineIn: 0, sourceIn: 10, sourceOut: expect.closeTo(12 + half), audioFadeOut: expect.closeTo(2 * half) },
    { timelineIn: expect.closeTo(2 - half), sourceIn: expect.closeTo(13 - half), sourceOut: 15, audioFadeIn: expect.closeTo(2 * half) },
    // The plain joins keep their edges and the editor's own fade.
    { timelineIn: 4, sourceIn: 0, sourceOut: 5, audioFadeIn: 0.2 },
    { timelineIn: 9, sourceIn: 0, audioFadeIn: 0, audioFadeOut: 0 },
    { timelineIn: 11, sourceIn: 3, audioFadeIn: 0 },
  ]);
  // Review plays the staged cuts with their crossfades, as approving them would keep them.
  expect(staged!.ops!.every(op => op.op === "rippleDelete")).toBe(true);
  expect(staged!.joinFades!.fades.map(f => f.at)).toEqual([11, 13]);

  // The editor keeps the first staged cut's footage: the join it held back is faded now, with the other cut's.
  const approval = approveChange(ctx, localUser(ctx), staged!, { restoredCuts: [0] });
  expect(approval.change.state).toBe("approved");
  expect(approval.change.appliedJoinFades!.fades.map(f => f.at)).toEqual([11, 14]);
  const after = clips(approval.change.appliedVersion!);
  expect(after.find(c => c.kind === "media" && c.audioFadeOut && Math.abs(clipEnd(c) - (11 + half)) < 1e-6)).toBeTruthy();
});

it("leaves every join a straight cut when the editor turned the crossfade off", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ dialogue: { crossfadeFrames: 0 } });
  const { task, base } = dialogueTask();
  const submitted = await (await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Tighten",
    cuts: [{ start: 2, end: 3, review: false, reason: "Restart." }] }, task)).json() as { changes: Change[]; joinCrossfades: unknown };
  expect(submitted.joinCrossfades).toEqual({ frames: 0, faded: 0, plain: [] });
  const applied = ctx.repos.changes.get(submitted.changes[0]!.id)!;
  expect(applied.joinFades).toBeUndefined();
  expect(ctx.repos.versions.get(project.id, applied.toVersion)!.timeline.tracks.find(t => t.id === "a1")!.clips)
    .toMatchObject([{ sourceOut: 2, audioFadeOut: 0 }, { timelineIn: 2, sourceIn: 3, audioFadeIn: 0 }]);
});

it("proposes nothing when the editor turned off every kind in the plan", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ dialogue: { aiCuts: { pause: "off" } } });
  const { task, base } = dialogueTask();
  const before = ctx.repos.changes.select("project_id = ?", [project.id]).length;
  const submitted = await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Pauses", cuts: [
    { start: 2, end: 3, review: false, reason: "Pause.", kind: "pause" }, { start: 6, end: 7, review: true, reason: "Pause?", kind: "pause" }] }, task);
  expect(submitted.status).toBe(201);
  expect(await submitted.json()).toEqual({ changes: [], editorPreferences: [
    { index: 0, kind: "pause", level: "off", outcome: "dropped", start: 2, end: 3 },
    { index: 1, kind: "pause", level: "off", outcome: "dropped", start: 6, end: 7 }], head: base });
  expect(ctx.repos.changes.select("project_id = ?", [project.id])).toHaveLength(before);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
});

it("accepts edits only from the current claim before, during and after an editor question", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const path = `/projects/${project.id}`;
  const proposal = { taskId: task.id, description: "Opening marker", intent: "requested", ops: [
    { op: "addMarker", marker: { id: "marker", time: 0, text: "Opening" } }] };
  const cuts = { taskId: task.id, fromVersion: base, description: "First cut", cuts: [
    { start: 2, end: 3, review: true, reason: "Repeat." }] };
  expect((await api("POST", path + "/changes", proposal)).status).toBe(409);
  const submitted = await api("POST", path + "/dialogue-cuts", cuts, task);
  expect(submitted.status).toBe(201);
  const staged = (await submitted.json()).changes[0] as Change;
  const { note } = await (await api("POST", path + "/notes", { time: 0, text: "Opening note." })).json();
  const paused = await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Which take?" });
  expect(await paused.json()).toEqual({ waiting: true });
  const count = ctx.repos.changes.select("project_id = ?", [project.id]).length;
  const assertFenced = async () => {
    expect((await api("POST", path + "/changes", proposal, task)).status).toBe(409);
    expect((await api("POST", path + "/dialogue-cuts", cuts, task)).status).toBe(409);
    expect((await api("POST", `/changes/${staged.id}/staged-cuts/0`, { start: 1.8, end: 3, reason: "Move the cut.", taskId: task.id }, task)).status).toBe(409);
    expect((await api("POST", `/changes/${staged.id}/cut-assessments`, { fromVersion: staged.fromVersion, toVersion: staged.toVersion,
      assessments: [{ index: 0, start: 2, end: 3, verdict: "cut", reason: "Checked." }] }, task)).status).toBe(409);
    expect((await api("POST", `/tasks/${task.id}/events`, { type: "log", text: "Old run event" }, task)).status).toBe(409);
    expect((await api("PATCH", `/notes/${note.id}`, { state: "resolved" }, task)).status).toBe(409);
    expect((await api("POST", `/notes/${note.id}/reply`, { text: "Old reply." }, task)).status).toBe(409);
    expect((await api("POST", path + "/renders", { version: base, kind: "segment", range: { start: 0, end: 1 }, quality: "preview" }, task)).status).toBe(409);
    expect((await api("POST", path + "/media", undefined, task)).status).toBe(409);
    expect((await api("GET", path + `/versions/${base}/export.otio`, undefined, task)).status).toBe(409);
    expect(ctx.repos.changes.select("project_id = ?", [project.id])).toHaveLength(count);
    expect(ctx.repos.projects.header(project.id)?.head).toBe(base);
    expect(ctx.repos.changes.get(staged.id)?.cutAssessments).toBeUndefined();
    expect(ctx.repos.notes.get(note.id)?.state).toBe("open");
    expect(ctx.repos.notes.get(note.id)?.replies ?? []).toEqual([]);
  };
  await assertFenced();
  expect((await api("POST", `/tasks/${task.id}/answer`, { text: "The first." })).status).toBe(200);
  await assertFenced();
  const { host } = await (await api("POST", "/hosts/register", { name: "Fixture", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  const next = (await (await api("POST", `/hosts/${host.id}/claim`, { taskId: task.id })).json()).task as Task;
  expect(next.startedAt).not.toBe(task.startedAt);
  await assertFenced();
  expect((await api("POST", path + "/changes", proposal, next)).status).toBe(201);
});

it("keeps a selected-cut request within its review slot at each engine write entry", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const path = `/projects/${project.id}`;
  const plan = { fromVersion: base, description: "Dialogue choices", cuts: [
    { start: 2, end: 3, review: true, reason: "Repeat." }, { start: 7, end: 8, review: true, reason: "Later take." }] };
  const original = (await (await api("POST", path + "/dialogue-cuts", plan, task)).json()).changes[0] as Change;
  const queued = (await (await api("POST", `/changes/${original.id}/revise`, { text: "Include the first word.",
    position: { version: base, time: 2, end: 3, clipIds: [], cutIndex: 0 } })).json()).task as Task;
  const revision = ctx.repos.tasks.put({ ...queued, state: "running", startedAt: new Date().toISOString() });
  const move = (id: string, index: number, start: number, end: number) => api("POST", `/changes/${id}/staged-cuts/${index}`,
    { start, end, reason: "Include the first word." }, revision);
  const before = ctx.repos.changes.select("project_id = ?", [project.id]).length;
  const generic = await api("POST", path + "/changes", { description: "New marker", intent: "requested",
    ops: [{ op: "addMarker", marker: { id: "unrelated", time: 12, text: "Elsewhere" } }] }, revision);
  expect(generic.status).toBe(400);
  expect((await api("POST", path + "/dialogue-cuts", plan, revision)).status).toBe(400);
  const assessment = await api("POST", `/changes/${original.id}/cut-assessments`, { fromVersion: original.fromVersion, toVersion: original.toVersion,
    assessments: [{ index: 1, start: 7, end: 8, verdict: "cut", reason: "Later take." }] }, revision);
  expect((await assessment.json()).error.code).toBe("wrong_cut");
  expect((await move(original.id, 1, 6.9, 8)).status).toBe(400);
  expect((await move(original.id, 0, 4, 5)).status).toBe(400);
  expect(ctx.repos.changes.select("project_id = ?", [project.id])).toHaveLength(before);
  const valid = await move(original.id, 0, 1.8, 3);
  expect(valid.status).toBe(201);
  const successor = (await valid.json()).change as Change;
  expect(successor.cutReasons).toMatchObject([{ start: 1.8, end: 3 }, { start: 7, end: 8 }]);
  expect((await move(successor.id, 1, 6.9, 8)).status).toBe(400);
  expect((await move(successor.id, 0, 1.4, 1.9)).status).toBe(400);
  expect(ctx.repos.projects.header(project.id)?.head).toBe(base);
});

it("keeps ordinary timeline edits available when the editor selected an already applied cut", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const path = `/projects/${project.id}`;
  const submitted = await api("POST", path + "/dialogue-cuts", { fromVersion: base, description: "Dialogue choice",
    cuts: [{ start: 2, end: 3, review: true, reason: "Repeat." }] }, task);
  const change = (await submitted.json()).changes[0] as Change;
  expect((await api("POST", `/changes/${change.id}/approve`, { restoredCuts: [] })).status).toBe(200);
  const edit = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Add a marker here.",
    context: { changeId: change.id, cutIndex: 0 }, createdBy: task.createdBy });
  expect(edit.stagedCutRevision).toBe(false);
  const active = ctx.repos.tasks.put({ ...edit, state: "claimed", startedAt: new Date().toISOString() });
  const marker = (id: string) => ({ description: "Opening marker", intent: "requested", ops: [
    { op: "addMarker", marker: { id, time: 2, text: "Opening" } }] });
  expect((await api("POST", path + "/changes", marker("first"), active)).status).toBe(201);
  // A pre-upgrade task has no snapshot. A later metadata write still leaves the earlier approval in its history.
  ctx.repos.tasks.put({ ...ctx.repos.tasks.get(active.id)!, stagedCutRevision: undefined });
  ctx.repos.changes.put({ ...ctx.repos.changes.get(change.id)!, updatedAt: new Date().toISOString() });
  expect((await api("POST", path + "/changes", marker("second"), active)).status).toBe(201);
});

it("discards an uploaded task artifact if the claim pauses while its media is being probed", async () => {
  const { ctx } = workspace;
  const { task } = dialogueTask();
  let probed!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { probed = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(ctx.render, "probeMedia").mockImplementation(async () => {
    probed();
    await finish;
    return { kind: "image", duration: 0, hasAudio: false };
  });
  const form = new FormData();
  form.append("file", new Blob(["a synthetic fixture"]), "card.png");
  const upload = workspace.app.request(`/api/projects/${project.id}/media`, { method: "POST", body: form,
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: task.startedAt! } });
  try {
    await started;
    await api("POST", `/tasks/${task.id}/question`, { startedAt: task.startedAt, text: "Which card?" });
  } finally { release(); }
  expect((await upload).status).toBe(409);
  expect(ctx.repos.projects.get(project.id)?.media.map(m => m.id)).toEqual(["mic"]);
  expect(readdirSync(ctx.paths.media(project.id))).toEqual([]);
});

it("lists other attempts at a line near a staged cut", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  const line = (text: string, start: number) => {
    const words = text.split(" ").map((w, i) => ({ text: w, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
    return { id: "s" + start, text, start, end: words.at(-1)!.end, words };
  };
  ctx.repos.transcripts.put({ id: "tr_mic", projectId: project.id, mediaId: "mic", segments: [
    line("So today we are going to edit.", 1), line("So today we are going to edit a video.", 6), line("Thanks for watching everyone here.", 30)] });
  const near = await (await api("GET", `/projects/${project.id}/media/mic/retakes?from=1&to=3`)).json();
  expect(near.mediaId).toBe("mic");
  expect(near.groups).toHaveLength(1);
  expect(near.groups[0].takes.map((t: { start: number; text: string }) => [t.start, t.text])).toEqual([
    [1, "So today we are going to edit."], [6, "So today we are going to edit a video."]]);
  expect((await (await api("GET", `/projects/${project.id}/media/mic/retakes?from=30&to=32`)).json()).groups).toEqual([]);
  expect((await api("GET", `/projects/${project.id}/media/mic/retakes?from=3&to=1`)).status).toBe(400);
  expect((await api("GET", `/projects/${project.id}/media/other/retakes?from=1&to=3`)).status).toBe(404);
});


it("enforces the selected footage across mixed ripples, individual tracks, clip trims and replacement timelines", async () => {
  const { ctx } = workspace;
  const { base } = dialogueTask();
  const url = `/projects/${project.id}`;
  const timeline = ctx.repos.versions.get(project.id, base)!.timeline;
  const marker = { op: "addMarker", marker: { id: "note", time: 1, kind: "note", text: "Here" } };
  const task = (context: Task["context"]) => {
    const queued = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Trim this passage.",
      context, createdBy: { type: "human", name: "Editor" } });
    return ctx.repos.tasks.put({ ...queued, state: "running", startedAt: new Date().toISOString() });
  };
  const selected = task({ version: base, time: 0, end: 3 });
  const submit = (edit: Task, proposal: object) => api("POST", url + "/changes", { fromVersion: base,
    intent: "suggestion", description: "Trim", ...proposal }, edit);
  const replacement = (start: number, end: number) => {
    const next = structuredClone(timeline);
    const clip = next.tracks.find(t => t.id === "a1")!.clips[0]!;
    if (clip.kind !== "media") throw new Error("expected recording");
    clip.sourceIn = start;
    clip.sourceOut = end;
    return next;
  };
  for (const proposal of [
    { ops: [marker, { op: "rippleDelete", start: 5, end: 6 }] },
    { ops: [{ op: "rippleDelete", start: 6, end: 8, trackIds: ["a1"] }] },
    { ops: [{ op: "rippleDelete", start: 6, end: 8, trackIds: ["v1"] }, marker] }, // Empty track.
    { ops: [{ op: "rippleDelete", start: 1, end: 2, trackIds: ["a1"] }, marker,
      { op: "rippleDelete", start: 1.5, end: 2.5, trackIds: ["a1"] }] }, // This track's selection now ends at 2.

    { ops: [{ op: "updateClip", clipId: "raw", patch: { sourceOut: 18 } }] },
    { timeline: replacement(0, 18) },
  ]) {
    const refused = await submit(selected, proposal);
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect((await refused.json()).error.code).toBe("cut_scope");
  }
  for (const proposal of [
    { ops: [marker, { op: "rippleDelete", start: 1, end: 2 }] },
    { ops: [{ op: "rippleDelete", start: 1, end: 2, trackIds: ["a1"] }] },
    { ops: [{ op: "updateClip", clipId: "raw", patch: { sourceIn: 2 } }] },
    { timeline: replacement(2, 20) },
  ]) {
    const saved = await submit(selected, proposal);
    expect(saved.status, await saved.clone().text()).toBe(201);
  }
  // A source selection also covers its second, sped-up placement. Keeping the first playing does not
  // justify trimming an unselected part of the second one.
  const reused = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Repeat",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "again", kind: "media", timelineIn: 20, mediaId: "mic", sourceIn: 4, sourceOut: 10, speed: 2 } }] }).change.toVersion;
  const source = task({ version: reused, mediaId: "mic", time: 5, end: 7 });
  const cutCopy = (start: number, end: number) => api("POST", url + "/changes", { fromVersion: reused, intent: "suggestion", description: "Trim the copy",
    ops: [marker, { op: "rippleDelete", start, end, trackIds: ["a1"] }] }, source);
  expect((await cutCopy(20.5, 21)).status).toBe(201);
  const elsewhere = await cutCopy(22, 22.5);
  expect(elsewhere.status, await elsewhere.clone().text()).toBe(400);

  // The interval beside an applied edit is context for a follow-up, and can legitimately be extended.
  const edit = task({ version: base, time: 0, end: 3, changeId: "prior", editIndex: 0 });
  expect((await submit(edit, { ops: [marker, { op: "rippleDelete", start: 5, end: 6 }] })).status).toBe(201);
  expect(ctx.repos.projects.get(project.id)?.head).toBe(reused);
});
