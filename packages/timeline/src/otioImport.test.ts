import { describe, expect, it } from "vitest";
import { applyOps, createProject, emptyTimeline, frameAligned, fromOtio, makeMediaClip, otioSourceVersion, OtioImportError, timelineDuration, toOtio, type MediaClip, type Timeline } from "./index.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function setup() {
  const project = createProject("Round trip");
  project.media.push({ id: "m1", kind: "video", name: "interview.mp4", path: "m1.mp4", duration: 60, fps: 30, hasAudio: true });
  project.media.push({ id: "m2", kind: "audio", name: "music.wav", path: "m2.wav", duration: 60, hasAudio: true });
  let tl: Timeline = {
    version: "v_export",
    parent: null,
    projectId: project.id,
    name: "Main",
    background: "#000000",
    markers: [{ id: "mk", time: 9, kind: "chapter", text: "Part two", resolved: false }],
    tracks: [
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [] },
      { id: "a1", kind: "audio", name: "A1", muted: false, hidden: false, clips: [] },
      { id: "cap", kind: "caption", name: "Captions", muted: false, hidden: false, clips: [] },
    ],
  };
  tl = applyOps(tl, [
    { op: "addClip", trackId: "v1", clip: { id: "open", kind: "media", mediaId: "m1", sourceIn: 2, sourceOut: 8, timelineIn: 0, label: "Cold open", videoFadeIn: 0.5, transform: { x: 0, y: 0, scale: 1.2, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } } as never },
    { op: "addClip", trackId: "v1", clip: { id: "point", kind: "media", mediaId: "m1", sourceIn: 10, sourceOut: 16, timelineIn: 6, label: "Point one" } as never },
    { op: "addClip", trackId: "a1", clip: { id: "bed", kind: "media", mediaId: "m2", sourceIn: 0, sourceOut: 12, timelineIn: 0, volume: 0.2, label: "Music" } as never },
    { op: "addClip", trackId: "cap", clip: { id: "c1", kind: "caption", timelineIn: 1, timelineOut: 3, text: "Welcome back" } },
    { op: "addClip", trackId: "cap", clip: { id: "c2", kind: "caption", timelineIn: 7, timelineOut: 9, text: "Point one" } },
  ]);
  return { project, tl };
}

/** What Resolve keeps: the edit, file paths and clip names — not Scarlet's metadata. */
function stripScarlet(o: Json): Json {
  return JSON.parse(JSON.stringify(o), (k, v) => (k === "metadata" ? {} : v));
}

describe("fromOtio", () => {
  it("refuses durations outside the playback budget during import", () => {
    const { project, tl } = setup();
    const doc = toOtio(project, tl) as Json;
    const clip = doc.tracks.children[0].children[0];
    clip.source_range.duration = { value: 86_401, rate: 1 };
    expect(() => fromOtio(doc, project, tl)).toThrow("24 hours");
  });
  it("round-trips an unedited timeline, keeping clip looks, captions and markers", () => {
    const { project, tl } = setup();
    const otio = toOtio(project, tl, { mediaRoot: "C:/scarlet/media" }) as Json;
    expect(otioSourceVersion(otio)).toBe("v_export");
    const back = fromOtio(stripScarlet(otio), project, tl);
    const v = back.tracks.find((t) => t.id === "v1")!.clips as MediaClip[];
    expect(v.map((c) => c.id)).toEqual(["open", "point"]);
    expect(v[0]!.transform?.scale).toBe(1.2);
    expect(v[0]!.videoFadeIn).toBe(0.5);
    expect(back.tracks.find((t) => t.id === "a1")!.clips[0]!.kind).toBe("media");
    expect((back.tracks.find((t) => t.id === "a1")!.clips[0] as MediaClip).volume).toBe(0.2);
    expect(back.tracks.find((t) => t.id === "cap")!.clips).toHaveLength(2);
    expect(back.markers.map((m) => m.text)).toEqual(["Part two"]);
    expect(timelineDuration(back)).toBeCloseTo(12, 5);
  });

  it("keeps a one-frame caption at the project's frame rate and drops a shorter one", () => {
    for (const [fps, kept] of [[60, true], [30, false]] as const) {
      const { project, tl: exported } = setup();
      project.settings.fps = fps;
      const tl = applyOps(exported, [{ op: "addClip", trackId: "cap", clip: { id: "flash", kind: "caption", timelineIn: 4, timelineOut: 4 + 1 / 60, text: "Hi" } }]);
      const back = fromOtio(stripScarlet(toOtio(project, tl, { mediaRoot: "C:/scarlet/media" }) as Json), project, tl);
      expect(back.tracks.find((t) => t.id === "cap")!.clips.some((c) => c.id === "flash")).toBe(kept);
    }
  });

  it.each([false, true])("keeps text-only captions on the surviving part of their shot (repeated take: %s)", repeated => {
    const { project, tl } = setup();
    const picture = tl.tracks[0]!, captions = tl.tracks[2]!;
    tl.tracks = [picture, captions];
    picture.clips = [makeMediaClip("m1", 0, 5, 0, { id: "take" })];
    const caption = (text: string, timelineIn: number, timelineOut: number) => ({
      kind: "caption" as const, id: text, text, timelineIn, timelineOut, enabled: true,
    });
    captions.clips = [caption("Removed", 0.25, 0.75), caption("Start trimmed", 0.75, 1.75), caption("End trimmed", 3.5, 4.5)];
    if (repeated) {
      picture.clips.push(makeMediaClip("m1", 0, 5, 5, { id: "repeat" }));
      captions.clips.push(caption("Second take", 5.25, 5.75));
    }

    // In Resolve, trim one second from each end of the first shot.
    const doc = stripScarlet(toOtio(project, tl) as Json);
    const range = doc.tracks.children[0].children[0].source_range;
    range.start_time.value += range.start_time.rate;
    range.duration.value -= 2 * range.duration.rate;
    const restored = fromOtio(doc, project, tl).tracks.find(t => t.id === captions.id)!.clips;
    expect(restored).toMatchObject([
      caption("Start trimmed", 0, 0.75), caption("End trimmed", 2.5, 3),
      ...(repeated ? [caption("Second take", 3.25, 3.75)] : []),
    ]);
  });

  it("retimes caption words through speed changes and drops words cut from the middle in Resolve", () => {
    const { project, tl } = setup();
    const picture = tl.tracks[0]!;
    const captions = tl.tracks[2]!;
    tl.tracks = [picture, captions];
    picture.clips = [makeMediaClip("m1", 0, 5, 0, { id: "take" })];
    captions.clips = [{ id: "line", kind: "caption", enabled: true, timelineIn: 0, timelineOut: 5, text: "One two three.",
      words: [{ text: "One", start: 0, end: 1 }, { text: "two", start: 2, end: 3 }, { text: "three.", start: 4, end: 5 }] }];
    const changed = applyOps(tl, [{ op: "rippleDelete", start: 2, end: 3 }, { op: "updateClip", clipId: "take", patch: { speed: 2 } }]);
    // Close the gap made by playing the first two seconds at double speed.
    changed.tracks[0]!.clips[1]!.timelineIn = 1;
    const doc = stripScarlet(toOtio(project, changed) as Json);
    const restored = fromOtio(doc, project, tl).tracks.find(track => track.id === captions.id)!.clips;
    expect(restored).toMatchObject([{ timelineIn: 0, timelineOut: 3, text: "One three.",
      words: [{ text: "One", start: 0, end: 0.5 }, { text: "three.", start: 2, end: 3 }] }]);

    // Trim inside the first and last words. An unrelated repetition of the source later still has its own caption.
    picture.clips.push(makeMediaClip("m1", 0, 5, 8, { id: "repeat" }));
    const caption = captions.clips[0]!;
    if (caption.kind !== "caption") throw new Error("Missing caption");
    captions.clips.push({ ...caption, id: "again", timelineIn: 8, timelineOut: 13,
      words: caption.words!.map(w => ({ ...w, start: w.start + 8, end: w.end + 8 })) });
    const trimmed = applyOps(tl, [{ op: "rippleDelete", start: 4.5, end: 5 }, { op: "rippleDelete", start: 0, end: 0.5 }]);
    const kept = fromOtio(toOtio(project, trimmed), project, tl).tracks.find(track => track.id === captions.id)!.clips;
    expect(kept).toMatchObject([{ timelineIn: 0, timelineOut: 4, words: [
      { text: "One", start: 0, end: 0.5 }, { text: "two", start: 1.5, end: 2.5 }, { text: "three.", start: 3.5, end: 4 }] },
      { timelineIn: 7, timelineOut: 12 }]);
  });

  it.each(["video", "audio"] as const)("keeps caption pieces on their own %s shots through a reorder or an inserted gap", kind => {
    const { project, tl } = setup();
    const track = tl.tracks.find(t => t.kind === kind)!, music = tl.tracks[1]!, captions = tl.tracks[2]!;
    // With picture present, its cuts lead over the unchanged music bed. Also exercise an audio-only edit.
    tl.tracks = kind === "video" ? [track, music, captions] : [track, captions];
    track.clips = [makeMediaClip("m1", 0, 2, 0, { id: "a" }), makeMediaClip("m1", 10, 12, 2, { id: "b" })];
    const words = [{ text: "Left", start: 1.5, end: 2 }, { text: "right.", start: 2, end: 2.5 }];
    const line = { kind: "caption" as const, id: "line", timelineIn: 1.5, timelineOut: 2.5, enabled: true, text: "Left\nright.", words };
    captions.clips = [line, { ...line, id: "title", text: "A title", words: undefined }];
    const original = structuredClone(tl);
    const importClips = () => fromOtio(stripScarlet(toOtio(project, tl) as Json), project, original)
      .tracks.find(t => t.kind === "caption")!.clips;
    expect(importClips()).toMatchObject([line, { id: "title", text: "A title" }]);

    for (const mode of ["reorder", "gap"] as const) {
      const [a, b] = original.tracks[0]!.clips;
      track.clips = mode === "reorder" ? [{ ...b!, timelineIn: 0 }, { ...a!, timelineIn: 2 }] : [a!, { ...b!, timelineIn: 3 }];
      const clips = importClips();
      const expected = mode === "reorder"
        ? [{ text: "right.", start: 0, end: 0.5 }, { text: "Left", start: 3.5, end: 4 }]
        : [{ text: "Left", start: 1.5, end: 2 }, { text: "right.", start: 3, end: 3.5 }];
      expect(clips).toMatchObject([
        ...expected.map(w => ({ text: w.text, timelineIn: w.start, timelineOut: w.end, words: [w] })),
        ...expected.map(w => ({ text: "A title", timelineIn: w.start, timelineOut: w.end })),
      ]);
      expect(new Set(clips.map(c => c.id)).size).toBe(4);
    }
  });

  it("exports overlapping clips on parallel tracks at their original times and in stacking order", () => {
    const { project, tl } = setup();
    const clip = (id: string, color: string, start: number, end: number) => ({
      kind: "color" as const, id, color, timelineIn: start, timelineOut: end, opacity: 1, enabled: true,
    });
    const track = tl.tracks[0]!;
    tl.tracks = [{ ...track, clips: [clip("bed", "red", 0, 4), clip("overlay", "blue", 1, 3), clip("top", "green", 2, 4)] }];
    const otio = toOtio(project, tl) as Json;
    expect(otio.tracks.children).toHaveLength(3);
    for (const doc of [otio, stripScarlet(otio)]) {
      const back = fromOtio(doc, project, tl);
      expect(timelineDuration(back)).toBe(4);
      expect(back.tracks.flatMap((t) => t.clips)).toMatchObject([
        { color: "red", timelineIn: 0, timelineOut: 4 },
        { color: "blue", timelineIn: 1, timelineOut: 3 },
        { color: "green", timelineIn: 2, timelineOut: 4 },
      ]);
    }
  });

  it("retains a solid overlay's appearance and identity when the round trip splits it", () => {
    const { project, tl } = setup();
    const overlay = { id: "band", kind: "color" as const, timelineIn: 1, timelineOut: 3, color: "#FFFFFF",
      enabled: true, opacity: 0.4, label: "Title backing",
      transform: { x: 0, y: 0.5, scale: 0.4, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } };
    tl.tracks[0]!.clips.push(overlay);
    const otio = toOtio(project, tl) as Json;
    for (const doc of [structuredClone(otio), stripScarlet(otio)]) {
      const lane = doc.tracks.children[1];
      const item = lane.children.at(-1);
      item.source_range.duration.value = 30;
      lane.children.push(structuredClone(item));
      const solids = fromOtio(doc, project, tl).tracks.flatMap(t => t.clips).filter(c => c.kind === "color");
      expect(solids).toMatchObject([
        { ...overlay, timelineOut: 2 },
        { label: overlay.label, transform: overlay.transform, opacity: overlay.opacity, timelineIn: 2, timelineOut: 3 },
      ]);
      expect(solids[0]!.id).not.toBe(solids[1]!.id);
    }
  });

  it("keeps picture and sound together through a cut whose footage isn't at the project's frame rate", () => {
    // A 30 fps project: a 23.976 camera on V1 and its microphone on A1.
    const project = createProject("Mixed rates");
    project.media.push({ id: "cam", kind: "video", name: "cam.mov", path: "cam.mov", duration: 3600, fps: 23.976 },
      { id: "mic", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 3600 });
    const base = emptyTimeline(project.id);
    base.tracks[0]!.clips = [makeMediaClip("cam", 0, 600, 0, { volume: 0 })];
    base.tracks[1]!.clips = [makeMediaClip("mic", 0, 600, 0)];
    // A dialogue pass: forty removals on whole frames of the project, applied back to front.
    const cut = applyOps(base, Array.from({ length: 40 }, (_, n) => {
      const i = 39 - n, start = 5 + i * 11.37 + (i % 7) * 0.211;
      return { op: "rippleDelete" as const, ...frameAligned({ start, end: start + 0.4 + (i % 9) * 0.173 }, 30) };
    }));
    const placed = cut.tracks[0]!.clips.map((c) => c.timelineIn);
    expect(placed).toHaveLength(41);
    const doc = toOtio(project, cut) as Json;
    // A track's clips play end to end, so each starts where the lengths before it add up to.
    const starts = (track: Json) => {
      let at = 0;
      return track.children.map((c: Json) => { const start = at; at += c.source_range.duration.value / c.source_range.duration.rate; return start; });
    };
    // The furthest any time is from the one it should equal, in frames of the project.
    const apart = (a: number[], b: number[]) => Math.max(...a.map((t, i) => Math.abs(t - b[i]!))) * 30;
    const [picture, sound] = doc.tracks.children;
    expect(apart(starts(picture), starts(sound))).toBeLessThan(0.001);
    expect(apart(starts(picture), placed)).toBeLessThan(0.001);
    // How much footage there is stays in the camera's own frames.
    expect(picture.children[0].media_references.DEFAULT_MEDIA.available_range.duration).toMatchObject({ value: 86314, rate: 23.976 });
    // Brought back untouched, it is the cut that was exported: every clip in its place, playing the same footage.
    const times = (tl: Timeline) => tl.tracks.slice(0, 2).flatMap((t) => (t.clips as MediaClip[]).flatMap((c) => [c.timelineIn, c.sourceIn, c.sourceOut]));
    for (const input of [doc, stripScarlet(doc)]) {
      const back = fromOtio(input, project, cut);
      expect(times(back)).toHaveLength(2 * 41 * 3);
      expect(apart(times(back), times(cut))).toBeLessThan(0.001);
    }
  });

  it("rejects filter syntax in an imported solid while retaining legitimate colors", () => {
    const { project, tl } = setup();
    const doc = toOtio(project, tl) as Json;
    const item = doc.tracks.children[0].children[0];
    const ref = { OTIO_SCHEMA: "GeneratorReference.1", generator_kind: "SolidColor", parameters: { color: "red@0.4" } };
    item.media_references.DEFAULT_MEDIA = ref;
    expect(fromOtio(doc, project, tl).tracks[0]?.clips[0]).toMatchObject({ kind: "color", color: "red@0.4" });
    for (const invalid of ["red,negate", "red@1;null", "#12345", "red@1.01", "unknowncolor"]) {
      ref.parameters.color = invalid;
      expect(() => fromOtio(doc, project, tl)).toThrow(/invalid color/);
    }
  });

  it("preserves the look of every imported split fragment with separate clip IDs", () => {
    const { project, tl } = setup();
    const otio = stripScarlet(toOtio(project, tl, { mediaRoot: "C:/media" }) as Json);
    const track = otio.tracks.children[0];
    const clip = track.children[0];
    const next = structuredClone(clip);
    const n = Math.floor(clip.source_range.duration.value / 2);
    clip.source_range.duration.value -= n;
    next.source_range.start_time.value += clip.source_range.duration.value;
    next.source_range.duration.value = n;
    track.children.splice(1, 0, next);
    const parts = fromOtio(otio, project, tl).tracks[0]!.clips.slice(0, 2) as MediaClip[];
    expect(parts.map((c) => c.transform?.scale)).toEqual([1.2, 1.2]);
    expect(parts[0]!.id).not.toBe(parts[1]!.id);
  });

  it("breaks equal source-overlap ties with the first unused clip of the same name", () => {
    const { project, tl } = setup();
    const track = tl.tracks[0]!;
    const first = track.clips[0] as MediaClip;
    track.clips = [first, { ...first, id: "later", timelineIn: 6, opacity: 0.4 }];
    const doc = stripScarlet(toOtio(project, tl) as Json);
    const clips = fromOtio(doc, project, tl).tracks[0]!.clips as MediaClip[];
    expect(clips.map(c => [c.id, c.opacity])).toEqual([[first.id, first.opacity], ["later", 0.4]]);
  });

  it("prefers the first matching file path over display-name aliases and accepts literal percent signs", () => {
    const { project, tl } = setup();
    const camera = project.media[0]!;
    camera.path = "100%camera.mp4";
    const doc = stripScarlet(toOtio(project, tl) as Json);
    const alias = { ...camera, id: "alias", path: "other.mp4", name: camera.path };
    project.media.unshift(alias);
    project.media.push({ ...camera, id: "later" });
    const clip = fromOtio(doc, project, tl).tracks[0]!.clips[0] as MediaClip;
    expect(clip.mediaId).toBe(camera.id);
  });

  it("exports usable file URLs and relinks literal percent escapes after an editor drops Scarlet metadata", () => {
    const { project, tl } = setup();
    const camera = project.media[0]!;
    camera.path = "takes/cam%20A #1.mov";
    project.media.unshift({ ...camera, id: "other", path: "takes/cam A #1.mov" });
    for (const [mediaRoot, expected] of [
      ["/Volumes/Edit #1", "file:///Volumes/Edit%20%231/takes/cam%2520A%20%231.mov"],
      ["C:/Edit #1", "file:///C:/Edit%20%231/takes/cam%2520A%20%231.mov"],
      ["//studio/Media library", "file://studio/Media%20library/takes/cam%2520A%20%231.mov"],
    ]) {
      const doc = stripScarlet(toOtio(project, tl, { mediaRoot }) as Json);
      expect(doc.tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url).toBe(expected);
      expect(fromOtio(doc, project, tl).tracks[0]!.clips[0]).toMatchObject({ mediaId: camera.id });
    }
  });

  it("brings back a hand trim and re-times the captions after it", () => {
    const { project, tl } = setup();
    const otio = stripScarlet(toOtio(project, tl, { mediaRoot: "C:/scarlet/media" }) as Json);
    // In Resolve: trim 2 s off the end of the cold open (rippling the rest earlier).
    const v1 = otio.tracks.children[0];
    v1.children[0].source_range.duration.value -= 60;
    const back = fromOtio(otio, project, tl);
    const v = back.tracks.find((t) => t.id === "v1")!.clips as MediaClip[];
    expect(v[0]!.sourceOut).toBeCloseTo(6, 5);
    expect(v[1]!.timelineIn).toBeCloseTo(4, 5);
    const caps = back.tracks.find((t) => t.id === "cap")!.clips;
    expect(caps.map((c) => c.timelineIn)).toEqual([1, 5]); // "Point one" moved 2 s earlier with its footage
    expect(back.markers[0]!.time).toBeCloseTo(7, 5);
  });

  it("drops Resolve's linked audio twins of video clips", () => {
    const { project, tl } = setup();
    const otio = toOtio(project, tl, { mediaRoot: "C:/media" }) as Json;
    const video = otio.tracks.children[0];
    otio.tracks.children.push({ ...JSON.parse(JSON.stringify(video)), kind: "Audio", name: "A2" });
    const back = fromOtio(stripScarlet(otio), project, tl);
    const audioClips = back.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
    expect(audioClips.map((c) => (c as MediaClip).mediaId)).toEqual(["m2"]);
  });

  it("keeps an independently edited audio clip from the same recording", () => {
    const { project, tl } = setup();
    const video = tl.tracks[0]!.clips[0] as MediaClip;
    for (const [muted, trim] of [[true, 2], [false, 2], [false, 0]] as const) {
      tl.tracks[0]!.muted = muted;
      tl.tracks[1]!.clips = [{ ...video, id: "dialogue", volume: 0.4, sourceOut: video.sourceOut - trim }];
      const doc = toOtio(project, tl) as Json;
      for (const input of [doc, stripScarlet(doc)]) {
        expect(fromOtio(input, project, tl).tracks[1]!.clips).toMatchObject([
          { id: "dialogue", mediaId: video.mediaId, sourceOut: video.sourceOut - trim, volume: 0.4 },
        ]);
      }
    }
  });

  it("distinguishes independent audio from a linked camera twin when Resolve strips metadata", () => {
    const { project, tl } = setup();
    const video = { ...(tl.tracks[0]!.clips[0] as MediaClip), label: "Interview", sourceIn: 1, sourceOut: 11 };
    tl.tracks[0]!.clips = [video];
    tl.tracks[1]!.name = "Dialogue";
    for (const sourceOut of [9, 11]) {
      tl.tracks[1]!.clips = [{ ...video, id: "dialogue", sourceOut, volume: 0.4 }];
      const doc = stripScarlet(toOtio(project, tl) as Json);
      const [picture, audio] = doc.tracks.children;
      const linked = { ...structuredClone(picture), kind: "Audio", name: "Linked" };
      for (const audioTracks of [[audio, linked], [linked, audio]]) {
        doc.tracks.children = [picture, ...audioTracks];
        const back = fromOtio(doc, project, tl).tracks.filter(track => track.kind === "audio");
        expect(back.flatMap(track => track.clips)).toMatchObject([{ id: "dialogue", sourceOut, volume: 0.4 }]);
        expect(back.find(track => track.clips.length)?.name).toBe("Dialogue");
      }
    }
  });

  it("reads a clip with no source range as all of its footage", () => {
    const { project, tl } = setup();
    const otio = stripScarlet(toOtio(project, tl) as Json);
    otio.tracks.children[0].children[0].source_range = null;
    const v = fromOtio(otio, project, tl).tracks.find((t) => t.id === "v1")!.clips as MediaClip[];
    // The file's available range is the whole 60 s recording, and the next clip follows it.
    expect(v[0]).toMatchObject({ mediaId: "m1", timelineIn: 0, sourceIn: 0, sourceOut: 60 });
    expect(v[1]).toMatchObject({ id: "point", timelineIn: 60 });
    // Another editor writes where the camera's timecode starts. All of the footage is still 0 to its length.
    otio.tracks.children[0].children[0].media_references.DEFAULT_MEDIA.available_range.start_time = { value: 108000, rate: 30 };
    expect((fromOtio(otio, project, tl).tracks.find((t) => t.id === "v1")!.clips as MediaClip[])[0]).toMatchObject({ sourceIn: 0, sourceOut: 60 });
  });

  it("reads a clip's range on its footage's own clock, which may start at a timecode", () => {
    const { project, tl } = setup();
    const otio = stripScarlet(toOtio(project, tl) as Json);
    // Another editor counts this camera's frames from its timecode, 01:00:00:00, and the clip's range with them.
    const clip = otio.tracks.children[0].children[0];
    const footage = clip.media_references.DEFAULT_MEDIA.available_range;
    footage.start_time.value = 108000;
    clip.source_range.start_time.value += 108000;
    const read = () => fromOtio(otio, project, tl).tracks.find((t) => t.id === "v1")!.clips as MediaClip[];
    expect(read()[0]).toMatchObject({ id: "open", timelineIn: 0, sourceIn: 2, sourceOut: 8 });
    // The next clip's footage is counted from 0 in the file, and is read as before.
    expect(read()[1]).toMatchObject({ id: "point", timelineIn: 6, sourceIn: 10, sourceOut: 16 });
    // One start written at two rates can differ by a rounding error: here the clip's comes out a hair before its
    // footage's. That is still the footage's first frame.
    footage.start_time = { value: 93093, rate: 24 };
    clip.source_range.start_time = { value: 93000, rate: 24000 / 1001 };
    expect(93000 / (24000 / 1001)).toBeLessThan(93093 / 24);
    expect(read()[0]).toMatchObject({ sourceIn: 0, sourceOut: 6 });
    // A range that starts before its footage does can't be read.
    clip.source_range.start_time = { value: 93093 - 24, rate: 24 };
    expect(() => read()).toThrow(/clip \(Cold open\) whose start or length isn't a time Scarlet can use/);
  });

  it("leaves a disabled clip out and keeps its place in the track", () => {
    const { project, tl } = setup();
    const otio = stripScarlet(toOtio(project, tl) as Json);
    otio.tracks.children[0].children[0].enabled = false;
    const v = fromOtio(otio, project, tl).tracks.find((t) => t.id === "v1")!.clips as MediaClip[];
    expect(v.map((c) => [c.id, c.timelineIn])).toEqual([["point", 6]]);
  });

  it("brings back a speed change, steps over transitions and other items, and keeps gaps", () => {
    const { project, tl } = setup();
    const fast = applyOps(tl, [{ op: "updateClip", clipId: "point", patch: { speed: 2, timelineIn: 8 } }]);
    const otio = stripScarlet(toOtio(project, fast) as Json);
    const v1 = otio.tracks.children[0];
    expect(v1.children.map((c: Json) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Gap.1", "Clip.2"]);
    // Resolve writes a dissolve between clips, and a nested timeline it can't flatten, as items of their own.
    v1.children.splice(1, 0, { OTIO_SCHEMA: "Transition.1", in_offset: { value: 12, rate: 30 }, out_offset: { value: 12, rate: 30 } },
      { OTIO_SCHEMA: "Stack.1", source_range: { start_time: { value: 0, rate: 30 }, duration: { value: 300, rate: 30 } } });
    const v = fromOtio(otio, project, fast).tracks.find((t) => t.id === "v1")!.clips as MediaClip[];
    expect(v.map((c) => [c.id, c.timelineIn, c.sourceIn, c.sourceOut, c.speed])).toEqual([["open", 0, 2, 8, 1], ["point", 8, 10, 16, 2]]);
    // A time warp that isn't a positive number is ignored.
    v1.children.at(-1).effects[0].time_scalar = 0;
    expect((fromOtio(otio, project, fast).tracks.find((t) => t.id === "v1")!.clips as MediaClip[])[1]!.speed).toBe(1);
  });

  it("keeps the source frames of slow motion footage between project frame boundaries", () => {
    const { project, tl } = setup();
    project.media[0]!.fps = 120;
    tl.tracks = [tl.tracks[0]!];
    tl.tracks[0]!.clips = [makeMediaClip("m1", 1 / 120, 2 / 120, 0, { speed: 0.25 })];
    const back = fromOtio(stripScarlet(toOtio(project, tl) as Json), project, tl);
    expect(back.tracks[0]!.clips[0]).toMatchObject({ sourceIn: 1 / 120, sourceOut: 2 / 120, speed: 0.25 });
    expect(timelineDuration(back)).toBeCloseTo(1 / 30, 10);
  });

  it("reads which version a file was exported from, when Scarlet wrote it", () => {
    const { project, tl } = setup();
    expect(otioSourceVersion(toOtio(project, tl))).toBe("v_export");
    expect(otioSourceVersion(stripScarlet(toOtio(project, tl) as Json))).toBeUndefined();
    expect(otioSourceVersion({ metadata: { scarlet: { version: 7 } } })).toBeUndefined();
    expect(otioSourceVersion(null)).toBeUndefined();
    expect(otioSourceVersion("not a document")).toBeUndefined();
  });

  it("explains a file it can't read instead of failing on its shape", () => {
    const { project, tl } = setup();
    const damaged: Array<[string, (doc: Json) => void]> = [
      ["a clip that starts before its footage", (doc) => { doc.tracks.children[0].children[0].source_range.start_time.value = -30; }],
      ["a clip of negative length", (doc) => { doc.tracks.children[0].children[0].source_range.duration.value = -30; }],
      ["a length that isn't a real number", (doc) => { doc.tracks.children[0].children[0].source_range.duration.value = Infinity; }],
      ["tracks that aren't a list", (doc) => { doc.tracks.children = { V1: doc.tracks.children[0] }; }],
      ["clips that aren't a list", (doc) => { doc.tracks.children[0].children = 5; }],
      ["effects that aren't a list", (doc) => { doc.tracks.children[0].children[0].effects = { speed: 2 }; }],
    ];
    for (const [what, damage] of damaged) {
      const doc = toOtio(project, tl) as Json;
      damage(doc);
      expect(() => fromOtio(doc, project, tl), what).toThrow(OtioImportError);
    }
    expect(() => fromOtio({ OTIO_SCHEMA: "Clip.2" }, project, tl)).toThrow(/isn't an OpenTimelineIO timeline/);
    expect(() => fromOtio(null, project, tl)).toThrow(OtioImportError);
    // A start no footage is read from doesn't matter: a gap's, a solid colour's and a disabled clip's still import.
    const early = { start_time: { value: -30, rate: 30 }, duration: { value: 60, rate: 30 } };
    const doc = toOtio(project, tl) as Json;
    doc.tracks.children[0].children[0].enabled = false;
    doc.tracks.children[0].children[0].source_range.start_time.value = -30;
    doc.tracks.children[0].children.push({ OTIO_SCHEMA: "Gap.1", source_range: early },
      { OTIO_SCHEMA: "Clip.2", name: "Black", source_range: early, media_reference: { OTIO_SCHEMA: "GeneratorReference.1", generator_kind: "SolidColor", parameters: {} } });
    const v = fromOtio(doc, project, tl).tracks.find((t) => t.id === "v1")!.clips;
    expect(v.map((c) => [c.kind, c.timelineIn])).toEqual([["media", 6], ["color", 14]]);
    // Footage Scarlet doesn't have is the thing to say, whatever the clip's start.
    const lost = toOtio(project, tl) as Json;
    const clip = lost.tracks.children[0].children[0];
    clip.source_range.start_time.value = -30;
    Object.assign(clip.media_references[clip.active_media_reference_key], { target_url: "file:///media/zzz.mov", metadata: {} });
    expect(() => fromOtio(lost, project, tl)).toThrow(/footage Scarlet doesn't have: zzz\.mov/);
    // A timeline with no tracks at all is still a timeline: it imports empty rather than failing.
    const bare = fromOtio({ OTIO_SCHEMA: "Timeline.1" }, project, tl);
    expect(bare.tracks.flatMap((t) => t.clips.filter((c) => c.kind !== "caption"))).toEqual([]);
  });

  it("explains missing footage instead of guessing", () => {
    const { project, tl } = setup();
    const otio = stripScarlet(toOtio(project, tl, { mediaRoot: "C:/media" }) as Json);
    otio.tracks.children[0].children[1].media_references.DEFAULT_MEDIA.target_url = "file:///D:/footage/broll-drone.mov";
    expect(() => fromOtio(otio, project, tl)).toThrow(OtioImportError);
    expect(() => fromOtio(otio, project, tl)).toThrow(/broll-drone\.mov/);
  });
});
