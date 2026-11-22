import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyOps, clipGainAt, createProject, emptyTimeline, makeMediaClip, putBackLooks, toFcpxml,
  type HandoffSource, type MediaClip, type ProposeOp, type Timeline,
} from "@scarlet/timeline";
import { DIP_DEFAULTS, expandDips } from "./music-dips.js";

const words = [{ start: 1, end: 2.5 }, { start: 3, end: 4 }, { start: 8, end: 9 }];
const speech = async () => words;
function bed(): Timeline {
  const tl = emptyTimeline("p");
  tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 20, 0, { id: "cam" })];
  tl.tracks[1]!.clips = [makeMediaClip("music", 0, 20, 0, { id: "bed", volume: 0.5 })];
  return tl;
}
const gain = (tl: Timeline, at: number) => (tl.tracks[1]!.clips as MediaClip[]).filter(c => c.timelineIn <= at && at < c.timelineIn + (c.sourceOut - c.sourceIn))
  .map(c => clipGainAt(c, at))[0]!;

describe("duckUnderSpeech", () => {
  it("defaults to the stock skill music-under-speech's numbers", () => {
    const skill = readFileSync(new URL("../../../skills/music-under-speech/SKILL.md", import.meta.url), "utf8");
    expect(DIP_DEFAULTS).toEqual({ depthDb: -18, fadeDown: 0.3, fadeUp: 0.8, minGap: 2 });
    expect(skill).toContain("about 18 dB under");
    expect(skill).toContain("about 0.3 s");
    expect(skill).toContain("about 0.8 s");
    expect(skill).toContain("about two seconds or more");
  });

  it("becomes the updateClip that keys the level, sharing a dip across pauses shorter than minGap and rising in longer ones", async () => {
    const steps: ProposeOp[] = [{ op: "duckUnderSpeech", clipId: "bed" }];
    const { ops, dips } = await expandDips(steps, bed(), speech);
    expect(ops).toEqual([{ op: "updateClip", clipId: "bed", patch: { volumeKeyframes: expect.any(Array) } }]);
    expect(dips).toEqual([{ clipId: "bed", under: "speech", depthDb: -18, dips: [{ start: 1, end: 4 }, { start: 8, end: 9 }] }]);
    const after = applyOps(bed(), ops);
    const db = (at: number) => 20 * Math.log10(gain(after, at) / 0.5);
    expect(db(0.5)).toBeCloseTo(0, 6);
    expect(db(2.7)).toBeCloseTo(-18, 6);
    expect(db(6)).toBeCloseTo(0, 6);
    expect(db(8.5)).toBeCloseTo(-18, 6);
  });

  it("leaves ordinary steps as they are and with no dip says nothing", async () => {
    const steps: ProposeOp[] = [{ op: "updateClip", clipId: "bed", patch: { volume: 0.3 } }];
    expect(await expandDips(steps, bed(), speech)).toEqual({ ops: steps, dips: [] });
  });

  it("is put back exactly by Reject, also after a later cut splits the music", async () => {
    const before = bed();
    const { ops } = await expandDips([{ op: "duckUnderSpeech", clipId: "bed" }], before, speech);
    const after = applyOps(before, ops);
    const later = applyOps(after, [{ op: "rippleDelete", start: 5, end: 6 }]);
    expect(later.tracks[1]!.clips).toHaveLength(2);
    const back = putBackLooks(later, before, after, ops, { start: 0, end: 20 }, [{ start: 0, end: 20 }], 30)!;
    expect(back.tracks[1]!.clips.map(c => c.kind === "media" && c.volumeKeyframes)).toEqual([undefined, undefined]);
    expect(back.tracks[1]!.clips.map(c => c.kind === "media" && c.volume)).toEqual([0.5, 0.5]);
  });

  it("hands its level to Final Cut as keyframes", async () => {
    const project = createProject("Show", { fps: 30 });
    project.media.push({ id: "cam", kind: "video", name: "cam.mov", path: "cam.mov", duration: 600, fps: 30, hasAudio: true },
      { id: "music", kind: "audio", name: "bed.wav", path: "bed.wav", duration: 600, hasAudio: true });
    const tl = { ...bed(), projectId: project.id };
    const { ops } = await expandDips([{ op: "duckUnderSpeech", clipId: "bed" }], tl, speech);
    const source = (over: Partial<HandoffSource>): HandoffSource => ({ url: "file:///x", fileName: "x", hasVideo: false, hasAudio: true,
      audioChannels: 2, audioRate: 48000, duration: 600, ...over });
    const xml = toFcpxml(project, applyOps(tl, ops), new Map([["cam", source({ hasVideo: true, rate: { num: 30, den: 1 }, width: 1920, height: 1080, fileName: "cam.mov" })],
      ["music", source({ fileName: "bed.wav" })]]));
    const volume = /<adjust-volume amount="[^"]+">[\s\S]*?<\/adjust-volume>/.exec(xml.slice(xml.indexOf("bed.wav")))![0];
    expect(volume).toContain('<keyframe time="1s" value="-24.0206dB"');
    expect(volume).toContain('<keyframe time="9s" value="-24.0206dB"');
  });
});
