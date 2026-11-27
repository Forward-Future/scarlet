import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type MediaAsset } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import type { FacesResult, FaceTrack } from "./faces.js";
import { binMouthMotion, mouthActivity, prominentFaceTracks, MOUTH_ACTIVITY_RATE } from "./mouthActivity.js";

// The face reader and the FFmpeg mouth measure are the native boundary: the test says what they find.
const native = vi.hoisted(() => ({
  faces: vi.fn(),
  mouthMotion: vi.fn(),
}));
vi.mock("./faces.js", async real => ({ ...await real<typeof import("./faces.js")>(), faces: native.faces }));
vi.mock("@scarlet/render", async real => ({ ...await real<typeof import("@scarlet/render")>(), mouthMotion: native.mouthMotion }));

let directory: string;
let workspace: ScarletApp;
let projectId: string;

beforeEach(() => {
  // The real path, as the media is read from: /private/var on macOS, not the /var link.
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "scarlet-mouth-activity-test-")));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  projectId = workspace.ctx.repos.projects.insert(createProject("Two cameras")).id;
  workspace.ctx.paths.ensureProject(projectId);
  writeFileSync(join(workspace.ctx.paths.media(projectId), "wide.mp4"), "");
  workspace.ctx.repos.settings.update({ render: { hwaccel: "none" } });
  native.faces.mockReset();
  native.mouthMotion.mockReset();
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function video(over: Partial<MediaAsset> = {}): MediaAsset & { projectId: string } {
  return { id: "wide", name: "Wide", path: "wide.mp4", kind: "video", duration: 40, width: 1920, height: 1080, fps: 60, projectId, ...over };
}
const track = (n: number, seconds: number, confidence = 0.9, box: FaceTrack["box"] = [0.2, 0.2, 0.6, 0.7]): FaceTrack =>
  ({ track: n, start: 0, end: seconds, seconds, box, eyes: [0.4, 0.4], confidence });
const found = (tracks: FaceTrack[], over: Partial<FacesResult> = {}): FacesResult =>
  ({ mediaId: "wide", from: 0, to: 40, tracks, spans: [], readSeconds: 40, done: true, ...over });

it("refuses what isn't a video, a recording still being prepared, and a recording whose file is gone", async () => {
  const { ctx } = workspace;
  await expect(mouthActivity(ctx, video({ kind: "audio" }), [{ from: 0, to: 5 }])).rejects.toThrow("Only a video");
  for (const missing of [{ duration: undefined }, { width: undefined }, { height: undefined }, { fps: undefined }]) {
    await expect(mouthActivity(ctx, video(missing), [{ from: 0, to: 5 }])).rejects.toThrow("still being prepared");
  }
  await expect(mouthActivity(ctx, video({ path: "../outside.mp4" }), [{ from: 0, to: 5 }])).rejects.toThrow("file is missing");
  expect(native.faces).not.toHaveBeenCalled();
});

it("answers at once with no faces when every stretch falls outside the recording or is too short to measure", async () => {
  const result = await mouthActivity(workspace.ctx, video(), [{ from: 45, to: 50 }, { from: 10, to: 10.4 }, { from: 39.8, to: 60 }]);
  expect(result).toEqual({ mediaId: "wide", sampleRate: MOUTH_ACTIVITY_RATE, faces: [], done: true });
  expect(native.faces).not.toHaveBeenCalled();
});

it("says the faces are still being read, and why reading stopped, when none are found yet", async () => {
  native.faces.mockResolvedValue(found([], { done: false, error: "The face model wouldn't load." }));
  expect(await mouthActivity(workspace.ctx, video(), [{ from: 0, to: 5 }])).toEqual({ mediaId: "wide", sampleRate: 5, faces: [], done: false, error: "The face model wouldn't load." });
  native.faces.mockResolvedValue(found([], { done: false }));
  expect(await mouthActivity(workspace.ctx, video(), [{ from: 0, to: 5 }])).toEqual({ mediaId: "wide", sampleRate: 5, faces: [], done: false });
  expect(native.mouthMotion).not.toHaveBeenCalled();
});

it("measures no mouth when the only faces are brief or doubtful, and passes on how far the reading got", async () => {
  native.faces.mockResolvedValue(found([track(1, 0.5), track(2, 20, 0.2)], { done: false, error: "Stopped early." }));
  expect(await mouthActivity(workspace.ctx, video(), [{ from: 0, to: 5 }])).toEqual({ mediaId: "wide", sampleRate: 5, faces: [], done: false, error: "Stopped early." });
  native.faces.mockResolvedValue(found([track(1, 0.5)]));
  expect(await mouthActivity(workspace.ctx, video(), [{ from: 0, to: 5 }])).toEqual({ mediaId: "wide", sampleRate: 5, faces: [], done: true });
  expect(native.mouthMotion).not.toHaveBeenCalled();
});

it("measures each prominent face's mouth over every stretch, clamped to the recording, at no more than 30 fps", async () => {
  native.faces.mockResolvedValue(found([track(1, 30), track(2, 12, 0.8, [0.6, 0.1, 0.9, 0.5])]));
  // Two seconds at 30 fps: quiet, then talking.
  native.mouthMotion.mockImplementation(async () => Float32Array.from({ length: 60 }, (_, i) => (i < 30 ? 0 : 2)));
  const result = await mouthActivity(workspace.ctx, video(), [{ from: -3, to: 2 }, { from: 38, to: 55 }], { waitMs: 90_000 });
  // The faces are read once over the whole span asked for, waiting no longer than 30 s.
  expect(native.faces).toHaveBeenCalledTimes(1);
  expect(native.faces.mock.calls[0]![2]).toEqual({ from: 0, to: 40 });
  expect(native.faces.mock.calls[0]![3]).toMatchObject({ waitMs: 30_000 });
  expect(result.done).toBe(true);
  expect(result.faces.map(f => f.track)).toEqual([1, 2]);
  expect(result.faces[0]).toMatchObject({ box: [0.2, 0.2, 0.6, 0.7], mouth: [0.26, 0.51, 0.54, 0.74], seconds: 30, confidence: 0.9 });
  expect(result.faces[0]!.stretches.map(s => [s.from, s.to])).toEqual([[0, 2], [38, 40]]);
  expect(result.faces[0]!.stretches[0]!.values).toEqual([0, 0, 0, 0, 0, 2, 2, 2, 2, 2]);
  expect(native.mouthMotion).toHaveBeenCalledTimes(4);
  const [file, range, opts] = native.mouthMotion.mock.calls[0]!;
  expect(file).toBe(join(workspace.ctx.paths.media(projectId), "wide.mp4"));
  expect(range).toEqual({ start: 0, end: 2 });
  expect(opts).toMatchObject({ box: [0.26, 0.51, 0.54, 0.74], width: 1920, height: 1080, fps: 30, decoder: undefined });
  // A slower recording is measured at its own rate.
  native.mouthMotion.mockClear();
  await mouthActivity(workspace.ctx, video({ fps: 24 }), [{ from: 0, to: 2 }]);
  expect(native.mouthMotion.mock.calls[0]![2]).toMatchObject({ fps: 24 });
});

it("keeps the reading's error beside the faces it did measure", async () => {
  native.faces.mockResolvedValue(found([track(1, 30)], { done: false, error: "Part of the recording couldn't be read." }));
  native.mouthMotion.mockResolvedValue(new Float32Array(30));
  const result = await mouthActivity(workspace.ctx, video({ fps: 30 }), [{ from: 0, to: 1 }]);
  expect(result).toMatchObject({ done: false, error: "Part of the recording couldn't be read.", faces: [{ track: 1, stretches: [{ from: 0, to: 1, values: [0, 0, 0, 0, 0] }] }] });
});

it("measures again on the CPU when the hardware decoder fails, and gives up when the CPU fails too", async () => {
  workspace.ctx.repos.settings.update({ render: { hwaccel: "videotoolbox" } });
  native.faces.mockResolvedValue(found([track(1, 30)]));
  native.mouthMotion
    .mockRejectedValueOnce(new Error("VideoToolbox session failed"))
    .mockResolvedValueOnce(Float32Array.from({ length: 30 }, () => 1));
  const result = await mouthActivity(workspace.ctx, video({ fps: 30 }), [{ from: 0, to: 1 }]);
  expect(result.faces[0]!.stretches[0]!.values).toEqual([1, 1, 1, 1, 1]);
  expect(native.mouthMotion.mock.calls.map(call => call[2].decoder)).toEqual(["videotoolbox", undefined]);

  native.mouthMotion.mockReset().mockRejectedValue(new Error("no frames"));
  await expect(mouthActivity(workspace.ctx, video({ fps: 30 }), [{ from: 0, to: 1 }])).rejects.toThrow("no frames");
  expect(native.mouthMotion).toHaveBeenCalledTimes(2);
});

it("doesn't retry on the CPU when no hardware decoder was used", async () => {
  native.faces.mockResolvedValue(found([track(1, 30)]));
  native.mouthMotion.mockRejectedValue(new Error("ffmpeg exited 1"));
  await expect(mouthActivity(workspace.ctx, video(), [{ from: 0, to: 1 }])).rejects.toThrow("ffmpeg exited 1");
  expect(native.mouthMotion).toHaveBeenCalledTimes(1);
});

it("stops between stretches, and doesn't fall back to the CPU, once the caller has gone", async () => {
  workspace.ctx.repos.settings.update({ render: { hwaccel: "videotoolbox" } });
  native.faces.mockResolvedValue(found([track(1, 30)]));
  const gone = new AbortController();
  native.mouthMotion.mockImplementation(async () => {
    gone.abort(new Error("caller left"));
    throw new Error("killed");
  });
  await expect(mouthActivity(workspace.ctx, video(), [{ from: 0, to: 1 }, { from: 5, to: 6 }], { signal: gone.signal })).rejects.toThrow("caller left");
  expect(native.mouthMotion).toHaveBeenCalledTimes(1);
  // Already gone, nothing is measured at all.
  native.mouthMotion.mockClear();
  await expect(mouthActivity(workspace.ctx, video(), [{ from: 0, to: 1 }], { signal: gone.signal })).rejects.toThrow("caller left");
  expect(native.mouthMotion).not.toHaveBeenCalled();
});

it("bins nothing for a rate it can't use, and keeps short series to one bin", () => {
  expect(binMouthMotion([1, 2, 3], 0)).toEqual([]);
  expect(binMouthMotion([1, 2, 3], 30, 0)).toEqual([]);
  expect(binMouthMotion([1, 2, 3], Number.NaN)).toEqual([]);
  // A tenth of a second at 30 fps is less than one 5 Hz bin, so it is one bin of their mean.
  expect(binMouthMotion([1, 2, 3], 30)).toEqual([2]);
});

it("keeps faces with at least a fifth of the longest's screen time, up to the most asked for", () => {
  expect(prominentFaceTracks([])).toEqual([]);
  // The longest is 10 s, so anything of 2 s or more stays; 1.5 s does not.
  expect(prominentFaceTracks([track(1, 10), track(2, 2), track(3, 1.5)]).map(t => t.track)).toEqual([1, 2]);
  // A long recording keeps any face on screen for 3 s or more.
  expect(prominentFaceTracks([track(1, 600), track(2, 3), track(3, 2.9)]).map(t => t.track)).toEqual([1, 2]);
  expect(prominentFaceTracks([track(1, 50), track(2, 40), track(3, 30), track(4, 20), track(5, 10)], 2).map(t => t.track)).toEqual([1, 2]);
});
