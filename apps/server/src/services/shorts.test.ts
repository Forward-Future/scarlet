import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { storeVersion } from "./timeline.js";
import { taskPrompt } from "./tasks.js";
import { makeShorts } from "./shorts.js";

let directory: string;
let workspace: ScarletApp;
let long: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-shorts-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  const { ctx } = workspace;
  long = ctx.repos.projects.insert(createProject("Weekly interview"));
  ctx.paths.ensureProject(long.id);
  writeFileSync(join(ctx.paths.media(long.id), "cam.mp4"), "the recording");
  writeFileSync(join(ctx.paths.waveforms(long.id), "cam.v4.waveform"), "its waveform");
  writeFileSync(join(ctx.paths.proxies(long.id), "cached-abc.mp4"), "a shared preview");
  ctx.repos.transcripts.put({ id: "trs_cam", projectId: long.id, mediaId: "cam", segments: [
    { id: "s1", start: 0, end: 2, text: "Agents fail without tools.", words: [{ text: "Agents", start: 0, end: 0.5 }] }] });
  ctx.repos.projects.putMedia(long.id, { id: "cam", name: "Camera.mp4", path: "cam.mp4", kind: "video", duration: 120, width: 1920, height: 1080,
    fps: 30, hasAudio: true, transcriptId: "trs_cam" }, "ready");
  const head = storeVersion(ctx, long.id, { version: "draft", parent: null, projectId: long.id, name: "Main", markers: [], background: "#000000",
    tracks: [{ id: "v1", kind: "video", name: "V1", muted: false, hidden: false,
      clips: [{ id: "c1", kind: "media", mediaId: "cam", timelineIn: 0, sourceIn: 10, sourceOut: 100 } as never] }] }, { parent: null });
  long = ctx.repos.projects.update(long.id, { head: head.version });
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, { method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
}

const form = { count: 3, aspect: "9:16", maxSeconds: 60, captions: true, agent: "claude", model: "claude-opus-5-5" };

it("makes a project for each short from the long video's finished edit, and starts the first", async () => {
  const { ctx } = workspace;
  const res = await api("POST", `/projects/${long.id}/shorts`, form);
  expect(res.status).toBe(201);
  const { projects, task } = await res.json() as { projects: Project[]; task: { id: string; projectId: string; instruction: string; context: Record<string, unknown> } };
  expect(projects.map(p => p.name)).toEqual(["Short 1 of 3", "Short 2 of 3", "Short 3 of 3"]);
  for (const short of projects) {
    // Vertical, said to come from the long video until the editor dismisses that line, and not the long video itself.
    expect(short.settings).toMatchObject({ width: 1080, height: 1920, aspect: "9:16", fps: 30 });
    expect(short.source).toEqual({ projectId: long.id, name: "Weekly interview", notice: true });
    const [media] = short.media;
    expect(media).toMatchObject({ name: "Camera.mp4", kind: "video", duration: 120 });
    expect(media!.id).not.toBe("cam");
    // The footage, its transcript and its caches come along, so nothing is imported or transcribed again.
    expect(readFileSync(join(ctx.paths.media(short.id), media!.path), "utf8")).toBe("the recording");
    expect(ctx.repos.transcripts.get(media!.transcriptId!)).toMatchObject({ mediaId: media!.id, projectId: short.id, segments: [{ text: "Agents fail without tools." }] });
    expect(existsSync(join(ctx.paths.waveforms(short.id), `${media!.id}.v4.waveform`))).toBe(true);
    expect(existsSync(join(ctx.paths.proxies(short.id), "cached-abc.mp4"))).toBe(true);
    // It starts as the finished edit, on its own copy of the footage.
    const head = ctx.repos.versions.get(short.id, short.head!)!.timeline;
    expect(head.tracks[0]!.clips[0]).toMatchObject({ mediaId: media!.id, sourceIn: 10, sourceOut: 100 });
  }
  // The long video is as it was.
  expect(ctx.repos.projects.get(long.id)).toMatchObject({ head: long.head, media: [{ id: "cam" }] });
  expect(ctx.repos.projects.get(long.id)!.source).toBeUndefined();

  // Only the first short runs now, with the form's words as the request. No learning check reads them: nobody said them.
  expect(task).toMatchObject({ projectId: projects[0]!.id, instruction: "Make up to 3 vertical shorts, each under 60 s.",
    context: { short: { index: 1, count: 3, sourceProjectId: long.id, sourceName: "Weekly interview", sourceVersion: long.head, projectIds: projects.map(p => p.id) } } });
  expect(ctx.repos.tasks.select("1=1").map(t => t.projectId)).toEqual([projects[0]!.id]);
  expect(taskPrompt(ctx, ctx.repos.tasks.get(task.id)!).systemPrompt).toContain("save them with `shorts_plan` before you cut. This project takes the first.");
});

it("names the shorts for the moments the first run chose, starts the others with theirs, and trashes a short left without one", async () => {
  const { ctx } = workspace;
  const { projects, task } = await (await api("POST", `/projects/${long.id}/shorts`, form)).json() as { projects: Project[]; task: { id: string } };
  // Overlapping moments would make two shorts of the same thing.
  const overlap = await api("POST", `/tasks/${task.id}/shorts-plan`, { moments: [{ start: 5, end: 40, title: "A" }, { start: 30, end: 60, title: "B" }] });
  expect(overlap.status).toBe(400);

  const plan = await api("POST", `/tasks/${task.id}/shorts-plan`, { moments: [
    { start: 5, end: 40, title: "Agents fail without tools" }, { start: 50, end: 80, title: "The wrong flight" }] });
  expect(plan.status).toBe(200);
  expect(ctx.repos.projects.get(projects[0]!.id)!.name).toBe("Agents fail without tools");
  expect(ctx.repos.projects.get(projects[1]!.id)!.name).toBe("The wrong flight");
  expect(ctx.repos.projects.get(projects[2]!.id)).toBeNull();
  const second = ctx.repos.tasks.select("project_id = ?", [projects[1]!.id])[0]!;
  expect(second.context.short).toMatchObject({ index: 2, moment: { start: 50, end: 80, title: "The wrong flight" } });
  expect(taskPrompt(ctx, second).systemPrompt).toContain("This short’s moment, chosen by the first short’s run: 50.00–80.00 s on the copied timeline");
  // Once the others have started, the moments stay as they are.
  expect((await api("POST", `/tasks/${task.id}/shorts-plan`, { moments: [{ start: 5, end: 40, title: "Again" }] })).status).toBe(409);
  // Only the first short's run chooses.
  expect((await api("POST", `/tasks/${second.id}/shorts-plan`, { moments: [{ start: 5, end: 40, title: "Mine" }] })).status).toBe(400);
});

it("keeps the line about where a short came from until the editor dismisses it, and says when that video is gone", async () => {
  const { ctx } = workspace;
  const { projects } = await (await api("POST", `/projects/${long.id}/shorts`, { ...form, count: 1 })).json() as { projects: Project[] };
  const id = projects[0]!.id;
  const { project } = await (await api("PATCH", `/projects/${id}`, { sourceNotice: false })).json() as { project: Project };
  expect(project.source).toEqual({ projectId: long.id, name: "Weekly interview" });
  await api("PATCH", `/projects/${long.id}`, { name: "Interview, final" });
  const listed = (await (await api("GET", "/projects")).json() as { projects: Array<{ id: string; source?: unknown }> }).projects;
  expect(listed.find(p => p.id === id)!.source).toEqual({ projectId: long.id, name: "Interview, final" });
  await api("DELETE", `/projects/${long.id}`);
  expect(ctx.repos.projects.header(id)!.source).toEqual({ projectId: long.id, name: "Interview, final", gone: true });
  // A short isn't made into shorts again: its source is the video to make them from.
  expect((await api("POST", `/projects/${id}/shorts`, form)).status).toBe(400);
});

it("copies only the files the edit plays, and leaves a file without a transcript to be transcribed when a short needs it", async () => {
  const { ctx } = workspace;
  writeFileSync(join(ctx.paths.media(long.id), "unused.mp4"), "never in the edit");
  ctx.repos.projects.putMedia(long.id, { id: "unused", name: "Outtakes.mp4", path: "unused.mp4", kind: "video", duration: 60, width: 1920, height: 1080,
    fps: 30, hasAudio: true, transcriptionOnImport: "whispercpp" }, "ready");
  const cam = ctx.repos.projects.getMedia("cam")!;
  const { projectId: _p, status: _s, error: _e, ...asset } = cam;
  // The camera's transcript hasn't been made yet, and it was to be made on import.
  ctx.repos.projects.putMedia(long.id, { ...asset, transcriptId: undefined, transcriptionOnImport: "whispercpp", transcriptionRevisionOnImport: 0 }, "ready");
  const { projects } = await (await api("POST", `/projects/${long.id}/shorts`, { ...form, count: 2 })).json() as { projects: Project[] };
  for (const short of projects) {
    expect(short.media.map(m => m.name)).toEqual(["Camera.mp4"]);
    expect(readdirSync(ctx.paths.media(short.id))).toEqual([short.media[0]!.path]);
    // Not marked to transcribe on import, so the next launch doesn't start one transcription per short.
    expect(short.media[0]!.transcriptionOnImport).toBeUndefined();
    expect(short.media[0]!.transcriptId).toBeUndefined();
  }
  const waiting = ctx.db.prepare(`SELECT m.id FROM media m WHERE json_extract(m.json, '$.transcriptionOnImport') IS NOT NULL
    AND json_extract(m.json, '$.transcriptId') IS NULL`).all() as Array<{ id: string }>;
  expect(waiting.map(w => w.id).sort()).toEqual(["cam", "unused"]);
});

it("removes the shorts outright, with their footage, when making them fails part-way", async () => {
  const { ctx } = workspace;
  const ids = () => (ctx.db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map(p => p.id);
  const before = ids();
  // The footage went missing from the long video's folder, so the copy for the short fails.
  rmSync(join(ctx.paths.media(long.id), "cam.mp4"));
  await expect(makeShorts(ctx, { id: "u1", name: "Editor" } as never, long.id, { ...form, count: 2 } as never)).rejects.toThrow();
  await Promise.allSettled([...ctx.pending]);
  expect(ids()).toEqual(before);
  expect(ctx.repos.projects.listDeleted()).toEqual([]);
  const folders = readdirSync(join(directory, "projects"));
  expect(folders).toEqual([long.id]);
});
