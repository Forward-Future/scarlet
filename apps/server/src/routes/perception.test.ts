import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { ffmpeg } from "../render/ffmpeg.js";
import { parseEbur128 } from "./perception.js";

const summary = (integrated: string, range: string, peak: string) => `[Parsed_ebur128_0 @ 0x600001] t: 2.9  TARGET:-23 LUFS    M: -18.1 S: -18.2     I: -99.0 LUFS       LRA:  88.0 LU
[Parsed_ebur128_0 @ 0x600001] Summary:

  Integrated loudness:
    I:         ${integrated} LUFS
    Threshold: -28.2 LUFS

  Loudness range:
    LRA:         ${range} LU
    Threshold: -38.2 LUFS
    LRA low:   -18.3 LUFS
    LRA high:  -18.1 LUFS

  True peak:
    Peak:       ${peak} dBFS
`;

it("reads loudness from ffmpeg's summary, not from the running figures before it", () => {
  expect(parseEbur128(summary("-18.2", "0.3", "-12.0"))).toEqual({ integratedLufs: -18.2, loudnessRangeLu: 0.3, truePeakDbtp: -12 });
  expect(parseEbur128(summary("-5.0", "12.5", "0.4"))).toEqual({ integratedLufs: -5, loudnessRangeLu: 12.5, truePeakDbtp: 0.4 });
});

it("reads silence, which ffmpeg writes as -inf, as no value", () => {
  expect(parseEbur128(summary("-inf", "0.0", "-inf"))).toEqual({ integratedLufs: null, loudnessRangeLu: 0, truePeakDbtp: null });
  // Whatever isn't a summary has no values to give.
  expect(parseEbur128("Output file is empty, nothing was encoded")).toEqual({ integratedLufs: null, loudnessRangeLu: null, truePeakDbtp: null });
  expect(parseEbur128("")).toEqual({ integratedLufs: null, loudnessRangeLu: null, truePeakDbtp: null });
});

let directory: string;
let workspace: ScarletApp;
let projectId: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-perception-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  const { ctx } = workspace;
  projectId = ctx.repos.projects.insert(createProject("Levels")).id;
  ctx.paths.ensureProject(projectId);
  // Four seconds: a tone at about a tenth of full scale, then silence from two seconds on.
  await ffmpeg(["-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*440*t)*lt(t\\,2):d=4:s=48000", "-c:a", "pcm_s16le", "-y", join(ctx.paths.media(projectId), "voice.wav")]);
  ctx.repos.projects.putMedia(projectId, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 4 }, "ready");
  ctx.repos.projects.putMedia(projectId, { id: "screen", name: "Screen", path: "screen.mov", kind: "video", duration: 4, hasAudio: false }, "ready");
});
afterAll(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});
async function loudness(query = "", media = "voice", project = projectId) {
  const res = await workspace.app.request(`/api/projects/${project}/media/${media}/loudness${query}`, { headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}` } });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

it("measures a recording's loudness, whole or over a range of it", async () => {
  const whole = await loudness();
  expect(whole.status).toBe(200);
  expect(Object.keys(whole.body).sort()).toEqual(["integratedLufs", "loudnessRangeLu", "mediaId", "truePeakDbtp"]);
  // A sine at 0.1 of full scale peaks at -20 dBFS and sits a little under -20 LUFS.
  expect(whole.body.truePeakDbtp).toBeCloseTo(-20, 0);
  expect(whole.body.integratedLufs).toBeGreaterThan(-26);
  expect(whole.body.integratedLufs).toBeLessThan(-19);
  const tone = await loudness("?from=0.5&to=1.5");
  expect(tone.body).toMatchObject({ mediaId: "voice", from: 0.5, to: 1.5 });
  expect(tone.body.truePeakDbtp).toBeCloseTo(-20, 0);
  // The silent half has no peak, and sits at the bottom of the scale.
  const silent = (await loudness("?from=2.5&to=3.5")).body;
  expect(silent).toMatchObject({ mediaId: "voice", from: 2.5, to: 3.5, truePeakDbtp: null });
  expect(silent.integratedLufs).toBeLessThanOrEqual(-70);
  // A start too small to write as a decimal is the start of the file.
  expect((await loudness("?from=1e-9&to=1.5")).body.truePeakDbtp).toBeCloseTo(-20, 0);
  // A range someone asked for is measured while the project's media work is paused: a running edit asks for these,
  // and pausing the caching doesn't stop it.
  workspace.ctx.repos.projects.update(projectId, { mediaPaused: true });
  try {
    expect(await loudness("?from=0.25&to=1.25")).toMatchObject({ status: 200, body: { mediaId: "voice", from: 0.25, to: 1.25 } });
  } finally { workspace.ctx.repos.projects.update(projectId, { mediaPaused: false }); }
});

it("refuses a range that isn't one, and a source with no sound", async () => {
  const refused = async (query: string, media?: string) => { const { status, body } = await loudness(query, media); return [status, body.error.code]; };
  expect(await refused("?from=-1")).toEqual([400, "bad_range"]);
  expect(await refused("?from=2&to=2")).toEqual([400, "bad_range"]);
  expect(await refused("?from=2&to=1")).toEqual([400, "bad_range"]);
  expect(await refused("?from=soon")).toEqual([400, "bad_param"]);
  expect(await refused("", "screen")).toEqual([400, "no_audio"]);
  expect(await refused("", "nothing")).toEqual([404, "not_found"]);
  expect((await loudness("", "voice", "prj_other")).status).toBe(404);
});
