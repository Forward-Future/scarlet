// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Render } from "@scarlet/shared";
import { api } from "../../lib/client";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore } from "../../stores/project";
import { usePlaybackCache } from "./usePlaybackCache";

const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const version = project.head!;
const full = db.renders.find(r => r.kind === "full")!;
const initialStore = useProjectStore.getState();
let root: Root;
let container: HTMLDivElement;
let start: () => void;

type Options = Parameters<typeof usePlaybackCache>[1];
function Cache({ options, paused = false }: { options: Options; paused?: boolean }) {
  const { cache, startCache } = usePlaybackCache(paused ? { ...project, mediaPaused: true } : project, options);
  start = startCache;
  return <output>{cache ? [cache.state, cache.url, cache.progress].filter(v => v !== undefined).join(" ") : "unknown"}</output>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useProjectStore.setState({ current: { id: PRJ, project, timeline: null, media: project.media, changes: [], notes: [], renders: [], tasks: [], taskEvents: {} } });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useProjectStore.setState(initialStore, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (state: Render["state"], over: Partial<Render> = {}): Render => ({ ...full, id: "rnd_cache", key: "preview-key", progress: 0, state, ...over });
const listed = (...renders: Render[]) => vi.spyOn(api, "renders").mockResolvedValue({ renders, fullRenderKeys: { context: "ctx", preview: "preview-key", delivery: "delivery-key" } });
const show = (options: Options, paused?: boolean) => act(async () => root.render(<Cache options={options} paused={paused} />));
const after = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const state = () => container.textContent;

it("uses the saved file a version already has, and asks for nothing more", async () => {
  // A cancelled render and one for other settings are not this version's file.
  const renders = listed(render("cancelled", { id: "rnd_gone" }), render("done", { id: "rnd_other", key: "another-key" }), render("failed", { id: "rnd_failed" }), render("done"));
  const request = vi.spyOn(api, "requestRender");
  await show({ version });
  expect(renders).toHaveBeenCalledWith(PRJ, { kind: "full", version });
  expect(state()).toBe(`ready ${api.renderFileUrl("rnd_cache")}`);
  await after(10_000);
  expect(renders).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});

it("knows nothing without a version or a clip, and leaves a version with no file alone until asked", async () => {
  const renders = listed();
  const request = vi.spyOn(api, "requestRender").mockResolvedValue({ render: render("queued") });
  await show({});
  expect(state()).toBe("unknown");
  expect(renders).not.toHaveBeenCalled();
  await show({ version });
  expect(state()).toBe("uncached");
  await after(5000);
  expect(request).not.toHaveBeenCalled();
  // Asked by the editor, it prepares the file without owning the render: nothing gives it up when the player goes.
  const release = vi.spyOn(api, "releaseRender").mockResolvedValue(undefined as never);
  await act(async () => start());
  expect(request).toHaveBeenCalledWith(PRJ, { version, kind: "full", quality: "preview" });
  expect(state()).toBe("caching 0");
  await act(async () => root.render(null));
  expect(release).not.toHaveBeenCalled();
});

it("prepares a missing file by itself after a moment, and gives the render up if the player goes first", async () => {
  listed();
  const request = vi.spyOn(api, "requestRender").mockResolvedValue({ render: render("running", { progress: 0.25 }) });
  const release = vi.spyOn(api, "releaseRender").mockResolvedValue(undefined as never);
  await show({ version, automatic: true });
  expect(state()).toBe("uncached");
  // Switching cuts quickly shouldn't start a render for each: it waits three quarters of a second.
  await after(749);
  expect(request).not.toHaveBeenCalled();
  await after(1);
  expect(request).toHaveBeenCalledTimes(1);
  const owner = (request.mock.calls[0]![1] as { owner?: string }).owner;
  expect(owner).toEqual(expect.any(String));
  expect(state()).toBe("caching 0.25");
  // The render was started for this player alone, so leaving stops it for whoever else doesn't need it.
  await act(async () => root.render(null));
  expect(release).toHaveBeenCalledWith("rnd_cache", owner);
});

it("keeps a render it started once the file is done, and doesn't start one while media processing is paused", async () => {
  listed();
  const request = vi.spyOn(api, "requestRender").mockResolvedValue({ render: render("running") });
  const release = vi.spyOn(api, "releaseRender").mockResolvedValue(undefined as never);
  await show({ version, automatic: true });
  await after(750);
  expect(state()).toBe("caching 0");
  // The engine says the render is done. The file is used at once, and it is no longer this player's to give up.
  await act(async () => useProjectStore.setState(s => ({ current: { ...s.current!, renders: [render("done")] } })));
  expect(state()).toBe(`ready ${api.renderFileUrl("rnd_cache")}`);
  await act(async () => root.render(null));
  expect(release).not.toHaveBeenCalled();
  request.mockClear();
  await show({ version, automatic: true }, true);
  await after(5000);
  expect(request).not.toHaveBeenCalled();
  expect(state()).toBe("uncached");
});

it("waits longer between tries while the engine can't be reached, up to 8 seconds, and starts over once it answers", async () => {
  listed(render("running"));
  const down = () => Promise.reject(new TypeError("Failed to fetch"));
  const read = vi.spyOn(api, "render").mockImplementation(down);
  await show({ version });
  expect(state()).toBe("caching 0");
  // No word from the engine in 1.2 seconds: ask how the render is doing.
  const tries = async (...waits: number[]) => {
    for (const wait of waits) {
      const before = read.mock.calls.length;
      await after(wait - 1);
      expect(read).toHaveBeenCalledTimes(before);
      await after(1);
      expect(read).toHaveBeenCalledTimes(before + 1);
    }
  };
  await tries(1200);
  // The connection is down. The render may still be writing, so it stays "caching" and each try waits twice as long.
  await tries(1200, 2400, 4800, 8000, 8000);
  expect(state()).toBe("caching 0");
  // The engine answers: still rendering. The next drop starts again from the short wait.
  read.mockResolvedValueOnce({ render: render("running", { progress: 0.5 }) });
  await tries(8000);
  expect(state()).toBe("caching 0.5");
  read.mockImplementation(down);
  await tries(1200, 1200, 2400);
  // Then it finishes.
  read.mockResolvedValue({ render: render("done") });
  await tries(4800);
  expect(state()).toBe(`ready ${api.renderFileUrl("rnd_cache")}`);
  await after(20_000);
  expect(read).toHaveBeenCalledTimes(11);
});

it("says the file failed when the engine refuses, instead of trying forever", async () => {
  listed(render("running"));
  const read = vi.spyOn(api, "render").mockRejectedValue(new Error("No such render"));
  await show({ version });
  await after(1200);
  expect(state()).toBe("failed");
  await after(20_000);
  expect(read).toHaveBeenCalledTimes(1);
  // A list that can't be read at all is a failure too.
  vi.spyOn(api, "renders").mockRejectedValue(new TypeError("Failed to fetch"));
  await show({ version, settingsRevision: 1 });
  expect(state()).toBe("failed");
});

it("follows a source clip's own cache, preparing it when asked", async () => {
  const cache = vi.spyOn(api, "sourceCache").mockResolvedValueOnce({ state: "uncached" })
    .mockResolvedValueOnce({ state: "caching", progress: 0.4 })
    .mockResolvedValue({ state: "ready", fileKey: "key-1" });
  await show({ mediaId: "med_a" });
  expect(cache).toHaveBeenLastCalledWith("med_a", false);
  expect(state()).toBe("uncached");
  await act(async () => start());
  expect(cache).toHaveBeenLastCalledWith("med_a", true);
  expect(state()).toBe("caching 0.4");
  await after(1200);
  expect(cache).toHaveBeenLastCalledWith("med_a", false);
  expect(state()).toBe(`ready ${api.sourceCacheUrl("med_a", "key-1")}`);
  await after(10_000);
  expect(cache).toHaveBeenCalledTimes(3);
});
