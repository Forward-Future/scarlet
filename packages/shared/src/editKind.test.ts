import { describe, expect, it } from "vitest";
import { applyOps, Change, emptyTimeline, makeMediaClip, makeTrack, splitJoinOps, timelineFromKeepRanges, type Timeline } from "@scarlet/timeline";
import { classifyEdits, editKinds } from "./editKind.js";

const base = timelineFromKeepRanges("project", "interview", [{ start: 0, end: 120 }]);
const picture = base.tracks.find(t => t.kind === "video")!;
const shot = picture.clips[0]!;
const upper = makeTrack("video", "V2", "v2");
const after = (edit: (t: Timeline) => void): Timeline => { const t = structuredClone(base); edit(t); return t; };
const change = (ops: Record<string, unknown>[]) => Change.parse({ id: "c", projectId: "project", fromVersion: "v0", toVersion: "v1",
  state: "approved", description: "An edit", author: { type: "agent", name: "Scarlet" }, createdAt: "2026-01-01T00:00:00Z", ops });
const one = { start: 10, end: 20 };

describe("telling what an applied edit did", () => {
  it("names a ripple delete a cut and a ripple insert a restore", () => {
    expect(editKinds(change([{ op: "rippleDelete", start: 10, end: 12 }]), [one])).toEqual(["cut"]);
    expect(editKinds(change([{ op: "rippleInsertGap", at: 10, duration: 1.2 },
      { op: "updateClip", clipId: shot.id, patch: { sourceIn: 3, timelineIn: 10 } }]), [one])).toEqual(["restore"]);
  });

  it("names footage from another file put into the main picture an insert, and the recording's own footage put back", () => {
    const joined = timelineFromKeepRanges("project", "interview", [{ start: 0, end: 10 }, { start: 30, end: 120 }]);
    const main = joined.tracks.find(t => t.kind === "video")!.id;
    const fill = (mediaId: string, sourceIn: number) => [{ op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: main, clip: makeMediaClip(mediaId, sourceIn, sourceIn + 5, 10, { id: `fill-${mediaId}` }) }];
    const clocks = (ops: Record<string, unknown>[]) => ({ before: joined, after: applyOps(joined, ops as never) });
    const spot = [{ start: 10, end: 15 }];
    const clip = fill("screen", 2401);
    expect(editKinds(change(clip), spot, clocks(clip))).toEqual(["insert"]);
    const back = fill("interview", 10);
    expect(editKinds(change(back), spot, clocks(back))).toEqual(["restore"]);
    // Without the finished picture, a file the main picture never played is still new to it.
    expect(editKinds(change(clip), spot, { before: joined })).toEqual(["insert"]);
    expect(editKinds(change(back), spot, { before: joined })).toEqual(["restore"]);
  });

  it("names level changes and room tone on an audio track audio, and a cut that smooths its join still a cut", () => {
    const tone = change([{ op: "addTrack", track: makeTrack("audio", "Room tone", "tone") },
      { op: "addClip", trackId: "tone", clip: makeMediaClip("m", 40, 50, 10) },
      { op: "updateClip", clipId: shot.id, patch: { volume: 0 } }]);
    expect(editKinds(tone, [one], { before: base })).toEqual(["audio"]);
    expect(editKinds(change([{ op: "rippleDelete", start: 10, end: 12 }, { op: "updateClip", clipId: shot.id, patch: { audioFadeIn: 0.1 } }]), [one]))
      .toEqual(["cut"]);
  });

  it("names a level that moves over a clip a dip, and voice cleanup a voice cleanup, on the camera's own sound too", () => {
    const dip = [{ time: 0, db: 0, ease: "easeInOut" }, { time: 0.3, db: -18, ease: "linear" }];
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { volumeKeyframes: dip } }]), [one], { before: base })).toEqual(["dip"]);
    // Keys that only even a clip's level out, a little down here and a little up there, are a level change.
    const evened = [{ time: 0, db: -1.5, ease: "linear" }, { time: 12, db: -1.5, ease: "linear" }, { time: 16, db: 0, ease: "linear" }, { time: 82, db: 0.9, ease: "linear" }];
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { volumeKeyframes: evened } }]), [one], { before: base })).toEqual(["audio"]);
    // A music bed added already dipped, or added and then dipped, is a dip.
    const bed = makeMediaClip("music", 0, 60, 0, { id: "bed" });
    expect(editKinds(change([{ op: "addTrack", track: makeTrack("audio", "Music", "music") }, { op: "addClip", trackId: "music", clip: bed },
      { op: "updateClip", clipId: "bed", patch: { volumeKeyframes: dip } }]), [one], { before: base })).toEqual(["dip"]);
    const cleanup = [{ type: "voiceCleanup", params: {}, enabled: true }];
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { effects: cleanup } }]), [one], { before: base })).toEqual(["voice"]);
    // Another effect only the sound has is a sound edit wherever the clip is; one on the picture is still an overlay.
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { effects: [{ type: "eq", params: { highpass: 80 }, enabled: true }] } }]), [one],
      { before: base })).toEqual(["audio"]);
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { effects: [{ type: "blur", params: {}, enabled: true }] } }]), [one],
      { before: base })).toEqual(["overlay"]);
  });

  it("names a scale-up a zoom and a move or inset a reframe", () => {
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { keyframes: [
      { time: 0, transform: { scale: 1 } }, { time: 1, transform: { scale: 1.3 } }] } }]), [one], { before: base })).toEqual(["zoom"]);
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { transform: { scale: 0.3, x: 0.35, y: 0.35 } } }]), [one],
      { before: base })).toEqual(["reframe"]);
    // A zoom on one clip does not turn a separate crop/reframe in the same change into a zoom.
    const two = after(t => {
      t.tracks.find(x => x.kind === "video")!.clips = [
        { ...shot, id: "a", timelineIn: 0, timelineOut: 30, sourceIn: 0, sourceOut: 30 },
        { ...shot, id: "b", timelineIn: 30, timelineOut: 60, sourceIn: 30, sourceOut: 60 },
      ];
    });
    const mixed = change([
      { op: "updateClip", clipId: "a", patch: { transform: { scale: 1.15 } } },
      { op: "updateClip", clipId: "b", patch: { transform: { scale: 1, cropLeft: 0.2, cropRight: 0.2 } } },
    ]);
    expect(editKinds(mixed, [{ start: 0, end: 30 }, { start: 30, end: 60 }], { before: two, after: two })).toEqual(["zoom", "reframe"]);
    // A single edit with both a crop and a scale-up keyframe stays a zoom.
    const both = change([
      { op: "updateClip", clipId: "a", patch: { transform: { scale: 1, cropLeft: 0.1 }, keyframes: [{ time: 0, transform: { scale: 1 } }, { time: 2, transform: { scale: 1.2 } }] } },
    ]);
    expect(editKinds(both, [{ start: 0, end: 30 }], { before: two, after: two })).toEqual(["zoom"]);
  });

  it("names a title text, and b-roll, a graphic or a color card laid over the picture an overlay", () => {
    expect(editKinds(change([{ op: "addClip", trackId: "cap", clip: { kind: "caption", id: "t", timelineIn: 10, timelineOut: 14, text: "Hi" } }]),
      [one])).toEqual(["text"]);
    const broll = makeMediaClip("graphic", 0, 4, 10, { id: "g", volume: 0 });
    const withUpper = after(t => { t.tracks.push({ ...upper, clips: [broll] }); });
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: broll }, { op: "updateClip", clipId: "g", patch: { volume: 0 } }]), [one],
      { before: base, after: withUpper })).toEqual(["overlay"]);
  });

  it("names a graphic Scarlet made, laid over the picture, a graphic, footage B-roll, and the two laid together overlays", () => {
    const media = [{ id: "lower", kind: "graphic" as const }, { id: "broll", kind: "video" as const }];
    const lower = makeMediaClip("lower", 0, 4, 10, { id: "l" });
    const broll = makeMediaClip("broll", 0, 4, 30, { id: "b", volume: 0 });
    const withLower = after(t => { t.tracks.push({ ...upper, clips: [lower] }); });
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: lower }]), [one], { before: base, after: withLower, media })).toEqual(["graphic"]);
    // Faded in or out afterwards, it is still the graphic.
    expect(editKinds(change([{ op: "updateClip", clipId: "l", patch: { videoFadeIn: 0.3 } }]), [one], { before: withLower, after: withLower, media }))
      .toEqual(["graphic"]);
    // Without the project's files nothing says it is a graphic.
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: lower }]), [one], { before: base, after: withLower })).toEqual(["overlay"]);
    const both = after(t => { t.tracks.push({ ...upper, clips: [lower, broll] }); });
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: broll }]), [one], { before: base, after: both, media })).toEqual(["broll"]);
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: lower }, { op: "addClip", trackId: "v2", clip: broll }]), [one],
      { before: base, after: both, media })).toEqual(["overlay"]);
  });

  it("names a picture taken from the web B-roll, and a picture from a file, such as a logo, an overlay", () => {
    const media = [{ id: "article", kind: "image" as const, source: { url: "https://example.com/story" } }, { id: "logo", kind: "image" as const }];
    const article = makeMediaClip("article", 0, 4, 10, { id: "a" });
    const logo = makeMediaClip("logo", 0, 4, 30, { id: "o" });
    const laid = after(t => { t.tracks.push({ ...upper, clips: [article, logo] }); });
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: article }]), [one], { before: base, after: laid, media })).toEqual(["broll"]);
    // Faded in afterwards, it is still B-roll.
    expect(editKinds(change([{ op: "updateClip", clipId: "a", patch: { videoFadeIn: 0.3 } }]), [one], { before: laid, after: laid, media })).toEqual(["broll"]);
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: logo }]), [one], { before: base, after: laid, media })).toEqual(["overlay"]);
    // A fade on the main picture is no B-roll.
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { videoFadeIn: 0.3 } }]), [one], { before: base, after: base, media }))
      .toEqual(["overlay"]);
  });

  it("names a speed change speed, not a cut, even though the cut gets shorter", () => {
    const faster = after(t => { (t.tracks[0]!.clips[0] as { speed: number }).speed = 2; });
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { speed: 2 } }]), [one], { before: base, after: faster })).toEqual(["speed"]);
  });

  it("names a transition put on a join a transition, at its join", () => {
    const pushed = after(t => { (t.tracks[0]!.clips[0] as { transitionIn?: unknown }).transitionIn = { type: "push", duration: 0.4, direction: "left" }; });
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { transitionIn: { type: "push", duration: 0.4, direction: "left" } } }]), [one], { before: base, after: pushed })).toEqual(["transition"]);
  });

  it("names a J or L cut a split edit, at its join, though it hands sound to a dialogue track and silences pictures", () => {
    const talk = emptyTimeline("project");
    talk.tracks[0]!.clips = [makeMediaClip("host", 0, 10, 0, { id: "ask" }), makeMediaClip("guest", 5, 15, 10, { id: "answer" }),
      makeMediaClip("host", 30, 40, 20, { id: "react" })];
    const files = [{ id: "host", kind: "video" as const, hasAudio: true, duration: 60 }, { id: "guest", kind: "video" as const, hasAudio: true, duration: 60 }];
    const { ops } = splitJoinOps(talk, files, 25, [{ at: 10, shift: -0.24 }, { at: 20, shift: 0.5 }]);
    const made = applyOps(talk, ops);
    expect(editKinds(change(ops), [{ start: 9.76, end: 10 }, { start: 20, end: 20.5 }], { before: talk, after: made })).toEqual(["split", "split"]);
    // Set back on its picture cut, it is still a split edit: the step says what moved.
    const straight = splitJoinOps(made, files, 25, [{ at: 10, shift: 0 }]).ops;
    expect(editKinds(change(straight), [{ start: 10, end: 10 }], { before: made, after: applyOps(made, straight) })).toEqual(["split"]);
  });

  it("calls footage placed on the main picture track an assembly, and a removed clip that shortens the cut a cut", () => {
    expect(editKinds(change([{ op: "addClip", trackId: picture.id, clip: makeMediaClip("cam", 0, 60, 0) },
      { op: "addClip", trackId: "v2", clip: makeMediaClip("screen", 0, 60, 0) }]), [one],
      { before: base, after: after(t => { t.tracks.push(upper); }) })).toEqual(["other"]);
    const shorter = after(t => { for (const track of t.tracks) track.clips = []; });
    expect(editKinds(change([{ op: "removeClip", clipId: shot.id }]), [one], { before: base, after: shorter })).toEqual(["cut"]);
  });

  it("gives each spot of a mixed visual pass the kind of the ops that land on it", () => {
    const pass = change([
      { op: "addClip", trackId: "cap", clip: { kind: "caption", id: "t", timelineIn: 10, timelineOut: 14, text: "Title" } },
      { op: "addClip", trackId: "v2", clip: makeMediaClip("broll", 0, 5, 60, { id: "b" }) },
    ]);
    expect(editKinds(pass, [{ start: 10, end: 14 }, { start: 60, end: 65 }, { start: 100, end: 101 }],
      { before: base, after: after(t => { t.tracks.push(upper); }) })).toEqual(["text", "overlay", "other"]);
  });

  it("gives a stretch that only touches an edit's edge to the edit beside it", () => {
    // A punch-in named end to end with a demo laid over the picture: each is what it did, not a mix of the two.
    const split = after(t => { t.tracks.push(upper);
      t.tracks.find(x => x.kind === "video")!.clips = [{ ...shot, id: "a", timelineOut: 30, sourceOut: 30 },
        { ...shot, id: "b", timelineIn: 30, timelineOut: 50, sourceIn: 30, sourceOut: 50 }, { ...shot, id: "c", timelineIn: 50, sourceIn: 50 }]; });
    const pass = change([
      { op: "updateClip", clipId: "a", patch: { transform: { scale: 1.2 } } },
      { op: "addClip", trackId: "v2", clip: makeMediaClip("screen", 0, 20, 30, { id: "demo" }) },
      { op: "updateClip", clipId: "c", patch: { transform: { scale: 1.2 } } },
    ]);
    expect(editKinds(pass, [{ start: 20, end: 30 }, { start: 30, end: 50 }, { start: 50, end: 60 }], { before: split, after: split }))
      .toEqual(["zoom", "overlay", "zoom"]);
  });

  it("doesn't give a spot that changed nothing the kind of a stretch another edit owns, just before it", () => {
    // ant crash, 2026-11-21: a spot asking whether to show the bowling clip began a third of a second after the Blender
    // demo laid over the picture ended, and its card said B-roll.
    const media = [{ id: "screen", kind: "video" as const }];
    const demo = makeMediaClip("screen", 0, 22.27, 15.6, { id: "demo" });
    const laid = after(t => { t.tracks.push({ ...upper, clips: [demo] }); });
    const pass = change([{ op: "addClip", trackId: "v2", clip: demo }]);
    expect(editKinds(pass, [{ start: 15.6, end: 37.87 }, { start: 38.22, end: 39.22 }], { before: base, after: laid, media }))
      .toEqual(["broll", "other"]);
  });

  it("says which named edits changed nothing at all", () => {
    const media = [{ id: "screen", kind: "video" as const }];
    const demo = makeMediaClip("screen", 0, 22.27, 15.6, { id: "demo" });
    const laid = after(t => { t.tracks.push({ ...upper, clips: [demo] }); });
    const pass = change([{ op: "addClip", trackId: "v2", clip: demo }]);
    expect(classifyEdits(pass, [{ start: 15.6, end: 37.87 }, { start: 50, end: 51 }], { before: base, after: laid, media }).nothing)
      .toEqual([false, true]);
  });

  it("doesn't call an edit a cut because another edit of the same change cut", () => {
    // Two pop-ups cut out and one covered by holding a frame, which only trims clips: the cover took nothing out.
    const pass = change([
      { op: "splitClip", clipId: shot.id, at: 30 },
      { op: "updateClip", clipId: shot.id, patch: { sourceIn: 0, sourceOut: 30 } },
      { op: "rippleDelete", start: 90, end: 92 },
      { op: "rippleDelete", start: 60, end: 61.5 },
    ]);
    expect(editKinds(pass, [{ start: 29.5, end: 31 }, { start: 59.5, end: 60.5 }, { start: 88, end: 89 }], { before: base, after: base }))
      .toEqual(["other", "cut", "cut"]);
  });

  it("places a removal where it sits once the removals stored after it have run", () => {
    // The removal at 90 was made first; the one at 60 then moved its join to 88.5. An edit named at 90 holds no cut.
    const pass = change([{ op: "rippleDelete", start: 90, end: 92 }, { op: "rippleDelete", start: 60, end: 61.5 },
      { op: "updateClip", clipId: shot.id, patch: { volume: 0.5 } }]);
    expect(editKinds(pass, [{ start: 88.3, end: 88.7 }, { start: 90, end: 90.4 }])).toEqual(["cut", "audio"]);
    // Footage put back before a removal moves its join later.
    const put = change([{ op: "rippleDelete", start: 90, end: 92 }, { op: "rippleInsertGap", at: 10, duration: 5 }]);
    expect(editKinds(put, [{ start: 9, end: 16 }, { start: 94.8, end: 95.2 }, { start: 89.8, end: 90.2 }])).toEqual(["restore", "cut", "other"]);
  });

  it("gives an edit no op lands on the kind of the ops that couldn't be placed", () => {
    // With no versions to read, a level change can't be placed: it may belong to either edit, and a cut elsewhere doesn't claim it.
    const pass = change([{ op: "rippleDelete", start: 60, end: 61.5 }, { op: "updateClip", clipId: shot.id, patch: { volume: 0.5 } }]);
    expect(editKinds(pass, [{ start: 59.5, end: 60.5 }, { start: 100, end: 101 }])).toEqual(["cut", "audio"]);
    // Only trims and moves anywhere: the length of the cut says what the change did, as for a change with one edit.
    const shorter = after(t => { t.tracks.find(k => k.kind === "video")!.clips[0]!.sourceOut = 100; });
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { sourceOut: 100 } }]), [{ start: 0, end: 1 }, { start: 99, end: 100 }],
      { before: base, after: shorter })).toEqual(["cut", "cut"]);
  });

  it("doesn't give the length a whole-video save changed to an edit it named where nothing changed", () => {
    // Matt's pass lengthened a pickup at 9:05 and named "Pricing and model names" at 18:00, which it left as it was.
    const longer = after(t => { t.tracks.find(k => k.kind === "video")!.clips[0]!.sourceOut = 121; });
    const saved = { ...change([]), ranges: [{ start: 544.9, end: 546 }] };
    expect(editKinds(saved, [{ start: 536, end: 547 }, { start: 1083, end: 1146 }], { before: base, after: longer, media: [] }, []))
      .toEqual(["restore", "other"]);
    // With no record of where it changed, both still go by the length.
    expect(editKinds({ ...saved, ranges: [] }, [{ start: 536, end: 547 }, { start: 1083, end: 1146 }], { before: base, after: longer, media: [] }, []))
      .toEqual(["restore", "restore"]);
  });

  it("matches the first clip in track order when a batch edits an older timeline with duplicate ids", () => {
    const historical = after(t => {
      t.tracks[0]!.clips = [makeMediaClip("interview", 0, 2, 1, { id: "duplicate" })];
      t.tracks[1]!.clips = [
        makeMediaClip("music", 0, 2, 10, { id: "duplicate" }),
        makeMediaClip("music", 0, 2, 20, { id: "music-level" }),
      ];
    });
    const batch = change([
      { op: "updateClip", clipId: "duplicate", patch: { keyframes: [{ time: 0, transform: { scale: 1.5 } }] } },
      { op: "updateClip", clipId: "music-level", patch: { volume: 0.7 } },
    ]);
    expect(editKinds(batch, [1, 10, 20].map(start => ({ start, end: start + 1 })), { after: historical }))
      .toEqual(["zoom", "other", "audio"]);
  });
});

describe("telling an edit that only left a marker for the editor", () => {
  const todo = (time: number, text = "Add the other boat renders") => ({ op: "addMarker", marker: { id: `mk${time}`, time, kind: "todo", text } });
  const caption = { kind: "caption", id: "t", timelineIn: 10, timelineOut: 14, text: "Hi" };
  const captioned = after(t => { t.tracks.push(makeTrack("caption", "Captions", "cap")); });

  it("calls an edit a marker only when markers are all that land on it", () => {
    const only = classifyEdits(change([todo(12)]), [one]);
    expect(only).toEqual({ kinds: ["other"], markers: [true], asks: ["Add the other boat renders"], restated: [true], nothing: [false] });
    // Text and a zoom with a marker beside them changed the video: it is a mix of edits, not a to-do.
    const mixed = change([todo(12), { op: "addClip", trackId: "cap", clip: caption },
      { op: "updateClip", clipId: shot.id, patch: { transform: { scale: 1.3 } } }]);
    expect(classifyEdits(mixed, [one], { before: captioned, after: captioned })).toMatchObject({ kinds: ["other"], markers: [false] });
    // Footage placed on the main picture builds the cut, whatever marker sits there.
    const placed = change([todo(12), { op: "addClip", trackId: picture.id, clip: makeMediaClip("cam", 0, 10, 10) }]);
    expect(classifyEdits(placed, [one], { before: base, after: base }).markers).toEqual([false]);
  });

  it("keeps a marker's spot a marker when a step that can't be placed did something else", () => {
    const muted = change([todo(12), todo(60), { op: "updateTrack", trackId: "a1", patch: { muted: true } }]);
    expect(classifyEdits(muted, [one, { start: 59.5, end: 60.5 }, { start: 100, end: 101 }]))
      .toMatchObject({ kinds: ["other", "other", "audio"], markers: [true, true, false] });
  });

  it("knows a marker moved or rewritten, or replaced by a new one, and that one marked resolved asks nothing", () => {
    const marked = after(t => { t.markers = [{ id: "mk", time: 12, kind: "todo", text: "Add the boat renders", resolved: false }]; });
    const moved = after(t => { t.markers = [{ id: "mk", time: 14, kind: "todo", text: "Add the boat renders", resolved: false }]; });
    expect(classifyEdits(change([{ op: "updateMarker", markerId: "mk", patch: { time: 14 } }]), [one], { before: marked, after: moved }))
      .toEqual({ kinds: ["other"], markers: [true], asks: ["Add the boat renders"], restated: [false], nothing: [false] });
    expect(classifyEdits(change([{ op: "updateMarker", markerId: "mk", patch: { text: "Add both renders" } }]), [one], { before: marked, after: marked }))
      .toMatchObject({ asks: ["Add both renders"], restated: [true], nothing: [false] });
    expect(classifyEdits(change([{ op: "removeMarker", markerId: "mk" }, todo(13, "Add both renders")]), [one]))
      .toEqual({ kinds: ["other"], markers: [true], asks: ["Add both renders"], restated: [true], nothing: [false] });
    expect(classifyEdits(change([{ op: "updateMarker", markerId: "mk", patch: { resolved: true } }]), [one]).markers).toEqual([false]);
    expect(classifyEdits(change([{ op: "removeMarker", markerId: "mk" }]), [one]).markers).toEqual([false]);
  });

  it("reads a marker beside a dialogue pass's known joins, without the joins' steps", () => {
    const pass = change([{ op: "rippleDelete", start: 30, end: 31 }, todo(80)]);
    expect(classifyEdits(pass, [{ start: 30, end: 30 }, { start: 80, end: 80 }], {}, [{ range: { start: 30, end: 30 } }]))
      .toMatchObject({ kinds: ["cut", "other"], markers: [false, true] });
  });
});
