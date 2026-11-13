import { describe, expect, it, vi } from "vitest";
import {
  applyOp,
  applyOps,
  captionsFromWords,
  clipEnd,
  createProject,
  diffTimelines,
  emptyTimeline,
  formatTimecode,
  frameAligned,
  makeMediaClip,
  mergeRanges,
  timelineDuration,
  timelineFromKeepRanges,
  planPlaybackSegments,
  sourceClockAnchors,
  toOtio,
  Timeline,
  WritableTimeline,
  type CaptionClip,
} from "./index.js";
import type { MediaClip, Project } from "./index.js";

const projectId = "prj_test";

describe("ops", () => {
  it("isolates nested effect parameters from the caller and from sibling edits", () => {
    const points = [0.25];
    const effects = [{ type: "curve", enabled: true, params: { points } }];
    const timeline = applyOps(emptyTimeline(projectId), ["first", "second"].map((id, i) => ({
      op: "addClip", trackId: "v1", clip: makeMediaClip("m1", 0, 1, i, { id, effects }),
    })));
    const curves = timeline.tracks[0]!.clips.map(clip => {
      if (clip.kind !== "media") throw new Error("expected media");
      return clip.effects[0]!.params.points as number[];
    });
    points[0] = 0.5;
    curves[0]![0] = 0.75;
    expect(curves[1]).toEqual([0.25]);
    expect(points).toEqual([0.5]);
  });

  it("leaves the original timeline untouched when a later op fails", () => {
    const timeline = emptyTimeline(projectId);
    expect(() => applyOps(timeline, [
      { op: "addClip", trackId: "v1", clip: makeMediaClip("m1", 0, 3, 0, { id: "c1" }) },
      { op: "removeClip", clipId: "missing" },
    ])).toThrow("clip missing not found");
    expect(timeline.tracks[0]!.clips).toEqual([]);
  });

  it("clones the timeline once per batch and keeps failed edits private", () => {
    const base = timelineFromKeepRanges(projectId, "m1", [{ start: 0, end: 10 }]);
    const clip = base.tracks[0]!.clips[0]!;
    const first = { op: "updateClip" as const, clipId: clip.id, patch: { volume: 0.4 } };
    const last = { ...first, patch: { volume: 0.7 } };
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const edited = applyOps(base, [first, last]);
      expect(clone.mock.calls.filter(([value]) => value === base)).toHaveLength(1);
      expect(edited.tracks[0]!.clips[0]).toMatchObject({ volume: 0.7 });
    } finally {
      clone.mockRestore();
    }
    expect(applyOp(base, first).tracks[0]!.clips[0]).toMatchObject({ volume: 0.4 });
    expect(() => applyOps(base, [first, { op: "removeClip", clipId: "absent" }])).toThrow();
    expect(clip).toMatchObject({ volume: 1 });
  });

  it("rejects duplicate clip IDs on new writes and leaves historical versions readable", () => {
    const base = timelineFromKeepRanges(projectId, "m1", [{ start: 0, end: 10 }]);
    const track = base.tracks[0]!;
    const clip = track.clips[0]!;
    const duplicateTrack = { ...track, id: "other" };
    expect(() => applyOp(base, { op: "splitClip", clipId: clip.id, at: 4, newClipId: clip.id })).toThrow(/already exists/);
    expect(() => applyOps(base, [{ op: "addTrack", track: duplicateTrack }])).toThrow(/already exists/);
    const legacy = { ...base, tracks: [...base.tracks, duplicateTrack] };
    expect(Timeline.safeParse(legacy).success).toBe(true);
    expect(WritableTimeline.safeParse(legacy).success).toBe(false);
    expect(applyOps(legacy, [{ op: "removeTrack", trackId: "other" }])).toEqual(base);
  });

  it("adds, splits and ripple-deletes", () => {
    let tl = emptyTimeline(projectId);
    tl = applyOps(tl, [{ op: "addClip", trackId: "v1", clip: makeMediaClip("m1", 0, 10, 0, { id: "c1" }) }]);
    expect(timelineDuration(tl)).toBe(10);

    tl = applyOps(tl, [{ op: "splitClip", clipId: "c1", at: 4, newClipId: "c2" }]);
    const v1 = tl.tracks[0]!;
    expect(v1.clips.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(clipEnd(v1.clips[0]!)).toBe(4);
    expect(v1.clips[1]!.timelineIn).toBe(4);
    expect((v1.clips[1] as { sourceIn: number }).sourceIn).toBe(4);

    // Cut out 2..6 (spans the split point) and close the gap.
    tl = applyOps(tl, [{ op: "rippleDelete", start: 2, end: 6 }]);
    expect(timelineDuration(tl)).toBe(6);
    const clips = tl.tracks[0]!.clips;
    expect(clips.length).toBe(2);
    expect(clips[0]!.timelineIn).toBe(0);
    expect(clipEnd(clips[0]!)).toBe(2);
    expect(clips[1]!.timelineIn).toBe(2);
    expect((clips[1] as { sourceIn: number }).sourceIn).toBe(6);
    expect(clipEnd(clips[1]!)).toBe(6);
  });

  it("preserves the same keyframe curve through splits and repeated head trims", () => {
    const base = timelineFromKeepRanges(projectId, "camera", [{ start: 1, end: 11 }]);
    const clip = base.tracks[0]!.clips[0]!;
    if (clip.kind !== "media") throw new Error("expected a media clip");
    clip.keyframes = [{ time: 0, ease: "easeInOut", transform: { x: 0 } }, { time: 10, ease: "hold", transform: { x: 0.5 } }];
    const split = applyOps(base, [{ op: "splitClip", clipId: clip.id, at: 5, newClipId: "right" }]);
    expect(diffTimelines(base, split).spots).toEqual([]);
    expect(split.tracks[0]!.clips[1]).toMatchObject({ sourceIn: 6, keyframes: [{ time: -5, ease: "easeInOut" }, { time: 5 }] });
    const trimmed = applyOps(split, [{ op: "rippleDelete", start: 5, end: 7 }]);
    expect(trimmed.tracks[0]!.clips[1]).toMatchObject({ sourceIn: 8, keyframes: [{ time: -7, ease: "easeInOut" }, { time: 3 }] });
  });

  it("moves both endpoints of range markers around an inserted gap", () => {
    const timeline = emptyTimeline(projectId);
    timeline.markers = [[1, 8], [2, 9], [8, 8], [12, 13]].map(([start, end], i) => ({
      id: String(i), time: start!, end, kind: "chapter", text: "", resolved: false,
    }));
    const changed = applyOps(timeline, [{ op: "rippleInsertGap", at: 8, duration: 5 }]);
    expect(changed.markers.map(m => [m.time, m.end])).toEqual([[1, 8], [2, 14], [13, 13], [17, 18]]);
  });

  it("trims and shifts absolute caption words and text with a ripple edit", () => {
    const base = emptyTimeline(projectId);
    const words = ["one", "two", "three"].map((text, i) => ({ text, start: i, end: i + 1 }));
    const caption: CaptionClip = { id: "words", kind: "caption", enabled: true, timelineIn: 0, timelineOut: 3, text: "one two three", words };
    base.tracks.push({ id: "caps", name: "Captions", kind: "caption", muted: false, hidden: false, clips: [caption] });
    const edited = applyOps(base, [{ op: "rippleDelete", start: 1, end: 2 }]);
    expect(edited.tracks.at(-1)?.clips).toMatchObject([
      { timelineIn: 0, timelineOut: 1, text: "one", words: [{ text: "one", start: 0, end: 1 }] },
      { timelineIn: 1, timelineOut: 2, text: "three", words: [{ text: "three", start: 1, end: 2 }] },
    ]);
    const gap = applyOps(base, [{ op: "rippleInsertGap", at: 0.5, duration: 2 }]);
    expect(gap.tracks.at(-1)?.clips).toMatchObject([
      { timelineIn: 0, timelineOut: 0.5, text: "one", words: [{ text: "one", start: 0, end: 0.5 }] },
      { timelineIn: 2.5, timelineOut: 5, words: [{ text: "one", start: 2.5, end: 3 }, { text: "two", start: 3, end: 4 }, { text: "three", start: 4, end: 5 }] },
    ]);
    caption.words = [{ text: "one", start: 0, end: 1 }];
    expect(applyOps(base, [{ op: "rippleDelete", start: 0, end: 1 }]).tracks.at(-1)?.clips[0]).toMatchObject({ words: [], text: "" });
    delete caption.words;
    expect(applyOps(base, [{ op: "rippleDelete", start: 0, end: 1 }]).tracks.at(-1)?.clips[0]).toMatchObject({ text: caption.text });
  });

  it("rejects caption clips on video tracks", () => {
    const tl = emptyTimeline(projectId);
    expect(() =>
      applyOps(tl, [
        {
          op: "addClip",
          trackId: "v1",
          clip: { id: "x", kind: "caption", timelineIn: 0, timelineOut: 1, text: "hi", enabled: true },
        },
      ]),
    ).toThrow();
  });
});

describe("diff", () => {
  it("computes affected ranges", () => {
    const before = timelineFromKeepRanges(projectId, "m1", [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
      { start: 20, end: 25 },
    ]);
    const c2 = before.tracks[0]!.clips[1]!;
    const after = applyOps(before, [{ op: "updateClip", clipId: c2.id, patch: { sourceOut: 14 } }]);
    const d = diffTimelines(before, after);
    expect(d.clips.length).toBe(1); // only c2 changed; c3 is not rippled by updateClip
    expect(d.durationAfter).toBe(15);
    // Only the trimmed second (9–10 s, now a gap before take 3) looks different.
    expect(d.ranges[0]!.start).toBe(9);
    expect(d.ranges[0]!.end).toBe(10);
  });

  it("merges ranges", () => {
    expect(mergeRanges([{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 5, end: 6 }])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
    ]);
  });
});

describe("otio", () => {
  it("exports a valid-looking document", () => {
    const project = createProject("Test");
    project.media.push({ id: "m1", kind: "video", name: "a.mp4", path: "a.mp4", duration: 60, fps: 30 });
    const tl = timelineFromKeepRanges(project.id, "m1", [{ start: 1, end: 3 }, { start: 5, end: 8 }]);
    const otio = toOtio(project, tl, { mediaRoot: "C:/media" }) as { tracks: { children: unknown[] } };
    expect(otio.tracks.children.length).toBe(2);
    const json = JSON.stringify(otio);
    expect(json).toContain("ExternalReference.1");
    expect(json).toContain("file:///C:/media/a.mp4");
  });

  it("writes gaps, speed changes, generators and each kind of media path", () => {
    const project = createProject("Export");
    project.media.push({ id: "m1", kind: "video", name: "a.mp4", path: "a.mp4", duration: 60, fps: 25, hash: "abc" });
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [
      { id: "card", kind: "color", enabled: true, timelineIn: 0, timelineOut: 1, color: "white", opacity: 1 },
      makeMediaClip("m1", 4, 8, 3, { id: "fast", speed: 2, label: "Fast take" }),
      { ...makeMediaClip("m1", 0, 1, 5, { id: "off" }), enabled: false },
      makeMediaClip("lost", 0, 2, 6, { id: "orphan" }),
    ];
    type Item = { OTIO_SCHEMA: string; name: string; source_range: { start_time: { value: number; rate: number }; duration: { value: number; rate: number } };
      effects: Array<{ OTIO_SCHEMA: string; time_scalar: number }>; media_references: { DEFAULT_MEDIA: Record<string, unknown> } };
    const children = (opts?: Parameters<typeof toOtio>[2]) => (toOtio(project, tl, opts) as { tracks: { children: Array<{ kind: string; children: Item[] }> } }).tracks.children;
    const [video, audio] = children();
    expect(audio).toMatchObject({ kind: "Audio", children: [] });
    // The disabled clip is left out, and the time it covered is part of the gap before the next clip.
    expect(video!.children.map(c => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Gap.1", "Clip.2", "Gap.1", "Clip.2"]);
    const [card, gap, fast, , orphan] = video!.children;
    expect(card!.media_references.DEFAULT_MEDIA).toMatchObject({ OTIO_SCHEMA: "GeneratorReference.1", generator_kind: "SolidColor", parameters: { color: "white" } });
    expect(gap!.source_range.duration).toMatchObject({ value: 60, rate: 30 });
    // Source times are in the project's frames, though the recording is 25 fps: 4 s and 4 s at 30.
    expect(fast).toMatchObject({ name: "Fast take", source_range: { start_time: { value: 120, rate: 30 }, duration: { value: 120, rate: 30 } },
      effects: [{ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: 2 }] });
    expect(fast!.media_references.DEFAULT_MEDIA).toMatchObject({ target_url: "a.mp4", metadata: { scarlet: { mediaId: "m1", hash: "abc" } } });
    // Footage the project no longer lists is still written, by its id, with no path.
    expect(orphan).toMatchObject({ name: "orphan", effects: [], media_references: { DEFAULT_MEDIA: { name: "lost", target_url: "" } } });
    const url = (mediaRoot: string) => children({ mediaRoot })[0]!.children[2]!.media_references.DEFAULT_MEDIA.target_url;
    expect(url("/Users/editor/media/")).toBe("file:///Users/editor/media/a.mp4");
    expect(url("D:\\footage\\")).toBe("file:///D:/footage/a.mp4");
    expect(url("media")).toBe("media/a.mp4");
  });

  it("writes footage at the project's frame rate in frames of that rate: each clip's source start and length, each gap's length", () => {
    type Range = { start_time: { value: number; rate: number }; duration: { value: number; rate: number } };
    type Doc = { tracks: { children: Array<{ children: Array<{ source_range: Range; media_references?: { DEFAULT_MEDIA: { available_range: Range } } }> }> } };
    // A start and a length in frames, then the rate each is counted at.
    const numbers = (r: Range) => [r.start_time.value, r.duration.value, r.start_time.rate, r.duration.rate];
    // A 25 fps recording and a microphone in a 25 fps project.
    const project = createProject("Same rate", { fps: 25 });
    project.media.push({ id: "m1", kind: "video", name: "a.mp4", path: "a.mp4", duration: 60, fps: 25 },
      { id: "mic", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 60 });
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [
      { id: "card", kind: "color", enabled: true, timelineIn: 0, timelineOut: 1, color: "white", opacity: 1 },
      makeMediaClip("m1", 4, 8, 3, { id: "fast", speed: 2 }),
      makeMediaClip("m1", 10, 12.4, 5, { id: "next" }),
      { ...makeMediaClip("m1", 0, 1, 7.4, { id: "off" }), enabled: false },
      makeMediaClip("lost", 0, 2, 9, { id: "orphan" }),
    ];
    tl.tracks[1]!.clips = [makeMediaClip("mic", 2, 6.4, 3, { id: "sound" })];
    const [video, audio] = (toOtio(project, tl) as Doc).tracks.children;
    expect(video!.children.map(c => numbers(c.source_range))).toEqual([
      [0, 25, 25, 25], // the card: 1 s
      [0, 50, 25, 25], // a gap of 2 s
      [100, 100, 25, 25], // the fast take: 4 s of footage from 4 s in
      [250, 60, 25, 25], // 2.4 s from 10 s in, joined to the take before
      [0, 40, 25, 25], // a gap of 1.6 s, the disabled clip's second included
      [0, 50, 25, 25], // 2 s of footage the project no longer lists
    ]);
    expect(audio!.children.map(c => numbers(c.source_range))).toEqual([[0, 75, 25, 25], [50, 110, 25, 25]]);
    expect(numbers(video!.children[2]!.media_references!.DEFAULT_MEDIA.available_range)).toEqual([0, 1500, 25, 25]);
    // A dialogue pass on whole frames, at 30 fps and at the 29.97 a project takes from its first clip: every clip on
    // both tracks is its own source start and its own length, each rounded to a frame.
    for (const fps of [30, 30000 / 1001]) {
      const pass = createProject("Pass", { fps });
      pass.media.push({ id: "v", kind: "video", name: "cam.mp4", path: "cam.mp4", duration: 3600, fps },
        { id: "a", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 3600 });
      const base = emptyTimeline(pass.id);
      base.tracks[0]!.clips = [makeMediaClip("v", 0, 600, 0)];
      base.tracks[1]!.clips = [makeMediaClip("a", 0, 600, 0)];
      const cut = applyOps(base, Array.from({ length: 40 }, (_, n) => {
        const i = 39 - n, start = 5 + i * 11.37 + (i % 7) * 0.211;
        return { op: "rippleDelete" as const, ...frameAligned({ start, end: start + 0.4 + (i % 9) * 0.173 }, fps) };
      }));
      const own = (c: MediaClip) => [Math.round(c.sourceIn * fps), Math.round((c.sourceOut - c.sourceIn) * fps), fps, fps];
      for (const [i, track] of (toOtio(pass, cut) as Doc).tracks.children.entries()) {
        expect(track.children).toHaveLength(41);
        expect(track.children.map(c => numbers(c.source_range))).toEqual((cut.tracks[i]!.clips as MediaClip[]).map(own));
      }
    }
  });

  it("writes markers by kind, and captions as markers unless asked not to", () => {
    const project = createProject("Markers");
    const tl = emptyTimeline(project.id);
    tl.markers = [
      { id: "todo", time: 1, kind: "todo", text: "Fix", resolved: false, author: "Editor", noteId: "n1" },
      { id: "chapter", time: 2, end: 5, kind: "chapter", text: "Part two", resolved: false },
      { id: "note", time: 6, kind: "note", text: "Nice", resolved: false },
    ];
    tl.tracks.push({ id: "cap", kind: "caption", name: "Captions", muted: false, hidden: false,
      clips: [{ id: "line", kind: "caption", enabled: true, timelineIn: 3, timelineOut: 4.5, text: "Hello there" }] });
    type Mark = { name: string; color: string; marked_range: { start_time: { value: number }; duration: { value: number } }; metadata: { scarlet: Record<string, unknown> } };
    const doc = toOtio(project, tl) as { tracks: { children: unknown[]; markers: Mark[] }; metadata: { scarlet: Record<string, unknown> } };
    expect(doc.metadata.scarlet).toMatchObject({ projectId: project.id, version: "draft", fps: 30, width: 1920, height: 1080 });
    // Caption tracks aren't OTIO tracks: Resolve has no subtitle import.
    expect(doc.tracks.children).toHaveLength(2);
    expect(doc.tracks.markers.map(m => [m.name, m.color, m.marked_range.start_time.value, m.marked_range.duration.value])).toEqual([
      // A marker at a point is one frame long.
      ["Fix", "RED", 30, 1], ["Part two", "BLUE", 60, 90], ["Nice", "GREEN", 180, 1], ["Hello there", "YELLOW", 90, 45],
    ]);
    expect(doc.tracks.markers[0]!.metadata.scarlet).toEqual({ id: "todo", kind: "todo", author: "Editor", noteId: "n1" });
    expect(doc.tracks.markers[3]!.metadata.scarlet).toEqual({ caption: true, clipId: "line" });
    const plain = toOtio(project, tl, { captionsAsMarkers: false }) as typeof doc;
    expect(plain.tracks.markers.map(m => m.name)).toEqual(["Fix", "Part two", "Nice"]);
  });

  it("keeps each track of a rippled cut on one track, though neighbours overlap by floating-point error", () => {
    const project = createProject("Rippled");
    project.media.push({ id: "v", kind: "video", name: "cam.mp4", path: "cam.mp4", duration: 3600, fps: 30 },
      { id: "a", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 3600 });
    const base = emptyTimeline(project.id);
    base.tracks[0]!.clips = [makeMediaClip("v", 0, 600, 0)];
    base.tracks[1]!.clips = [makeMediaClip("a", 0, 600, 0)];
    // A dialogue pass: forty frame-aligned removals, applied back to front.
    const cut = applyOps(base, Array.from({ length: 40 }, (_, n) => {
      const i = 39 - n, start = 5 + i * 11.37 + (i % 7) * 0.211;
      return { op: "rippleDelete" as const, ...frameAligned({ start, end: start + 0.4 + (i % 9) * 0.173 }, 30) };
    }));
    const clips = cut.tracks[0]!.clips;
    expect(clips).toHaveLength(41);
    // The case under test: some neighbours overlap, by far less than a sample.
    const overlaps = clips.flatMap((c, i) => (i && clipEnd(clips[i - 1]!) > c.timelineIn ? [clipEnd(clips[i - 1]!) - c.timelineIn] : []));
    expect(overlaps.length).toBeGreaterThan(0);
    expect(Math.max(...overlaps)).toBeLessThan(1e-9);
    const otio = toOtio(project, cut) as { tracks: { children: Array<{ name: string; children: Array<{ OTIO_SCHEMA: string }> }> } };
    expect(otio.tracks.children.map(t => t.name)).toEqual(["V1", "A1"]);
    for (const track of otio.tracks.children) expect(track.children.map(c => c.OTIO_SCHEMA)).toEqual(Array(41).fill("Clip.2"));
    // A real overlap still gets its own layer.
    const stacked = applyOps(cut, [{ op: "addClip", trackId: "v1", clip: makeMediaClip("v", 0, 2, 1) }]);
    expect((toOtio(project, stacked) as typeof otio).tracks.children.map(t => t.name)).toEqual(["V1", "V1 (layer 2)", "A1"]);
  });
});

describe("captions", () => {
  it("keeps simultaneous words together when a word or character limit would split their onset", () => {
    const words = [
      { text: "Well", start: 0, end: 1.1 },
      { text: "Yes", start: 1, end: 1.6 },
      { text: "Right", start: 1, end: 1.3 },
      { text: "Then", start: 1.5, end: 2 },
    ];
    for (const limit of [{ maxWords: 1 }, { maxWords: 2 }, { maxChars: 8 }]) {
      expect(captionsFromWords(words, limit).map(({ text, start, end }) => [text, start, end]))
        .toEqual([["Well", 0, 1], ["Yes Right", 1, 1.5], ["Then", 1.5, 2]]);
    }
  });
  it("ends a full cue before the next one even while an earlier word continues", () => {
    const words = [
      { text: "hello", start: 0, end: 1.7 }, { text: "yes", start: 0.3, end: 0.5 },
      { text: "then", start: 0.7, end: 2 },
    ];
    expect(captionsFromWords(words, { maxWords: 2 }).map(cue => [cue.start, cue.end]))
      .toEqual([[0, 0.7], [0.7, 2]]);
    const short = captionsFromWords([{ text: "A", start: 0, end: 0.02 }, { text: "B", start: 0.05, end: 0.06 }],
      { maxWords: 1, minDuration: 0.1 });
    expect(short[0]!.end).toBe(0.05);
    expect(short[1]!.end).toBeCloseTo(0.15, 10);
  });
  it("keeps a cue through overlapping speech and measures the gap from its last audible word ending", () => {
    const words = [
      { text: "Well", start: 0, end: 2 },
      { text: "yes", start: 0.1, end: 0.5 },
      { text: "okay", start: 1.8, end: 1.9 },
      { text: "thanks", start: 3, end: 3.5 },
    ];
    expect(captionsFromWords(words).map(({ text, start, end }) => [text, start, end]))
      .toEqual([["Well yes okay", 0, 2], ["thanks", 3, 3.5]]);
  });
  it("groups words", () => {
    const words = Array.from({ length: 12 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.5 }));
    const clips = captionsFromWords(words, { maxWords: 5 });
    expect(clips.length).toBe(3);
    expect(clips[0]!.text).toBe("w0 w1 w2 w3 w4");
  });
});

describe("ripple removal", () => {
  it("drops a clip whose edges meet the removal's to within floating-point error, leaving no clip of no length", () => {
    const project = createProject("Ripple");
    const tl = emptyTimeline(project.id);
    // A one-frame clip whose edges differ from the removal's in the thirteenth decimal, as after a few ripples.
    const a = 820.3666666666663, b = a + 1 / 30;
    tl.tracks[0]!.clips = [makeMediaClip("m", 0, a, 0), { ...makeMediaClip("m", 900, 900 + 1 / 30, a), id: "sliver" }, { ...makeMediaClip("m", 1000, 1100, b), id: "after" }];
    const cut = applyOps(tl, [{ op: "rippleDelete", start: a + 4e-13, end: b - 4e-13 }]);
    expect(cut.tracks[0]!.clips.map(c => c.id)).not.toContain("sliver");
    expect(cut.tracks[0]!.clips).toHaveLength(2);
    expect(cut.tracks[0]!.clips[1]!.timelineIn).toBeCloseTo(a, 9);
  });

  it("leaves no clip of no length when a removal starts or ends a hair inside a longer clip", () => {
    const project = createProject("Ripple");
    const tl = emptyTimeline(project.id);
    // As saved by a real pass: the clip begins 1.3e-13 s before the removal and runs past its end.
    const a = 121.13333333333321, start = 121.13333333333334, end = 144.76666666666668;
    tl.tracks[0]!.clips = [{ ...makeMediaClip("m", 0, a, 0), id: "before" }, { ...makeMediaClip("m", 500, 600, a), id: "long" }];
    const head = applyOps(tl, [{ op: "rippleDelete", start, end }]).tracks[0]!.clips;
    expect(head.map(c => c.id)).toEqual(["before", "long"]);
    expect(head[1]!.sourceIn).toBeCloseTo(500 + (end - a), 9);
    // The other way round: the clip ends 1.3e-13 s after the removal does.
    tl.tracks[0]!.clips = [{ ...makeMediaClip("m", 0, end + 1.3e-13, 0), id: "long" }, { ...makeMediaClip("m", 500, 600, end + 1.3e-13), id: "after" }];
    const tail = applyOps(tl, [{ op: "rippleDelete", start, end }]).tracks[0]!.clips;
    expect(tail.map(c => c.id)).toEqual(["long", "after"]);
    expect(tail.every(c => c.sourceOut - c.sourceIn > 1)).toBe(true);
  });

  it("trims a clip whose one edge meets the removal's to within floating-point error, splitting off no clip of no length", () => {
    const ids = (clips: Array<{ id: string }>) => clips.map(c => c.id);
    // The join drifted: the clip after the removal's start begins in the thirteenth decimal before it.
    const head = emptyTimeline(projectId);
    head.tracks[0]!.clips = [makeMediaClip("m", 0, 10, 0, { id: "a" }), makeMediaClip("m", 20, 40, 10 - 1e-13, { id: "b" })];
    const headCut = applyOps(head, [{ op: "rippleDelete", start: 10, end: 12 }]).tracks[0]!.clips;
    expect(ids(headCut)).toEqual(["a", "b"]);
    expect(headCut[1]).toMatchObject({ timelineIn: 10, sourceOut: 40 });
    expect((headCut[1] as MediaClip).sourceIn).toBeCloseTo(22, 9);
    // The clip the removal ends in runs on in the thirteenth decimal past it, and the next starts just short of it.
    const tail = emptyTimeline(projectId);
    const end = 1114.6333333333337;
    tail.tracks[0]!.clips = [makeMediaClip("m", 0, end - 1019.93, 1019.93, { id: "a" }), makeMediaClip("m", 200, 300, 1114.6333333333332, { id: "b" })];
    const tailCut = applyOps(tail, [{ op: "rippleDelete", start: 1112.4666666666667, end: 1114.6333333333334 }]).tracks[0]!.clips;
    expect(ids(tailCut)).toEqual(["a", "b"]);
    expect(clipEnd(tailCut[0]!)).toBeCloseTo(1112.4666666666667, 9);
    expect(tailCut[1]!.timelineIn).toBeCloseTo(1112.4666666666667, 9);
    // A removal well inside a clip still splits it in two.
    expect(applyOps(head, [{ op: "rippleDelete", start: 4, end: 6 }]).tracks[0]!.clips).toHaveLength(3);
  });

  it("opens a gap between two clips when asked a few microseconds off their join, splitting neither", () => {
    const project = createProject("Gap");
    const tl = emptyTimeline(project.id);
    const join = 930.3333333333335;
    tl.tracks[0]!.clips = [{ ...makeMediaClip("m", 0, join, 0), id: "left" }, { ...makeMediaClip("m", 2000, 2030, join), id: "right" }];
    for (const at of [930.3333, 930.3334, join]) {
      const gap = applyOps(tl, [{ op: "rippleInsertGap", at, duration: 0.5 }]);
      expect(gap.tracks[0]!.clips.map(c => c.id)).toEqual(["left", "right"]);
      expect(gap.tracks[0]!.clips[1]!.timelineIn).toBeCloseTo(join + 0.5, 9);
    }
    // A gap asked for inside a clip still splits it.
    expect(applyOps(tl, [{ op: "rippleInsertGap", at: 100, duration: 0.5 }]).tracks[0]!.clips).toHaveLength(3);
  });
});

describe("whole frames", () => {
  it("rounds a cut inward to whole frames, and takes an edge within a millisecond of a frame as on it", () => {
    // 2.013 s is past frame 60 and 3.387 s is short of frame 102: frames 61 to 101 come out.
    expect(frameAligned({ start: 2.013, end: 3.387 }, 30)).toEqual({ start: 61 / 30, end: 101 / 30 });
    // Frame 3,670 is 122.3333… s. Given to the millisecond, either side of it, it is still that frame.
    expect(frameAligned({ start: 120, end: 122.333 }, 30)).toEqual({ start: 120, end: 3670 / 30 });
    expect(frameAligned({ start: 122.334, end: 125 }, 30)).toEqual({ start: 3670 / 30, end: 125 });
    // A cut shorter than a frame rounds to the nearest frame, and one that rounds to nothing stays as given.
    expect(frameAligned({ start: 1.01, end: 1.04 }, 30)).toEqual({ start: 30 / 30, end: 31 / 30 });
    expect(frameAligned({ start: 1.012, end: 1.014 }, 30)).toEqual({ start: 1.012, end: 1.014 });
  });
});

describe("timecode", () => {
  it("shows the frame a frame-aligned time is on, not the one before", () => {
    // 2.3 - 2 and 59.9 - 59 are a few ulps short of 9/30 and 27/30.
    expect(formatTimecode(2.3, 30)).toBe("0:02.09");
    expect(formatTimecode(59.9, 30)).toBe("0:59.27");
    expect(formatTimecode(69 / 30, 30)).toBe("0:02.09");
    expect(formatTimecode(3 - 1e-12, 30)).toBe("0:03.00");
    expect(formatTimecode(3661.5, 30)).toBe("1:01:01.15");
  });
});

describe("sha256", () => {
  it("matches known vectors", async () => {
    const { sha256 } = await import("./ids.js");
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 56-byte input crosses the single-block padding boundary.
    expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("playback sections", () => {
  it("follow the first picture track's source clock, so a cut before them leaves their footage unchanged", () => {
    const fps = 30;
    const project = { settings: { fps } } as Pick<Project, "settings">;
    const tl = timelineFromKeepRanges("p", "m1", [{ start: 0, end: 100 }]);
    const sources = (t: Timeline) => planPlaybackSegments(project, t).map(r => sourceAt(t, r.start));
    const sourceAt = (t: Timeline, at: number) => {
      const clip = t.tracks[0]!.clips.find(c => c.timelineIn <= at + 1e-9 && at < clipEnd(c)) as MediaClip;
      return Math.round((clip.sourceIn + at - clip.timelineIn) * 1000) / 1000;
    };
    expect(sources(tl).slice(0, 4)).toEqual([0, 4, 8, 12]);
    const cut = applyOps(tl, [{ op: "rippleDelete", start: 5, end: 6.5 }]);
    // Sections after the cut start at the same source moments as before it.
    expect(sources(cut).filter(s => s > 12)).toEqual(sources(tl).filter(s => s > 12));
    expect(sourceClockAnchors(cut, 4).slice(0, 3)).toEqual([4, 6.5, 10.5]);
  });
});
