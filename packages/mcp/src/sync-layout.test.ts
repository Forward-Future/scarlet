import { expect, it } from "vitest";
import { applyOps, createProject, emptyTimeline, makeMediaClip, makeTrack, Transform } from "@scarlet/timeline";
import { InsetFraming, syncPictureOps } from "./sync-layout.js";

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
