import { describe, expect, it } from "vitest";
import {
  applyOps, clipGainAt, createProject, dipKeyframes, emptyTimeline, handoffLosses, levelLines, makeMediaClip, putBackLooks, toFcpxml,
  toOtio, volumeDbAt, type HandoffSource, type MediaClip, type Timeline, type VolumeKeyframe,
} from "./index.js";

const FPS = 30;
const dip: VolumeKeyframe[] = [
  { time: 1, db: 0, ease: "easeInOut" }, { time: 2, db: -18, ease: "linear" }, { time: 4, db: -18, ease: "easeInOut" }, { time: 5, db: 0, ease: "linear" }];

describe("the level keyframes give", () => {
  it("holds the ends, eases between keys in dB and steps on a hold", () => {
    expect(volumeDbAt(undefined, 3)).toBe(0);
    expect(volumeDbAt(dip, 0)).toBe(0);
    expect(volumeDbAt(dip, 1.5)).toBeCloseTo(-9, 9);
    expect(volumeDbAt(dip, 1.25)).toBeCloseTo(-18 * 0.25 * 0.25 * (3 - 0.5), 9);
    expect(volumeDbAt(dip, 3)).toBe(-18);
    expect(volumeDbAt(dip, 9)).toBe(0);
    expect(volumeDbAt([{ time: 0, db: -6, ease: "hold" }, { time: 1, db: 0, ease: "linear" }], 0.99)).toBe(-6);
    // On top of the clip's volume, at a timeline second.
    expect(clipGainAt({ timelineIn: 10, volume: 0.5, volumeKeyframes: dip }, 13)).toBeCloseTo(0.5 * Math.pow(10, -18 / 20), 9);
  });

  it("dips under each stretch, sharing a dip where the level couldn't come back up between two", () => {
    const music = makeMediaClip("music", 0, 60, 10);
    const { keys, dips } = dipKeyframes(music, [{ start: 12, end: 14 }, { start: 14.5, end: 16 }, { start: 30, end: 32 }], { depth: -20, down: 0.25, up: 0.75 });
    expect(dips).toEqual([{ start: 12, end: 16, depth: -20 }, { start: 30, end: 32, depth: -20 }]);
    expect(keys.map(k => [k.time, k.db])).toEqual([[1.75, 0], [2, -20], [6, -20], [6.75, 0], [19.75, 0], [20, -20], [22, -20], [22.75, 0]]);
    // Within a stretch of the clip, the dips there take the place of the keys there and leave the rest.
    const again = dipKeyframes({ ...music, volumeKeyframes: keys }, [{ start: 30, end: 31 }], { depth: -10, down: 0.25, up: 0.75 }, { start: 25, end: 40 });
    expect(again.keys.map(k => [k.time, k.db])).toEqual([[1.75, 0], [2, -20], [6, -20], [6.75, 0], [19.75, 0], [20, -10], [21, -10], [21.75, 0]]);
  });

  it("draws eased moves as straight pieces and steps a hold a frame before its next key", () => {
    const lines = levelLines(dip, 0, 6, 1 / FPS, 4);
    expect(lines.map(p => p.time)).toEqual([0, 1, 1.25, 1.5, 1.75, 2, 4, 4.25, 4.5, 4.75, 5, 6]);
    for (const p of lines) expect(p.db).toBeCloseTo(volumeDbAt(dip, p.time), 9);
    const held = levelLines([{ time: 0, db: -6, ease: "hold" }, { time: 1, db: 0, ease: "linear" }], 0, 2, 1 / FPS);
    expect(held.map(p => [p.time, p.db])).toEqual([[0, -6], [1 - 1 / FPS, -6], [1, 0], [2, 0]]);
  });
});

describe("level keyframes through edits", () => {
  it("move with the music's own footage when a cut splits it, and Reject puts back the level as it was", () => {
    const before = emptyTimeline("p");
    before.tracks[1]!.clips = [makeMediaClip("music", 0, 60, 0, { id: "bed" })];
    const ops = [{ op: "updateClip" as const, clipId: "bed", patch: { volumeKeyframes: dip } }];
    const after = applyOps(before, ops);
    // A later cut takes 2.5–3 s out of every track: the bed's second piece keeps the level its footage had.
    const later = applyOps(after, [{ op: "rippleDelete", start: 2.5, end: 3 }]);
    const [left, right] = later.tracks[1]!.clips as MediaClip[];
    expect(clipGainAt(left!, 1.5)).toBeCloseTo(clipGainAt((after.tracks[1]!.clips[0] as MediaClip), 1.5), 9);
    expect(clipGainAt(right!, 3.75)).toBeCloseTo(clipGainAt((after.tracks[1]!.clips[0] as MediaClip), 4.25), 9);
    const back = putBackLooks(later, before, after, ops, { start: 0, end: 60 }, [{ start: 0, end: 60 }], FPS)!;
    expect(back.tracks[1]!.clips.map(c => c.kind === "media" && c.volumeKeyframes)).toEqual([undefined, undefined]);
    expect(back.tracks[1]!.clips.map(c => [c.timelineIn, c.kind === "media" && c.sourceIn])).toEqual(later.tracks[1]!.clips.map(c => [c.timelineIn, c.kind === "media" && c.sourceIn]));
  });

  it("puts back a voice cleanup alone, leaving the rest of the clip's sound", () => {
    const before = emptyTimeline("p");
    before.tracks[0]!.clips = [makeMediaClip("cam", 0, 20, 0, { id: "cam", effects: [{ type: "eq", params: { highpass: 80 }, enabled: true }] })];
    const effects = [{ type: "eq", params: { highpass: 80 }, enabled: true }, { type: "voiceCleanup", params: {}, enabled: true }];
    const ops = [{ op: "updateClip" as const, clipId: "cam", patch: { effects } }];
    const after = applyOps(before, ops);
    const back = putBackLooks(after, before, after, ops, { start: 0, end: 20 }, [{ start: 0, end: 20 }], FPS)!;
    expect((back.tracks[0]!.clips[0] as MediaClip).effects).toEqual(before.tracks[0]!.clips[0]!.kind === "media" && before.tracks[0]!.clips[0]!.effects);
  });
});

describe("handing a dipped bed and a cleaned voice to another app", () => {
  const source = (over: Partial<HandoffSource> = {}): HandoffSource => ({ url: "file:///Edit/Media/x", fileName: "x", hasVideo: false, hasAudio: true,
    audioChannels: 2, audioRate: 48000, duration: 600, ...over });
  function dipped() {
    const project = createProject("Show", { fps: 30 });
    project.media.push({ id: "cam", kind: "video", name: "cam.mov", path: "cam.mov", duration: 600, fps: 30, hasAudio: true },
      { id: "music", kind: "audio", name: "bed.wav", path: "bed.wav", duration: 600, hasAudio: true });
    const tl: Timeline = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0, { effects: [{ type: "voiceCleanup", params: {}, enabled: true }] })];
    tl.tracks[1]!.clips = [makeMediaClip("music", 0, 10, 0, { volume: 0.5, volumeKeyframes: dip })];
    const sources = new Map([["cam", source({ hasVideo: true, rate: { num: 30, den: 1 }, width: 1920, height: 1080, fileName: "cam.mov" })],
      ["music", source({ fileName: "bed.wav" })]]);
    return { project, tl, sources };
  }

  it("keys the bed's level in Final Cut's file, as Scarlet plays it", () => {
    const { project, tl, sources } = dipped();
    const xml = toFcpxml(project, tl, sources);
    const volume = /<adjust-volume amount="([^"]+)">[\s\S]*?<\/adjust-volume>/.exec(xml.slice(xml.indexOf("bed.wav")))!;
    expect(volume[1]).toBe("-6.0206dB");
    const keys = [...volume[0].matchAll(/<keyframe time="([^"]+)" value="([^"]+)"/g)].map(m => [m[1], m[2]]);
    expect(keys[0]).toEqual(["0s", "-6.0206dB"]);
    expect(keys).toContainEqual(["2s", "-24.0206dB"]);
    expect(keys).toContainEqual(["4s", "-24.0206dB"]);
    expect(keys.at(-1)).toEqual(["10s", "-6.0206dB"]);
    // The eased moves come as a few straight pieces each.
    expect(keys.length).toBeGreaterThan(8);
    // OTIO keeps the keys with Scarlet's own clip.
    expect(JSON.stringify(toOtio(project, tl))).toContain('"volumeKeyframes"');
  });

  it("lists the voice cleanup among what doesn't carry over", () => {
    const { project, tl } = dipped();
    expect(handoffLosses(project, tl).map(l => l.what)).toEqual(["Voice cleanup on “cam.mov”"]);
  });
});
