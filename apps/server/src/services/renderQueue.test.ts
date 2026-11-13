import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FfmpegError } from "@scarlet/render";
import { createProject, makeMediaClip, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { storeVersion } from "./timeline.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;
let version: string;
let lines: string[];
const programs: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-render-queue-test-"));
  const said: string[] = lines = [];
  workspace = createApp({
    dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line),
    render: {
      ...scarletRenderAdapter,
      async renderRange(_project, _timeline, _range, file) { writeFileSync(file, "section"); },
      async renderPlaybackSegment(_project, _timeline, _range, _cache, file) { writeFileSync(file, "fragment"); },
    },
  });
  const { ctx } = workspace;
  project = ctx.repos.projects.insert(createProject("Renders"));
  ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Camera", path: "camera.mp4", duration: 30, hasAudio: true }, "ready");
  version = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null }).version;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const program of programs.splice(0)) program.kill();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };
const section = () => ({ projectId: project.id, version, kind: "segment", quality: "delivery", range: { start: 1, end: 3 } }) as const;

it("yields a speculative fragment to playback, then finishes it before resuming the full cache", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 1 } });
  const order: string[] = [];
  const untilAbort = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  vi.spyOn(ctx.render, "renderFullCached").mockImplementationOnce(async (_p, _t, _c, _out, opts) => {
    order.push("full"); await untilAbort(opts.signal!);
  }).mockImplementation(async (_p, _t, _c, out) => { order.push("full"); writeFileSync(out, "full"); });
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementationOnce(async (_p, _t, _r, _c, _out, opts) => {
    order.push("warm"); await untilAbort(opts.signal!);
  }).mockImplementation(async (_p, _t, range, _c, out) => {
    order.push(range.start ? "play" : "warm"); writeFileSync(out, "fragment");
  });
  const input = { projectId: project.id, version, quality: "preview" } as const;
  const full = ctx.renders.request({ ...input, kind: "full", range: null }, "cache");
  const warm = ctx.renders.request({ ...input, kind: "playback", range: { start: 0, end: 4 }, speculative: true }, "next");
  await vi.waitFor(() => expect(order).toEqual(["full", "warm"]));
  const playing = ctx.renders.request({ ...input, kind: "playback", range: { start: 8, end: 12 } }, "viewer");
  await settle();
  expect(order).toEqual(["full", "warm", "play", "warm", "full"]);
  for (const render of [full, warm, playing]) expect(ctx.repos.renders.get(render.id)?.state).toBe("done");
});

it("promotes the same preparation when its viewer arrives and preserves playback when the preparation leaves", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 1 } });
  let finish!: () => void;
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementationOnce(async (_p, _t, _r, _c, out, opts) => {
    await new Promise<void>(resolve => {
      finish = resolve;
      opts.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    writeFileSync(out, "shared fragment");
  }).mockImplementation(async (_p, _t, _r, _c, out) => { writeFileSync(out, "second fragment"); });
  const input = { projectId: project.id, version, kind: "playback", quality: "preview", range: { start: 0, end: 4 } } as const;
  const warm = ctx.renders.request({ ...input, speculative: true }, "next");
  expect(ctx.renders.request(input, "viewer").id).toBe(warm.id);
  const other = ctx.renders.request({ ...input, range: { start: 8, end: 12 } }, "second viewer");
  ctx.renders.release(warm.id, "next");
  expect(encode.mock.calls[0]![5].signal?.aborted).toBe(false);
  expect(ctx.repos.renders.get(other.id)?.state).toBe("queued");
  finish();
  await settle();
  expect(encode).toHaveBeenCalledTimes(2);
  expect(ctx.repos.renders.get(warm.id)?.state).toBe("done");
});

it.each(["joined", "released"])("keeps the latest export destination when a running render's save is %s", async state => {
  const { ctx } = workspace;
  let finish!: () => void;
  const encoding = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => {
    await encoding;
    writeFileSync(file, "finished");
  });
  const input = { projectId: project.id, version, kind: "full", quality: "delivery", range: null } as const;
  const save = { ticket: 12, name: "Interview.mp4" };
  const owner = crypto.randomUUID();
  try {
    const render = state === "joined" ? ctx.renders.request(input) : ctx.renders.request(input, owner, save);
    expect(ctx.repos.renders.get(render.id)?.state).toBe("running");
    if (state === "joined") {
      expect(ctx.renders.request(input, owner, save).id).toBe(render.id);
    } else {
      // The encoder still has a second reader after the editor cancels the save.
      expect(ctx.renders.request(input, "reader").id).toBe(render.id);
      ctx.renders.release(render.id, owner);
    }
    finish();
    await settle();
    expect(ctx.repos.renders.get(render.id)?.state).toBe("done");
    expect(ctx.renders.exports().map(r => r.export)).toEqual(state === "joined" ? [{ owner, ...save }] : []);
  } finally { finish(); }
});

it("loads only overlapping clips and their sources for playback, in compositing order", async () => {
  const { ctx } = workspace;
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]);
  const clips = timeline.tracks[0]!.clips;
  for (const id of ["later", "overlay", "unused"]) {
    ctx.repos.projects.putMedia(project.id, { id, kind: "video", name: id, path: id + ".mp4", duration: 30 }, "ready");
  }
  clips.push(makeMediaClip("later", 0, 5, 5), makeMediaClip("overlay", 0, 2, 1));
  const v = storeVersion(ctx, project.id, timeline, { parent: version }).version;
  const render = vi.spyOn(ctx.render, "renderPlaybackSegment");
  const allMedia = vi.spyOn(ctx.repos.projects, "listMedia");
  ctx.renders.request({ ...section(), version: v, kind: "playback", quality: "preview", range: { start: 1, end: 5 } });
  await settle();
  expect(allMedia).not.toHaveBeenCalled();
  const [inputs, part] = render.mock.calls[0]!;
  expect(inputs.media.map(m => m.id).sort()).toEqual(["camera", "overlay"]);
  expect(part.tracks[0]!.clips.map(c => c.id)).toEqual([clips[0]!.id, clips[2]!.id]);
});

it.each([
  ["full", "preview", "-pts1", "unstamped"], ["full", "preview", "-pts1", "stamped"], ["full", "preview", "-pts1", "changed"],
  ["full", "delivery", "-mix4", "stamped"], ["export", "preview", "-mix4", "stamped"], ["export", "delivery", "-mix4", "mix3"],
] as const)("retires an old %s %s assembly before %s and validates its %s recovery", async (kind, quality, revision, legacy) => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => { writeFileSync(file, "full"); });
  const input = { ...section(), kind, quality, range: null };
  const initial = ctx.renders.request(input);
  await settle();
  const current = ctx.repos.renders.get(initial.id)!;
  expect(current).toMatchObject({ state: "done", key: expect.stringContaining(revision), previewContentKey: expect.stringContaining(revision) });
  const oldRevision = legacy === "mix3" ? "-mix3" : "";
  const old = ctx.repos.renders.put({ ...current, key: current.key.replace(revision, oldRevision),
    previewContentKey: legacy === "unstamped" ? undefined : current.previewContentKey!.replace(revision, oldRevision) });
  expect(ctx.renders.isCurrent(old, ctx.repos.projects.get(project.id)!)).toBe(false);
  expect(ctx.renders.coveringPreview(project, version, { start: 0, end: 2 }, 0)).toBeUndefined();
  const replacement = ctx.renders.request(input);
  await settle();
  expect(replacement.id).not.toBe(old.id);
  expect(encode).toHaveBeenCalledTimes(2);

  // An interrupted job must validate and rekey even when another worker has since
  // finished the corrected assembly and can supply its bytes.
  ctx.repos.renders.put({ ...old, state: "queued", path: null });
  if (legacy === "changed") {
    ctx.paths.ensureProject(project.id);
    writeFileSync(join(ctx.paths.media(project.id), "camera.mp4"), "different source bytes");
  }
  ctx.renders.recover();
  await settle();
  const retried = ctx.repos.renders.get(old.id)!;
  if (legacy === "changed") {
    expect(retried).toMatchObject({ state: "failed", error: expect.stringContaining("source changed") });
  } else {
    expect(retried).toMatchObject({ state: "done", key: current.key, previewContentKey: current.previewContentKey,
      path: ctx.repos.renders.get(replacement.id)!.path });
  }
  expect(encode).toHaveBeenCalledTimes(2);
});

it("keeps a finished render finished when updating the edits that waited on it throws", async () => {
  const { ctx } = workspace;
  // The listener that moves an edit from rendering to ready reads the edits first. A locked database throws there.
  vi.spyOn(ctx.repos.changes, "select").mockImplementation(() => { throw new Error("database is locked"); });
  const render = ctx.renders.request(section());
  await settle();
  const saved = ctx.repos.renders.get(render.id)!;
  expect(saved).toMatchObject({ state: "done", progress: 1 });
  expect(saved.error).toBeUndefined();
  expect(existsSync(join(ctx.paths.renders(project.id), saved.path!))).toBe(true);
  expect(lines.filter(line => line.startsWith("[review]"))).toEqual([
    `[review] couldn’t update the edits waiting on render ${render.id} (done): database is locked`,
  ]);
  expect(lines.filter(line => line.includes("failed"))).toEqual([]);
});

/** A viewer's render that the engine working on it never finished: the engine was killed. `pid`: the process id it ran under. */
function abandoned(id: string, pid = spawnSync(process.execPath, ["-e", ""]).pid) {
  const { ctx } = workspace;
  const template = ctx.renders.request({ ...section(), kind: "playback", quality: "preview" }, "viewer");
  return ctx.repos.renders.put({ ...template, id, state: "running", progress: 0.4, queuePid: pid, demandPid: pid });
}

/**
 * A process that is running now: another engine at work, or whatever program was since given a killed engine's process id.
 * `began`: when it began, as an engine running in it notes.
 */
async function running(): Promise<{ pid: number; began: number }> {
  const program = spawn(process.execPath, ["-e", "console.log(performance.timeOrigin); setTimeout(() => {}, 60_000)"], { stdio: ["ignore", "pipe", "ignore"] });
  programs.push(program);
  const [began] = await once(program.stdout!, "data");
  return { pid: program.pid!, began: Number(began) };
}

/** What an engine notes as it starts: when it began, beside its process id. */
const noteStart = (pid: number, began: number) =>
  workspace.ctx.db.prepare("INSERT OR REPLACE INTO engines (pid, started_at) VALUES (?, ?)").run(pid, began);

/** A round of recovery, the time it takes to learn when a process began, and the round after. */
async function recovered(id: string) {
  const { ctx } = workspace;
  ctx.renders.recover();
  await settle();
  ctx.renders.recover();
  return ctx.repos.renders.get(id)?.state;
}

it("removes the file a killed engine was writing when it gives up that viewer's render", async () => {
  const { ctx } = workspace;
  const render = abandoned("rnd_killed");
  await settle();
  const file = join(ctx.paths.renders(project.id), `${render.id}.mp4`);
  writeFileSync(file, "half an encode");
  ctx.renders.recover();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("cancelled");
  expect(existsSync(file)).toBe(false);
});

it("still gives up a killed engine's render when its unfinished file can't be removed", async () => {
  const { ctx } = workspace;
  const render = abandoned("rnd_held");
  await settle();
  // Windows refuses to remove a file another program holds open. A folder in its place is refused everywhere.
  const file = join(ctx.paths.renders(project.id), `${render.id}.mp4`);
  mkdirSync(file);
  lines.length = 0;
  expect(() => ctx.renders.recover()).not.toThrow();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("cancelled");
  expect(lines.filter(line => line.includes("couldn’t remove"))).toEqual([
    expect.stringMatching(/^\[render\] rnd_held couldn’t remove the file its engine left unfinished: .+/),
  ]);
  // Given up for good: the next round has nothing to do, and says nothing.
  lines.length = 0;
  ctx.renders.recover();
  expect(lines).toEqual([]);
});

// Only macOS is asked when a process began: elsewhere a render stays with whatever process has its engine's id.
it.runIf(process.platform === "darwin")("gives up a killed engine's render once another program has its process id", async () => {
  const { ctx } = workspace;
  const { pid: program } = await running();
  // The engine noted that it began an hour before the program that has its id now did.
  noteStart(program, Date.now() - 3_600_000);
  const render = abandoned("rnd_reused", program), stopped = abandoned("rnd_stopped", program);
  await settle();
  const file = join(ctx.paths.renders(project.id), `${render.id}.mp4`);
  writeFileSync(file, "half an encode");
  // The first rounds only ask when that process began, once between them. Until that is known the renders are still its engine's.
  ctx.renders.recover();
  ctx.renders.recover();
  expect(ctx.pending.size).toBe(1);
  expect(ctx.renders.cancel(stopped.id)?.state).toBe("running");
  expect(ctx.repos.renders.get(render.id)?.state).toBe("running");
  await settle();
  expect(lines.filter(line => line.startsWith("[engine]"))).toEqual([expect.stringMatching(new RegExp(
    `^\\[engine\\] process ${program} began at least \\d+m( \\d+s)? after the engine that noted that id, so it is another program: what that engine left claimed is free$`))]);
  // Stopping one works now, and the next round gives up the other.
  expect(ctx.renders.cancel(stopped.id)?.state).toBe("cancelled");
  ctx.renders.recover();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("cancelled");
  expect(existsSync(file)).toBe(false);
});

it("leaves a render with the engine that claimed it for as long as that engine runs", async () => {
  const engine = await running();
  const render = abandoned("rnd_claimed", engine.pid);
  await settle();
  // An engine from before engines noted when they began: there is nothing to hold its process id against.
  expect(await recovered(render.id)).toBe("running");
  // What an engine notes of itself and what is then learned of its process agree.
  noteStart(engine.pid, engine.began);
  expect(await recovered(render.id)).toBe("running");
});

it("logs each warning the renderer gives with the render it belongs to", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file, opts) => {
    opts.onWarning?.("clip clp_1: media med_gone not in project; skipped");
    opts.onWarning?.("no font file found for \"Inter\";\n relying on fontconfig");
    writeFileSync(file, "section");
  });
  const render = ctx.renders.request(section());
  await settle();
  expect(ctx.repos.renders.get(render.id)?.state).toBe("done");
  expect(lines.filter(line => line.includes("warning"))).toEqual([
    `[render] ${render.id} warning: clip clp_1: media med_gone not in project; skipped`,
    `[render] ${render.id} warning: no font file found for "Inter"; relying on fontconfig`,
  ]);
});

it.each([
  ["a source file is gone", (media: string) => [`${media}/camera.mp4: No such file or directory\nError opening input file ${media}/camera.mp4.`, false],
    "Scarlet can’t find “Camera” in this project’s files: export the logs from Settings → Advanced to report it."],
  ["a source file can't be decoded", (media: string) => [`[mov,mp4,m4a,3gp,3g2,mj2 @ 0x7f8] moov atom not found\n${media}/camera.mp4: Invalid data found when processing input`, true],
    "Scarlet can’t read “Camera” in this project’s files: export the logs from Settings → Advanced to report it."],
  // The source is gone too, but ffmpeg named another file: that one is what it couldn't open.
  ["ffmpeg can't open a file that isn't a source", (media: string) => [`${media}/../luts/grade.cube: No such file or directory`, false], "Scarlet couldn’t render this part of the video: try once more, or export the logs from Settings → Advanced to report it."],
  ["the disk is full", () => ["[out#0/mp4 @ 0x600] Error writing trailer: No space left on device", true],
    "There isn’t enough free disk space to render this: free some space, then try again."],
  ["ffmpeg fails for its own reasons", () => ["[fc#0 @ 0x600] Error reinitializing filters!\nFailed to inject frame into filter network: Invalid argument", true], "Scarlet couldn’t render this part of the video: try once more, or export the logs from Settings → Advanced to report it."],
] as const)("says why a render failed in plain words when %s, and keeps ffmpeg's own output in the log and for an agent", async (_why, wrote, said) => {
  const { ctx } = workspace;
  const media = ctx.paths.media(project.id);
  const [stderr, present] = wrote(media);
  if (present) { mkdirSync(media, { recursive: true }); writeFileSync(join(media, "camera.mp4"), "footage"); }
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async () => {
    throw new FfmpegError(`ffmpeg exited with code 1:\n${stderr}\n--- filter graph ---\n[0:v]trim=start=1:end=3[v0]`, "ffmpeg", [], 1, stderr);
  });
  const render = ctx.renders.request(section());
  await settle();
  const raw = `ffmpeg exited with code 1:\n${stderr}\n--- filter graph ---\n[0:v]trim=start=1:end=3[v0]`;
  expect(ctx.repos.renders.get(render.id)).toMatchObject({ state: "failed", error: said, errorDetail: raw });
  expect(lines.filter(line => line.startsWith(`[render] ${render.id} failed:`))).toEqual([`[render] ${render.id} failed: ${raw}`]);
});
