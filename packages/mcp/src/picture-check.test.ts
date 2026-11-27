import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline, Transform, type MediaAsset, type Timeline } from "@scarlet/timeline";
import type { BriefPicture } from "./brief-pictures.js";
import { framingReport, type BesideEvidence, type FramedStretch } from "./framing-report.js";
import { pictureFindings } from "./picture-check.js";
import type { ScreenLine } from "./screen-reading.js";

const clip = (id: string, mediaId: string, timelineIn: number, sourceIn: number, seconds: number) => ({ id, kind: "media", mediaId, timelineIn, sourceIn,
  sourceOut: sourceIn + seconds, speed: 1, enabled: true, opacity: 1, volume: 0 });
/** Project 88 at 4:53 (2026-11-21): the camera under two screen clips with 0.45 s of camera between them. */
function timeline(shift = 0): Timeline {
  return { version: "v", tracks: [
    { id: "v1", kind: "video", clips: [clip("cam", "camera", 293 + shift, 502.2, 23)] },
    { id: "screen-demo", kind: "video", clips: [clip("screen-1", "screen", 293.58 + shift, 497.55, 4.42), clip("screen-2", "screen", 298.45 + shift, 507.57, 4.85)] },
  ] } as unknown as Timeline;
}
const stretch = (from: number, to: number, beside: Partial<Pick<FramedStretch, "shownAfter" | "shownBefore">>): FramedStretch =>
  ({ mediaId: "screen", trackId: "screen-demo", from, to, clips: 1, holds: [], moves: [], ...beside });

const wholeCut = (at: number) => ({ at, share: 1, cells: Buffer.alloc(64 * 36 / 8, 0xff).toString("base64") });
const detailGrid = (cols: [number, number], rows: [number, number]) => {
  const cells = new Uint8Array(64 * 36 / 8);
  for (let y = rows[0]; y < rows[1]; y++) for (let x = cols[0]; x < cols[1]; x++) cells[(y * 64 + x) >> 3]! |= 1 << ((y * 64 + x) & 7);
  return Buffer.from(cells).toString("base64");
};

describe("pictureFindings", () => {
  it("names a brief picture by what plays there, so a keep holds when the edit moves it", () => {
    const brief = (shift: number): BriefPicture[] => [{ from: 298 + shift, to: 298.45 + shift, seconds: 0.45, shows: ["cam"], before: ["screen-1"], after: ["screen-2"] }];
    const [a] = pictureFindings(timeline(), brief(0), [], []);
    const [b] = pictureFindings(timeline(-2), brief(-2), [], []);
    expect(a).toMatchObject({ kind: "brief", from: 298, to: 298.45, shows: ["cam"] });
    expect(a!.id).toBe(b!.id);
  });

  it("lists the camera back while the screen still shows what it showed, once for a gap seen from both sides", () => {
    const words = [{ mediaId: "camera", index: 1017, start: 303.4, end: 303.6 }, { mediaId: "camera", index: 1018, start: 303.7, end: 303.9 }];
    const found = pictureFindings(timeline(), [], [
      stretch(298.45, 303.3, { shownAfter: { from: 303.3, to: 315.9, unchanged: true, showing: ["Disabled below active"], said: "line and put the disabled ones",
        reads: [{ from: 303.25, to: 306.13, said: "line and put the disabled ones below the active ones" }] } }),
      stretch(315.9, 319.75, { shownBefore: { from: 312, to: 315.9, showing: ["Single-line rows"], reads: [{ from: 313, to: 315, said: "single line rows place the model label" }] } }),
    ], words);
    expect(found).toEqual([{ id: "picture-off:screen:camera:1017", kind: "offPicture", from: 303.3, to: 315.9, mediaId: "screen", unchanged: true,
      showing: ["Disabled below active", "Single-line rows"], said: "line and put the disabled ones",
      reads: [{ from: 303.25, to: 306.13, said: "line and put the disabled ones below the active ones" }, { from: 313, to: 315, said: "single line rows place the model label" }] }]);
  });

  // Regression suite modeled on the framing defects observed in project 444 (2026-11-24):
  // 1) glides across demo changes vs a legitimate smooth pan on the same page,
  // 2) mid-word clipped sidebars and a cut-off chart title at the top edge,
  // 3) camera inset covering a pricing table cell and chat text,
  // 4) tiny unreadable chat/blog text (below 2.5% of video height) vs readable zoomed text,
  // 5) a 2 s "Loading scene.." screen with near-zero visual detail.
  it("lists all five framing defects from project 444 patterns and keeps IDs stable across timeline shifts", () => {
    const media: MediaAsset[] = [
      { id: "camera", kind: "video", name: "cam", path: "cam.mp4", width: 3840, height: 2160 },
      { id: "screen", kind: "video", name: "scr", path: "scr.mp4", width: 3840, height: 2160 },
    ];
    const canvas = { width: 3840, height: 2160 };
    const insetBR = Transform.parse({ scale: 0.25, x: 0.35, y: 0.35 });

    const build = (shift: number) => applyOps(emptyTimeline("p444"), [
      { op: "addTrack", track: { id: "v2", kind: "video", name: "Screen", clips: [] } },
      { op: "addTrack", track: { id: "v3", kind: "video", name: "Inset", clips: [] } },
      // Clip 1 (t=0..10, src=100..110): zoomed on demo A (left side), with clipped text at left edge & cut-off title at top.
      { op: "addClip", trackId: "v2", clip: { id: "s1", kind: "media", mediaId: "screen", timelineIn: shift, sourceIn: 100, sourceOut: 110, volume: 0,
        transform: Transform.parse({ scale: 2, x: 0, y: 0 }) } }, // frame [25, 25, 75, 75]
      // Clip 2 (t=10..20, src=130..140): jumps 20 s to demo B and GLIDES over 1 s from [25,25,75,75] to [0,0,100,100] (scale 2 -> 1).
      { op: "addClip", trackId: "v2", clip: { id: "s2", kind: "media", mediaId: "screen", timelineIn: shift + 10, sourceIn: 130, sourceOut: 140, volume: 0,
        transform: Transform.parse({ scale: 2, x: 0, y: 0 }),
        keyframes: [
          { time: 0, transform: Transform.parse({ scale: 2, x: 0, y: 0 }), ease: "easeInOut" },
          { time: 1, transform: Transform.parse({ scale: 1, x: 0, y: 0 }), ease: "easeInOut" },
        ] } },
      // Clip 3 (t=20..26, src=140..146): SAME page (no source jump, no recording cut), smooth pan down over 1 s (should NOT trigger moveAcrossCut).
      { op: "addClip", trackId: "v2", clip: { id: "s3", kind: "media", mediaId: "screen", timelineIn: shift + 20, sourceIn: 140, sourceOut: 146, volume: 0,
        transform: Transform.parse({ scale: 1.5, x: 0, y: 0.1 }),
        keyframes: [
          { time: 0, transform: Transform.parse({ scale: 1.5, x: 0, y: 0.1 }), ease: "easeInOut" },
          { time: 1, transform: Transform.parse({ scale: 1.5, x: 0, y: -0.1 }), ease: "easeInOut" },
        ] } },
      // Clip 4 (t=26..28.5, src=200..202.5): straight cut (over: 0, no keyframes) to a blank "Loading scene.." screen.
      { op: "addClip", trackId: "v2", clip: { id: "s4", kind: "media", mediaId: "screen", timelineIn: shift + 26, sourceIn: 200, sourceOut: 202.5, volume: 0,
        transform: Transform.parse({ scale: 1.5, x: 0, y: 0 }) } },
      // Camera inset in bottom-right over clips 1-2.
      { op: "addClip", trackId: "v3", clip: { id: "cam1", kind: "media", mediaId: "camera", timelineIn: shift, sourceIn: 0, sourceOut: 20, volume: 1, transform: insetBR } },
    ]);

    const lines: ScreenLine[] = [
      // On s1 (frame [25..75, 25..75]): left-clipped sidebar line, top-clipped chart title, and pricing cell under bottom-right inset.
      { start: 100, end: 110, text: "Scheduled tasks sidebar", box: [0.20, 0.40, 0.32, 0.43] },
      { start: 100, end: 110, text: "FRONTIER MODEL BENCHMARKS", box: [0.35, 0.23, 0.60, 0.256] },
      { start: 100, end: 110, text: "$0.20 / MTok", box: [0.64, 0.65, 0.72, 0.68] },
      // On s2 settled hold (frame [0..100, 0..100], 11..20s): 10 tiny lines at 1.4% height (unreadable blog/chat).
      ...Array.from({ length: 10 }, (_, i) => ({
        start: 130, end: 140, text: `Benchmark result line number ${i + 1} with details`,
        box: [0.1, 0.1 + i * 0.03, 0.55, 0.114 + i * 0.03] as [number, number, number, number],
      })),
      // On s4 (src 200..202.5): single "Loading scene.." line.
      { start: 200, end: 203, text: "Loading scene..", box: [0.46, 0.49, 0.54, 0.51] },
    ];
    const evidence: BesideEvidence = {
      lines: new Map([["screen", lines]]),
      seconds: new Map(),
      cuts: new Map([["screen", [wholeCut(120)]]]), // Recording switched demos during the 110..130 jump!
      detail: new Map([["screen", [
        { at: 100, cells: detailGrid([10, 54], [6, 30]) },
        { at: 130, cells: detailGrid([6, 40], [4, 24]) },
        { at: 200, cells: detailGrid([30, 32], [17, 19]) }, // 4 / 2304 = 0.17% detail -> blank/loading
      ]]]),
      words: [],
    };

    const runAt = (shift: number) => {
      const tl = build(shift);
      const framed = framingReport(null, tl, media, canvas, [], [], evidence);
      return pictureFindings(tl, [], framed, []);
    };
    const found = runAt(0);
    const shifted = runAt(5);

    // 1. Glide across demo cut at t=10 is flagged; smooth pan at t=20 on same page is NOT; straight cut at t=26 is NOT.
    const moves = found.filter(f => f.kind === "moveAcrossCut");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "moveAcrossCut", from: 10, to: 11, screenChangeAt: 10, mediaId: "screen" });

    // 2. Clipped text on s1 catches BOTH left-clipped sidebar and top-clipped chart title.
    const clipped = found.filter(f => f.kind === "clippedText");
    expect(clipped).toHaveLength(1);
    expect(clipped[0]!.sides).toEqual(["left", "top"]);
    expect(clipped[0]!.lines).toEqual(expect.arrayContaining(["Scheduled tasks sidebar", "FRONTIER MODEL BENCHMARKS"]));

    // 3. Camera inset covering pricing table cell "$0.20 / MTok" on s1 is flagged.
    const covered = found.filter(f => f.kind === "underCover");
    expect(covered.some(f => f.lines?.includes("$0.20 / MTok"))).toBe(true);

    // 4. Tiny 1.4% blog/chat text on s2 is flagged as smallText.
    const small = found.filter(f => f.kind === "smallText");
    expect(small).toHaveLength(1);
    expect(small[0]).toMatchObject({ kind: "smallText", mediaId: "screen", heightPct: 1.4, videoHeight: 2160, lineCount: 10 });

    // 5. "Loading scene.." blank screen on s4 is flagged as blankScreen.
    const blank = found.filter(f => f.kind === "blankScreen");
    expect(blank).toHaveLength(1);
    expect(blank[0]).toMatchObject({ kind: "blankScreen", mediaId: "screen", showing: ["Loading scene.."] });

    // Every finding's ID is anchored to source time and survives an earlier timeline shift unchanged.
    expect(shifted.map(f => f.id)).toEqual(found.map(f => f.id));
  });

  it("ignores single-character OCR noise under the camera inset and respects custom smallTextUnder", () => {
    const media: MediaAsset[] = [
      { id: "camera", kind: "video", name: "cam", path: "cam.mp4", width: 1920, height: 1080 },
      { id: "screen", kind: "video", name: "scr", path: "scr.mp4", width: 1920, height: 1080 },
    ];
    const canvas = { width: 1920, height: 1080 };
    const tl = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "v2", kind: "video", name: "Screen", clips: [] } },
      { op: "addTrack", track: { id: "v3", kind: "video", name: "Inset", clips: [] } },
      { op: "addClip", trackId: "v2", clip: { id: "s1", kind: "media", mediaId: "screen", timelineIn: 0, sourceIn: 0, sourceOut: 10, volume: 0, transform: Transform.parse({ scale: 1 }) } },
      { op: "addClip", trackId: "v3", clip: { id: "cam", kind: "media", mediaId: "camera", timelineIn: 0, sourceIn: 0, sourceOut: 10, volume: 1,
        transform: Transform.parse({ scale: 0.25, x: 0.35, y: 0.35 }) } },
    ]);
    const lines: ScreenLine[] = [
      { start: 0, end: 10, text: "4", box: [0.85, 0.85, 0.87, 0.87] }, // 1-char OCR noise under bottom-right inset
      ...Array.from({ length: 10 }, (_, i) => ({
        start: 0, end: 10, text: `Readable line number ${i + 1} at two percent`,
        box: [0.1, 0.1 + i * 0.04, 0.5, 0.12 + i * 0.04] as [number, number, number, number], // 2.0% height
      })),
    ];
    const evidence: BesideEvidence = { lines: new Map([["screen", lines]]), seconds: new Map(), words: [] };
    // At default 2.5%, 2.0% text is flagged, while 1-char "4" under cover is ignored.
    const def = pictureFindings(tl, [], framingReport(null, tl, media, canvas, [], [], evidence), []);
    expect(def.filter(f => f.kind === "underCover")).toEqual([]);
    expect(def.filter(f => f.kind === "smallText")).toHaveLength(1);
    // With smallTextUnder lowered to 1.5%, 2.0% text is no longer flagged.
    const relaxed = pictureFindings(tl, [], framingReport(null, tl, media, canvas, [], [], evidence, 1.5), []);
    expect(relaxed.filter(f => f.kind === "smallText")).toEqual([]);
  });

  it("treats ease:hold straight cuts as cuts, catches playerControls, and checks unframed v1 screen clips unless covered full-screen", () => {
    const media: MediaAsset[] = [
      { id: "camera", kind: "video", name: "cam", path: "cam.mp4", width: 1920, height: 1080 },
      { id: "screen", kind: "video", name: "scr", path: "scr.mp4", width: 1920, height: 1080 },
    ];
    const canvas = { width: 1920, height: 1080 };
    const insetBR = Transform.parse({ scale: 0.25, x: 0.35, y: 0.35 });
    const tl = applyOps(emptyTimeline("p-v1"), [
      { op: "addTrack", track: { id: "v2", kind: "video", name: "Camera", clips: [] } },
      // v1 clip 1 (0..10, src 0..10): unframed screen, completely hidden under full-screen camera on v2 -> must NOT emit findings.
      { op: "addClip", trackId: "v1", clip: { id: "s_hidden", kind: "media", mediaId: "screen", timelineIn: 0, sourceIn: 0, sourceOut: 10, volume: 0 } },
      { op: "addClip", trackId: "v2", clip: { id: "cam_full", kind: "media", mediaId: "camera", timelineIn: 0, sourceIn: 0, sourceOut: 10, volume: 1 } },
      // v1 clip 2 (10..20, src 20..30): unframed screen with corner inset on v2 + visible video player bar "0:02 / 0:14" + tiny text -> MUST be checked.
      { op: "addClip", trackId: "v1", clip: { id: "s_unframed", kind: "media", mediaId: "screen", timelineIn: 10, sourceIn: 20, sourceOut: 30, volume: 0 } },
      { op: "addClip", trackId: "v2", clip: { id: "cam_inset", kind: "media", mediaId: "camera", timelineIn: 10, sourceIn: 20, sourceOut: 40, volume: 1, transform: insetBR } },
      // v1 clip 3 (20..30, src 50..60): straight cut at clip join immediately followed by an ease:"hold" step at clip-local 0.008s -> must NOT trigger moveAcrossCut.
      { op: "addClip", trackId: "v1", clip: { id: "s_holdcut", kind: "media", mediaId: "screen", timelineIn: 20, sourceIn: 50, sourceOut: 60, volume: 0,
        transform: Transform.parse({ scale: 1.2, x: 0, y: 0 }),
        keyframes: [
          { time: -10, transform: Transform.parse({ scale: 1.2, x: 0, y: 0 }), ease: "hold" },
          { time: 0.008, transform: Transform.parse({ scale: 1.5, x: 0, y: 0 }), ease: "hold" },
        ] } },
    ]);
    const lines: ScreenLine[] = [
      // Hidden under full-screen camera (src 0..10): should produce zero findings.
      { start: 0, end: 10, text: "0:01 / 0:54", box: [0.4, 0.8, 0.5, 0.82] },
      // Visible unframed screen (src 20..30): player controls + covered pricing text.
      { start: 20, end: 30, text: "0:02 / 0:14", box: [0.35, 0.85, 0.45, 0.87] },
      { start: 20, end: 30, text: "$0.20 / MTok", box: [0.80, 0.82, 0.92, 0.85] },
    ];
    const evidence: BesideEvidence = {
      lines: new Map([["screen", lines]]),
      seconds: new Map(),
      cuts: new Map([["screen", [wholeCut(40)]]]), // Cut during the 30..50 source jump into s_holdcut
      words: [],
    };
    const found = pictureFindings(tl, [], framingReport(null, tl, media, canvas, [], [], evidence), []);
    // 0. Discovery pass (beside = undefined, as framedOn runs first) discovers the unframed v1 screen clip too.
    expect(framingReport(null, tl, media, canvas).some(s => s.mediaId === "screen" && s.from <= 10 && s.to >= 20)).toBe(true);
    // 1. ease:"hold" straight cut at t=20 is NOT flagged as moveAcrossCut.
    expect(found.filter(f => f.kind === "moveAcrossCut")).toEqual([]);
    // 2. Hidden v1 stretch (0..10) under full-screen camera emits NO findings.
    expect(found.filter(f => f.from < 10)).toEqual([]);
    // 3. Visible unframed v1 stretch (10..20) catches BOTH playerControls and underCover.
    expect(found.filter(f => f.kind === "playerControls")).toMatchObject([{ kind: "playerControls", mediaId: "screen", showing: ["0:02 / 0:14"] }]);
    expect(found.filter(f => f.kind === "underCover" && f.lines?.includes("$0.20 / MTok"))).toHaveLength(1);
  });
});
