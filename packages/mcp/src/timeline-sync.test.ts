import { describe, expect, it } from "vitest";
import { applyOps, buildMulticamTimeline, switchCameraOps, type MediaAsset, type MediaClip, type Timeline } from "@scarlet/timeline";
import { syncRate } from "./audio-sync.js";
import { lagBetween, syncSummary, timelineSync } from "./timeline-sync.js";

function envelope(seed: number, length: number) {
  return Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
}

const asset = (id: string, kind: "video" | "audio" = "video", hasAudio = true) =>
  ({ id, name: id, kind, hasAudio, duration: 600 }) as unknown as MediaAsset;
let n = 0;
const clip = (mediaId: string, timelineIn: number, sourceIn: number, length: number) =>
  ({ id: `c${n++}`, kind: "media", mediaId, timelineIn, sourceIn, sourceOut: sourceIn + length, speed: 1, enabled: true }) as unknown as MediaClip;
const timeline = (...tracks: MediaClip[][]) =>
  ({ tracks: tracks.map((clips, i) => ({ id: `t${i}`, kind: "video", name: `V${i + 1}`, clips })) }) as unknown as Timeline;

// The camera's sound; the screen recording started 2 s later and hears the same room.
const cameraLevels = envelope(5, 600 * syncRate);
const screenStartsAfter = 2;
const levels = async (mediaId: string, from: number, to: number) => {
  const shift = mediaId === "screen" ? screenStartsAfter : 0;
  return cameraLevels.slice(Math.round((from + shift) * syncRate), Math.round((to + shift) * syncRate)).map(v => v * (mediaId === "screen" ? 0.4 : 1));
};

/** Keep camera ranges [source from, to] in order; the screen plays the same moments over them. */
function edit(keeps: Array<[number, number]>, screenSlip: (index: number) => number = () => 0) {
  const camera: MediaClip[] = [], screen: MediaClip[] = [];
  let at = 0;
  keeps.forEach(([from, to], i) => {
    camera.push(clip("camera", at, from, to - from));
    screen.push(clip("screen", at, from - screenStartsAfter + screenSlip(i), to - from));
    at += to - from;
  });
  return timeline(camera, screen);
}

const keeps: Array<[number, number]> = [[10, 30], [40, 70], [90, 120], [150, 200], [220, 260], [300, 330]];
const assets = [asset("camera"), asset("screen")];

describe("recordings in line through the edit", () => {
  it("finds every cut in line and hears it at five spots", async () => {
    const [pair] = await timelineSync(edit(keeps), assets, 30, levels);
    expect(pair).toMatchObject({ reference: "camera", secondary: "screen", offset: screenStartsAfter, outOfLine: [], unheard: 0 });
    expect(pair!.heard).toHaveLength(5);
    expect(pair!.heard.every(h => h.late === 0)).toBe(true);
    expect(syncSummary([pair!], new Map([["camera", "Camera"], ["screen", "Screen"]]), 30))
      .toBe("Camera and Screen: placed in line throughout; heard in line at 5 spots, within a frame.");
  });

  it("names a cut that trimmed one track and not the other, and hears it", async () => {
    const slipped = edit(keeps, i => (i === 3 ? 0.2 : 0));
    const [pair] = await timelineSync(slipped, assets, 30, levels, 6);
    expect(pair!.outOfLine).toEqual([{ from: 80, to: 130, offset: 1.8, differsBy: -0.2 }]);
    // The screen starts 0.2 s further into its recording there, so its sound comes 0.2 s early.
    expect(pair!.heard.find(h => h.at > 80 && h.at < 130)?.late).toBeCloseTo(-0.2, 2);
  });

  it("leaves B-roll from all over a source unchecked", async () => {
    const camera = [clip("camera", 0, 0, 300)];
    const broll = [clip("broll", 10, 400, 5), clip("broll", 60, 20, 5), clip("broll", 120, 250, 5)];
    expect(await timelineSync(timeline(camera, broll), [asset("camera"), asset("broll")], 30, levels)).toEqual([]);
  });

  it("checks placement alone when one recording has no sound", async () => {
    const [pair] = await timelineSync(edit(keeps), [asset("camera"), asset("screen", "video", false)], 30, levels);
    expect(pair).toMatchObject({ outOfLine: [], heard: [], unheard: 0 });
  });

  it("measures a lag only where there is sound to compare", () => {
    const ref = cameraLevels.slice(1000, 1150);
    expect(lagBetween(ref, cameraLevels.slice(1000 - 25 - 4, 1150 + 25 - 4), 25)).toBeCloseTo(4 / syncRate);
    expect(lagBetween(Array(150).fill(0.2), cameraLevels.slice(0, 200), 25)).toBeUndefined();
  });

  it("verifies drift-compensated multi-cam tracks and switched Program tracks through rippleDelete cuts without double-counting", async () => {
    const driftRate = 1 + 0.0005;
    const driftSpeed = 1 / driftRate;
    const base = envelope(19, 300 * syncRate);
    const cam2Offset = 2;
    const driftLevels = Array.from({ length: 240 * syncRate }, (_, i) => {
      const idx = Math.round(i * driftRate + cam2Offset * syncRate);
      return (base[idx] ?? 0) * 0.6;
    });
    const mcAssets = [
      asset("cam_wide", "video", true),
      asset("cam_drift", "video", true),
      asset("mic_main", "audio", true),
    ];
    const mcLevels = async (mediaId: string, from: number, to: number) => {
      const src = mediaId === "cam_drift" ? driftLevels : base;
      return src.slice(Math.round(from * syncRate), Math.round(to * syncRate));
    };

    const built = buildMulticamTimeline(
      "prj_mc",
      [
        { mediaId: "cam_wide", duration: 200, offset: 0 },
        { mediaId: "cam_drift", duration: 200, offset: cam2Offset, speed: driftSpeed },
      ],
      [{ mediaId: "mic_main", duration: 200, offset: 0 }],
    );
    const switched = applyOps(
      built.timeline,
      switchCameraOps(built.timeline, mcAssets, 30, [{ from: 30, to: 110, mediaId: "cam_drift" }]).ops,
    );
    const cut = applyOps(switched, [
      { op: "rippleDelete", start: 60, end: 75 },
      { op: "rippleDelete", start: 130, end: 145 },
    ]);

    const pairs = await timelineSync(cut, mcAssets, 30, mcLevels);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (const pair of pairs) {
      expect(pair.outOfLine).toEqual([]);
      expect(pair.heard.length).toBeGreaterThan(0);
      expect(pair.heard.every(h => Math.abs(h.late) < 1 / 30)).toBe(true);
    }
    // Program + hidden reference track overlap must not double-count `togetherSeconds`.
    const wideMic = pairs.find(p =>
      (p.reference === "cam_wide" && p.secondary === "mic_main") ||
      (p.reference === "mic_main" && p.secondary === "cam_wide"),
    )!;
    expect(wideMic.togetherSeconds).toBeLessThanOrEqual(171);
  });
});
