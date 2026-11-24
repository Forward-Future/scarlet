import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ATTEMPT_HEADER, FlagEditRequest, TASK_HEADER } from "@scarlet/shared";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { flagEdit, proposeChange } from "./changes.js";
import { createTask } from "./tasks.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-changes-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {},
    render: { ...scarletRenderAdapter, async renderFullCached(p, _tl, _cache, file) { writeFileSync(file, JSON.stringify(p.settings)); } } });
  workspace.ctx.speakers.beside = false;
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

it("places an agent's later ripple removal on the footage it was written for, after an earlier one went onto whole frames", () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Cut the stumbles", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 60 } }] });
  // At 30 fps the first removal is frames 301 to 360: 1.9667 s of the 2.010 s asked. The second was written on the edit
  // with 2.010 s out, so the footage it meant (22.01–23.01 s) now plays from 20.0433 s, and it goes inward onto frames from there.
  const cut = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Stumbles",
    ops: [{ op: "rippleDelete", start: 10.01, end: 12.02 }, { op: "rippleDelete", start: 20, end: 21 }] });
  expect(cut.change.ops).toEqual([{ op: "rippleDelete", start: 301 / 30, end: 12 }, { op: "rippleDelete", start: 602 / 30, end: 631 / 30 }]);
  // The footage after the second removal resumes at 23.0 s of the source, inside the 22.01–23.01 s asked, not before it.
  const clips = cut.timeline.tracks.find(t => t.id === "a1")!.clips;
  expect(clips.map(c => c.kind === "media" && c.sourceIn)).toEqual([0, 12, expect.closeTo(631 / 30 + (12 - 301 / 30), 9)]);

  // A second removal running to the end of the shortened timeline leaves no sub-frame tail stub.
  const tail = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Trim middle and tail",
    ops: [{ op: "rippleDelete", start: 2, end: 4 }, { op: "rippleDelete", start: 40, end: 56 }] });
  const tailClips = tail.timeline.tracks.find(t => t.id === "a1")!.clips;
  expect(tailClips.every(c => c.kind === "media" && (c.sourceOut - c.sourceIn) >= 1 / 30 - 1e-6)).toBe(true);
});

it("flags an edit once for a run, also when the run was resumed as a new attempt", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const by = { type: "human" as const, name: "Editor" };
  const cutting = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Assemble", createdBy: by });
  const made = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: cutting.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }],
    timelineEdits: [{ label: "Open on the answer", range: { start: 0, end: 4 } }] }).change;
  expect(made.state).toBe("approved");
  const first = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Check the music", createdBy: by });
  const resumed = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Check the music", createdBy: by, resumeRootId: first.id });
  const body = { changeId: made.id, spot: 0, check: "The music swells over the answer" };
  flagEdit(ctx, project.id, first, body);
  flagEdit(ctx, project.id, resumed, body);
  expect(ctx.repos.changes.get(made.id)!.flags).toMatchObject([{ spot: 0, check: body.check, taskId: first.id }]);
  const range = { start: 12, end: 13 };
  const location = { version: made.toVersion, range };
  flagEdit(ctx, project.id, resumed, { ...body, range });
  flagEdit(ctx, project.id, resumed, { ...body, range });
  expect(ctx.repos.changes.get(made.id)!.flags).toMatchObject([{ spot: 0, check: body.check, taskId: first.id, location }]);
  // Another request that finds the same doubt flags it on its own.
  const other = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Check the mix", createdBy: by });
  flagEdit(ctx, project.id, other, body);
  expect(ctx.repos.changes.get(made.id)!.flags).toHaveLength(2);
});

it("records a flag's playback range in the version it refers to", () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const user = localUser(ctx);
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Assemble", createdBy: { type: "human", name: "Editor" } });
  const made = proposeChange(ctx, user, project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }],
    timelineEdits: [{ label: "Open on the answer", range: { start: 0, end: 4 } }] }).change;
  const moved = proposeChange(ctx, user, project.id, { intent: "requested", taskId: task.id, description: "Tighten the pause",
    ops: [{ op: "rippleDelete", start: 5, end: 7 }] }).change;
  const historical = { check: "Check the mix later in the opening", range: { start: 12, end: 12 }, version: made.toVersion };
  expect(() => flagEdit(ctx, project.id, task, historical)).toThrow(expect.objectContaining({ code: "stale_flag_range" }));
  const named = FlagEditRequest.parse({ ...historical, changeId: made.id, spot: 0 });
  const result = flagEdit(ctx, project.id, task, named);
  expect(result).toMatchObject({ flagged: { changeId: made.id, spot: 0, range: { start: 0, end: 4 } }, version: moved.toVersion });
  expect(ctx.repos.changes.get(made.id)!.flags).toMatchObject([{ location: { version: made.toVersion, range: historical.range } }]);
  expect(() => flagEdit(ctx, project.id, task, { ...named, range: { start: 21, end: 21 } }))
    .toThrow(expect.objectContaining({ code: "invalid_flag_range" }));

  const range = { start: 1, end: 2 };
  const found = flagEdit(ctx, project.id, task, FlagEditRequest.parse({ check: "Check the first line", range }));
  expect(found.flagged).toMatchObject({ changeId: made.id, spot: 0 });
  expect(ctx.repos.changes.get(made.id)!.flags?.[1]?.location).toEqual({ version: moved.toVersion, range });
  expect(FlagEditRequest.safeParse({ check: "Check the mix", changeId: made.id, spot: 0, version: made.toVersion }).success).toBe(false);
});

it("projects only the named change's thread on edit-flags by changeId and preserves route behavior for revisions, elsewhere edits, errors, and ranges", async () => {
  const { ctx, app } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  const user = localUser(ctx);
  const by = { type: "human" as const, id: user.id, name: user.name };
  const token = accessToken(ctx);
  const runner = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Audit edits", createdBy: by });
  const startedAt = new Date().toISOString();
  ctx.repos.tasks.put({ ...runner, state: "running", startedAt });

  const postFlag = (body: object) => app.request(`/api/projects/${project.id}/edit-flags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [TASK_HEADER]: runner.id,
      [ATTEMPT_HEADER]: startedAt,
    },
    body: JSON.stringify({ taskId: runner.id, ...body }),
  });

  // Thread 1: assemble + edit covering 0..10
  const t1 = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Assemble intro", createdBy: by });
  const c1 = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: t1.id, description: "Assemble", skipRender: true,
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 60 } }],
    timelineEdits: [{ label: "Assemble intro", range: { start: 0, end: 10 } }],
  }).change;

  // Thread 2: unrelated edit + same-thread revision covering 2..8
  const t2 = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Boost opening", createdBy: by });
  const c2 = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: t2.id, description: "Boost opening", skipRender: true,
    ops: [{ op: "updateClip", clipId: "raw", patch: { volume: 0.9 } }],
    timelineEdits: [{ label: "Boost opening", range: { start: 2, end: 8 } }],
  }).change;
  const t2Rev = createTask(ctx, { projectId: project.id, kind: "revise", agent: "codex", instruction: "Dial back boost", createdBy: by, context: { threadId: t2.id, changeId: c2.id } });
  const c2Rev = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: t2Rev.id, description: "Boost opening gently", skipRender: true,
    ops: [{ op: "updateClip", clipId: "raw", patch: { volume: 0.95 } }],
    timelineEdits: [{ label: "Boost opening gently", range: { start: 2, end: 8 }, replaces: { changeId: c2.id, spot: 0 } }],
  }).change;

  // Thread 3: edit flagged by runner (enters runner's `flagged` / elsewhere list) and revised from runner's thread
  const t3 = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Lower hum", createdBy: by });
  const c3 = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: t3.id, description: "Lower hum", skipRender: true,
    ops: [{ op: "updateClip", clipId: "raw", patch: { volume: 0.85 } }],
    timelineEdits: [{ label: "Lower hum", range: { start: 20, end: 25 } }],
  }).change;
  expect((await postFlag({ changeId: c3.id, spot: 0, check: "Still hear hum" })).status).toBe(201);
  const t4Rev = createTask(ctx, { projectId: project.id, kind: "revise", agent: "codex", instruction: "Fix hum", createdBy: by, context: { threadId: runner.id, changeId: c3.id } });
  const c4Rev = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: t4Rev.id, description: "Lower hum more", skipRender: true,
    ops: [{ op: "updateClip", clipId: "raw", patch: { volume: 0.8 } }],
    timelineEdits: [{ label: "Lower hum more", range: { start: 20, end: 25 }, replaces: { changeId: c3.id, spot: 0 } }],
  }).change;

  // Thread 5: ready suggestion (not applied)
  const t5 = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Offer alternative", createdBy: by });
  const cReady = proposeChange(ctx, user, project.id, {
    intent: "suggestion", taskId: t5.id, description: "Try quieter", skipRender: true,
    ops: [{ op: "updateClip", clipId: "raw", patch: { volume: 0.7 } }],
    timelineEdits: [{ label: "Try quieter", range: { start: 30, end: 35 } }],
  }).change;

  // Flagging c1 by changeId must not read versions belonging only to unrelated threads (c2, c2Rev, c3).
  const readSpy = vi.spyOn(ctx.repos.versions, "get");
  const byIdRes = await postFlag({ changeId: c1.id, spot: 0, check: "Check intro pacing" });
  expect(byIdRes.status).toBe(201);
  const byIdBody = await byIdRes.json();
  expect(byIdBody).toEqual({
    flagged: { changeId: c1.id, spot: 0, label: "Assemble intro", request: "Assemble intro", range: { start: 0, end: 10 } },
    version: c4Rev.toVersion,
  });
  const readVersions = readSpy.mock.calls.map(([, version]) => version);
  expect(readVersions).not.toContain(c2.toVersion);
  expect(readVersions).not.toContain(c2Rev.toVersion);
  expect(readVersions).not.toContain(c3.toVersion);
  readSpy.mockRestore();

  // Same-thread revision: old replaced changeId is not found; replacement resolves to the revised edit.
  const replacedOld = await postFlag({ changeId: c2.id, spot: 0, check: "Flag old" });
  expect(replacedOld.status).toBe(404);
  expect(await replacedOld.json()).toMatchObject({ error: { code: "not_found" } });
  const replacedNew = await postFlag({ changeId: c2Rev.id, spot: 0, check: "Flag revision" });
  expect(replacedNew.status).toBe(201);
  expect(await replacedNew.json()).toEqual({
    flagged: { changeId: c2Rev.id, spot: 0, label: "Boost opening gently", request: "Boost opening", range: { start: 2, end: 8 } },
    version: c4Rev.toVersion,
  });

  // Elsewhere/flagged change and its revision from the flagging thread both resolve to their own threads.
  const elsewhereOrig = await postFlag({ changeId: c3.id, spot: 0, check: "Flag orig again" });
  expect(elsewhereOrig.status).toBe(201);
  expect(await elsewhereOrig.json()).toMatchObject({ flagged: { changeId: c3.id, spot: 0, label: "Lower hum", request: "Lower hum" } });
  const elsewhereRev = await postFlag({ changeId: c4Rev.id, spot: 0, check: "Flag elsewhere rev" });
  expect(elsewhereRev.status).toBe(201);
  expect(await elsewhereRev.json()).toMatchObject({ flagged: { changeId: c4Rev.id, spot: 0, label: "Lower hum more", request: "Audit edits" } });

  // Missing, wrong spot, and staged changes return the same errors without scanning unrelated threads.
  const errReadSpy = vi.spyOn(ctx.repos.versions, "get");
  expect((await postFlag({ changeId: "chg_missing", spot: 0, check: "Missing" })).status).toBe(404);
  expect((await postFlag({ changeId: c1.id, spot: 9, check: "Wrong spot" })).status).toBe(404);
  const staged = await postFlag({ changeId: cReady.id, spot: 0, check: "Staged" });
  expect(staged.status).toBe(400);
  expect(await staged.json()).toMatchObject({ error: { code: "not_applied" } });
  const errReadVersions = errReadSpy.mock.calls.map(([, version]) => version);
  expect(errReadVersions).not.toContain(c2.toVersion);
  expect(errReadVersions).not.toContain(c2Rev.toVersion);
  expect(errReadVersions).not.toContain(c3.toVersion);
  errReadSpy.mockRestore();

  // Range form still projects across threads, picks the best overlap, and reports alsoThere.
  const byRange = await postFlag({ range: { start: 2, end: 8 }, check: "Check overlap by range" });
  expect(byRange.status).toBe(201);
  expect(await byRange.json()).toEqual({
    flagged: { changeId: c2Rev.id, spot: 0, label: "Boost opening gently", request: "Boost opening", range: { start: 2, end: 8 } },
    version: c4Rev.toVersion,
    alsoThere: [{ changeId: c1.id, spot: 0, label: "Assemble intro", request: "Assemble intro", range: { start: 0, end: 10 } }],
  });
});

it("refuses a timelineEdit that bundles disjoint changed stretches across untouched gaps, while allowing individual, contiguous, and single-clip edits", () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "cam", name: "cam.mp4", path: "cam.mp4", kind: "video", duration: 120, hasAudio: true }, "ready");
  const user = localUser(ctx);
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Frame clips", createdBy: { type: "human", name: "Editor" } });
  proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Assemble four clips", skipRender: true,
    ops: [
      { op: "addClip", trackId: "v1", clip: { id: "c1", kind: "media", mediaId: "cam", timelineIn: 0, sourceIn: 0, sourceOut: 10 } },
      { op: "addClip", trackId: "v1", clip: { id: "c2", kind: "media", mediaId: "cam", timelineIn: 10, sourceIn: 10, sourceOut: 40 } },
      { op: "addClip", trackId: "v1", clip: { id: "c3", kind: "media", mediaId: "cam", timelineIn: 40, sourceIn: 40, sourceOut: 50 } },
      { op: "addClip", trackId: "v1", clip: { id: "c4", kind: "media", mediaId: "cam", timelineIn: 50, sourceIn: 50, sourceOut: 60 } },
    ],
  });

  // Bundling two separate reframes (c1 at 0..10 and c3 at 40..50) across untouched c2 (10..40) into one spanning edit is rejected.
  const scatteredOps = [
    { op: "updateClip" as const, clipId: "c1", patch: { transform: { scale: 1.15 } } },
    { op: "updateClip" as const, clipId: "c3", patch: { transform: { scale: 1.15 } } },
  ];
  expect(() => proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Punch in on two moments", skipRender: true,
    ops: scatteredOps,
    timelineEdits: [{ label: "Punch in on two moments", range: { start: 0, end: 50 } }],
  })).toThrow(expect.objectContaining({
    code: "spanning_edit_range",
    message: expect.stringMatching(/0\.00–10\.00 s.*40\.00–50\.00 s/),
  }));

  // Listing each separate stretch as its own timelineEdit succeeds.
  const separate = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Punch in on two moments", skipRender: true,
    ops: scatteredOps,
    timelineEdits: [
      { label: "Punch in on opening", range: { start: 0, end: 10 } },
      { label: "Punch in on reveal", range: { start: 40, end: 50 } },
    ],
  }).change;
  expect(separate.timelineEdits).toHaveLength(2);

  // A single clip with audioFadeIn + audioFadeOut (diff ranges only at start and end) is one touched clip, not a bundle.
  const faded = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Fade clip edges", skipRender: true,
    ops: [{ op: "updateClip", clipId: "c2", patch: { audioFadeIn: 0.2, audioFadeOut: 0.2 } }],
    timelineEdits: [{ label: "Soften clip edges", range: { start: 10, end: 40 } }],
  }).change;
  expect(faded.timelineEdits).toHaveLength(1);

  // Two adjacent/contiguous clips edited together (c3 40..50 and c4 50..60) share one continuous range and succeed.
  const contiguous = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Frame closing pair", skipRender: true,
    ops: [
      { op: "updateClip", clipId: "c3", patch: { transform: { scale: 1.1 } } },
      { op: "updateClip", clipId: "c4", patch: { transform: { scale: 1.1 } } },
    ],
    timelineEdits: [{ label: "Tighten closing pair", range: { start: 40, end: 60 } }],
  }).change;
  expect(contiguous.timelineEdits).toHaveLength(1);

  // Revising an existing edit via `replaces` is never blocked even if its ops touch separated spots.
  const revised = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Adjust opening and reveal", skipRender: true,
    ops: [
      { op: "updateClip", clipId: "c1", patch: { transform: { scale: 1.12 } } },
      { op: "updateClip", clipId: "c3", patch: { transform: { scale: 1.12 } } },
    ],
    timelineEdits: [{ label: "Adjust both punches", range: { start: 0, end: 50 }, replaces: { changeId: separate.id, spot: 0 } }],
  }).change;
  expect(revised.timelineEdits).toHaveLength(1);
});

it("refuses range-only edit flags that do not match an edit's time range, while naming broader overlapping edits and still allowing explicit changeId + spot", () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "cam", name: "cam.mp4", path: "cam.mp4", kind: "video", duration: 240, hasAudio: true }, "ready");
  const user = localUser(ctx);
  const by = { type: "human" as const, name: "Editor" };
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Assemble", createdBy: by });
  const bed = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Assemble full take", skipRender: true,
    ops: [{ op: "addClip", trackId: "v1", clip: { id: "raw", kind: "media", mediaId: "cam", timelineIn: 0, sourceIn: 0, sourceOut: 240 } }],
    timelineEdits: [{ label: "Full-length music bed", range: { start: 0, end: 240 } }],
  }).change;
  const cut = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Cut stumble", skipRender: true,
    ops: [{ op: "rippleDelete", start: 100, end: 102 }],
  }).change;
  const local = proposeChange(ctx, user, project.id, {
    intent: "requested", taskId: task.id, description: "Trim quiet intro", skipRender: true,
    ops: [{ op: "updateClip", clipId: "raw", patch: { volume: 0.9 } }],
    timelineEdits: [{ label: "Local volume tweak", range: { start: 95, end: 115 } }],
  }).change;

  // A short range-only flag (50..55 s) inside a 240 s spanning edit (IoU ~ 0.02 < 0.2) refuses to hijack it and names the broader edit.
  expect(() => flagEdit(ctx, project.id, task, FlagEditRequest.parse({
    check: "Dialogue cut feels tight", range: { start: 50, end: 55 },
  }))).toThrow(expect.objectContaining({
    code: "no_edit_there",
    message: expect.stringMatching(new RegExp(`${bed.id}\\[0\\].*Full-length music bed.*Pass changeId and spot explicitly`)),
  }));

  // A point flag at 50 s inside the 240 s spanning edit (> 30 s) also refuses to hijack it.
  expect(() => flagEdit(ctx, project.id, task, FlagEditRequest.parse({
    check: "Check pause here", range: { start: 50, end: 50 },
  }))).toThrow(expect.objectContaining({ code: "no_edit_there" }));

  // A point flag at the cut (100 s) prefers the point cut over the overlapping 20 s local span edit.
  const atCut = flagEdit(ctx, project.id, task, FlagEditRequest.parse({
    check: "Check this join", range: { start: 100, end: 100 },
  }));
  expect(atCut.flagged).toMatchObject({ changeId: cut.id, spot: 0 });

  // A point flag at 108 s (away from the cut, inside the 20 s local edit <= 30 s) matches the local edit, not the 240 s bed.
  const atLocal = flagEdit(ctx, project.id, task, FlagEditRequest.parse({
    check: "Check local tweak", range: { start: 108, end: 108 },
  }));
  expect(atLocal.flagged).toMatchObject({ changeId: local.id, spot: 0 });

  // Flagging a short passage inside the 240 s edit still works when changeId and spot are passed explicitly.
  const explicit = flagEdit(ctx, project.id, task, FlagEditRequest.parse({
    changeId: bed.id, spot: 0, range: { start: 50, end: 55 }, check: "Bed feels loud here",
  }));
  expect(explicit.flagged).toMatchObject({ changeId: bed.id, spot: 0 });
});

