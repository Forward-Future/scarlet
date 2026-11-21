import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyOps, createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { recordHistoryEdit, rejectEdits } from "./cutHistory.js";
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
  const entry = ctx.repos.activity.select("project_id = ? AND type = 'version.restored'", [project.id])[0]!;
  expect(entry.data).toMatchObject({ changeId: change.id, target: first.version, from: second.version, version: restored.head, branch, durationBefore: 40, durationAfter: 60 });
});

it("puts a rejected cut's footage back itself, and refuses a cut whose join it can't find", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const cut = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 10 }, { start: 12, end: 40 }, { start: 45, end: 60 }]), { parent: first.version });
  ctx.repos.projects.update(project.id, { head: cut.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const pause = { changeId: "chg_pass", spot: 0, label: "Trimmed the pause.", range: { start: 8.5, end: 11.5 }, at: 10, before: { version: first.version, removed: { start: 10, end: 12 } } };
  const reject = (cuts: (typeof pause)[], head = cut.version) => rejectEdits(ctx, user, project.id, "thread", cuts, head, branch);
  // Asked for from a video that has moved on, at a place with no join, and for more footage than the join is missing.
  expect(() => reject([pause], first.version)).toThrow("The video changed. Try again.");
  expect(() => reject([{ ...pause, at: 20 }])).toThrow("This edit can’t be put back as it was.");
  expect(() => reject([{ ...pause, before: { version: first.version, removed: { start: 10, end: 13 } } }])).toThrow("This edit can’t be put back as it was.");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(cut.version);
  // The pause is back and the other cut is as it was: 53 s plus the 2 s it took.
  const { project: after, change } = reject([pause]);
  expect(change).toMatchObject({ rejects: true, state: "approved", threadId: "thread", description: "Rejected · Trimmed the pause.",
    timelineEdits: [{ label: "Trimmed the pause.", range: { start: 10, end: 12 }, replaces: { changeId: "chg_pass", spot: 0 } }] });
  const now = ctx.repos.versions.get(project.id, after.head!)!.timeline;
  expect(now.tracks.flatMap(t => t.clips).filter(c => c.kind === "media").map(c => [c.timelineIn, c.sourceIn, c.sourceOut]).sort((a, b) => a[0]! - b[0]!))
    .toEqual(expect.arrayContaining([[0, 0, 40], [40, 45, 60]]));
  expect(ctx.repos.versions.summaries(project.id, after.head).find(v => v.isHead)).toMatchObject({ parent: cut.version, duration: 55 });
  const entry = ctx.repos.activity.select("project_id = ? AND type = 'change.undone'", [project.id])[0]!;
  expect(entry.data).toMatchObject({
    changeId: change.id, threadId: "thread", from: cut.version, version: after.head, branch, durationBefore: 53, durationAfter: 55,
    rejected: [{ changeId: "chg_pass", spot: 0, label: "Trimmed the pause.", range: { start: 8.5, end: 11.5 } }],
  });
});

it("takes a look edit off again itself, undoes a request whose every edit is rejected, and asks Scarlet for the rest", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 10 }, { start: 12, end: 40 }, { start: 45, end: 60 }]), { parent: null });
  const clips = first.tracks.find(t => t.kind === "video")!.clips;
  const punch = { x: 0, y: 0, scale: 1.1, rotation: 0 };
  const ops = [{ op: "updateClip" as const, clipId: clips[1]!.id, patch: { transform: punch } }, { op: "updateClip" as const, clipId: clips[2]!.id, patch: { transform: punch } }];
  const punched = storeVersion(ctx, project.id, applyOps(first, ops), { parent: first.version, changeId: "chg_punch" });
  const base = { projectId: project.id, author: { type: "agent" as const, id: "codex", name: "codex" }, state: "approved" as const, noteIds: [], renders: [], ranges: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  ctx.repos.changes.put({ ...base, id: "chg_punch", description: "Punched in twice", fromVersion: first.version, toVersion: punched.version, appliedOnto: first.version, appliedVersion: punched.version, ops,
    timelineEdits: [{ label: "Punch in on the answer", range: { start: 10, end: 38 } }, { label: "Punch in on the close", range: { start: 38, end: 53 } }] });
  ctx.repos.projects.update(project.id, { head: punched.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const scales = (version: string) => ctx.repos.versions.get(project.id, version)!.timeline.tracks.find(t => t.kind === "video")!.clips.map(c => c.kind === "media" && c.transform?.scale);
  const reject = (edits: Parameters<typeof rejectEdits>[4]) => rejectEdits(ctx, user, project.id, "thread", edits, ctx.repos.projects.get(project.id)!.head!, branch);
  const answer = { changeId: "chg_punch", spot: 0, label: "Punch in on the answer", range: { start: 10, end: 38 } };
  const close = { changeId: "chg_punch", spot: 1, label: "Punch in on the close", range: { start: 38, end: 53 } };
  // An edit that has been revised is only known by its latest version: Scarlet is asked.
  expect(() => reject([{ ...answer, revised: true }])).toThrow("This edit can’t be put back as it was.");
  // One of the two punch-ins comes off, and the other stays.
  const one = reject([answer]);
  expect(one.change).toMatchObject({ rejects: true, timelineEdits: [{ label: "Punch in on the answer", replaces: { changeId: "chg_punch", spot: 0 } }] });
  expect(scales(one.project.head!)).toEqual([undefined, undefined, 1.1]);
  // Rejected again, there is nothing of it left to take off.
  expect(() => reject([answer])).toThrow("This edit can’t be put back as it was.");
  // The other comes off the same way.
  expect(scales(reject([close]).project.head!)).toEqual([undefined, undefined, undefined]);
});

it("undoes a request whose only edit is rejected, whatever it changed", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const ops = [{ op: "addMarker" as const, marker: { id: "mark", time: 5, text: "Title here" } }];
  const marked = storeVersion(ctx, project.id, applyOps(first, ops), { parent: first.version, changeId: "chg_title" });
  ctx.repos.changes.put({ id: "chg_title", projectId: project.id, description: "Marked a title", author: { type: "agent", id: "codex", name: "codex" }, state: "approved", noteIds: [], renders: [], ranges: [],
    fromVersion: first.version, toVersion: marked.version, appliedOnto: first.version, appliedVersion: marked.version, ops,
    timelineEdits: [{ label: "Title", range: { start: 5, end: 5 } }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  ctx.repos.projects.update(project.id, { head: marked.version });
  const { project: after, change } = rejectEdits(ctx, user, project.id, "thread", [{ changeId: "chg_title", spot: 0, label: "Title", range: { start: 5, end: 5 } }],
    marked.version, ctx.repos.projects.get(project.id)!.branch ?? "main");
  expect(change).toMatchObject({ rejects: true, description: "Rejected · Title" });
  expect(ctx.repos.versions.get(project.id, after.head!)!.timeline.markers).toEqual([]);
});
