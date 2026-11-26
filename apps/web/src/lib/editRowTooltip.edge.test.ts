import { describe, expect, it } from "vitest";
import type { Change, Timeline } from "@scarlet/timeline";
import type { Thread, ThreadEdit } from "@scarlet/shared";
import { callRowTooltip, changeForEdit, cutRemovedSeconds, decidedCallRowTooltip, editRowTooltip, momentRowTooltip } from "./editRowTooltip";

const media = [
  { id: "med_main", name: "Interview.mov" },
  { id: "med_music", name: "Warm bed.wav" },
  { id: "med_raw", name: "IMG_4821.MOV" },
  { id: "med_broll", name: "city-skyline.mp4" },
];

type Track = { id: string; kind: string; name?: string; clips: Record<string, unknown>[] };
const timelineOf = (...tracks: Track[]) => ({ version: "v1", tracks: tracks.map(t => ({ name: t.id, ...t })) } as unknown as Timeline);
const mediaClip = (over: Record<string, unknown> = {}) => ({ id: "clp_main", kind: "media", mediaId: "med_main", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1, ...over });
const mainTrack = (...clips: Record<string, unknown>[]): Track => ({ id: "trk_v1", kind: "video", clips: clips.length ? clips : [mediaClip({ timelineIn: 0, sourceOut: 60 })] });

const edit = (over: Partial<Omit<ThreadEdit, "at">> = {}): Omit<ThreadEdit, "at"> => ({
  changeId: "chg_1",
  spot: 0,
  label: "Edit",
  range: { start: 10, end: 14 },
  previous: [],
  ...over,
});

const change = (over: Partial<Change> = {}): Change => ({ id: "chg_1", ...over } as Change);
const update = (clipId: string, patch: Record<string, unknown>) => change({ ops: [{ op: "updateClip", clipId, patch }] } as Partial<Change>);

describe("cutRemovedSeconds", () => {
  it("passes over an empty beforeCut and reads the applied join of the edit's spot", () => {
    const cut = edit({ kind: "cut", spot: 1, beforeCut: { version: "v1", removed: { start: 5, end: 5 } } });
    expect(cutRemovedSeconds(cut)).toBeUndefined();
    const applied = change({ appliedReview: { joins: [{ removed: { start: 0, end: 1 } }, { removed: { start: 12, end: 14.5 } }] } } as unknown as Partial<Change>);
    expect(cutRemovedSeconds(cut, applied)).toBeCloseTo(2.5);
  });

  it("settles each removal against the later ripple steps before matching it to the edit", () => {
    // The first removal at 20 lands at 12 once the later 2–10 removal ripples it back.
    const ops = [
      { op: "rippleDelete", start: 20, end: 21.5 },
      { op: "rippleDelete", start: 2, end: 10 },
    ];
    expect(cutRemovedSeconds(edit({ kind: "cut", range: { start: 12, end: 12 } }), change({ ops } as Partial<Change>))).toBeCloseTo(1.5);
    // A gap opened before it pushes it later; a removal starting after it and a track-only step leave it alone.
    const pushed = [
      { op: "rippleDelete", start: 5, end: 6 },
      { op: "rippleInsertGap", at: 1, duration: 3 },
      { op: "rippleDelete", start: 30, end: 40 },
      { op: "rippleDelete", start: 0, end: 1, trackIds: ["trk_a1"] },
      { op: "rippleInsertGap", at: 50, duration: 2 },
    ];
    expect(cutRemovedSeconds(edit({ kind: "cut", range: { start: 8, end: 8 } }), change({ ops: pushed } as Partial<Change>))).toBeCloseTo(1);
  });

  it("falls back to removals on single tracks when nothing global landed on the edit", () => {
    const ops = [
      { op: "updateClip", clipId: "clp_main", patch: {} },
      { op: "rippleDelete", start: 10, end: 10 },
      { op: "rippleDelete", start: "10", end: 12 },
      { op: "rippleDelete", start: 10, end: 11.2, trackIds: ["trk_a1"] },
    ];
    expect(cutRemovedSeconds(edit({ kind: "cut", range: { start: 10, end: 10 } }), change({ ops } as Partial<Change>))).toBeCloseTo(1.2);
  });

  it("adds up the joins left out near the edit when the steps say nothing about it", () => {
    const leftOut = {
      joins: [
        { at: 10.3, removed: { start: 30, end: 31 } },
        { at: 13.9, removed: { start: 40, end: 40.5 } },
        { at: 10.1, removed: { start: 50, end: 50 } },
        { at: 30, removed: { start: 60, end: 65 } },
      ],
    };
    expect(cutRemovedSeconds(edit({ kind: "cut" }), change({ ops: [{ op: "rippleDelete", start: 90, end: 95 }], leftOut } as unknown as Partial<Change>))).toBeCloseTo(1.5);
    expect(cutRemovedSeconds(edit({ kind: "cut", range: { start: 80, end: 80 } }), change({ leftOut } as unknown as Partial<Change>))).toBeUndefined();
  });

  it("matches a cut reason by its summary or reason, or takes the only one there is", () => {
    const cutReasons = [
      { start: 1, end: 3, summary: "Trimmed the false start", reason: "Stumbled twice" },
      { start: 5, end: 5.4, summary: "Breath", reason: "Long breath" },
      { start: 7, end: 7, summary: "Empty", reason: "Nothing" },
    ];
    const withReasons = change({ cutReasons } as unknown as Partial<Change>);
    expect(cutRemovedSeconds(edit({ kind: "cut", label: "Trimmed the false start" }), withReasons)).toBe(2);
    expect(cutRemovedSeconds(edit({ kind: "cut", label: "Row", summary: "Something", reason: "Long breath" }), withReasons)).toBeCloseTo(0.4);
    // Two matches can't tell which one it was.
    expect(cutRemovedSeconds(edit({ kind: "cut", label: "x", reason: "Stumbled twice", summary: "Breath" }), withReasons)).toBeUndefined();
    expect(cutRemovedSeconds(edit({ kind: "cut", label: "Unrelated" }), change({ cutReasons: [{ start: 4, end: 6.5, summary: "Other", reason: "Other reason" }] } as unknown as Partial<Change>))).toBe(2.5);
    expect(cutRemovedSeconds(edit({ kind: "cut", label: "Unrelated" }), change({ cutReasons: [{ start: 4, end: 4, summary: "Other", reason: "Other reason" }] } as unknown as Partial<Change>))).toBeUndefined();
  });
});

describe("editRowTooltip", () => {
  it("says a put back and an insert by how much they added, from the gaps the change opened when the edit has no length", () => {
    const gaps = change({ ops: [
      { op: "rippleInsertGap", at: 10, duration: 2.4 },
      { op: "rippleInsertGap", at: 10, duration: 0 },
      { op: "rippleInsertGap", at: 90, duration: 5 },
      { op: "rippleDelete", start: 0, end: 1 },
    ] } as Partial<Change>);
    expect(editRowTooltip(edit({ label: "Restored laugh", kind: "restore", range: { start: 9, end: 9 } }), { change: gaps })).toEqual({
      tip: "Restored laugh",
      meta: "Put back · +2.4 s",
    });
    expect(editRowTooltip(edit({ label: "Restored laugh", kind: "restore", rejected: true, range: { start: 9, end: 9 } }))).toEqual({
      tip: "Restored laugh",
      meta: "Rejected put back",
    });
    expect(editRowTooltip(edit({ label: "Restored laugh", kind: "restore", range: { start: 50, end: 50 } }), { change: gaps })).toEqual({
      tip: "Restored laugh",
      meta: "Put back",
    });
  });

  it("names an inserted file from the clip the change added, by its label or a helpful file name", () => {
    const added = (clip: Record<string, unknown>) => change({ ops: [
      { op: "rippleInsertGap", at: 10, duration: 4 },
      { op: "addClip", trackId: "trk_v1" },
      { op: "addClip", trackId: "trk_c1", clip: { id: "cap", kind: "caption", timelineIn: 10, timelineOut: 14, text: "Hi" } },
      { op: "addClip", trackId: "trk_v1", clip: mediaClip({ id: "far", mediaId: "med_broll", timelineIn: 80 }) },
      { op: "addClip", trackId: "trk_v1", clip },
    ] } as Partial<Change>);
    const row = edit({ label: "Insert demo", kind: "insert", range: { start: 10, end: 10 } });
    expect(editRowTooltip(row, { change: added(mediaClip({ id: "c1", label: " Product demo " })), media }).meta).toBe("Inserted Product demo · +4.0 s");
    expect(editRowTooltip(row, { change: added(mediaClip({ id: "c1", mediaId: "med_broll" })), media }).meta).toBe("Inserted city-skyline · +4.0 s");
    // A camera's own file name says nothing, and nor does a file that isn't in the project.
    expect(editRowTooltip(row, { change: added(mediaClip({ id: "c1", mediaId: "med_raw" })), media }).meta).toBe("Insert · +4.0 s");
    expect(editRowTooltip(row, { change: added(mediaClip({ id: "c1", mediaId: "med_gone" })), media }).meta).toBe("Insert · +4.0 s");
    expect(editRowTooltip({ ...row, rejected: true }, { change: added(mediaClip({ id: "c1", mediaId: "med_broll" })), media }).meta).toBe("Rejected · Inserted city-skyline · +4.0 s");
  });

  it("names an inserted file from the main track's clip that lines up with the edit, passing over other clips", () => {
    const timeline = timelineOf(
      { id: "trk_c1", kind: "caption", clips: [{ id: "cap", kind: "caption", timelineIn: 20, timelineOut: 24, text: "Hi" }] },
      mainTrack(
        { id: "col", kind: "color", color: "#000", timelineIn: 20, timelineOut: 24 },
        mediaClip({ id: "raw", mediaId: "med_raw", timelineIn: 20 }),
        mediaClip({ id: "named", label: "Screen demo", timelineIn: 20 }),
      ),
    );
    expect(editRowTooltip(edit({ label: "Insert", kind: "insert", range: { start: 20, end: 24 } }), { timeline, media }).meta).toBe("Inserted Screen demo · +4.0 s");
    expect(editRowTooltip(edit({ label: "Insert", kind: "insert", range: { start: 30, end: 34 } }), { timeline, media }).meta).toBe("Insert · +4.0 s");
    expect(editRowTooltip(edit({ label: "Insert", kind: "insert", range: { start: 30, end: 30 } }), { timeline: timelineOf({ id: "trk_a1", kind: "audio", clips: [] }) })).toEqual({ tip: "Insert", meta: "Insert" });
  });

  it("says a marker is to do and a spot Scarlet only flagged needs a look, with how many places and the row's status", () => {
    expect(editRowTooltip(edit({ label: "Check the slide", onlyCheck: true, check: "Is the slide readable?" }), { places: 3, status: "Waiting" })).toEqual({
      tip: "Check the slide",
      meta: "Needs a look · in 3 places · Waiting",
      detail: "Is the slide readable?",
    });
    // One place says nothing, and Rejected is said by the row's own words.
    expect(editRowTooltip(edit({ label: "Check the slide", onlyCheck: true }), { places: 1, status: "Rejected" })).toEqual({ tip: "Check the slide", meta: "Needs a look" });
    // A marker whose to-do is its own label has no line underneath.
    expect(editRowTooltip(edit({ label: "Find a cutaway.", marker: true, todo: "find a  cutaway" }))).toEqual({ tip: "Find a cutaway.", meta: "To do" });
  });

  it("prefers what the review says over the bare check while it waits, and drops a revision's or a finished row's check", () => {
    const row = edit({ label: "Tightened", kind: "cut", check: "Listen at the join", reviewSays: "The breath might clip", reason: "Long breath", beforeCut: { version: "v1", removed: { start: 10, end: 11 } } });
    expect(editRowTooltip(row).detail).toBe("The breath might clip");
    expect(editRowTooltip(row, { status: "Done" })).toEqual({ tip: "Tightened", meta: "Cut · −1.0 s · Done", detail: "Long breath" });
    expect(editRowTooltip({ ...row, check: "Revised", reviewSays: undefined }).detail).toBe("Long breath");
    expect(editRowTooltip({ ...row, rejected: true }).meta).toBe("Rejected cut · −1.0 s");
    // A reason is the title when there's a summary, so it is never repeated underneath.
    expect(editRowTooltip(edit({ label: "Row", summary: "Cut the aside", reason: "Cut the aside." }))).toEqual({ tip: "Cut the aside", meta: "Lasts 4.0 s" });
    // A reason of only spaces still makes the summary the title, and says nothing underneath.
    expect(editRowTooltip(edit({ label: "Row", summary: "Cut the aside", reason: "  " }))).toEqual({ tip: "Cut the aside", meta: "Lasts 4.0 s" });
  });

  it("names the kind of edit with its length when nothing more can be read, and nothing for a point with no kind", () => {
    expect(editRowTooltip(edit({ label: "Zoom", kind: "zoom" }))).toEqual({ tip: "Zoom", meta: "Zoom · 4.0 s" });
    expect(editRowTooltip(edit({ label: "Fade", kind: "transition" }))).toEqual({ tip: "Fade", meta: "Transition" });
    expect(editRowTooltip(edit({ label: "Look", kind: "zoom", rejected: true, range: { start: 10, end: 10.01 } }))).toEqual({ tip: "Look", meta: "Rejected · Zoom" });
    expect(editRowTooltip(edit({ label: "Assembly" }))).toEqual({ tip: "Assembly", meta: "Lasts 4.0 s" });
    expect(editRowTooltip(edit({ label: "Assembly", range: { start: 10, end: 10 } }))).toEqual({ tip: "Assembly" });
    // A range written backwards has no length.
    expect(editRowTooltip(edit({ label: "Odd", range: { start: 14, end: 10 } }))).toEqual({ tip: "Odd" });
  });

  describe("reading what the change's steps did", () => {
    const timeline = timelineOf(
      mainTrack(mediaClip()),
      { id: "trk_a1", kind: "audio", name: "Music", clips: [mediaClip({ id: "clp_music", mediaId: "med_music" })] },
    );
    const ctx = (c: Change) => ({ change: c, timeline, media });

    it("says a zoom out, a zoom between two scales and a reframe's scale in plain words", () => {
      const keyed = (kind: "zoom" | "reframe", from: number, to: number) => editRowTooltip(edit({ label: "Move", kind }),
        ctx(update("clp_main", { keyframes: [{ time: 0, transform: { scale: from } }, { time: 4, transform: { scale: to } }] })));
      expect(keyed("zoom", 1.3, 1).meta).toBe("Zooms out to 100%");
      expect(keyed("zoom", 1.2, 1.5).meta).toBe("Zooms 120% to 150%");
      expect(keyed("reframe", 1, 0.5).meta).toBe("Scales to 50%");
      expect(editRowTooltip(edit({ label: "Zoom", kind: "zoom" }), ctx(update("clp_main", { opacity: 0.5 }))).meta).toBe("Zoom · Interview at 50% opacity");
      expect(editRowTooltip(edit({ label: "Frame", kind: "reframe" }), ctx(update("clp_main", { opacity: 0.5 }))).meta).toBe("Reframe · Interview at 50% opacity");
    });

    it("says a speed change as faster, slower or normal", () => {
      const speed = (rate: unknown) => editRowTooltip(edit({ label: "Speed", kind: "speed" }), ctx(update("clp_main", { speed: rate }))).meta;
      expect(speed(0.5)).toBe("0.5× slower");
      expect(speed(1)).toBe("Normal speed · 4.0 s");
      expect(editRowTooltip(edit({ label: "Speed", kind: "speed" }), ctx(update("clp_main", { opacity: 0.25 }))).meta).toBe("Speed · Interview at 25% opacity");
    });

    it("says a transition without a length, and leaves words that already say transition alone", () => {
      expect(editRowTooltip(edit({ label: "Dissolve", kind: "transition" }), ctx(update("clp_main", { transitionIn: { type: "dissolve" } }))).meta).toBe("Dissolve transition");
      expect(editRowTooltip(edit({ label: "Slide", kind: "transition" }), ctx(update("clp_main", { transitionIn: { type: "slide" } }))).meta).toBe("Slide left transition");
      expect(editRowTooltip(edit({ label: "Words", kind: "transition" }), ctx(update("clp_main", { text: "A smooth transition" }))).meta).toBe("“A smooth transition”");
    });

    it("quotes a caption the change added, with how long it lasts", () => {
      const caption = change({ ops: [{ op: "addClip", trackId: "trk_c1", clip: { id: "cap", kind: "caption", timelineIn: 10, timelineOut: 14, text: "Hello · there" } }] } as Partial<Change>);
      expect(editRowTooltip(edit({ label: "Caption", kind: "text" }), ctx(caption)).meta).toBe("Caption: “Hello · 4.0 s");
    });

    it("says a voice cleanup's mix in brackets", () => {
      expect(editRowTooltip(edit({ label: "Clean", kind: "voice" }), ctx(update("clp_main", { effects: [{ type: "voiceCleanup", params: { mix: 0.4 } }] }))).meta).toBe("Voice cleanup on Interview (40%)");
    });

    it("says a sound's level as lowered, raised, louder, quieter, muted or full volume", () => {
      const audio = (patch: Record<string, unknown>, clipId = "clp_music") => editRowTooltip(edit({ label: "Sound", kind: "audio" }), ctx(update(clipId, patch))).meta;
      expect(audio({ volume: 2 })).toBe("Audio · Warm bed louder (+6 dB)");
      expect(audio({ volume: 1.01 })).toBe("Audio · Warm bed at full volume · 4.0 s");
      expect(audio({ volume: 0 }, "clp_gone")).toBe("Audio · Muted · 4.0 s");
      expect(audio({ volume: 0.5 }, "clp_gone")).toBe("Audio · quieter (−6 dB)");
      expect(audio({ volumeKeyframes: [{ time: 0, db: 0 }, { time: 1, db: 6 }, { time: 2, db: 0 }] })).toBe("Audio · Warm bed raised to +6 dB");
      expect(audio({ volumeKeyframes: [{ time: 0, db: -12 }] }, "clp_gone")).toBe("Audio · lowered to −12 dB");
      expect(editRowTooltip(edit({ label: "Dip", kind: "dip" }), ctx(update("clp_music", { volumeKeyframes: [{ time: 0, db: -6 }, { time: 1, db: 0 }, { time: 2, db: -6 }] }))).meta)
        .toBe("Music dip · Warm bed lowered to −6 dB");
      expect(audio({ volumeKeyframes: [] })).toBe("Audio · Warm bed back to a steady level · 4.0 s");
    });

    it("says a sound file the change added to an audio track, at its level", () => {
      const added = (volume?: number, mediaId = "med_music") => editRowTooltip(edit({ label: "Music", kind: "audio" }), ctx(change({ ops: [
        { op: "addClip", trackId: "trk_a1", clip: mediaClip({ id: "new", mediaId, ...(volume !== undefined && { volume }) }) },
      ] } as Partial<Change>))).meta;
      expect(added()).toBe("Audio · Added Warm bed · 4.0 s");
      expect(added(0)).toBe("Audio · Added Warm bed (muted) · 4.0 s");
      expect(added(1.01)).toBe("Audio · Added Warm bed · 4.0 s");
      expect(added(0, "med_raw")).toBe("Audio · Added sound (muted) · 4.0 s");
    });

    // Bug: humanizeDetail's "Sound −6 dB" pattern runs before the "Added …, −6 dB" one and swallows it, so the comma stays and the added branch never runs.
    it.fails("says a sound file the change added at a set level in brackets", () => {
      expect(editRowTooltip(edit({ label: "Music", kind: "audio" }), ctx(change({ ops: [
        { op: "addClip", trackId: "trk_a1", clip: mediaClip({ id: "new", mediaId: "med_music", volume: 0.5 }) },
      ] } as Partial<Change>))).meta).toBe("Audio · Added Warm bed (−6 dB)");
    });

    it("says an overlay's opacity in brackets and reads a b-roll as an overlay", () => {
      const timelineWithOverlay = timelineOf(mainTrack(), { id: "trk_v2", kind: "video", clips: [mediaClip({ id: "clp_o", mediaId: "med_broll" })] });
      expect(editRowTooltip(edit({ label: "Over", kind: "overlay" }), { change: update("clp_o", { opacity: 0.5 }), timeline: timelineWithOverlay, media }).meta)
        .toBe("Overlay · city-skyline (50% opacity)");
      expect(editRowTooltip(edit({ label: "Broll", kind: "broll" }), { change: update("clp_o", { opacity: 0.5 }), timeline: timelineWithOverlay, media }).meta)
        .toBe("B-roll · city-skyline (50% opacity) · 4.0 s");
    });
  });

  describe("reading the timeline when the change has no steps to read", () => {
    it("reads nothing without a timeline", () => {
      expect(editRowTooltip(edit({ label: "Music", kind: "audio" }), { media })).toEqual({ tip: "Music", meta: "Audio · 4.0 s" });
    });

    it("says how an audio clip's keyframes move its level, on top of its own volume", () => {
      const audio = (clip: Record<string, unknown>, kind: "audio" | "dip" = "audio") => editRowTooltip(edit({ label: "Sound", kind }), {
        timeline: timelineOf(mainTrack(), { id: "trk_a1", kind: "audio", clips: [
          { id: "cap", kind: "caption", timelineIn: 10, timelineOut: 14, text: "x" },
          mediaClip({ id: "far", mediaId: "med_music", timelineIn: 60 }),
          mediaClip({ id: "clp_music", mediaId: "med_music", ...clip }),
        ] }),
        media,
      }).meta;
      expect(audio({ volume: 0.5, volumeKeyframes: [{ time: 2, db: 0 }, { time: 1, db: -12 }, { time: 3, db: -12 }, { db: 40 }] }, "dip")).toBe("Music dip · Warm bed lowered to −18 dB");
      expect(audio({ volumeKeyframes: [{ time: 0, db: 0 }, { time: 1, db: 3 }] })).toBe("Audio · Warm bed raised to +3 dB");
      expect(audio({ volume: 0, volumeKeyframes: [{ time: 0, db: 0 }, { time: 1, db: 0 }] })).toBe("Audio · Warm bed muted · 4.0 s");
      expect(audio({ mediaId: "med_raw", volume: 2, volumeKeyframes: "loud" })).toBe("Audio · louder (+6 dB)");
      expect(audio({ mediaId: "med_raw", volumeKeyframes: [{ time: 0, db: -6 }, { time: 1, db: 0 }, { time: 2, db: -6 }] })).toBe("Audio · lowered to −6 dB");
      expect(audio({ volume: 1.01 })).toBe("Audio · Warm bed at full volume · 4.0 s");
      expect(audio({})).toBe("Audio · Warm bed · 4.0 s");
      expect(audio({ mediaId: "med_raw" })).toBe("Audio · 4.0 s");
      expect(audio({ mediaId: "med_raw", volumeKeyframes: [{ time: 0, db: 0 }] })).toBe("Audio · 4.0 s");
      // Keys without a time or level move nothing; a dip back to the clip's own raised level reads as 0 dB.
      expect(audio({ mediaId: "med_raw", volumeKeyframes: [{ db: -6 }, { time: 1 }, null] })).toBe("Audio · 4.0 s");
      expect(audio({ volume: 2, volumeKeyframes: [{ time: 0, db: -6 }] })).toBe("Audio · Warm bed lowered to 0 dB");
      expect(audio({ mediaId: "med_gone" })).toBe("Audio · 4.0 s");
    });

    it("finds the voice cleanup on a clip under the edit, its mix and the clip's name", () => {
      const voice = (clip: Record<string, unknown>) => editRowTooltip(edit({ label: "Clean", kind: "voice" }), {
        timeline: timelineOf(mainTrack(
          { id: "cap", kind: "caption", timelineIn: 10, timelineOut: 14, text: "x" },
          mediaClip({ id: "off", effects: [{ type: "voiceCleanup", enabled: false, params: { mix: 0.2 } }] }),
          mediaClip({ id: "plain" }),
          mediaClip(clip),
        )),
        media,
      }).meta;
      expect(voice({ label: "Host", effects: [{ type: "voiceCleanup", params: { mix: -0.5 } }] })).toBe("Voice cleanup on Host (0%)");
      expect(voice({ mediaId: "med_raw", effects: [{ type: "eq" }, { type: "voiceCleanup" }] })).toBe("Voice cleanup · 4.0 s");
      expect(voice({ effects: [{ type: "voiceCleanup", params: { mix: 1 } }] })).toBe("Voice cleanup on Interview · 4.0 s");
    });

    it("finds the clip over the main picture for a b-roll, graphic or overlay", () => {
      const over = (kind: "broll" | "graphic" | "overlay", clip: Record<string, unknown>) => editRowTooltip(edit({ label: "Over", kind }), {
        timeline: timelineOf(mainTrack(), { id: "trk_a1", kind: "audio", clips: [mediaClip({ id: "music", mediaId: "med_music" })] },
          { id: "trk_v2", kind: "video", clips: [mediaClip({ id: "early", timelineIn: 0, sourceOut: 2 }), mediaClip({ id: "raw", mediaId: "med_raw" }), clip] }),
        media,
      }).meta;
      expect(over("graphic", { id: "card", kind: "color", color: "#111", timelineIn: 10, timelineOut: 14 })).toBe("Graphic · A colour card · 4.0 s");
      expect(over("overlay", mediaClip({ id: "o", mediaId: "med_broll", opacity: 0.4 }))).toBe("Overlay · city-skyline (40% opacity)");
      expect(over("broll", mediaClip({ id: "o", mediaId: "med_broll", opacity: 1 }))).toBe("B-roll · city-skyline · 4.0 s");
      expect(over("overlay", mediaClip({ id: "o", mediaId: "med_raw" }))).toBe("Overlay · 4.0 s");
    });

    it("reads a zoom or reframe from a clip's keyframes or its still transform", () => {
      const look = (kind: "zoom" | "reframe", clip: Record<string, unknown>) => editRowTooltip(edit({ label: "Look", kind }), {
        timeline: timelineOf({ id: "trk_a1", kind: "audio", clips: [] }, mainTrack({ id: "col", kind: "color", color: "#000", timelineIn: 10, timelineOut: 14 }, mediaClip(clip))),
        media,
      }).meta;
      const keys = (...scales: number[]) => ({ keyframes: scales.map((scale, i) => ({ time: i, transform: { scale } })) });
      expect(look("zoom", keys(1, 1.25))).toBe("Zooms in to 125%");
      expect(look("reframe", keys(1, 0.6))).toBe("Scales to 60%");
      // Keyframes that end where they began, or go the other way for the kind, say nothing of the move.
      expect(look("zoom", { ...keys(1, 1.5, 1), transform: { scale: 1.2 } })).toBe("Zoom to 120%");
      expect(look("reframe", keys(1, 1.4))).toBe("Reframe · 4.0 s");
      expect(look("zoom", keys(1, 0.8))).toBe("Zoom · 4.0 s");
      expect(look("zoom", { keyframes: [{ time: 0 }, { time: 1, transform: { x: 1 } }], transform: { scale: 1 } })).toBe("Zoom · 4.0 s");
      expect(look("reframe", { transform: { scale: 0.5 } })).toBe("Inset at 50%");
      expect(look("reframe", { transform: { cropLeft: 0.1, x: 0.2 } })).toBe("Cropped & repositioned · 4.0 s");
      expect(look("reframe", { transform: { cropBottom: 0.1 } })).toBe("Cropped · 4.0 s");
      expect(look("reframe", { transform: { y: -0.1 } })).toBe("Repositioned · 4.0 s");
      expect(look("reframe", { transform: { x: 0.001, cropTop: 0, cropRight: 0 } })).toBe("Reframe · 4.0 s");
    });

    it("reads a clip's speed, the transition into the clip at the edit, and a split edit's lead", () => {
      const at = (kind: "speed" | "transition" | "split", clips: Record<string, unknown>[], range = { start: 10, end: 14 }) =>
        editRowTooltip(edit({ label: "Edit", kind, range }), { timeline: timelineOf({ id: "trk_a1", kind: "audio", clips: [] }, mainTrack(...clips)), media, fps: 30 }).meta;
      expect(at("speed", [mediaClip({ speed: 0.5, sourceOut: 2 })])).toBe("0.5× slower");
      expect(at("speed", [mediaClip({ speed: 1.005 })])).toBe("Speed · 4.0 s");
      expect(at("transition", [mediaClip({ id: "a", timelineIn: 0, sourceOut: 10 }), mediaClip({ transitionIn: { type: "whip", direction: "up", duration: 0.25 } })], { start: 10, end: 10 }))
        .toBe("Whip up transition · 0.3 s");
      expect(at("transition", [mediaClip({ transitionIn: { duration: 0.5 } })], { start: 10, end: 10 })).toBe("Transition");
      expect(at("transition", [mediaClip({ transitionIn: { type: "push", duration: 0.5 } })], { start: 10, end: 10 })).toBe("Push left transition · 0.5 s");
      expect(at("transition", [mediaClip({ transitionIn: { type: "fade" } })], { start: 10.2, end: 10.2 })).toBe("Fade transition");
      expect(at("split", [mediaClip({ splitEdit: { trails: 0.5 } })])).toBe("Split edit · Sound carries 15 frames past the cut");
      expect(at("split", [mediaClip({ splitEdit: {} })])).toBe("Split edit · 4.0 s");
    });

    it("reads an unclassified edit as the caption, sound or overlay that lines up with it exactly", () => {
      const other = (tracks: Track[], range = { start: 10, end: 14 }) => editRowTooltip(edit({ label: "Saved", kind: "other", range }), { timeline: timelineOf(mainTrack(), ...tracks), media });
      expect(other([{ id: "trk_v2", kind: "video", clips: [{ id: "c", kind: "color", color: "#fff", timelineIn: 10, timelineOut: 14 }] }])).toEqual({ tip: "Saved", meta: "Overlay · A colour card · 4.0 s" });
      expect(other([{ id: "trk_v2", kind: "video", clips: [mediaClip({ id: "o", mediaId: "med_broll" })] }])).toEqual({ tip: "Saved", meta: "Overlay · city-skyline · 4.0 s" });
      expect(other([{ id: "trk_v2", kind: "video", clips: [mediaClip({ id: "o", mediaId: "med_raw" })] }])).toEqual({ tip: "Saved", meta: "Lasts 4.0 s" });
      expect(other([{ id: "trk_a1", kind: "audio", clips: [mediaClip({ id: "m", mediaId: "med_music", volumeKeyframes: [{ time: 0, db: -9 }] })] }])).toEqual({ tip: "Saved", meta: "Audio · Warm bed lowered to −9 dB" });
      expect(other([{ id: "trk_a1", kind: "audio", clips: [mediaClip({ id: "m", mediaId: "med_raw", volume: 0.5 })] }])).toEqual({ tip: "Saved", meta: "Audio · quieter (−6 dB)" });
      expect(other([{ id: "trk_a1", kind: "audio", clips: [mediaClip({ id: "m", mediaId: "med_raw", volumeKeyframes: [{ time: 0, db: 4 }] })] }])).toEqual({ tip: "Saved", meta: "Audio · raised to +4 dB" });
      expect(other([{ id: "trk_a1", kind: "audio", clips: [mediaClip({ id: "m", label: "Theme", volume: 0 })] }])).toEqual({ tip: "Saved", meta: "Audio · Theme muted · 4.0 s" });
      expect(other([{ id: "trk_a1", kind: "audio", clips: [mediaClip({ id: "m", mediaId: "med_raw" })] }])).toEqual({ tip: "Saved", meta: "Lasts 4.0 s" });
      // A caption of only spaces quotes nothing; one that doesn't line up isn't this edit's.
      expect(other([{ id: "trk_c1", kind: "caption", clips: [{ id: "cap", kind: "caption", timelineIn: 10, timelineOut: 14, text: "   " }] }])).toEqual({ tip: "Saved", meta: "Lasts 4.0 s" });
      expect(other([{ id: "trk_c1", kind: "caption", clips: [{ id: "cap", kind: "caption", timelineIn: 10, timelineOut: 12, text: "Hi" }] }])).toEqual({ tip: "Saved", meta: "Lasts 4.0 s" });
    });

    it("cuts a long caption short and quotes nothing for an empty one", () => {
      const long = "word ".repeat(30);
      const caption = (text: string) => editRowTooltip(edit({ label: "Caption", kind: "text" }), {
        timeline: timelineOf(mainTrack(), { id: "trk_c1", kind: "caption", clips: [{ id: "cap", kind: "caption", timelineIn: 10, timelineOut: 14, text }] }),
      }).meta;
      expect(caption(long)).toBe(`Caption: “${"word ".repeat(12)}wor…” · 4.0 s`);
      expect(caption(" ")).toBe("Caption · 4.0 s");
    });
  });
});

describe("changeForEdit", () => {
  it("finds the change among the thread's changes, then its flagged ones", () => {
    const thread = { changes: [change({ id: "a" } as Partial<Change>)], flagged: [change({ id: "b" } as Partial<Change>)] } as unknown as Pick<Thread, "changes" | "flagged">;
    expect(changeForEdit(thread, "a")?.id).toBe("a");
    expect(changeForEdit(thread, "b")?.id).toBe("b");
    expect(changeForEdit(thread, "c")).toBeUndefined();
    expect(changeForEdit({ changes: [] } as unknown as Pick<Thread, "changes" | "flagged">, "c")).toBeUndefined();
    expect(changeForEdit(undefined, "a")).toBeUndefined();
  });
});

describe("callRowTooltip", () => {
  it("says a cut by its tag when it has no length, and a call's own word while open", () => {
    expect(callRowTooltip({ summary: "Pause", tag: "−0.8 s", state: "open", version: 1, word: "Needs your answer", reason: "pause." })).toEqual({
      tip: "Pause",
      meta: "Cut · −0.8 s · Needs your answer",
    });
    expect(callRowTooltip({ summary: "Pause", tag: "Cut", length: 0, state: "skipped", version: 1 })).toEqual({ tip: "Pause", meta: "Cut · Rejected" });
    expect(callRowTooltip({ summary: "Laugh", tag: "Check", state: "revising", version: 2, earlier: {} })).toEqual({
      tip: "Laugh",
      meta: "Keep",
      detail: "Earlier: Scarlet’s earlier version.",
    });
  });
});

describe("decidedCallRowTooltip", () => {
  it("leaves out a missing length and a note that only repeats the label", () => {
    expect(decidedCallRowTooltip({ label: "Aside", note: "aside.", approved: true })).toEqual({ tip: "Aside", meta: "Kept cut" });
  });
});

describe("momentRowTooltip", () => {
  it("names up to three distinct kinds once, adds the status, and lists members only when there are several", () => {
    expect(momentRowTooltip("Moment", [
      { label: "A", kind: "Zoom" }, { label: "B", kind: "Zoom" }, { label: "C", value: "Edit" },
      { label: "D", kind: "Audio" }, { label: "E", kind: "Text" }, { label: "F", kind: "Speed" },
    ], undefined, "Kept")).toEqual({
      tip: "Moment",
      meta: "6 edits · Zoom, Audio, Text · Kept",
      detail: "A\nB\nC\nD\nE\nF",
    });
    expect(momentRowTooltip("Alone", [{ label: "A", value: "Edit" }])).toEqual({ tip: "Alone", meta: "1 edits" });
    expect(momentRowTooltip("Empty", [])).toEqual({ tip: "Empty", meta: "0 edits" });
  });
});
