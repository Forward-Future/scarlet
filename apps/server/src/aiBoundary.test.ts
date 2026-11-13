import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipEnd, createProject, type Change, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken, localUser } from "./auth.js";
import { approveChange, proposeChange } from "./services/changes.js";
import { createTask } from "./services/tasks.js";
import { migrateDialogueSettings } from "./services/migrateDialogueSettings.js";
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

it("directs old dialogue settings writes to the editable skill", async () => {
  const initial = (await (await api("GET", "/settings")).json()).settings;
  expect(initial).not.toHaveProperty("dialogue");
  const response = await api("PATCH", "/settings", { dialogue: { aiCuts: { filler: "suggest" } } });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatchObject({ code: "dialogue_settings_moved" });
});

it("applies and stages the model’s choices with an empty skill library", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const submitted = await api("POST", `/projects/${project.id}/dialogue-cuts`, { fromVersion: base, description: "Tighten the opening",
    kept: [{ start: 8, end: 9 }], cuts: [
      { start: 1, end: 3, review: false, reason: "Restarted line.", kind: "retake" },
      { start: 5, end: 5.4, review: true, reason: "An um.", kind: "filler" },
      { start: 12, end: 13, review: false, reason: "Direction to the camera.", kind: "coaching" },
    ] }, task);
  expect(submitted.status).toBe(201);
  const { changes } = await submitted.json() as { changes: Change[] };
  expect(changes.map(c => c.state)).toEqual(["approved", "ready"]);
  const applied = ctx.repos.changes.get(changes[0]!.id)!;
  expect(applied.cutReasons).toEqual([{ start: 1, end: 3, reason: "Restarted line.", kind: "retake" },
    { start: 12, end: 13, reason: "Direction to the camera.", kind: "coaching" }]);
  const staged = ctx.repos.changes.get(changes[1]!.id)!;
  expect(staged.cutReasons).toEqual([{ start: 3, end: expect.closeTo(3.4), reason: "An um.", kind: "filler" }]);
  const check = await api("POST", `/changes/${staged.id}/cut-assessments`, { fromVersion: staged.fromVersion, toVersion: staged.toVersion,
    assessments: [{ index: 0, start: 3, end: staged.cutReasons![0]!.end, verdict: "ask", inspected: true, reason: "Keep the hesitation?" }] });
  expect(await check.json()).toMatchObject({ total: 1, assessed: 1, needsDecision: 1 });
});

it("carries a pre-upgrade request to review fillers until its assessment, without changing the editor's other calls", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const submit = async (cuts: object[]) => {
    const response = await api("POST", `/projects/${project.id}/dialogue-cuts`, { fromVersion: base, description: "Tighten", cuts }, task);
    expect(response.status, await response.clone().text()).toBe(201);
    return ctx.repos.changes.get((await response.json()).changes[0].id)!;
  };
  const cut = (start: number, kind: string, review = true) => ({ start, end: start + 1, kind, review, reason: `Cut at ${start}.` });
  const original = await submit([cut(1, "retake"), cut(2, "filler"), cut(5, "filler"), cut(8, "pause")]);
  const placeholder = { index: 0, start: 1, end: 3, verdict: "ask" as const, reason: "A cut to check.", provisional: true as const };
  ctx.repos.changes.put({ ...original, cutAssessments: [placeholder], cutChoices: [{ index: 1, start: 5, end: 6, choice: "keep" }] });
  ctx.db.prepare("INSERT OR REPLACE INTO settings (id, json) VALUES (1, ?)").run(JSON.stringify({ dialogue: { aiCuts: { filler: "suggest" } } }));
  migrateDialogueSettings(ctx);
  const migrated = ctx.repos.changes.get(original.id)!;
  expect(migrated.cutReasons?.map(c => c.legacySuggest)).toEqual([undefined, true, undefined, undefined]);
  expect(migrated.cutAssessments).toEqual([placeholder]);
  // A later batch cannot promote the older pending cut to a confident removal.
  const carried = await submit([cut(2, "filler", false), cut(12, "retake")]);
  expect(ctx.repos.projects.get(project.id)?.head).toBe(base);
  expect(carried.cutChoices).toEqual(migrated.cutChoices);
  expect(carried.cutReasons?.[1]?.legacySuggest).toBe(true);
  const decision = await api("POST", `/changes/${carried.id}/cut-assessments`, { fromVersion: carried.fromVersion, toVersion: carried.toVersion,
    assessments: [{ index: 0, start: 1, end: 3, verdict: "cut", reason: "A clean filler cut." },
      { index: 2, start: 8, end: 9, verdict: "cut", reason: "Tighten the gap." }] });
  expect(await decision.json()).toMatchObject({ heldForEditor: [0] });
  expect(ctx.repos.changes.get(carried.id)?.cutAssessments).toMatchObject([{ verdict: "ask" }, { verdict: "cut" }]);
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
  // The second op is written on the edit as the first one asked to leave it, where the selection now ends at 3 s. The
  // first came out a little short on whole frames (0.9667 s of 0.9995 s), so the second moves later by the difference
  // before it goes onto frames, and still ends inside the shortened selection.
  const saved = await send(2.5, 3);
  expect(saved.status).toBe(201);
  const [first, second] = (await saved.json()).change.ops;
  expect(first).toEqual({ op: "rippleDelete", start: 31 / 30, end: 2 });
  expect(second).toMatchObject({ op: "rippleDelete", start: expect.closeTo(76 / 30, 9), end: expect.closeTo(3, 9) });
  const outside = await send(2.5, 3.01);
  expect(outside.status).toBe(400);
  expect((await outside.json()).error.code).toBe("cut_scope");
});

it("crossfades each join it applies or stages, keeps the cut where a join can't take one, and preserves applied fades when a staged cut is skipped", async () => {
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
  const submitted = await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Tighten", crossfadeFrames: 2, cuts: [
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
  expect(body.joinCrossfades).toEqual({ frames: 2, faded: 4, plain: [
    { version: applied!.toVersion, at: 4, reason: "already has a fade" },
    { version: applied!.toVersion, at: 9, reason: "not enough recorded sound past the cut for the crossfade" },
  ] });
  // The ops are still the removals the plan asked for. The timeline has the fades on top.
  expect(applied!.ops!.every(op => op.op === "rippleDelete")).toBe(true);
  const clips = (version: string) => ctx.repos.versions.get(project.id, version)!.timeline.tracks.find(t => t.id === "a1")!.clips;
  expect(clips(applied!.toVersion)).toMatchObject([
    { timelineIn: 0, sourceIn: 10, sourceOut: expect.closeTo(12 + half), audioFadeOut: expect.closeTo(2 * half) },
    { timelineIn: expect.closeTo(2 - half), sourceIn: expect.closeTo(13 - half), sourceOut: 15, audioFadeIn: expect.closeTo(2 * half) },
    // The plain joins keep their edges and the editor's own fade.
    { timelineIn: 4, sourceIn: 0, sourceOut: 5, audioFadeIn: 0.2 },
    { timelineIn: 9, sourceIn: 0, audioFadeIn: 0, audioFadeOut: expect.closeTo(2 * half) },
    { timelineIn: expect.closeTo(11 - half), sourceIn: expect.closeTo(3 - half), audioFadeIn: expect.closeTo(2 * half) },
  ]);
  // Review plays the staged cuts with their crossfades, as approving them would keep them.
  expect(staged!.ops!.every(op => op.op === "rippleDelete")).toBe(true);
  expect(staged!.joinFades!.fades.map(f => f.at)).toEqual([11, 13]);

  // Keeping the first staged cut preserves the fade that was already playing. Only the other join is new.
  const approval = approveChange(ctx, localUser(ctx), staged!, { restoredCuts: [0] });
  expect(approval.change.state).toBe("approved");
  expect(approval.change.appliedJoinFades!.fades.map(f => f.at)).toEqual([14]);
  const after = clips(approval.change.appliedVersion!);
  expect(after.find(c => c.kind === "media" && c.audioFadeOut && Math.abs(clipEnd(c) - (11 + half)) < 1e-6)).toBeTruthy();
});

it("leaves the joins straight when the plan omits a crossfade", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const submitted = await (await api("POST", `/projects/${project.id}/dialogue-cuts`, { taskId: task.id, fromVersion: base, description: "Tighten",
    cuts: [{ start: 2, end: 3, review: false, reason: "Restart." }] }, task)).json() as { changes: Change[]; joinCrossfades: unknown };
  expect(submitted.joinCrossfades).toEqual({ frames: 0, faded: 0, plain: [] });
  const applied = ctx.repos.changes.get(submitted.changes[0]!.id)!;
  expect(applied.joinFades).toBeUndefined();
  expect(ctx.repos.versions.get(project.id, applied.toVersion)!.timeline.tracks.find(t => t.id === "a1")!.clips)
    .toMatchObject([{ sourceOut: 2, audioFadeOut: 0 }, { timelineIn: 2, sourceIn: 3, audioFadeIn: 0 }]);
});

it("reports the recorded overlap for a pre-upgrade retry that had no crossfade argument", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const body = { fromVersion: base, description: "Retake", cuts: [{ start: 2, end: 3, review: true, reason: "A repeat." }] };
  const submit = async (extra: object) => (await (await api("POST", `/projects/${project.id}/dialogue-cuts`, { ...body, ...extra }, task)).json());
  const oldId = (await submit({})).changes[0].id;
  const withFade = ctx.repos.changes.get((await submit({ crossfadeFrames: 6 })).changes[0].id)!;
  ctx.repos.changes.put({ ...withFade, id: oldId, cutReasons: withFade.cutReasons!.map(({ crossfade, ...reason }) => reason) });
  expect((await submit({})).joinCrossfades).toEqual({ frames: 6, faded: 1, plain: [] });
});

it("caches a review draft with the recorded fade for its selected cut", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const cuts = [2, 7].map(start => ({ start, end: start + 1, review: true, reason: `Retake at ${start}.` }));
  const result = await api("POST", `/projects/${project.id}/dialogue-cuts`, { fromVersion: base, description: "Stage both retakes", crossfadeFrames: 6, cuts }, task);
  expect(result.status, await result.clone().text()).toBe(201);
  const change = ctx.repos.changes.get((await result.json()).changes[0].id)!;
  const preview = async (ontoVersion = base) => {
    const response = await api("POST", `/changes/${change.id}/cut-review?view=draft`, { ontoVersion, restoredCuts: [0] });
    expect(response.status, await response.clone().text()).toBe(200);
    const { draft, removed } = await response.json();
    expect(removed).toEqual([{ start: 7, end: 8 }]);
    return ctx.repos.versions.get(project.id, draft.version)!.timeline;
  };
  const legacy = ctx.repos.changes.put({ ...change, cutReasons: change.cutReasons!.map(({ crossfade, ...r }) => r) });
  const first = await preview();
  expect(first.tracks.find(t => t.id === "a1")!.clips).toMatchObject([{ audioFadeOut: 6 / 30 }, { audioFadeIn: 6 / 30 }]);
  const lookup = vi.spyOn(ctx.reviewDrafts, "set");
  expect((await preview()).version).toBe(first.version);
  expect(lookup).not.toHaveBeenCalled();

  const mixed = ctx.repos.changes.put({ ...legacy,
    cutReasons: legacy.cutReasons!.map((r, i) => ({ ...r, crossfade: i === 1 ? 0 : 6 / 30 })) });
  const after = await preview();
  expect(after.version).not.toBe(first.version);
  expect(after.tracks.find(t => t.id === "a1")!.clips).toMatchObject([{ audioFadeOut: 0 }, { audioFadeIn: 0 }]);
  const head = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Mark the last line",
    ops: [{ op: "addMarker", marker: { id: "line", time: 12, text: "Last line" } }] }).change.toVersion;
  const moved = await preview(head);
  const approval = approveChange(ctx, localUser(ctx), mixed, { restoredCuts: [0] });
  expect(ctx.repos.versions.get(project.id, approval.change.appliedVersion!)!.timeline.tracks).toEqual(moved.tracks);
  expect(moved.tracks.find(t => t.id === "a1")!.clips).toMatchObject([{ audioFadeOut: 0 }, { audioFadeIn: 0 }]);
});

it("reapplies an earlier fade choice to the right review slot after adjacent reasons combine", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const cuts = [2, 3, 7].map(start => ({ start, end: start + 1, review: true, reason: `Retake at ${start}.` }));
  const submission = await api("POST", `/projects/${project.id}/dialogue-cuts`, { fromVersion: base, description: "Retakes", cuts }, task);
  const original = (await submission.json()).changes[0].id;
  const revise = async (crossfadeFrames: number) => {
    const response = await api("POST", `/changes/${original}/staged-cuts/1`, { start: 7, end: 8.2, crossfadeFrames, reason: "Keep this breath." }, task);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()).change as Change;
  };
  const first = await revise(2);
  await revise(4);
  const retry = await revise(2);
  expect(retry.id).not.toBe(first.id);
  expect(retry.state).toBe("ready");
  expect(retry.cutReasons?.at(-1)?.crossfade).toBe(2 / 30);
  expect(ctx.repos.changes.get(first.id)?.state).toBe("rejected");
});

it("keeps different requested overlaps when staged parts combine, a cut is revised and the editor decides", async () => {
  const { ctx } = workspace;
  const { task, base } = dialogueTask();
  const submit = async (start: number, crossfadeFrames?: number) => {
    const result = await api("POST", `/projects/${project.id}/dialogue-cuts`, { fromVersion: base, description: "First pass", crossfadeFrames,
      cuts: [{ start, end: start + 1, review: true, reason: "Retake." }] }, task);
    expect(result.status, await result.clone().text()).toBe(201);
    return ctx.repos.changes.get((await result.json()).changes[0].id)!;
  };
  const first = await submit(2, 2);
  // Pre-upgrade changes stored their overlap once, in seconds, on joinFades.
  ctx.repos.changes.put({ ...first, cutReasons: first.cutReasons!.map(({ crossfade, ...c }) => c) });
  const combined = await submit(7, 4);
  expect((await submit(7, 4)).id).toBe(combined.id);
  const three = await submit(14);
  expect(three.cutReasons?.map(r => r.crossfade)).toEqual([2 / 30, 4 / 30, 0]);
  const revised = await api("POST", `/changes/${three.id}/staged-cuts/1`, { start: 7, end: 8.2, reason: "Keep the breath." }, task);
  expect(revised.status, await revised.clone().text()).toBe(201);
  const { change } = await revised.json() as { change: Change };
  const audio = (version: string) => ctx.repos.versions.get(project.id, version)!.timeline.tracks.find(t => t.id === "a1")!.clips;
  expect(audio(change.toVersion)).toMatchObject([{ audioFadeOut: 2 / 30 }, { audioFadeIn: 2 / 30, audioFadeOut: 4 / 30 },
    { audioFadeIn: 4 / 30, audioFadeOut: 0 }, { audioFadeIn: 0 }]);
  const straight = await api("POST", `/changes/${change.id}/staged-cuts/0`, { start: 2, end: 3, crossfadeFrames: 0, reason: "Straight cut here." }, task);
  expect(straight.status, await straight.clone().text()).toBe(201);
  const updated = (await straight.json()).change as Change;
  expect(updated.cutReasons?.map(r => r.crossfade)).toEqual([0, 4 / 30, 0]);
  expect(audio(updated.toVersion)).toMatchObject([{ audioFadeOut: 0 }, { audioFadeIn: 0, audioFadeOut: 4 / 30 },
    { audioFadeIn: 4 / 30, audioFadeOut: 0 }, { audioFadeIn: 0 }]);
  const approval = approveChange(ctx, localUser(ctx), updated, { restoredCuts: [0] });
  expect(audio(approval.change.appliedVersion!)).toMatchObject([{ audioFadeOut: 4 / 30 }, { audioFadeIn: 4 / 30, audioFadeOut: 0 }, { audioFadeIn: 0 }]);
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
