import { describe, expect, it } from "vitest";
import type { Change, Timeline } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
import { callRowTooltip, cutRemovedSeconds, decidedCallRowTooltip, editRowTooltip, momentRowTooltip } from "./editRowTooltip";

const media = [
  { id: "med_main", name: "Interview.mov" },
  { id: "med_music", name: "Warm bed.wav" },
  { id: "med_broll", name: "city-skyline.mp4" },
  { id: "med_gfx", name: "opus-title.mov" },
  { id: "med_demo", name: "screen-demo.mp4" },
  { id: "med_riemann", name: "Riemann’s 1859 paper and the primes.mov" },
];

const timeline = {
  version: "v3",
  tracks: [
    {
      id: "trk_v1", kind: "video", name: "Main", clips: [
        { id: "clp_main", kind: "media", mediaId: "med_main", timelineIn: 0, sourceIn: 0, sourceOut: 60, speed: 1 },
        { id: "clp_demo", kind: "media", mediaId: "med_demo", timelineIn: 20, sourceIn: 0, sourceOut: 4, speed: 1 },
      ],
    },
    {
      id: "trk_v2", kind: "video", name: "Overlay", clips: [
        { id: "clp_gfx", kind: "media", mediaId: "med_gfx", timelineIn: 2, sourceIn: 0, sourceOut: 3, speed: 1, opacity: 1 },
      ],
    },
    {
      id: "trk_a1", kind: "audio", name: "Music", clips: [
        { id: "clp_music", kind: "media", mediaId: "med_music", timelineIn: 0, sourceIn: 0, sourceOut: 16, speed: 1, volume: 0.2 },
      ],
    },
    {
      id: "trk_c1", kind: "caption", name: "Captions", clips: [
        { id: "cap_1", kind: "caption", timelineIn: 0.2, timelineOut: 2.4, text: "Welcome back" },
      ],
    },
  ],
} as unknown as Timeline;

const edit = (over: Partial<Omit<ThreadEdit, "at">> = {}): Omit<ThreadEdit, "at"> => ({
  changeId: "chg_1",
  spot: 0,
  label: "Edit",
  range: { start: 10, end: 14 },
  previous: [],
  ...over,
});

const change = (over: Partial<Change> = {}): Change => ({ id: "chg_1", ...over } as Change);

describe("editRowTooltip", () => {
  it("shows cut amount from beforeCut, and recovers it from rippleDelete ops when beforeCut is absent", () => {
    const withBefore = editRowTooltip(edit({
      label: "Trimmed the wait after “but”",
      kind: "cut",
      range: { start: 253, end: 253 },
      beforeCut: { version: "v1", removed: { start: 253, end: 254.8 } },
    }));
    expect(withBefore).toEqual({
      tip: "Trimmed the wait after “but”",
      meta: "Cut · −1.8 s",
    });

    const fromOps = editRowTooltip(
      edit({ label: "Trimmed the wait after “but”", kind: "cut", range: { start: 253, end: 253 } }),
      { change: change({ ops: [{ op: "rippleDelete", start: 253, end: 254.8 }] }) },
    );
    expect(fromOps).toEqual({
      tip: "Trimmed the wait after “but”",
      meta: "Cut · −1.8 s",
    });
    expect(cutRemovedSeconds(edit({ kind: "cut", range: { start: 253, end: 253 } }), change({ ops: [{ op: "rippleDelete", start: 253, end: 254.8 }] }))).toBeCloseTo(1.8);
  });

  it("shows concise plain-English details without clip filenames or redundant timestamps across edit kinds", () => {
    expect(editRowTooltip(edit({ label: "Punch in on keynote", kind: "zoom" }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_main", patch: { transform: { scale: 1.4 } } }] }),
      timeline, media,
    })).toEqual({
      tip: "Punch in on keynote",
      meta: "Zoom to 140%",
    });

    expect(editRowTooltip(edit({ label: "Slow zoom in", kind: "zoom" }), {
      change: change({
        ops: [{ op: "updateClip", clipId: "clp_main", patch: { keyframes: [{ time: 0, transform: { scale: 1 } }, { time: 4, transform: { scale: 1.3 } }] } }],
      }),
      timeline, media,
    })).toEqual({
      tip: "Slow zoom in",
      meta: "Zooms in to 130%",
    });

    expect(editRowTooltip(edit({ label: "Picture-in-picture inset", kind: "reframe" }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_main", patch: { transform: { scale: 0.3 } } }] }),
      timeline, media,
    })).toEqual({
      tip: "Picture-in-picture inset",
      meta: "Inset at 30%",
    });

    expect(editRowTooltip(edit({ label: "Lower music bed", kind: "audio", range: { start: 0, end: 16 } }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_music", patch: { volume: 0.5 } }] }),
      timeline, media,
    })).toEqual({
      tip: "Lower music bed",
      meta: "Audio · quieter (−6 dB)",
    });

    expect(editRowTooltip(edit({ label: "Duck music under speech", kind: "dip", range: { start: 0, end: 16 } }), {
      change: change({
        ops: [{
          op: "updateClip", clipId: "clp_music", patch: {
            volumeKeyframes: [
              { time: 1, db: 0, ease: "linear" },
              { time: 1.3, db: -18, ease: "linear" },
              { time: 4, db: 0, ease: "linear" },
            ],
          },
        }],
      }),
      timeline, media,
    }).meta).toContain("Music dip · lowered to");

    expect(editRowTooltip(edit({ label: "Clean room noise", kind: "voice", range: { start: 0, end: 16 } }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_main", patch: { effects: [{ type: "voiceCleanup", params: { mix: 0.6 }, enabled: true }] } }] }),
      timeline, media,
    })).toEqual({
      tip: "Clean room noise",
      meta: "Voice cleanup (60%)",
    });

    expect(editRowTooltip(edit({ label: "Speed up setup", kind: "speed" }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_main", patch: { speed: 1.5 } }] }),
      timeline, media,
    })).toEqual({
      tip: "Speed up setup",
      meta: "1.5× faster",
    });

    expect(editRowTooltip(edit({ label: "Push into demo", kind: "transition", range: { start: 10, end: 10 } }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_main", patch: { transitionIn: { type: "push", duration: 0.4, direction: "right" } } }] }),
      timeline, media,
    })).toEqual({
      tip: "Push into demo",
      meta: "Push right transition · 0.4 s",
    });

    expect(editRowTooltip(edit({ label: "J-cut into answer", kind: "split", range: { start: 11.76, end: 12 } }), {
      change: change({ ops: [{ op: "updateClip", clipId: "clp_main", patch: { splitEdit: { leads: 0.24 } } }] }),
      timeline, media, fps: 25,
    })).toEqual({
      tip: "J-cut into answer",
      meta: "Split edit · Sound leads by 6 frames",
    });

    expect(editRowTooltip(edit({ label: "Opening caption", kind: "text", range: { start: 0.2, end: 2.4 } }), {
      timeline, media,
    })).toEqual({
      tip: "Opening caption",
      meta: "Caption: “Welcome back” · 2.2 s",
    });

    // Skip duplicating the caption quote when the title already includes it.
    expect(editRowTooltip(edit({ label: "Added caption “Welcome back”", kind: "text", range: { start: 0.2, end: 2.4 } }), {
      timeline, media,
    })).toEqual({
      tip: "Added caption “Welcome back”",
      meta: "Caption · 2.2 s",
    });

    expect(editRowTooltip(edit({ label: "Add skyline cutaway", kind: "broll" }), {
      change: change({ ops: [{ op: "addClip", trackId: "trk_v2", clip: { id: "c1", kind: "media", mediaId: "med_broll", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } }] }),
      timeline, media,
    })).toEqual({
      tip: "Add skyline cutaway",
      meta: "B-roll · 4.0 s",
    });

    expect(editRowTooltip(edit({ label: "Hold Opus title", kind: "graphic", range: { start: 2, end: 5 } }), {
      timeline, media,
    })).toEqual({
      tip: "Hold Opus title",
      meta: "Graphic · 3.0 s",
    });

    expect(editRowTooltip(edit({ label: "Insert screen recording", kind: "insert", range: { start: 20, end: 24 } }), {
      timeline, media,
    })).toEqual({
      tip: "Insert screen recording",
      meta: "Insert · +4.0 s",
    });

    expect(editRowTooltip(edit({ label: "Restored laugh", kind: "restore", range: { start: 10, end: 12.4 } }))).toEqual({
      tip: "Restored laugh",
      meta: "Put back · +2.4 s",
    });
  });

  it("omits duplicate clip filenames and stale rationale on revising overlays while naming the active model cleanly", () => {
    const revisingOverlay = editRowTooltip(edit({
      label: "Added Riemann’s portrait and 1859, then brought in the primes as you named them.",
      summary: "Added Riemann’s portrait and 1859, then brought in the primes as you named them.",
      reason: "The portrait introduces Riemann and the row gives viewers examples as you explain his idea.",
      kind: "overlay",
      range: { start: 2, end: 14 },
    }), {
      change: change({
        ops: [{ op: "addClip", trackId: "trk_v2", clip: { id: "c_r", kind: "media", mediaId: "med_riemann", timelineIn: 2, sourceIn: 0, sourceOut: 12, speed: 1 } }],
      }),
      timeline,
      media,
      status: "Revising…",
      by: "GPT-6.2-Sol",
    });
    expect(revisingOverlay).toEqual({
      tip: "Added Riemann’s portrait and 1859, then brought in the primes as you named them.",
      meta: "Overlay · 12 s · Revising with GPT-6.2-Sol",
    });

    // Handed-off task model names keep their separator intact.
    const handedOff = editRowTooltip(edit({
      label: "Added Riemann’s portrait",
      kind: "overlay",
      range: { start: 2, end: 14 },
    }), {
      status: "Revising…",
      by: "Motion graphics · Gemini 3 Pro",
    });
    expect(handedOff).toEqual({
      tip: "Added Riemann’s portrait",
      meta: "Overlay · 12 s · Revising… · Motion graphics · Gemini 3 Pro",
    });
  });

  it("infers clip details from the timeline on full-timeline saves without ops or filenames", () => {
    expect(editRowTooltip(edit({ label: "captions", kind: "other", range: { start: 0.2, end: 2.4 } }), { timeline, media })).toEqual({
      tip: "captions",
      meta: "Caption: “Welcome back” · 2.2 s",
    });
    expect(editRowTooltip(edit({ label: "captions", range: { start: 0.2, end: 2.4 } }), { timeline, media })).toEqual({
      tip: "captions",
      meta: "Caption: “Welcome back” · 2.2 s",
    });
    expect(editRowTooltip(edit({ label: "music bed", range: { start: 0, end: 16 } }), { timeline, media })).toEqual({
      tip: "music bed",
      meta: "Audio · quieter (−14 dB)",
    });
  });

  it("keeps actionable check cues and to-dos while omitting general rationale when kept or revising", () => {
    expect(editRowTooltip(edit({
      label: "Tightened transition",
      summary: "Tightened transition",
      reason: "Removed the 1.2 s breath before the next topic.",
      check: "Listen for the breath at the join.",
      kind: "cut",
      range: { start: 40, end: 40 },
      beforeCut: { version: "v1", removed: { start: 40, end: 41.2 } },
    }), { version: 2 })).toEqual({
      tip: "Tightened transition",
      meta: "Cut · −1.2 s",
      detail: "Listen for the breath at the join.",
    });

    // While revising or once kept, old check cues and general rationale stay off the hover tooltip.
    expect(editRowTooltip(edit({
      label: "Tightened transition",
      summary: "Tightened transition",
      reason: "Removed the 1.2 s breath before the next topic.",
      check: "Listen for the breath at the join.",
      kind: "cut",
      range: { start: 40, end: 40 },
      beforeCut: { version: "v1", removed: { start: 40, end: 41.2 } },
    }), { status: "Revising…", by: "GPT-6.2-Sol" })).toEqual({
      tip: "Tightened transition",
      meta: "Cut · −1.2 s · Revising with GPT-6.2-Sol",
    });

    expect(editRowTooltip(edit({
      label: "Tightened transition",
      summary: "Tightened transition",
      reason: "Removed the 1.2 s breath before the next topic.",
      check: "Listen for the breath at the join.",
      kind: "cut",
      range: { start: 40, end: 40 },
      beforeCut: { version: "v1", removed: { start: 40, end: 41.2 } },
    }), { status: "Kept" })).toEqual({
      tip: "Tightened transition",
      meta: "Cut · −1.2 s · Kept",
    });

    expect(editRowTooltip(edit({ label: "Need cutaway shot", marker: true, todo: "Drop in product B-roll from Alex.", range: { start: 30, end: 30 } }))).toEqual({
      tip: "Need cutaway shot",
      meta: "To do",
      detail: "Drop in product B-roll from Alex.",
    });

    expect(editRowTooltip(edit({ label: "False start", kind: "cut", rejected: true, range: { start: 2, end: 4.5 } }))).toEqual({
      tip: "False start",
      meta: "Rejected cut · 2.5 s",
    });
  });

  it("formats staged pass calls, decided calls, and moments without duplicating the title", () => {
    expect(callRowTooltip({
      summary: "Trimmed pause before pricing",
      reason: "1.8 s of dead air before the price reveal.",
      tag: "Cut",
      length: 1.8,
      state: "open",
      version: 1,
    })).toEqual({
      tip: "Trimmed pause before pricing",
      meta: "Cut · −1.8 s",
      detail: "1.8 s of dead air before the price reveal.",
    });

    expect(callRowTooltip({
      summary: "Trimmed pause before pricing",
      reason: "1.8 s of dead air before the price reveal.",
      tag: "Cut",
      length: 1.8,
      state: "revising",
      version: 1,
      word: "Revising…",
      by: "GPT-6.2-Sol",
    })).toEqual({
      tip: "Trimmed pause before pricing",
      meta: "Cut · −1.8 s · Revising with GPT-6.2-Sol",
    });

    expect(callRowTooltip({
      summary: "Kept the laugh",
      tag: "Check",
      length: 1.4,
      state: "approved",
      version: 2,
      earlier: { reason: "Cut the laugh", note: "Keep laughs in" },
    })).toEqual({
      tip: "Kept the laugh",
      meta: "Keep · 1.4 s · Kept",
      detail: "Earlier: Cut the laugh\nYou: “Keep laughs in”",
    });

    expect(decidedCallRowTooltip({ label: "Aside about weather", note: "Skipped by editor.", length: 3.2, approved: false })).toEqual({
      tip: "Aside about weather",
      meta: "Rejected cut · 3.2 s",
    });

    expect(momentRowTooltip(
      "Trimmed pause",
      [{ label: "Trimmed pause", value: "−1.2 s" }, { label: "Punch in", kind: "Zoom" }],
      { start: 30, end: 34 },
    )).toEqual({
      tip: "Trimmed pause",
      meta: "2 edits · −1.2 s, Zoom",
      detail: "Punch in",
    });
  });
});
