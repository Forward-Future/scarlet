import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { recordHistoryEdit } from "./cutHistory.js";
import { storeVersion } from "./timeline.js";

let dataDir: string;
let app: ScarletApp;
let project: Project;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-cut-history-"));
  app = createApp({ dataDir, env: {}, log: () => {} });
  project = app.ctx.repos.projects.insert(createProject("Long interview"));
});
afterEach(async () => {
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

it("calls the whole video the video when a restore can't go ahead, and restores as a new version when it can", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const second = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 40 }]), { parent: first.version });
  ctx.repos.projects.update(project.id, { head: second.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const restore = (version: string, expectedHead: string) => recordHistoryEdit(ctx, user, project.id, version, "restore", expectedHead, branch);
  // Asked for from a video that has moved on since, and for the version the video is on already.
  expect(() => restore(first.version, first.version)).toThrow("The video changed. Try again.");
  expect(() => restore(second.version, second.version)).toThrow("The video is already on this version.");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(second.version);
  // The earlier version comes back as a new one on top: both versions stay.
  const { project: restored, change } = restore(first.version, second.version);
  expect(change.description).toBe(`Restore · ${first.version}`);
  expect(ctx.repos.versions.summaries(project.id, restored.head).map(v => v.version)).toEqual(expect.arrayContaining([first.version, second.version, restored.head]));
  expect(ctx.repos.versions.summaries(project.id, restored.head).find(v => v.isHead)).toMatchObject({ parent: second.version, duration: 60 });
});
