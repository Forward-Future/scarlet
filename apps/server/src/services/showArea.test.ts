import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveFfmpeg, runCapture } from "@scarlet/render";
import type { Task } from "@scarlet/shared";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { askAreas, editShowAreas, showArea } from "./showArea.js";
import { createTask } from "./tasks.js";
import type { VideoMedia } from "./pictureReading.js";

let directory: string, workspace: ScarletApp, projectId: string;
const recordings: Record<string, VideoMedia> = {};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scarlet-show-area-"));
  workspace = createApp({ dataDir: directory, env: {}, log: () => {} });
  const { ctx } = workspace;
  projectId = ctx.repos.projects.insert(createProject("Areas", { width: 320, height: 180, fps: 25 })).id;
  ctx.paths.ensureProject(projectId);
  // A camera has no window in it. The screen holds a white window on gray that moves halfway through.
  const window = (x: number, when: string) => `drawbox=x=${x}:y=30:w=160:h=110:c=white:t=fill:enable='${when}'`;
  for (const [id, filter] of [["camera", "null"], ["screen", `${window(40, "lt(t,600)")},${window(120, "gte(t,600)")}`]] as const) {
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=1:d=1200", "-vf", filter,
      "-c:v", "libx264", "-threads", "1", "-g", "5", join(ctx.paths.media(projectId), `${id}.mp4`)]);
    recordings[id] = { ...ctx.repos.projects.putMedia(projectId, { id, kind: "video", name: id, path: `${id}.mp4`, hasAudio: false, duration: 1200, fps: 1, width: 320, height: 180 }, "ready"), projectId };
  }
}, 120_000);
afterAll(async () => { await workspace?.ctx.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

/** Answers each look as it starts, as its run would, and counts how many were open at once. */
function answering(media: VideoMedia, area: (at: number) => number[]) {
  const { ctx } = workspace;
  const seen = new Set<string>();
  let most = 0, stopped = false;
  const looked: number[] = [];
  const loop = (async () => {
    while (!stopped) {
      const open = ctx.repos.tasks.select("project_id = ? AND kind = 'area_check' AND state = 'queued'", [projectId]).filter(t => t.context.areaCheck?.mediaId === media.id);
      most = Math.max(most, open.length);
      for (const task of open) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        const at = task.context.areaCheck!.at;
        looked.push(at);
        await editShowAreas(ctx, media, { set: [{ at, area: area(at) }] });
        ctx.repos.tasks.put({ ...ctx.repos.tasks.get(task.id)!, state: "done", finishedAt: new Date().toISOString() });
      }
      await new Promise(done => setTimeout(done, 20));
    }
  })();
  return { looked, most: () => most, stop: async () => { stopped = true; await loop; } };
}

function asker(): Task {
  return createTask(workspace.ctx, { projectId, kind: "edit", agent: "codex", instruction: "Frame the demo", createdBy: { type: "human", name: "Editor" } });
}

it("looks at one frame of a recording with no area before the rest, and stops once the whole picture may show", async () => {
  const { ctx } = workspace, camera = recordings.camera!;
  const seconds = [100, 400, 700, 1000];
  expect(await showArea(ctx, camera, { waitMs: 60_000 })).toMatchObject({ done: true, areas: [], unset: [[0, 1200]] });
  const answers = answering(camera, () => [0, 0, 1, 1]);
  try {
    const task = asker();
    expect(await askAreas(ctx, camera, { seconds, taskId: task.id, waitMs: 20_000 })).toEqual({ asked: 1, answered: 1, waiting: 0 });
    expect(answers.looked).toEqual([100]);
    const state = await showArea(ctx, camera, { waitMs: 5000 });
    expect(state.unset).toEqual([]);
    // The whole picture holds whatever the picture does, so its changes are never read for it.
    expect(existsSync(join(ctx.paths.waveforms(projectId), "camera.picture-cuts.json"))).toBe(false);
    // Asked again, a second look is taken; after two that agree, no more are.
    expect((await askAreas(ctx, camera, { seconds: [700], taskId: task.id, waitMs: 20_000, again: true })).asked).toBe(1);
    expect((await askAreas(ctx, camera, { seconds: [1000], taskId: task.id, waitMs: 20_000, again: true })).asked).toBe(0);
    expect(answers.looked).toEqual([100, 700]);
  } finally { await answers.stop(); }
}, 60_000);

it("goes on to the other stretches of a recording whose first look found a window", async () => {
  const { ctx } = workspace, screen = recordings.screen!;
  const answers = answering(screen, at => at < 600 ? [0.125, 30 / 180, 0.625, 140 / 180] : [0.375, 30 / 180, 0.875, 140 / 180]);
  try {
    const result = await askAreas(ctx, screen, { seconds: [100, 400, 700, 1000], taskId: asker().id, waitMs: 20_000 });
    expect(result.waiting).toBe(0);
    // The first window's area holds until it moves, so 400 needs no look; the stretch after the move does.
    expect(answers.looked[0]).toBe(100);
    expect(answers.looked).not.toContain(400);
    expect(answers.looked).toContain(700);
    const state = await showArea(ctx, screen, { waitMs: 5000 });
    expect(state.unset).toEqual([]);
    expect(state.areas.map(a => a.holds.length)).toEqual(state.areas.map(() => 1));
  } finally { await answers.stop(); }
}, 60_000);

it("starts no look when the asking model can't see images, and still asks for one that can", async () => {
  const { ctx } = workspace, screen = recordings.screen!;
  const queued = () => ctx.repos.tasks.select("project_id = ? AND kind = 'area_check' AND state = 'queued'", [projectId])
    .filter(t => t.context.areaCheck?.mediaId === screen.id);
  await showArea(ctx, screen, { waitMs: 60_000 });
  try {
    for (const { agent, model } of [{ agent: "ollama", model: "qwen3:30b" }, { agent: "openrouter", model: "x-ai/grok-4" }] as const) {
      const task = createTask(ctx, { projectId, kind: "edit", agent, model, instruction: "Frame the demo", createdBy: { type: "human", name: "Editor" } });
      expect(await askAreas(ctx, screen, { seconds: [200], taskId: task.id, waitMs: 500, again: true })).toEqual({ asked: 0, answered: 0, waiting: 0 });
      expect(queued()).toEqual([]);
    }
    const vision = createTask(ctx, { projectId, kind: "edit", agent: "openrouter", model: "anthropic/claude-sonnet-4", instruction: "Frame the demo", createdBy: { type: "human", name: "Editor" } });
    const result = await askAreas(ctx, screen, { seconds: [200], taskId: vision.id, waitMs: 500, again: true });
    expect(result.asked).toBeGreaterThanOrEqual(1);
    expect(queued()).toEqual([expect.objectContaining({ agent: "openrouter", model: "anthropic/claude-sonnet-4" })]);
  } finally {
    for (const task of queued()) ctx.repos.tasks.put({ ...task, state: "cancelled", finishedAt: new Date().toISOString() });
  }
}, 60_000);
