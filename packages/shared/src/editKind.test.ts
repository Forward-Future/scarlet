import { describe, expect, it } from "vitest";
import { Change, makeMediaClip, makeTrack, timelineFromKeepRanges, type Timeline } from "@scarlet/timeline";
import { editKinds } from "./editKind.js";

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

  it("names level changes and room tone on an audio track audio, and a cut that smooths its join still a cut", () => {
    const tone = change([{ op: "addTrack", track: makeTrack("audio", "Room tone", "tone") },
      { op: "addClip", trackId: "tone", clip: makeMediaClip("m", 40, 50, 10) },
      { op: "updateClip", clipId: shot.id, patch: { volume: 0 } }]);
    expect(editKinds(tone, [one], { before: base })).toEqual(["audio"]);
    expect(editKinds(change([{ op: "rippleDelete", start: 10, end: 12 }, { op: "updateClip", clipId: shot.id, patch: { audioFadeIn: 0.1 } }]), [one]))
      .toEqual(["cut"]);
  });

  it("names a scale-up a zoom and a move or inset a reframe", () => {
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { keyframes: [
      { time: 0, transform: { scale: 1 } }, { time: 1, transform: { scale: 1.3 } }] } }]), [one], { before: base })).toEqual(["zoom"]);
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { transform: { scale: 0.3, x: 0.35, y: 0.35 } } }]), [one],
      { before: base })).toEqual(["reframe"]);
  });

  it("names a title text, and b-roll, a graphic or a color card laid over the picture an overlay", () => {
    expect(editKinds(change([{ op: "addClip", trackId: "cap", clip: { kind: "caption", id: "t", timelineIn: 10, timelineOut: 14, text: "Hi" } }]),
      [one])).toEqual(["text"]);
    const broll = makeMediaClip("graphic", 0, 4, 10, { id: "g", volume: 0 });
    const withUpper = after(t => { t.tracks.push({ ...upper, clips: [broll] }); });
    expect(editKinds(change([{ op: "addClip", trackId: "v2", clip: broll }, { op: "updateClip", clipId: "g", patch: { volume: 0 } }]), [one],
      { before: base, after: withUpper })).toEqual(["overlay"]);
  });

  it("names a speed change speed, not a cut, even though the cut gets shorter", () => {
    const faster = after(t => { (t.tracks[0]!.clips[0] as { speed: number }).speed = 2; });
    expect(editKinds(change([{ op: "updateClip", clipId: shot.id, patch: { speed: 2 } }]), [one], { before: base, after: faster })).toEqual(["speed"]);
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
