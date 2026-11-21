import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline } from "@scarlet/timeline";
import { screenReadings, type ScreenLine } from "./screen-reading.js";
import { framingReport } from "./framing-report.js";
import { motionSpans } from "./screen-motion.js";
import type { TimelineWord } from "./timeline-perception.js";

// A screen recording 10 s into its file plays from timeline 0 to 20 under a camera recording that is heard.
function timeline(screen: Record<string, unknown> = {}) {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
    { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
    { op: "addClip", trackId: "cam", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 20, timelineIn: 0 } },
    { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 10, sourceOut: 20, timelineIn: 0, ...screen } },
    { op: "addClip", trackId: "scr", clip: { id: "s2", kind: "media", mediaId: "screen", sourceIn: 22, sourceOut: 32, timelineIn: 10, ...screen } },
  ]);
}

const said = (text: string, start: number, step = 0.3): TimelineWord[] =>
  text.split(" ").map((word, i) => ({ mediaId: "camera", index: i, text: word, start: start + i * step, end: start + i * step + 0.25 }));

const lines: ScreenLine[] = [
  { start: 10, end: 25, text: "Leave your Lineage pure: do not investigate", box: [0.3, 0.5, 0.6, 0.52] },
  { start: 10, end: 25, text: "origin, ancestry, or self-inflicted", box: [0.3, 0.53, 0.55, 0.55] },
  { start: 10, end: 32, text: "Settings", box: [0.9, 0.02, 0.95, 0.04] },
  { start: 26, end: 32, text: "Price per million tokens", box: [0.1, 0.2, 0.4, 0.23] },
];

describe("screenReadings", () => {
  it("finds a passage read aloud across lines, with the area of the lines it was read from", () => {
    const words = [...said("so it told me this", 1), ...said("leave your lineage pure do not investigate origin ancestry or self-inflicted", 3)];
    const [reading, ...rest] = screenReadings(timeline(), words, new Map([["screen", lines]]));
    expect(rest).toEqual([]);
    expect(reading).toMatchObject({ mediaId: "screen", from: 3, matched: 11, said: "leave your lineage pure do not investigate origin ancestry or self-inflicted",
      box: [0.3, 0.5, 0.6, 0.55] });
    expect(reading!.lines.map(l => l.text)).toEqual([lines[0]!.text, lines[1]!.text]);
    // Source seconds of the screen recording, 10 s into its file.
    expect(reading!.source[0]).toBeCloseTo(13);
  });

  it("matches only text on screen as it is said, and not a few common words", () => {
    // "price per million tokens" is on screen only from source 26, timeline 14.
    expect(screenReadings(timeline(), said("the price per million tokens", 2), new Map([["screen", lines]]))).toEqual([]);
    expect(screenReadings(timeline(), said("the price per million tokens", 15), new Map([["screen", lines]]))).toHaveLength(1);
    expect(screenReadings(timeline(), said("do not go", 15), new Map([["screen", lines]]))).toEqual([]);
  });
});

describe("framingReport", () => {
  const media = [{ id: "screen", kind: "video", width: 1920, height: 1080 }, { id: "camera", kind: "video", width: 1920, height: 1080 }] as never;
  const canvas = { width: 1920, height: 1080 };

  it("gives where the frame holds and moves, a move starting on a cut, and a passage read aloud that the frame leaves out", () => {
    const before = timeline();
    // Zoomed to the top left on the first clip; the second starts there and moves to the bottom right over its first second.
    const after = applyOps(before, [
      { op: "updateClip", clipId: "s1", patch: { transform: { scale: 2, x: 0.5, y: 0.5 } } },
      { op: "updateClip", clipId: "s2", patch: { transform: { scale: 2, x: 0.5, y: 0.5 }, keyframes: [
        { time: 0, transform: { scale: 2, x: 0.5, y: 0.5 }, ease: "linear" }, { time: 1, transform: { scale: 2, x: -0.5, y: -0.5 }, ease: "linear" }] } },
    ]);
    const reading = { from: 3, to: 6, mediaId: "screen", source: [13, 16] as [number, number], said: "leave your lineage", matched: 3, lines: [], box: [0.3, 0.5, 0.6, 0.55] as [number, number, number, number] };
    const [stretch, ...rest] = framingReport(before, after, media, canvas, [reading]);
    expect(rest).toEqual([]);
    expect(stretch).toMatchObject({ mediaId: "screen", trackId: "scr", from: 0, to: 20, clips: 2 });
    expect(stretch!.holds.map(h => [h.from, h.frame])).toEqual([[0, [0, 0, 50, 50]], [11, [50, 50, 100, 100]]]);
    expect(stretch!.moves).toEqual([{ from: 10, to: 11, fromFrame: [0, 0, 50, 50], toFrame: [50, 50, 100, 100], onCut: true }]);
    // The top-left quarter leaves out most of a passage at 30-60% across, 50-55% down.
    expect(stretch!.readsHidden).toEqual([expect.objectContaining({ from: 3, outsideFrame: 100 })]);
    // The cube still turning low on the picture as the frame moves up and away from it.
    const turning = [{ mediaId: "screen", from: 10, to: 12, box: [0.6, 0.6, 0.9, 0.9] as [number, number, number, number], share: 0.1 }];
    expect(framingReport(before, after, media, canvas, [], turning)[0]!.actionHidden).toEqual([{ from: 10, to: 12, box: [60, 60, 90, 90], outsideFrame: 100 }]);
    // Nothing the edit didn't frame is reported.
    expect(framingReport(after, after, media, canvas)).toEqual([]);
  });

  it("gives the video beside a stretch where the recording, off picture, still shows what the frame did, on the clock of the camera beside it", () => {
    // The camera plays throughout, cut at 25 to later footage; the screen, 10 s ahead of it, is framed on its top-left quarter from 5 to 15.
    const before = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c1", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 25, timelineIn: 0 } },
      { op: "addClip", trackId: "cam", clip: { id: "c2", kind: "media", mediaId: "camera", sourceIn: 60, sourceOut: 75, timelineIn: 25 } },
      { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 15, sourceOut: 25, timelineIn: 5 } },
    ]);
    const after = applyOps(before, [{ op: "updateClip", clipId: "s1", patch: { transform: { scale: 2, x: 0.5, y: 0.5 } } }]);
    const demo: ScreenLine = { start: 12, end: 34, text: "Watermelon vs. rifle bullet", box: [0.1, 0.1, 0.4, 0.15] };
    const outside: ScreenLine = { start: 0, end: 90, text: "Settings", box: [0.6, 0.6, 0.9, 0.65] };
    const changes = (...at: number[]) => at.map(s => ({ at: s, areas: [[0.1, 0.2, 0.4, 0.45, 0.05]] as Array<[number, number, number, number, number]> }));
    const words = said("I mean it's pretty cool to watch", 16, 1);
    const report = (lines: ScreenLine[], seconds: ReturnType<typeof changes>) =>
      framingReport(before, after, media, canvas, [], [], { lines: new Map([["screen", lines]]), seconds: new Map([["screen", seconds]]), words })[0]!;

    // The demo's title stays on screen to source 34, timeline 24, while the frame's area keeps moving from source 27.
    const stretch = report([demo, outside], changes(11, 27));
    expect(stretch.shownAfter).toEqual({ from: 15, to: 24, showing: ["Watermelon vs. rifle bullet"], said: "I mean it's pretty cool to watch" });
    // Before, the title came up at source 12, timeline 2, and the frame's area held still from then on.
    expect(stretch.shownBefore).toEqual({ from: 2, to: 5, showing: ["Watermelon vs. rifle bullet"], unchanged: true });
    // A screen that moves on as the stretch ends has nothing beside it; text outside the frame doesn't count.
    expect(report([{ ...demo, end: 25 }, outside], changes(25)).shownAfter).toBeUndefined();
    // With no text, an area that holds still says so, up to where the camera's cut takes the clock past its change.
    expect(report([], changes(11, 40)).shownAfter).toEqual({ from: 15, to: 25, unchanged: true, said: "I mean it's pretty cool to watch" });
  });

  it("names the passages read aloud off the recording beside a stretch while it is off picture", () => {
    // Neon review 2, 5:45: the screen ended on a live mock, then 25 s of camera while he read its note out word for word.
    const before = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c1", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 25, timelineIn: 0 } },
      { op: "addClip", trackId: "cam", clip: { id: "c2", kind: "media", mediaId: "camera", sourceIn: 60, sourceOut: 75, timelineIn: 25 } },
      { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 15, sourceOut: 25, timelineIn: 5 } },
    ]);
    const after = applyOps(before, [{ op: "updateClip", clipId: "s1", patch: { transform: { scale: 2, x: 0.5, y: 0.5 } } }]);
    const note: ScreenLine = { start: 12, end: 34, text: "Noted, I'll include a live mock for UI changes going forward.", box: [0.1, 0.1, 0.4, 0.15] };
    const words = [...said("and at the bottom", 16), ...said("noted I'll include a live mock for UI changes", 17.5), ...said("it's just super clean", 21)];
    const report = (lines: ScreenLine[]) =>
      framingReport(before, after, media, canvas, [], [], { lines: new Map([["screen", lines]]), seconds: new Map([["screen", []]]), words })[0]!;

    expect(report([note]).shownAfter?.reads).toEqual([{ from: 17.5, to: 20.15, said: "noted I'll include a live mock for UI changes" }]);
    // Text the recording shows only later on its clock isn't read yet.
    expect(report([{ ...note, start: 40 }]).shownAfter?.reads).toBeUndefined();
  });

  it("says how far the speaker's eyes look down beside a stretch, in the picture of the recording heard there", () => {
    const before = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c1", kind: "media", mediaId: "camera", sourceIn: 100, sourceOut: 130, timelineIn: 0 } },
      { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 15, sourceOut: 25, timelineIn: 5 } },
    ]);
    const after = applyOps(before, [{ op: "updateClip", clipId: "s1", patch: { transform: { scale: 2, x: 0.5, y: 0.5 } } }]);
    const page: ScreenLine = { start: 0, end: 60, text: "Noted, I'll include a live mock for UI changes going forward.", box: [0.1, 0.1, 0.4, 0.15] };
    const report = (eyes?: Array<{ start: number; end: number; eyesDown?: number }>) => framingReport(before, after, media, canvas, [], [],
      { lines: new Map([["screen", [page]]]), seconds: new Map([["screen", []]]), words: [], ...(eyes && { eyes: new Map([["camera", eyes]]) }) })[0]!;
    // After the screen, 15-30 s of the video plays the camera's 115-130 s: down at the laptop from 120 s, at the lens before.
    expect(report([{ start: 100, end: 120, eyesDown: 0.1 }, { start: 120, end: 130, eyesDown: 0.7 }]).shownAfter).toMatchObject({ from: 15, to: 30, eyesDown: 0.5 });
    // Before it, 0-5 s plays 100-105 s.
    expect(report([{ start: 100, end: 120, eyesDown: 0.1 }, { start: 120, end: 130, eyesDown: 0.7 }]).shownBefore).toMatchObject({ from: 0, to: 5, eyesDown: 0.1 });
    // Where to see the face midway, 22.75 s of the video at the camera's 122.75 s: two and a half faces wide round it.
    const face = [0.4, 0.2, 0.5, 0.4];
    expect(report([{ start: 100, end: 130, eyesDown: 0.7, box: face }]).shownAfter?.look).toEqual({ mediaId: "camera", at: 122.75, area: [32.5, 17.5, 57.5, 42.5] });
    // No eyes read, or read over less than half of it: nothing said.
    expect(report().shownAfter?.eyesDown).toBeUndefined();
    expect(report([{ start: 125, end: 130, eyesDown: 0.7 }]).shownAfter?.eyesDown).toBeUndefined();
  });

  // A camera heard on its own sound track, its picture beneath a silent screen recording 10 s ahead of it, laid in two
  // clips that are off picture until an edit turns them on.
  function cameraAndScreen(screen: { s1?: boolean; s2?: boolean } = {}) {
    return applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "voice", kind: "audio", name: "Camera sound", clips: [] } },
      { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 40, timelineIn: 0, volume: 0 } },
      { op: "addClip", trackId: "voice", clip: { id: "v", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 40, timelineIn: 0 } },
      { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 15, sourceOut: 25, timelineIn: 5, volume: 0, enabled: !!screen.s1 } },
      { op: "addClip", trackId: "scr", clip: { id: "s2", kind: "media", mediaId: "screen", sourceIn: 25, sourceOut: 35, timelineIn: 15, volume: 0, enabled: !!screen.s2 } },
    ]);
  }
  /** A cut in the recording at `at` that changes every cell of its picture. */
  const wholeCut = (at: number) => ({ at, share: 1, cells: Buffer.alloc(64 * 36 / 8, 0xff).toString("base64") });
  const post: ScreenLine = { start: 10, end: 60, text: "Below Neon 3D modeled a lab simulation", box: [0.3, 0.3, 0.7, 0.33] };
  const bookmarks: ScreenLine = { start: 0, end: 90, text: "Contractors", box: [0.1, 0.05, 0.15, 0.07] };

  it("reports a silent recording a save only turns on in place of the camera, with the video after it while the recording shows the same page", () => {
    const before = cameraAndScreen(), after = cameraAndScreen({ s1: true });
    const words = said("and I think this looks incredible", 16, 0.5);
    const evidence = (cuts: ReturnType<typeof wholeCut>[]) => ({ lines: new Map([["screen", [bookmarks, post]]]), seconds: new Map(), cuts: new Map([["screen", cuts]]), words });
    const [stretch, ...rest] = framingReport(before, after, media, canvas, [], [], evidence([wholeCut(31)]));
    expect(rest).toEqual([]);
    expect(stretch).toMatchObject({ mediaId: "screen", from: 5, to: 15, holds: [{ from: 5, to: 15, frame: [0, 0, 100, 100] }] });
    // The recording goes on showing the post until it cuts to another page at source 31, timeline 21; the page's own
    // sentence leads, ahead of the browser's bookmarks bar.
    expect(stretch!.shownAfter).toEqual({ from: 15, to: 21, showing: ["Below Neon 3D modeled a lab simulation", "Contractors"], unchanged: true,
      said: "and I think this looks incredible" });
    // The bookmarks bar stays through the cut, and by itself doesn't carry the page past it.
    const lines = new Map([["screen", [bookmarks, { ...post, end: 31 }]]]);
    expect(framingReport(before, after, media, canvas, [], [], { ...evidence([wholeCut(31)]), lines })[0]!.shownAfter).toMatchObject({ from: 15, to: 21 });
    // A cut in a small part of the picture, such as a video playing in the post, doesn't end it.
    const small = { at: 31, share: 0.01, cells: Buffer.alloc(64 * 36 / 8).fill(0xff, 0, 8).toString("base64") };
    expect(framingReport(before, after, media, canvas, [], [], evidence([small]))[0]!.shownAfter).toMatchObject({ from: 15, to: 40 });
  });

  it("doesn't take a silent main picture, beside a separate recorder's sound, for one shown in its place", () => {
    const before = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "mic", kind: "audio", name: "Recorder", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 40, timelineIn: 0, volume: 0 } },
      { op: "addClip", trackId: "mic", clip: { id: "m", kind: "media", mediaId: "recorder", sourceIn: 0, sourceOut: 40, timelineIn: 0 } },
    ]);
    expect(framingReport(before, applyOps(before, [{ op: "rippleDelete", start: 10, end: 12 }]), media, canvas)).toEqual([]);
  });

  it("reports a stretch whose edges a save moves by turning the recording off beside it, and none a save leaves alone", () => {
    const both = cameraAndScreen({ s1: true, s2: true });
    const [stretch, ...rest] = framingReport(both, cameraAndScreen({ s1: true }), media, canvas);
    expect(rest).toEqual([]);
    expect(stretch).toMatchObject({ from: 5, to: 15 });
    expect(framingReport(both, both, media, canvas)).toEqual([]);
  });

  it("names the screen's text a camera inset sits on while the frame holds, and the corners where it would sit on none", () => {
    // A chart framed whole, with the camera laid over its bottom right quarter in the same save.
    const before = cameraAndScreen({ s1: true });
    const after = applyOps(before, [
      { op: "updateClip", clipId: "s1", patch: { transform: { scale: 1, x: 0, y: 0 } } },
      { op: "addTrack", track: { id: "inset", kind: "video", name: "Inset", clips: [] } },
      { op: "addClip", trackId: "inset", clip: { id: "i", kind: "media", mediaId: "camera", sourceIn: 5, sourceOut: 15, timelineIn: 5, volume: 0, transform: { scale: 0.3, x: 0.32, y: 0.32 } } },
    ]);
    const header: ScreenLine = { start: 0, end: 90, text: "Claude Opus 5.5", box: [0.6, 0.1, 0.75, 0.13] };
    const covered: ScreenLine = { start: 0, end: 90, text: "80.0%", box: [0.7, 0.8, 0.76, 0.83] };
    const left: ScreenLine = { start: 0, end: 90, text: "RiemannBench", box: [0.05, 0.8, 0.2, 0.83] };
    const evidence = (lines: ScreenLine[]) => ({ lines: new Map([["screen", lines]]), seconds: new Map(), words: [] });
    const [stretch] = framingReport(before, after, media, canvas, [], [], evidence([header, covered, left]));
    expect(stretch!.holds).toEqual([{ from: 5, to: 15, frame: [0, 0, 100, 100], underCover: ["80.0%"], cornersClearOfText: ["top-left"] }]);
    // Text beside the inset, not under it, isn't named.
    expect(framingReport(before, after, media, canvas, [], [], evidence([header, left]))[0]!.holds[0]!.underCover).toBeUndefined();
    // A ring with no text in it, most of it under the inset's left edge, and a flat background elsewhere.
    const cells = new Uint8Array(64 * 36 / 8);
    for (let y = 26; y < 30; y++) for (let x = 40; x < 48; x++) cells[(y * 64 + x) >> 3]! |= 1 << ((y * 64 + x) & 7);
    const ring = { ...evidence([header, left]), detail: new Map([["screen", [{ at: 0, cells: Buffer.from(cells).toString("base64") }]]]) };
    const hold = framingReport(before, after, media, canvas, [], [], ring)[0]!.holds[0]!;
    expect(hold.underCover).toBeUndefined();
    expect(hold.coverHides).toEqual([{ box: [62.5, 72.2, 75, 83.3], hidden: 63 }]);
    expect(hold.detailInCorners).toEqual({ "bottom-right": 10, "bottom-left": 0, "top-right": 0, "top-left": 0 });
    // A save that only moves the inset over a stretch it leaves framed as it was reports the stretch too.
    const moved = applyOps(after, [{ op: "updateClip", clipId: "i", patch: { transform: { scale: 0.3, x: -0.32, y: 0.32 } } }]);
    expect(framingReport(after, moved, media, canvas, [], [], evidence([header, covered, left]))[0]!.holds[0]!.underCover).toEqual(["RiemannBench"]);
  });

  it("keeps the time beside a stretch on the clip that plays on into it where two overlap at a crossfaded cut", () => {
    // The camera's sound cuts at 10 from source 10 to 50 with a 0.1 s crossfade; the screen, 10 s ahead, comes on at the cut.
    const before = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
      { op: "addTrack", track: { id: "voice", kind: "audio", name: "Camera sound", clips: [] } },
      { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "cam", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 10, timelineIn: 0, volume: 0 } },
      { op: "addClip", trackId: "voice", clip: { id: "v1", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 10.05, timelineIn: 0 } },
      { op: "addClip", trackId: "voice", clip: { id: "v2", kind: "media", mediaId: "camera", sourceIn: 49.95, sourceOut: 70, timelineIn: 9.95 } },
      { op: "addClip", trackId: "scr", clip: { id: "s", kind: "media", mediaId: "screen", sourceIn: 60, sourceOut: 70, timelineIn: 10, volume: 0, enabled: false } },
    ]);
    const after = applyOps(before, [{ op: "updateClip", clipId: "s", patch: { enabled: true } }]);
    // The post is up from source 55; before that the picture keeps changing.
    const seconds = Array.from({ length: 50 }, (_, at) => ({ at, areas: [[0, 0, 1, 1, 0.5]] as Array<[number, number, number, number, number]> }));
    const report = framingReport(before, after, media, canvas, [], [], { lines: new Map([["screen", [{ ...post, start: 55, end: 70 }]]]), seconds: new Map([["screen", seconds]]), words: [] });
    expect(report).toHaveLength(1);
    // Before the cut the camera is at source 9, the screen at 19, which doesn't show the post: read on the outgoing
    // clip's clock, the screen there read as source 59, with the post on it.
    expect(report[0]!.shownBefore).toBeUndefined();
  });
});

describe("motionSpans", () => {
  it("runs seconds where the same area changes into one span on the timeline, and keeps a pointer apart", () => {
    const seconds = [
      { at: 12, areas: [[0.3, 0.3, 0.6, 0.8, 0.1], [0.9, 0.1, 0.91, 0.12, 0.001]] as Array<[number, number, number, number, number]> },
      { at: 13, areas: [[0.32, 0.3, 0.62, 0.85, 0.12]] as Array<[number, number, number, number, number]> },
      // The pointer alone, then a new area elsewhere.
      { at: 15, areas: [[0.7, 0.2, 0.71, 0.22, 0.001]] as Array<[number, number, number, number, number]> },
      { at: 16, areas: [[0.05, 0.05, 0.2, 0.2, 0.05]] as Array<[number, number, number, number, number]> },
    ];
    expect(motionSpans(timeline(), new Map([["screen", seconds]]))).toEqual([
      { mediaId: "screen", from: 2, to: 4, box: [0.3, 0.3, 0.62, 0.85], share: 0.12, small: [[0.905, 0.11]] },
      { mediaId: "screen", from: 5, to: 6, box: [0.7, 0.2, 0.71, 0.22], share: 0.001 },
      { mediaId: "screen", from: 6, to: 7, box: [0.05, 0.05, 0.2, 0.2], share: 0.05 },
    ]);
  });
});
