import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyOps, createProject, emptyTimeline, makeMediaClip, splitJoinOps, timelineFromKeepRanges, type MediaClip, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { adjustAppliedCut, adjustAppliedEdit, recordHistoryEdit, rejectEdits } from "./cutHistory.js";
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

it("puts one split edit's sound back on its picture cut itself, and keeps the other", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  for (const id of ["host", "guest"]) ctx.repos.projects.putMedia(project.id, { id, name: `${id}.mov`, kind: "video", path: `${id}.mov`, hasAudio: true, duration: 60 }, "ready");
  const talk = emptyTimeline(project.id);
  talk.tracks[0]!.clips = [makeMediaClip("host", 2, 12, 0, { id: "ask" }), makeMediaClip("guest", 10, 20, 10, { id: "answer" }), makeMediaClip("host", 30, 40, 20, { id: "react" })];
  const first = storeVersion(ctx, project.id, talk, { parent: null });
  const { ops } = splitJoinOps(first, ctx.repos.projects.get(project.id)!.media, 25, [{ at: 10, shift: -0.24 }, { at: 20, shift: 0.5 }]);
  const split = storeVersion(ctx, project.id, applyOps(first, ops), { parent: first.version, changeId: "chg_split" });
  ctx.repos.changes.put({ id: "chg_split", projectId: project.id, description: "Split edits", author: { type: "agent", id: "codex", name: "codex" }, state: "approved", noteIds: [], renders: [], ranges: [],
    fromVersion: first.version, toVersion: split.version, appliedOnto: first.version, appliedVersion: split.version, ops,
    timelineEdits: [{ label: "J cut at 0:10", range: { start: 9.76, end: 10 } }, { label: "L cut at 0:20", range: { start: 20, end: 20.5 } }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  ctx.repos.projects.update(project.id, { head: split.version });
  const { project: after } = rejectEdits(ctx, user, project.id, "thread", [{ changeId: "chg_split", spot: 1, label: "L cut at 0:20", range: { start: 20, end: 20.5 } }],
    split.version, ctx.repos.projects.get(project.id)!.branch ?? "main");
  const tl = ctx.repos.versions.get(project.id, after.head!)!.timeline;
  const clip = (id: string) => tl.tracks.flatMap(t => t.clips).find(c => c.id === id) as MediaClip;
  // The reaction plays its own sound again; the answer's sound still leads into its picture and ends on the cut.
  expect(clip("react").volume).toBe(1);
  const answer = tl.tracks.find(t => t.kind === "audio" && t.clips.some(c => c.kind === "media" && c.mediaId === "guest"))!.clips.find(c => c.kind === "media" && c.mediaId === "guest") as MediaClip;
  expect(answer).toMatchObject({ timelineIn: 9.76, sourceOut: 20, splitEdit: { leads: 0.24 } });
});

it("takes one music dip back with no model, after a later cut split the music it was on, and leaves the other", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "music", name: "bed.wav", kind: "audio", path: "bed.wav" }, "ready");
  const start = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]);
  start.tracks.push({ id: "music", kind: "audio", name: "Music", muted: false, hidden: false, clips: [
    makeMediaClip("music", 0, 20, 0, { id: "intro" }), makeMediaClip("music", 100, 120, 40, { id: "outro" })] });
  const first = storeVersion(ctx, project.id, start, { parent: null });
  const dip = [{ time: 2, db: 0, ease: "easeInOut" as const }, { time: 2.3, db: -18, ease: "linear" as const },
    { time: 9, db: -18, ease: "easeInOut" as const }, { time: 9.8, db: 0, ease: "linear" as const }];
  const ops = [{ op: "updateClip" as const, clipId: "intro", patch: { volumeKeyframes: dip } }, { op: "updateClip" as const, clipId: "outro", patch: { volumeKeyframes: dip } }];
  const dipped = storeVersion(ctx, project.id, applyOps(first, ops), { parent: first.version, changeId: "chg_dip" });
  const base = { projectId: project.id, author: { type: "agent" as const, id: "codex", name: "codex" }, state: "approved" as const, noteIds: [], renders: [], ranges: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  ctx.repos.changes.put({ ...base, id: "chg_dip", description: "Dipped the music under speech", fromVersion: first.version, toVersion: dipped.version,
    appliedOnto: first.version, appliedVersion: dipped.version, ops,
    timelineEdits: [{ label: "Dip the intro music", range: { start: 0, end: 20 } }, { label: "Dip the outro music", range: { start: 40, end: 60 } }] });
  // A later cut takes 5–6 s out of every track, through the intro's music.
  const cut = storeVersion(ctx, project.id, applyOps(dipped, [{ op: "rippleDelete", start: 5, end: 6 }]), { parent: dipped.version });
  ctx.repos.projects.update(project.id, { head: cut.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const result = rejectEdits(ctx, user, project.id, "thread", [{ changeId: "chg_dip", spot: 0, label: "Dip the intro music", range: { start: 0, end: 19 } }],
    cut.version, branch);
  const music = ctx.repos.versions.get(project.id, result.project.head!)!.timeline.tracks.find(t => t.id === "music")!.clips;
  expect(music.map(c => [c.id === "outro" ? "outro" : "intro", c.kind === "media" && c.volumeKeyframes?.length])).toEqual([["intro", undefined], ["intro", undefined], ["outro", 4]]);
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

it("takes a rejected to-do's marker off with no model and leaves the change's other edits as they were", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }, { start: 30, end: 60 }]), { parent: null });
  const clip = first.tracks.find(t => t.kind === "video")!.clips[1]!;
  // One request punched in and marked two spots for B-roll.
  const ops = [{ op: "updateClip" as const, clipId: clip.id, patch: { transform: { x: 0, y: 0, scale: 1.1, rotation: 0 } } },
    { op: "addMarker" as const, marker: { id: "boats", time: 9, kind: "todo" as const, text: "Add B-roll of the boats" } },
    { op: "addMarker" as const, marker: { id: "harbour", time: 20, kind: "todo" as const, text: "Add B-roll of the harbour" } }];
  const marked = storeVersion(ctx, project.id, applyOps(first, ops), { parent: first.version, changeId: "chg_broll" });
  ctx.repos.changes.put({ id: "chg_broll", projectId: project.id, description: "Punched in and marked B-roll", author: { type: "agent", id: "codex", name: "codex" }, state: "approved", noteIds: [], renders: [], ranges: [],
    fromVersion: first.version, toVersion: marked.version, appliedOnto: first.version, appliedVersion: marked.version, ops,
    timelineEdits: [{ label: "Punch in", range: { start: 30, end: 60 } }, { label: "Boats B-roll", range: { start: 8, end: 11 } }, { label: "Harbour B-roll", range: { start: 19, end: 22 } }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  ctx.repos.projects.update(project.id, { head: marked.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const boats = { changeId: "chg_broll", spot: 1, label: "Boats B-roll", range: { start: 8, end: 11 }, marker: true };
  const reject = () => rejectEdits(ctx, user, project.id, "thread", [boats], ctx.repos.projects.get(project.id)!.head!, branch);
  const { project: after, change } = reject();
  expect(change).toMatchObject({ rejects: true, description: "Rejected · Boats B-roll", timelineEdits: [{ label: "Boats B-roll", replaces: { changeId: "chg_broll", spot: 1 } }] });
  const now = ctx.repos.versions.get(project.id, after.head!)!.timeline;
  expect(now.markers.map(m => m.id)).toEqual(["harbour"]);
  expect(now.tracks.find(t => t.kind === "video")!.clips.map(c => c.kind === "media" && c.transform?.scale)).toEqual([undefined, 1.1]);
  // Rejected again, its marker is gone: Scarlet is asked.
  expect(reject).toThrow("This edit can’t be put back as it was.");
});

it("keeps the cuts a built video left out when its one named edit is rejected", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  // The change built the video from two pieces, which left 20-30 s out, and named one edit besides: a title's marker.
  const built = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 20 }, { start: 30, end: 60 }]);
  const ops = [{ op: "addMarker" as const, marker: { id: "mark", time: 5, text: "Title here" } }];
  const marked = storeVersion(ctx, project.id, applyOps(built, ops), { parent: first.version, changeId: "chg_built" });
  ctx.repos.changes.put({ id: "chg_built", projectId: project.id, description: "Built the video", author: { type: "agent", id: "codex", name: "codex" }, state: "approved", noteIds: [], renders: [], ranges: [],
    fromVersion: first.version, toVersion: marked.version, appliedOnto: first.version, appliedVersion: marked.version, ops,
    timelineEdits: [{ label: "Title", range: { start: 5, end: 5 } }], leftOut: { version: first.version, joins: [{ at: 20, removed: { start: 20, end: 30 } }] },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  ctx.repos.projects.update(project.id, { head: marked.version });
  // The title isn't every edit of the change: taking the change out would put the cut's footage back unasked.
  expect(() => rejectEdits(ctx, user, project.id, "thread", [{ changeId: "chg_built", spot: 0, label: "Title", range: { start: 5, end: 5 } }],
    marked.version, ctx.repos.projects.get(project.id)!.branch ?? "main")).toThrow("This edit can’t be put back as it was.");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(marked.version);
});

it("adjusts an applied cut's edges directly, projects the updated cut through threadTimeline, and reverts cleanly with undo", async () => {
  const { threadTimeline } = await import("@scarlet/shared");
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov", duration: 60 }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const cut = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 10 }, { start: 12, end: 40 }, { start: 45, end: 60 }]), { parent: first.version, changeId: "chg_pass" });
  const passChange = {
    id: "chg_pass", projectId: project.id, description: "Trimmed pauses", author: { type: "agent" as const, id: "claude", name: "Claude" },
    state: "approved" as const, threadId: "thread", fromVersion: first.version, toVersion: cut.version, appliedOnto: first.version, appliedVersion: cut.version,
    timelineEdits: [
      { label: "Cut pause", range: { start: 10, end: 10 }, reason: "Removed filler before next sentence." },
      { label: "Cut tangent", range: { start: 38, end: 38 }, reason: "Tightened tangent." },
    ],
    leftOut: { version: first.version, joins: [{ at: 10, removed: { start: 10, end: 12 } }, { at: 38, removed: { start: 40, end: 45 } }] },
    noteIds: [], renders: [], ranges: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  ctx.repos.changes.put(passChange);
  ctx.repos.projects.update(project.id, { head: cut.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";

  // Pull left edge forward by 0.5 s (restores 10.0–10.5 s).
  const target = { changeId: "chg_pass", spot: 0, label: "Cut pause", range: { start: 8.5, end: 11.5 }, at: 10, before: { version: first.version, removed: { start: 10, end: 12 } } };
  const { project: after, change } = adjustAppliedCut(ctx, user, project.id, "thread", target, { start: 10.5, end: 12 }, cut.version, branch);
  expect(change).toMatchObject({ state: "approved", threadId: "thread", description: "Adjusted · Cut pause" });
  const headTl = ctx.repos.versions.get(project.id, after.head!)!.timeline;
  expect(headTl.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
    .toEqual([[0, 0, 10.5], [10.5, 12, 40], [38.5, 45, 60]]);

  // threadTimeline keeps the cut's identity (via previous), preserves the note, and updates its removed range!
  const links = ctx.repos.versions.links(project.id);
  const read = (v: string) => ctx.repos.versions.get(project.id, v)?.timeline;
  const projected = threadTimeline({ id: "thread", title: "Tighten", changes: [passChange, change], tasks: [], notes: [] } as never, headTl, links, read, 30);
  expect(projected).toHaveLength(2);
  expect(projected[0]).toMatchObject({ changeId: change.id, at: 10.5, reason: "Removed filler before next sentence.", beforeCut: { version: first.version, removed: { start: 10.5, end: 12 } } });
  expect(projected[0]!.previous).toEqual([{ changeId: "chg_pass", spot: 0 }]);

  // ⌘Z revert takes back the adjustment cleanly.
  const { project: reverted } = recordHistoryEdit(ctx, user, project.id, change.appliedVersion!, "revert", after.head!, branch);
  expect(ctx.repos.versions.get(project.id, reverted.head!)!.timeline.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
    .toEqual([[0, 0, 10], [10, 12, 40], [38, 45, 60]]);

  // Pulling edges together to zero puts back the full footage cleanly.
  const { project: restored, change: rej } = adjustAppliedCut(ctx, user, project.id, "thread", target, { start: 12, end: 12 }, reverted.head!, branch);
  expect(rej.rejects).toBe(true);
  expect(ctx.repos.versions.get(project.id, restored.head!)!.timeline.tracks[0]!.clips.length).toBe(2);

  // Opening cut pulled all the way to zero restores the opening footage cleanly too.
  const openCut = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 2, end: 60 }]), { parent: first.version, changeId: "chg_open" });
  ctx.repos.projects.update(project.id, { head: openCut.version });
  const openTarget = { changeId: "chg_open", spot: 0, label: "Trim opening", range: { start: 0, end: 0 }, at: 0, before: { version: first.version, removed: { start: 0, end: 2 } } };
  const { project: openRestored, change: openRej } = adjustAppliedCut(ctx, user, project.id, "thread", openTarget, { start: 0, end: 0 }, openCut.version, branch);
  expect(openRej.rejects).toBe(true);
  expect(ctx.repos.versions.get(project.id, openRestored.head!)!.timeline.tracks[0]!.clips[0]).toMatchObject({ timelineIn: 0, sourceIn: 0, sourceOut: 60 });
});

it("adjusts a non-cut caption edit directly, preserves its kind in threadTimeline, reverts with undo, and removes when pulled to zero", async () => {
  const { threadTimeline } = await import("@scarlet/shared");
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov", duration: 20 }, "ready");
  const base = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 20 }]), { parent: null });
  const withCap = storeVersion(ctx, project.id, {
    ...base,
    tracks: [
      ...base.tracks,
      { id: "c1", kind: "caption", name: "Captions", muted: false, hidden: false, clips: [{ id: "cap_1", kind: "caption", timelineIn: 1, timelineOut: 3, text: "Welcome", enabled: true }] },
    ],
  }, { parent: base.version, changeId: "chg_cap" });
  const capChange = {
    id: "chg_cap", projectId: project.id, description: "Add opening caption", author: { type: "agent" as const, id: "claude", name: "Claude" },
    state: "approved" as const, threadId: "thr_cap", fromVersion: base.version, toVersion: withCap.version, appliedOnto: base.version, appliedVersion: withCap.version,
    ops: [{ op: "addClip", trackId: "c1", clip: { id: "cap_1", kind: "caption", timelineIn: 1, timelineOut: 3, text: "Welcome", enabled: true } }],
    timelineEdits: [{ label: "Opening caption", range: { start: 1, end: 3 }, reason: "Call out intro." }],
    noteIds: [], renders: [], ranges: [{ start: 1, end: 3 }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  ctx.repos.changes.put(capChange);
  ctx.repos.projects.update(project.id, { head: withCap.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";

  const target = { changeId: "chg_cap", spot: 0, label: "Opening caption", range: { start: 1, end: 3 }, kind: "text" };
  const { project: after, change } = adjustAppliedEdit(ctx, user, project.id, "thr_cap", target, { start: 0.5, end: 4.5 }, withCap.version, branch);
  expect(change).toMatchObject({ state: "approved", threadId: "thr_cap", description: "Adjusted · Opening caption" });
  const headTl = ctx.repos.versions.get(project.id, after.head!)!.timeline;
  const cap = headTl.tracks.find(t => t.id === "c1")!.clips[0]!;
  expect(cap.kind === "caption" && [cap.timelineIn, cap.timelineOut]).toEqual([0.5, 4.5]);

  // threadTimeline preserves kind: "text", reason, and previous identity while updating range.
  const links = ctx.repos.versions.links(project.id);
  const read = (v: string) => ctx.repos.versions.get(project.id, v)?.timeline;
  const projected = threadTimeline({ id: "thr_cap", title: "Caption", changes: [capChange, change], tasks: [], notes: [] } as never, headTl, links, read, 30);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ changeId: change.id, kind: "text", reason: "Call out intro.", range: { start: 0.5, end: 4.5 } });
  expect(projected[0]!.previous).toEqual([{ changeId: "chg_cap", spot: 0 }]);

  // ⌘Z revert restores original caption timing.
  const { project: reverted } = recordHistoryEdit(ctx, user, project.id, change.appliedVersion!, "revert", after.head!, branch);
  const revCap = ctx.repos.versions.get(project.id, reverted.head!)!.timeline.tracks.find(t => t.id === "c1")!.clips[0]!;
  expect(revCap.kind === "caption" && [revCap.timelineIn, revCap.timelineOut]).toEqual([1, 3]);

  // Pulling edges together removes the caption and marks the change as rejected.
  const { project: removed, change: rej } = adjustAppliedEdit(ctx, user, project.id, "thr_cap", target, { start: 2, end: 2 }, reverted.head!, branch);
  expect(rej.rejects).toBe(true);
  expect(ctx.repos.versions.get(project.id, removed.head!)!.timeline.tracks.find(t => t.id === "c1")!.clips).toHaveLength(0);
});
