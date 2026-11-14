import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { packSheet, renderTimelineFrame, runCapture } from "@scarlet/render";
import { createProject, emptyTimeline } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { inspectionPictures } from "./inspectionPictures.js";

vi.mock("@scarlet/render", async original => ({
  ...await original<typeof import("@scarlet/render")>(),
  buildFilterGraph: vi.fn(async () => ({ args: [], cleanup: async () => {} })),
  renderTimelineFrame: vi.fn(),
  runCapture: vi.fn(),
  // The sheet lists its frames in the order it was given them.
  packSheet: vi.fn(async (frames: Buffer[], timestamps: number[]) =>
    ({ timestamps, columns: 3, jpeg: frames.map(frame => frame.toString()).join(",") })),
}));

const fps = 30, frameBytes = 320 * 180 * 3 / 2;
interface Still { frame: number; signal: AbortSignal; resolve(jpeg: Buffer): void; reject(error: Error): void }
let stills: Still[], rendering: number, mostAtOnce: number, failing: number | undefined, root = 0;

beforeEach(() => {
  stills = [];
  rendering = mostAtOnce = 0;
  failing = undefined;
  vi.mocked(renderTimelineFrame).mockImplementation((_project, _timeline, range, _mediaRoot, signal) => {
    const frame = Math.round(range.start * fps);
    if (frame === failing) return Promise.reject(new Error(`No timeline frame at ${range.start}s`));
    mostAtOnce = Math.max(mostAtOnce, ++rendering);
    return new Promise<Buffer>((resolve, reject) => {
      const done = () => { rendering--; signal!.removeEventListener("abort", abort); };
      const abort = () => { done(); reject(signal!.reason); };
      signal!.addEventListener("abort", abort, { once: true });
      stills.push({ frame, signal: signal!, resolve: jpeg => { done(); resolve(jpeg); }, reject: error => { done(); reject(error); } });
    });
  });
});
afterEach(() => vi.clearAllMocks());

function engine() {
  const project = createProject("Contact sheets", { width: 3840, height: 2160, fps });
  const timeline = { ...emptyTimeline(project.id), version: "v1" };
  const ctx = {
    projectSignal: () => new AbortController().signal,
    track: <T>(work: Promise<T>) => work,
    settings: () => ({ render: { previewHeight: 360, hwaccel: "none" } }),
    // Each engine gets its own picture lane.
    paths: { root: `/sheets-${root++}`, media: () => "/media" },
    renders: { inspectionKey: () => "pictures", coveringPreview: () => undefined },
    log: () => {},
  } as unknown as Ctx;
  const pictures = inspectionPictures(ctx);
  return (mode: "uniform" | "scene" | "activity", count = 9, signal?: AbortSignal, range = { start: 10, end: 20 }) =>
    pictures(project, timeline, range, mode, count, undefined, signal);
}
const finish = (still: Still) => still.resolve(Buffer.from(`frame ${still.frame}`));

it("renders a sheet's stills together and keeps them in order when they finish out of order", async () => {
  const sheet = engine()("uniform");
  // Two at a time, the stills cache's workers, before either is done.
  await vi.waitFor(() => expect(stills).toHaveLength(2));
  for (let n = 2; n < 9; n++) {
    finish(stills.at(-1)!);
    await vi.waitFor(() => expect(stills).toHaveLength(n + 1));
  }
  // The first still is the last to finish.
  finish(stills[8]!);
  finish(stills[0]!);
  const { jpeg } = await sheet;
  const frames = stills.map(still => still.frame);
  expect(frames).toEqual([...frames].sort((a, b) => a - b));
  expect(jpeg).toBe(frames.map(frame => `frame ${frame}`).join(","));
  expect(mostAtOnce).toBe(2);
});

it("stops a sheet's other stills once one fails", async () => {
  const sheet = engine()("uniform");
  await vi.waitFor(() => expect(stills).toHaveLength(2));
  const second = stills[1]!;
  // The second still can't be drawn, on the GPU or the CPU.
  failing = second.frame;
  second.reject(new Error("decoder failed"));
  await expect(sheet).rejects.toThrow(`No timeline frame at ${failing / fps}s`);
  await new Promise(resolve => setTimeout(resolve, 20));
  // The others never ran or were stopped as they began.
  expect(stills.filter(still => still !== second && !still.signal.aborted)).toEqual([]);
  expect(stills.length).toBeLessThanOrEqual(3);
  expect(rendering).toBe(0);
});

it("stops every still when the request goes away", async () => {
  const request = new AbortController();
  const sheet = engine()("uniform", 9, request.signal);
  await vi.waitFor(() => expect(stills).toHaveLength(2));
  request.abort(new Error("left the page"));
  await expect(sheet).rejects.toThrow("left the page");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(stills).toHaveLength(2);
  expect(stills.every(still => still.signal.aborted)).toBe(true);
  expect(rendering).toBe(0);
});

it("renders a sheet asked for twice at once only once", async () => {
  const sheets = engine();
  const both = Promise.all([sheets("uniform"), sheets("uniform")]);
  for (let n = 0; n < 9; n++) {
    await vi.waitFor(() => expect(stills.length).toBeGreaterThan(n));
    finish(stills[n]!);
  }
  await both;
  expect(packSheet).toHaveBeenCalledTimes(1);
});

it("renders a one-frame sheet", async () => {
  const sheet = engine()("uniform", 1);
  await vi.waitFor(() => expect(stills).toHaveLength(1));
  finish(stills[0]!);
  expect((await sheet).jpeg).toBe(`frame ${stills[0]!.frame}`);
});

it("packs scene and activity sheets from the tiles they read, without stills", async () => {
  // Every decoded tile is one byte value; no scene change is printed, so a scene sheet keeps its uniform samples.
  vi.mocked(runCapture).mockImplementation(async (_bin, _args, options) => {
    const tiles = (options!.maxStdout! - frameBytes) / frameBytes;
    return { stdout: Buffer.concat(Array.from({ length: tiles }, (_, n) => Buffer.alloc(frameBytes, n))), stderr: "" } as Awaited<ReturnType<typeof runCapture>>;
  });
  const sheets = engine();
  for (const [mode, range] of [["scene", { start: 10, end: 20 }], ["activity", { start: 10, end: 12 }]] as const) {
    await sheets(mode, 9, undefined, range);
    const [frames, , raw] = vi.mocked(packSheet).mock.calls.at(-1)!;
    expect(raw).toBe(true);
    expect(frames.every(frame => frame.length === frameBytes)).toBe(true);
  }
  expect(renderTimelineFrame).not.toHaveBeenCalled();
});
