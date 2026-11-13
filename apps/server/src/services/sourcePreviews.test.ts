import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import type { SourceCacheStatus } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import type { RenderAdapter } from "../render/adapter.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { cacheTimeLeft, prepareSourceProxies, recoverSourcePreviews } from "./sourcePreviews.js";

function estimator() {
  let at = 0;
  const timeLeft = cacheTimeLeft(() => at);
  return (seconds: number, fraction: number) => { at = seconds * 1000; return timeLeft(fraction); };
}

it("estimates a cache's time left from its pace, once there's enough of it to go on", () => {
  const report = estimator();
  expect(report(0, 0)).toBeUndefined();
  expect(report(3, 0.006)).toBeUndefined();
  // 4% in a minute leaves 24 minutes at the same pace.
  expect(report(60, 0.04)).toBe(1440);
  expect(report(750, 0.5)).toBe(750);
  expect(report(1500, 1)).toBeUndefined();
});

it("measures a resumed cache's pace from where its own encoding began, not from the parts it kept", () => {
  const report = estimator();
  // The kept parts are counted as the run starts.
  expect(report(0, 0.125)).toBeUndefined();
  expect(report(0.1, 0.25)).toBeUndefined();
  expect(report(4, 0.26)).toBeUndefined();
  // A quarter in 100 s since then, with half still to go.
  expect(report(100.1, 0.5)).toBe(200);
});

/**
 * An engine with one project of two ready videos and a voice recording. An encode hangs until it is stopped, as a
 * long one does, until `finish` lets them complete. `reopen` quits the engine and launches it again on the same library.
 */
async function withVideos(render: Partial<RenderAdapter>, options: { prepareSourceProxies?: boolean },
  run: (engine: { app(): ScarletApp; reopen(): Promise<void>; projectId: string; encode: ReturnType<typeof vi.fn<RenderAdapter["makeProxy"]>>;
    finish(): void; settle(): Promise<void>; states(): Promise<Record<string, string>>; api(method: string, path: string, body?: unknown): Promise<Response> }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "scarlet-source-caches-"));
  let finished = false;
  const encode = vi.fn<RenderAdapter["makeProxy"]>(async (_, file, opts) => {
    if (finished) return writeFileSync(file, "complete");
    await new Promise<void>((_, reject) => opts.signal!.addEventListener("abort", () => reject(Error("stopped")), { once: true }));
  });
  const open = () => createApp({ dataDir: dir, skillsSeedDir: join(dir, "empty-seed"), env: {}, log: () => {}, ...options,
    render: { ...scarletRenderAdapter, makeProxy: encode, ...render } });
  let app = open();
  try {
    const project = app.ctx.repos.projects.insert(createProject("Test"));
    app.ctx.paths.ensureProject(project.id);
    for (const id of ["first", "second"]) {
      app.ctx.repos.projects.putMedia(project.id, { id, name: id, path: id + ".mov", kind: "video", duration: 90, previewMode: "on-demand" }, "ready");
      writeFileSync(join(app.ctx.paths.media(project.id), id + ".mov"), "recording " + id);
    }
    app.ctx.repos.projects.putMedia(project.id, { id: "voice", name: "voice", path: "voice.wav", kind: "audio", duration: 90 }, "ready");
    const api = (method: string, path: string, body?: unknown) => app.app.request("/api" + path, { method, body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${accessToken(app.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
    await run({
      app: () => app, projectId: project.id, encode, api, finish: () => { finished = true; },
      async reopen() { await app.ctx.close(); app = open(); },
      async settle() { while (app.ctx.pending.size) await Promise.allSettled([...app.ctx.pending]); },
      // Each video's cache as Media reads it: its state, and whether it is waiting or held.
      async states() {
        const { caches } = await (await api("GET", `/projects/${project.id}/playback-caches`)).json() as { caches: SourceCacheStatus[] };
        return Object.fromEntries(caches.map(c => [c.mediaId, c.state + (c.queued ? ", queued" : "")]));
      },
    });
  } finally {
    await app.ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(["pause", "quit"])("keeps a video that was waiting to cache through a %s, and caches it afterwards", how => withVideos({}, {}, async engine => {
  prepareSourceProxies(engine.app().ctx, ["first", "second"], true);
  await vi.waitFor(() => expect(engine.encode).toHaveBeenCalledTimes(1));
  expect(await engine.states()).toEqual({ first: "caching", second: "uncached, queued" });
  if (how === "pause") {
    await engine.api("PATCH", `/projects/${engine.projectId}`, { mediaPaused: true });
    await engine.settle();
    // Both are held, the one that never started too: Media says Caching paused, not Not cached.
    expect(await engine.states()).toEqual({ first: "uncached, queued", second: "uncached, queued" });
    engine.finish();
    await engine.api("PATCH", `/projects/${engine.projectId}`, { mediaPaused: false });
  } else {
    engine.finish();
    await engine.reopen();
  }
  await engine.settle();
  expect(await engine.states()).toEqual({ first: "ready", second: "ready" });
  // Nothing is left written down once they are cached.
  expect(engine.app().ctx.db.prepare("SELECT media_id FROM source_cache_requests").all()).toEqual([]);
}));

// Only macOS is asked when a process began: elsewhere a cache stays with whatever process has its engine's id.
it.runIf(process.platform === "darwin")("caches a video a killed engine was caching once another program has its process id", () => withVideos({}, {}, async engine => {
  const { ctx } = engine.app();
  const program = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    // The engine noted that it began an hour before the program that has its id now did.
    ctx.db.prepare("INSERT INTO engines (pid, started_at) VALUES (?, ?)").run(program.pid, Date.now() - 3_600_000);
    ctx.db.prepare("INSERT INTO source_cache_requests VALUES ('first', ?)").run(program.pid);
    engine.finish();
    // Media's first look only asks when that process began. Until that is known the cache is still its engine's.
    expect(await engine.states()).toEqual({ first: "caching", second: "uncached" });
    await engine.settle();
    recoverSourcePreviews(ctx);
    await engine.settle();
    expect(await engine.states()).toEqual({ first: "ready", second: "uncached" });
    expect(ctx.db.prepare("SELECT media_id FROM source_cache_requests").all()).toEqual([]);
  } finally { program.kill(); }
}));

it("writes down a cache nobody asked for only where the GPU can make it, and never a file it can't cache", async () => {
  const waiting = (app: ScarletApp) => (app.ctx.db.prepare("SELECT media_id FROM source_cache_requests ORDER BY media_id").all() as { media_id: string }[]).map(row => row.media_id);
  for (const gpu of [false, true]) {
    await withVideos({ hardwareProxies: async () => gpu }, { prepareSourceProxies: true }, async engine => {
      prepareSourceProxies(engine.app().ctx, ["first", "second"]);
      if (!gpu) {
        // Resume and relaunch cache whatever is written down, so a video the GPU can't encode must not be.
        await engine.settle();
        expect(engine.encode).not.toHaveBeenCalled();
        return expect(waiting(engine.app())).toEqual([]);
      }
      await vi.waitFor(() => expect(engine.encode).toHaveBeenCalledTimes(1));
      expect(waiting(engine.app())).toEqual(["first", "second"]);
      // A recording with no picture takes its turn and is let go.
      prepareSourceProxies(engine.app().ctx, ["voice"], true);
      await engine.api("PATCH", `/projects/${engine.projectId}`, { mediaPaused: true });
      await engine.settle();
      expect(waiting(engine.app())).toEqual(["first", "second"]);
    });
  }
});

it("says which video couldn't be cached and why, and shows it as failed", () => withVideos({
  makeProxy: async () => { throw new Error("encoder exited with code 1"); },
}, {}, async engine => {
  const lines: string[] = [];
  engine.app().ctx.log = line => lines.push(line);
  prepareSourceProxies(engine.app().ctx, ["first"], true);
  await engine.settle();
  expect(lines).toEqual(["[media] first couldn’t cache its source preview: Error: encoder exited with code 1"]);
  expect(await engine.states()).toEqual({ first: "failed", second: "uncached" });
  // Nothing is left written down for a cache that failed: it is not retried by itself.
  expect(engine.app().ctx.db.prepare("SELECT media_id FROM source_cache_requests").all()).toEqual([]);
}));

it("logs a GPU that can't be asked about, and a video whose turn to cache couldn't start", async () => {
  await withVideos({ hardwareProxies: async () => { throw new Error("no driver"); } }, { prepareSourceProxies: true }, async engine => {
    const lines: string[] = [];
    engine.app().ctx.log = line => lines.push(line);
    prepareSourceProxies(engine.app().ctx, ["first", "second"]);
    await engine.settle();
    expect(lines).toEqual(["[media] couldn’t check for a GPU to prepare 2 source proxies: Error: no driver"]);
    expect(engine.encode).not.toHaveBeenCalled();
  });
  await withVideos({}, {}, async engine => {
    const { ctx } = engine.app();
    const lines: string[] = [];
    ctx.log = line => lines.push(line);
    const proxies = vi.spyOn(ctx.paths, "proxies").mockImplementation(() => { throw new Error("EACCES: permission denied"); });
    prepareSourceProxies(ctx, ["first"], true);
    await engine.settle();
    expect(lines).toEqual(["[media] first couldn’t prepare its source proxy: Error: EACCES: permission denied"]);
    proxies.mockRestore();
  });
});

it("logs a cache whose status can't be read once, however often the window asks", () => withVideos({}, {}, async engine => {
  const { ctx } = engine.app();
  const lines: string[] = [];
  ctx.log = line => lines.push(line);
  const proxies = vi.spyOn(ctx.paths, "proxies").mockImplementation(() => { throw new Error("EACCES: permission denied"); });
  // Media polls this while it is open.
  for (let poll = 0; poll < 5; poll++) expect(await engine.states()).toEqual({ first: "failed", second: "failed" });
  expect(lines.filter(line => line.startsWith("[media]")).sort()).toEqual([
    "[media] first couldn’t read its playback cache: EACCES: permission denied",
    "[media] second couldn’t read its playback cache: EACCES: permission denied",
  ]);
  proxies.mockRestore();
  expect(await engine.states()).toEqual({ first: "uncached", second: "uncached" });
}));
