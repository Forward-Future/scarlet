import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyOps, createProject, emptyTimeline, makeMediaClip, expandSplitJoins, type Project, type Timeline } from "@scarlet/timeline";
import { probeMedia, probeToAssetFields, renderFullCached, renderPlaybackSegment, renderRange, resolveFfmpeg, runCapture } from "./index.js";

const RATE = 48000, FPS = 25;
let dir: string, project: Project;

/** A recording: a colour picture, and a tone that plays from `from` to `to` seconds of it, silence elsewhere. */
async function recording(name: string, color: string, from: number, to: number) {
  const path = join(dir, `${name}.mov`);
  await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=${FPS}:d=6`,
    "-f", "lavfi", "-i", `sine=f=660:r=${RATE}:d=6:samples_per_frame=48`, "-filter_complex", `[1:a]volume='between(t,${from},${to})':eval=frame[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "1", "-c:a", "pcm_s16le", "-ar", String(RATE), "-shortest", path]);
  project.media.push({ id: name, name, kind: "video", path, ...probeToAssetFields(await probeMedia(path)) });
}

/**
 * The first and last moments the files are audible, in seconds, from their decoded samples played one after another,
 * as the player appends its sections.
 */
async function audible(files: string | string[]) {
  const decoded = await Promise.all([files].flat().map(async file =>
    (await runCapture(resolveFfmpeg(), ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(RATE), "pipe:1"])).stdout));
  const stdout = Buffer.concat(decoded);
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length / 2);
  // Loud is a tenth of the file's peak: the mix may set the tone's level, never where it starts.
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  expect(peak).toBeGreaterThan(500);
  const loud = (i: number) => Math.abs(samples[i]!) > peak / 10;
  let first = -1, last = -1;
  for (let i = 0; i < samples.length; i++) if (loud(i)) { if (first < 0) first = i; last = i; }
  return { from: first / RATE, to: last / RATE };
}

/** Within 10 ms: a quarter of a frame at 25 fps. */
const near = (seconds: number, expected: number) => expect(Math.abs(seconds - expected)).toBeLessThan(0.01);

/** Whether the picture at a time is mostly red or mostly blue. */
async function colourAt(file: string, t: number) {
  const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return stdout[0]! > stdout[2]! ? "red" : "blue";
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-split-edit-"));
  project = createProject("Split edits", { width: 160, height: 90, fps: FPS });
  // The host speaks for the first 3 s of their recording; the guest from 2.5 s of theirs.
  await recording("host", "red", 0, 3);
  await recording("guest", "blue", 2.5, 6);
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Host (red) 0–2 s from their 0–2 s; guest (blue) 2–4 s from their 3–5 s: one picture cut at 2 s. */
function conversation(): Timeline {
  const tl = emptyTimeline(project.id);
  tl.tracks[0]!.clips = [makeMediaClip("host", 0, 2, 0, { id: "ask" }), makeMediaClip("guest", 3, 5, 2, { id: "answer" })];
  return tl;
}
/** The guest's sound, alone: the host's recording is made silent in a copy so each side can be heard apart. */
function only(tl: Timeline, mediaId: string): Timeline {
  const copy = structuredClone(tl);
  for (const track of copy.tracks) for (const clip of track.clips) if (clip.kind === "media" && clip.mediaId !== mediaId) clip.volume = 0;
  return copy;
}

describe("a split edit as rendered", () => {
  type Path = "whole" | "playback" | "export";
  /** The render the editor hears: one range, the player's 1 s sections appended, or a delivery export. */
  const render = async (tl: Timeline, name: string, path: Path = "whole"): Promise<string[]> => {
    const output = join(dir, `${name}-${path}.mp4`);
    if (path === "whole") await renderRange(project, tl, { start: 0, end: 4 }, output, { mediaRoot: dir, quality: "preview", hwaccel: "none" });
    if (path === "export") await renderFullCached(project, tl, join(dir, `cache-${name}`), output, { mediaRoot: dir, quality: "delivery", hwaccel: "none", segmentSeconds: 1 });
    if (path !== "playback") return [output];
    return Promise.all([0, 1, 2, 3].map(async k => {
      const section = join(dir, `${name}-playback-${k}.mp4`);
      await renderPlaybackSegment(project, tl, { start: k, end: k + 1 }, join(dir, `cache-${name}`), section, { mediaRoot: dir, hwaccel: "none" });
      return section;
    }));
  };
  const paths: Path[] = ["whole", "playback", "export"];

  it.each(paths)("plays the next voice before its picture by the amount set (a J cut): %s", async path => {
    near((await audible(await render(only(conversation(), "guest"), "straight", path))).from, 2);
    const j = applyOps(conversation(), expandSplitJoins(conversation(), project.media, FPS, [{ op: "splitJoin", leftClipId: "ask", rightClipId: "answer", leads: 0.24 }]).ops);
    const [file] = await render(j, "j", path);
    // The picture still cuts at 2 s.
    if (path !== "playback") {
      expect(await colourAt(file!, 1.9)).toBe("red");
      expect(await colourAt(file!, 2.1)).toBe("blue");
    }
    near((await audible(await render(only(j, "guest"), "j-guest", path))).from, 1.76);
    // The host's voice stops where the guest's begins.
    near((await audible(await render(only(j, "host"), "j-host", path))).to, 1.76);
  }, 120_000);

  it.each(paths)("carries a voice over the next picture by the amount set (an L cut): %s", async path => {
    near((await audible(await render(only(conversation(), "host"), "straight-host", path))).to, 2);
    const l = applyOps(conversation(), expandSplitJoins(conversation(), project.media, FPS, [{ op: "splitJoin", leftClipId: "ask", rightClipId: "answer", trails: 0.4 }]).ops);
    if (path !== "playback") expect(await colourAt((await render(l, "l", path))[0]!, 2.1)).toBe("blue");
    near((await audible(await render(only(l, "host"), "l-host", path))).to, 2.4);
    near((await audible(await render(only(l, "guest"), "l-guest", path))).from, 2.4);
  }, 120_000);
});
