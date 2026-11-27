import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, makeTrack } from "@scarlet/timeline";
import { brollSectionForEdit, continuousBrollSections, stretchesContiguous } from "./brollSections.js";

describe("continuousBrollSections", () => {
  const media = [
    { id: "cam", kind: "video" as const },
    { id: "flyer1", kind: "video" as const, source: { url: "https://example.com/1", capturedAt: "2026-11-26T00:00:00Z" } },
    { id: "flyer2", kind: "image" as const, source: { url: "https://example.com/2", capturedAt: "2026-11-26T00:00:00Z" } },
    { id: "flyer3", kind: "image" as const, source: { url: "https://example.com/3", capturedAt: "2026-11-26T00:00:00Z" } },
    { id: "jet1", kind: "video" as const, source: { url: "https://example.com/4", capturedAt: "2026-11-26T00:00:00Z" } },
    { id: "jet2", kind: "image" as const, source: { url: "https://example.com/5", capturedAt: "2026-11-26T00:00:00Z" } },
    { id: "gfx", kind: "graphic" as const },
  ];

  it("merges contiguous and overlapping B-roll clips into one section and splits across gaps back to main footage", () => {
    const tl = emptyTimeline("prj");
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 120, 0, { id: "cam_base" })];
    tl.tracks.push(
      {
        ...makeTrack("video", "B-roll", "v_broll"),
        clips: [
          makeMediaClip("flyer1", 0, 3, 10, { id: "b1" }),
          makeMediaClip("flyer2", 0, 3, 13, { id: "b2" }),
          makeMediaClip("flyer3", 0, 3, 16.05, { id: "b3" }), // tiny rounding gap within tolerance
          makeMediaClip("jet1", 0, 4, 30, { id: "b4" }),
          makeMediaClip("jet2", 0, 3, 33.8, { id: "b5" }), // slight overlap/crossfade
        ],
      },
      {
        ...makeTrack("video", "Graphics", "v_gfx"),
        clips: [makeMediaClip("gfx", 0, 10, 18, { id: "g1" })],
      },
      {
        ...makeTrack("video", "Camera inset", "v_inset"),
        clips: [makeMediaClip("cam", 0, 10, 50, { id: "pip1", transform: { scale: 0.3 } })],
      },
    );

    const sections = continuousBrollSections(tl, media);
    expect(sections).toEqual([
      { id: "broll:10000:19050", range: { start: 10, end: 19.05 }, clipIds: ["b1", "b2", "b3"] },
      { id: "broll:30000:36800", range: { start: 30, end: 36.8 }, clipIds: ["b4", "b5"] },
    ]);

    expect(brollSectionForEdit(sections, { start: 13, end: 16 }, ["b2"])?.id).toBe("broll:10000:19050");
    expect(brollSectionForEdit(sections, { start: 31, end: 34 })?.id).toBe("broll:30000:36800");
    // A B-roll removal right after a section ends (where camera returned) does not match the active section.
    expect(brollSectionForEdit(sections, { start: 19.05, end: 21 }, ["removed_clip"])).toBeUndefined();
  });

  it("ignores disabled clips and hidden tracks", () => {
    const tl = emptyTimeline("prj");
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 60, 0, { id: "cam_base" })];
    tl.tracks.push(
      { ...makeTrack("video", "B-roll", "v_broll"), clips: [makeMediaClip("flyer1", 0, 4, 5, { id: "off", enabled: false })] },
      { ...makeTrack("video", "Hidden", "v_hidden"), hidden: true, clips: [makeMediaClip("flyer1", 0, 4, 15, { id: "hid" })] },
    );
    expect(continuousBrollSections(tl, media)).toEqual([]);
  });

  it("detects contiguous stretches within frame tolerance", () => {
    expect(stretchesContiguous({ start: 10, end: 13 }, { start: 13, end: 16 })).toBe(true);
    expect(stretchesContiguous({ start: 10, end: 13 }, { start: 13.08, end: 16 })).toBe(true);
    expect(stretchesContiguous({ start: 10, end: 13 }, { start: 13.5, end: 16 })).toBe(false);
  });
});
