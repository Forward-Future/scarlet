import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { proposeChange } from "./changes.js";
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
});
