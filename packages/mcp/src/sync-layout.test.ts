import { expect, it } from "vitest";
import { applyOps, createProject, emptyTimeline, makeMediaClip, makeTrack, Transform } from "@scarlet/timeline";
import { InsetFraming, insetStretches, presetInset, syncPictureOps, type FaceReading } from "./sync-layout.js";

it("leaves solo cameras and intentional compositions alone, and uses the selected camera above an earlier screen", () => {
  const project = createProject("Screen and camera");
  project.media = ["one", "two"].map(id => ({ id, kind: "video", name: id, path: id + ".mov" }));
  const placed = emptyTimeline(project.id);
  const camera = makeMediaClip("two", 3, 7, 1, { id: "presenter", volume: .8 });
  const upper = makeTrack("video", "V2");
  upper.clips.push(camera);
  placed.tracks.push(upper);
  expect(syncPictureOps(project, placed)).toEqual([]);
  const screen = makeMediaClip("one", 0, 8, 0, { id: "screen", volume: 0 });
  placed.tracks[0]!.clips.push(screen);
  expect(syncPictureOps(project, placed)).toEqual([]);
  const roles = { screenClipId: screen.id, cameraClipId: camera.id };
  const framed = applyOps(placed, syncPictureOps(project, placed, roles));
  const framing = { x: -.25, y: .1, scale: .4, cropLeft: .13, cropRight: .13, cropTop: .06, cornerRadius: .06 };
  const custom = applyOps(placed, syncPictureOps(project, placed, { ...roles, framing: InsetFraming.parse(framing) }));
  expect(custom.tracks.at(-1)!.clips[0]).toMatchObject({ transform: framing });
  expect(framed.tracks).toHaveLength(placed.tracks.length);
  expect(framed.tracks[0]).toEqual(placed.tracks[0]);
  expect(framed.tracks.at(-1)!.clips).toEqual([{ ...camera, transform: Transform.parse({ x: .35, y: .35, scale: .25 }) }]);
  camera.transform = Transform.parse({ x: -.2, scale: .6 });
  expect(syncPictureOps(project, placed, "asPlaced")).toEqual([]);
  expect(() => syncPictureOps(project, placed, roles)).toThrow("already has framing");
  camera.transform = Transform.parse({ cornerRadius: .08 });
  expect(() => syncPictureOps(project, placed, roles)).toThrow("already has framing");
});

it("doesn't split off a clip of no length where the camera and screen end together but for rounding", () => {
  const project = createProject("Synced");
  project.media = ["screen", "camera"].map(id => ({ id, kind: "video", name: id, path: id + ".mov" }));
  const tl = emptyTimeline(project.id);
  // As an agent lays them: the camera starts 3.64 s into its recording, and both run to the same instant on the timeline.
  const screen = makeMediaClip("screen", 0, 3463.95, 0, { id: "screen", volume: 0 });
  const camera = makeMediaClip("camera", 3.64, 3467.59, 0, { id: "camera" });
  tl.tracks[0]!.clips.push(screen);
  const upper = makeTrack("video", "Camera");
  upper.clips.push(camera);
  tl.tracks.push(upper);
  const ops = syncPictureOps(project, tl, { screenClipId: "screen", cameraClipId: "camera" });
  expect(ops.filter(op => op.op === "splitClip")).toEqual([]);
  const laid = applyOps(tl, ops);
  expect(laid.tracks.flatMap(t => t.clips)).toHaveLength(2);
});

it("insets only the overlap of a camera that rolls before and after the screen, on a new track above it", () => {
  const project = createProject("Screen over camera");
  project.media = ["screen", "camera"].map(id => ({ id, kind: "video", name: id, path: id + ".mov" }));
  const tl = emptyTimeline(project.id);
  // The camera sits on the track under the screen recording, and runs two seconds past it at each end.
  const camera = makeMediaClip("camera", 0, 10, 0, { id: "camera" });
  const screen = makeMediaClip("screen", 0, 6, 2, { id: "screen", volume: 0 });
  tl.tracks[0]!.clips.push(camera);
  const upper = makeTrack("video", "Screen");
  upper.clips.push(screen);
  tl.tracks.splice(1, 0, upper);
  const laid = applyOps(tl, syncPictureOps(project, tl, { screenClipId: "screen", cameraClipId: "camera" }));
  // The lead and the tail stay full frame where they were, on their own source clock.
  expect(laid.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut, c.transform])).toEqual([[0, 0, 2, undefined], [8, 8, 10, undefined]]);
  expect(laid.tracks[1]!.clips).toEqual([screen]);
  // The overlap moves to a track of its own right above the screen, framed as the default inset.
  const inset = laid.tracks[2]!;
  expect(inset).toMatchObject({ kind: "video", name: "Camera inset", muted: false });
  expect(inset.clips).toHaveLength(1);
  expect(inset.clips[0]).toMatchObject({ mediaId: "camera", timelineIn: 2, sourceIn: 2, sourceOut: 8, transform: { scale: .25, x: .35, y: .35 } });
  // The audio track stays last.
  expect(laid.tracks.map(t => t.kind)).toEqual(["video", "video", "video", "audio"]);
});

it("asks for a screen and a separate camera that overlap, and names what is wrong", () => {
  const project = createProject("Roles");
  project.media = [{ id: "screen", kind: "video", name: "screen", path: "screen.mov" }, { id: "camera", kind: "video", name: "camera", path: "camera.mov" },
    { id: "mic", kind: "audio", name: "mic", path: "mic.wav" }];
  const tl = emptyTimeline(project.id);
  const upper = makeTrack("video", "Camera");
  tl.tracks.push(upper);
  const screen = makeMediaClip("screen", 0, 5, 0, { id: "screen" });
  tl.tracks[0]!.clips.push(screen, makeMediaClip("screen", 5, 9, 5, { id: "same-track" }), makeMediaClip("mic", 0, 9, 10, { id: "sound-only" }));
  upper.clips.push(makeMediaClip("camera", 0, 3, 6, { id: "later" }), makeMediaClip("screen", 0, 3, 0, { id: "same-source" }),
    makeMediaClip("camera", 0, 3, 0, { id: "invisible", opacity: 0 }));
  const roles = (cameraClipId: string) => () => syncPictureOps(project, tl, { screenClipId: "screen", cameraClipId });
  // Not on the timeline, on the screen's own track, the screen's own recording, hidden, or not a video.
  for (const id of ["missing", "same-track", "same-source", "invisible", "sound-only"]) {
    expect(roles(id), id).toThrow("Choose a screen clip and a separate camera recording on visible video tracks.");
  }
  expect(roles("later")).toThrow("The screen and camera clips must overlap after sync.");
  upper.hidden = true;
  expect(roles("later")).toThrow("Choose a screen clip and a separate camera recording");
});

// The presenter as `faces` read a 4K talking head on 2026-11-20: one face, a little right of centre, in spans that each
// hold its box through small moves.
const presenter = (track = 1, shift = 0): FaceReading["spans"] => [
  { track, start: 73, end: 107.5, box: [.414 + shift, .266, .623 + shift, .796], eyes: [.527 + shift, .453], confidence: .95 },
  { track, start: 107.5, end: 152.5, box: [.434 + shift, .268, .636 + shift, .72], eyes: [.554 + shift, .46], confidence: .95 },
  { track, start: 152.5, end: 286.5, box: [.409 + shift, .269, .62 + shift, .767], eyes: [.519 + shift, .481], confidence: .95 },
  { track, start: 286.5, end: 400, box: [.415 + shift, .237, .621 + shift, .728], eyes: [.528 + shift, .424], confidence: .95 },
];
const camera = { width: 3840, height: 2160 };
const project4k = () => createProject("Demo", { width: 3840, height: 2160 });

it("crops the preset inset to the presenter's head and shoulders, in the canvas's shape and its corner", () => {
  const { framing, presenter: held, whole } = presetInset(project4k(), camera, [{ spans: presenter() }]);
  expect(whole).toBeUndefined();
  expect(held).toMatchObject({ seconds: 327 });
  const w = 1 - framing.cropLeft! - framing.cropRight!, h = 1 - framing.cropTop! - framing.cropBottom!;
  // The canvas's shape: no background beside the camera, and the same corner and size as the whole-picture preset.
  expect(w * camera.width / (h * camera.height)).toBeCloseTo(16 / 9, 2);
  expect(framing).toMatchObject({ scale: .25, x: .35, y: .35 });
  // Tighter than the whole picture, holding the face's box wherever the presenter keeps to, eyes in the upper half.
  expect(w).toBeLessThan(.85);
  expect(framing.cropLeft).toBeLessThan(.409);
  expect(1 - framing.cropRight!).toBeGreaterThan(.636);
  expect(framing.cropTop).toBeLessThan(.237);
  const eyeLine = (.46 - framing.cropTop!) / h;
  expect(eyeLine).toBeGreaterThan(.35);
  expect(eyeLine).toBeLessThan(.5);
});

it("frames the inset as the editor's skill asks: 20% larger, 1.5:1, down to the desk, corners rounded", () => {
  // matt-talking-head: “scale it up by 20% in both dimensions, then crop the sides … 1.5:1 … from clear room above
  // my hair down to the desk in front of me … Round all four corners of the inset.”
  const { framing, whole } = presetInset(project4k(), camera, [{ spans: presenter() }], { show: "desk", aspect: 1.5, size: 1.2, cornerRadius: .06 });
  expect(whole).toBeUndefined();
  const w = 1 - framing.cropLeft! - framing.cropRight!, h = 1 - framing.cropTop! - framing.cropBottom!;
  expect(w * camera.width / (h * camera.height)).toBeCloseTo(1.5, 2);
  // Down to the bottom of the camera's picture, from above the hair, with the sides cut.
  expect(framing.cropBottom).toBe(0);
  expect(framing.cropTop).toBeGreaterThan(0);
  expect(framing.cropTop).toBeLessThan(.15);
  expect(framing.cropLeft).toBeGreaterThan(.05);
  expect(framing.cropRight).toBeGreaterThan(.05);
  // A quarter of the canvas's height, 20% larger, in the bottom-right corner with the preset's margin.
  expect(framing).toMatchObject({ scale: .3, cornerRadius: .06 });
  const heightOnCanvas = .3, widthOnCanvas = .3 * 1.5 / (16 / 9);
  expect(.5 + framing.x + widthOnCanvas / 2).toBeCloseTo(.975, 3);
  expect(.5 + framing.y + heightOnCanvas / 2).toBeCloseTo(.975, 3);
});

it("leaves clear room above the hair at the presenter's highest, and keeps a camera's whole top when it has little", () => {
  // Hair sits about 0.8 of a face width above the eyes. Over the hair at the presenter's highest, the crop leaves room.
  const source = camera.width / camera.height;
  const spans = presenter(), face = (.623 - .414) * source;
  const highest = Math.min(...spans.map(s => s.eyes[1]));
  const { framing } = presetInset(project4k(), camera, [{ spans }], { show: "desk", aspect: 1.5, size: 1.2 });
  expect((highest - .8 * face) - framing.cropTop!).toBeGreaterThan(.15 * face);
  // His camera in a review on 2026-11-20 had his hair about 4% of the picture from its top: no room to crop there.
  const tight: FaceReading["spans"] = [
    { track: 1, start: 160, end: 400, box: [.46, .106, .589, .405], eyes: [.524, .234], confidence: .93 },
    { track: 1, start: 400, end: 405, box: [.46, .093, .589, .405], eyes: [.524, .207], confidence: .93 },
    { track: 1, start: 405, end: 900, box: [.45, .12, .59, .42], eyes: [.52, .25], confidence: .93 },
  ];
  expect(presetInset(project4k(), camera, [{ spans: tight }], { show: "desk", aspect: 1.5, size: 1.2 }).framing.cropTop).toBe(0);
});

it("reaches further down for more of the presenter and stops at the chin for a head", () => {
  const reach = (show: "head" | "shoulders" | "chest" | "desk") => 1 - presetInset(project4k(), camera, [{ spans: presenter() }], { show }).framing.cropBottom!;
  expect(reach("head")).toBeLessThan(reach("shoulders"));
  expect(reach("shoulders")).toBeLessThan(reach("chest"));
  // This camera's picture ends at his chest: the desk is as far as it shows.
  expect(reach("chest")).toBe(1);
  expect(reach("desk")).toBe(1);
});

it("cuts a camera it can't frame on a presenter to the shape asked from its middle", () => {
  const { framing, whole } = presetInset(project4k(), camera, [], { aspect: 1.5, cornerRadius: .06 });
  expect(whole).toBe("no face was found in the camera's picture");
  expect(framing).toMatchObject({ cropTop: 0, cropBottom: 0, cornerRadius: .06 });
  expect(framing.cropLeft).toBeCloseTo(framing.cropRight!, 4);
  expect(framing.cropLeft).toBeGreaterThan(.07);
});

it("keeps the crop inside the picture for a presenter near its edge", () => {
  const { framing } = presetInset(project4k(), camera, [{ spans: presenter(1, .33) }]);
  expect(framing.cropRight).toBe(0);
  expect(framing.cropLeft).toBeGreaterThan(0);
});

it("counts only the seconds of a span inside the stretch that read it", () => {
  // Two ten-second stretches inside one long span: twenty seconds of the presenter, not the span's length twice.
  const span = presenter()[2]!;
  expect(presetInset(project4k(), camera, [{ from: 160, to: 170, spans: [span] }, { from: 260, to: 270, spans: [span] }]).presenter)
    .toMatchObject({ seconds: 20 });
});

it("reads the presenter across stretches read apart, and follows the face most on screen", () => {
  const spans = presenter();
  const glimpse = { track: 2, start: 200, end: 203, box: [.05, .3, .1, .4] as const, eyes: [.07, .33] as const, confidence: .55 };
  const { framing } = presetInset(project4k(), camera, [{ spans: spans.slice(0, 2) }, { spans: [...spans.slice(2), glimpse] }]);
  expect(framing.cropLeft).toBeGreaterThan(.1);
});

it("shows the whole camera when there is no presenter to frame, two to choose between, or one who fills it", () => {
  const project = project4k();
  const preset = { scale: .25, x: .35, y: .35 };
  expect(presetInset(project, camera, [])).toEqual({ framing: preset, whole: "no face was found in the camera's picture" });
  expect(presetInset(project, camera, [{ done: false, spans: [] }])).toEqual({ framing: preset, whole: "its faces weren't read in time" });
  expect(presetInset(project, {}, [{ spans: presenter() }])).toMatchObject({ framing: preset, whole: "the camera's picture size isn't known yet" });
  const guest = presenter(2, -.3);
  expect(presetInset(project, camera, [{ spans: [...presenter(), ...guest] }]).whole).toMatch(/^a second face shares the camera's picture/);
  const close = [{ track: 1, start: 0, end: 60, box: [.3, .1, .7, .9] as const, eyes: [.5, .4] as const, confidence: .95 }];
  expect(presetInset(project, camera, [{ spans: close }])).toMatchObject({ framing: preset, whole: "the presenter already fills the camera's picture" });
});

it("reads faces in a few short stretches spread over a long camera, and all of a short one", () => {
  expect(insetStretches(10, 40)).toEqual([{ from: 10, to: 40 }]);
  const spread = insetStretches(0, 600);
  expect(spread).toHaveLength(6);
  expect(spread[0]).toEqual({ from: 45, to: 55 });
  expect(spread.at(-1)).toEqual({ from: 545, to: 555 });
});
