import { describe, expect, it } from "vitest";
import {
  applyOps,
  buildMulticamTimeline,
  clipEnd,
  doubledSound,
  emptyTimeline,
  makeMediaClip,
  makeTrack,
  sourceAt,
  switchCameraOps,
  timelineDuration,
  type MediaAsset,
  type MediaClip,
} from "./index.js";

const asset = (id: string, kind: "video" | "audio" = "video", name = `${id}.${kind === "video" ? "mp4" : "wav"}`, hasAudio = true): MediaAsset =>
  ({ id, name, kind, path: name, duration: 120, hasAudio }) as MediaAsset;

describe("buildMulticamTimeline", () => {
  it("syncs 3 cameras and 2 external mics onto Program, hidden angle tracks, and dedicated audio tracks with camera scratch muted", () => {
    const built = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_wide", duration: 60, name: "Wide", offset: 0 },
        { mediaId: "cam_host", duration: 60, name: "Host", offset: 2 },
        { mediaId: "cam_guest", duration: 62, name: "Guest", offset: -1.5 },
      ],
      [
        { mediaId: "mic_host", duration: 60, name: "Host mic", offset: 0 },
        { mediaId: "mic_guest", duration: 60, name: "Guest mic", offset: 0.5 },
      ],
      { align: "reference" },
    );

    expect(built.programTrackId).toBe("v1");
    expect(built.initialCameraId).toBe("cam_wide");
    expect(built.origin).toBe(0);
    expect(built.duration).toBeCloseTo(62, 3);

    const v1 = built.timeline.tracks.find(t => t.id === "v1")!;
    expect(v1.hidden).toBe(false);
    expect(v1.clips).toHaveLength(1);
    expect(v1.clips[0]).toMatchObject({ mediaId: "cam_wide", timelineIn: 0, sourceIn: 0, sourceOut: 60, volume: 0 });

    // All 3 cameras live on hidden muted reference tracks with exact synced offsets.
    const mc1 = built.timeline.tracks.find(t => t.id === "mc_1")!;
    const mc2 = built.timeline.tracks.find(t => t.id === "mc_2")!;
    const mc3 = built.timeline.tracks.find(t => t.id === "mc_3")!;
    expect([mc1.hidden, mc2.hidden, mc3.hidden]).toEqual([true, true, true]);
    expect(mc2.clips[0]).toMatchObject({ mediaId: "cam_host", timelineIn: 2, sourceIn: 0, sourceOut: 60, volume: 0 });
    // cam_guest started 1.5 s before ref 0, so at timeline 0 its sourceIn is 1.5 s.
    expect(mc3.clips[0]).toMatchObject({ mediaId: "cam_guest", timelineIn: 0, sourceIn: 1.5, sourceOut: 62, volume: 0 });

    // Separate mics sit on dedicated unmuted audio tracks.
    const a1 = built.timeline.tracks.find(t => t.id === "a1")!;
    const a2 = built.timeline.tracks.find(t => t.id === "a2")!;
    expect([a1.muted, a2.muted]).toEqual([false, false]);
    expect(a1.clips[0]).toMatchObject({ mediaId: "mic_host", timelineIn: 0, sourceIn: 0, sourceOut: 60, volume: 1 });
    expect(a2.clips[0]).toMatchObject({ mediaId: "mic_guest", timelineIn: 0.5, sourceIn: 0, sourceOut: 60, volume: 1 });

    // Zero doubled sound.
    const media = [asset("cam_wide"), asset("cam_host"), asset("cam_guest"), asset("mic_host", "audio"), asset("mic_guest", "audio")];
    expect(doubledSound(built.timeline, media)).toEqual([]);
  });

  it("supports overlap and earliest alignment modes and keeps camera audio on a dedicated track when no external mic exists", () => {
    const overlap = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_a", duration: 50, name: "Cam A", offset: 0 },
        { mediaId: "cam_b", duration: 50, name: "Cam B", offset: 3 },
      ],
      [],
      { align: "overlap" },
    );
    expect(overlap.origin).toBe(3);
    expect(overlap.duration).toBeCloseTo(47, 3);
    // Without separate audio layers, cam_a's audio automatically lands on `a1` while all video tracks stay muted.
    const a1 = overlap.timeline.tracks.find(t => t.id === "a1")!;
    expect(a1.muted).toBe(false);
    expect(a1.clips[0]).toMatchObject({ mediaId: "cam_a", timelineIn: 0, sourceIn: 3, sourceOut: 50, volume: 1 });
    expect(overlap.timeline.tracks.find(t => t.id === "v1")!.clips[0]).toMatchObject({ mediaId: "cam_a", sourceIn: 3, sourceOut: 50, volume: 0 });
    expect(overlap.timeline.tracks.find(t => t.id === "mc_2")!.clips[0]).toMatchObject({ mediaId: "cam_b", timelineIn: 0, sourceIn: 0, sourceOut: 47, volume: 0 });

    const earliest = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_a", duration: 30, offset: 0 },
        { mediaId: "cam_b", duration: 30, offset: -4 },
      ],
      [],
      { align: "earliest" },
    );
    expect(earliest.origin).toBe(-4);
    expect(earliest.duration).toBeCloseTo(34, 3);
    expect(earliest.timeline.tracks.find(t => t.id === "mc_2")!.clips[0]).toMatchObject({ timelineIn: 0, sourceIn: 0, sourceOut: 30 });
    expect(earliest.timeline.tracks.find(t => t.id === "mc_1")!.clips[0]).toMatchObject({ timelineIn: 4, sourceIn: 0, sourceOut: 30 });
  });

  it("applies clock-drift speed compensation and multi-part step fits accurately and stays lock-stepped under rippleDelete", () => {
    const driftSpeed = 1 / 1.0005; // Secondary clock drifts +30 ms/min
    const built = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_main", duration: 600, offset: 0 },
        { mediaId: "cam_drift", duration: 600, offset: 2, speed: driftSpeed },
        {
          mediaId: "cam_step",
          duration: 600,
          segments: [
            { sourceIn: 0, sourceOut: 300, offset: 1 },
            { sourceIn: 300, sourceOut: 600, offset: 2.5 },
          ],
        },
      ],
      [{ mediaId: "mic", duration: 600, offset: 0 }],
    );

    const driftClip = built.timeline.tracks.find(t => t.id === "mc_2")!.clips[0] as MediaClip;
    expect(driftClip.speed).toBeCloseTo(driftSpeed, 6);
    expect(driftClip.timelineIn).toBe(2);
    // At timeline 302 s (300 ref seconds after cam_drift started), cam_drift source is 300 * driftSpeed.
    expect(sourceAt(driftClip, 302)).toBeCloseTo(300 * driftSpeed, 6);

    // Apply a global dialogue rippleDelete removing [100, 120] across all tracks.
    const cut = applyOps(built.timeline, [{ op: "rippleDelete", start: 100, end: 120 }]);
    const mainAfter = cut.tracks.find(t => t.id === "mc_1")!.clips[1] as MediaClip;
    const driftAfter = cut.tracks.find(t => t.id === "mc_2")!.clips[1] as MediaClip;
    const micAfter = cut.tracks.find(t => t.id === "a1")!.clips[1] as MediaClip;
    expect(mainAfter.timelineIn).toBe(100);
    expect(micAfter.timelineIn).toBe(100);
    expect(driftAfter.timelineIn).toBe(100);
    // At timeline 100 s after the 20 s cut (= original ref 120 s), sourceAt(driftAfter, 100) must equal (120 - 2) * driftSpeed.
    expect(sourceAt(driftAfter, 100)).toBeCloseTo(118 * driftSpeed, 6);

    // Step camera produced 2 non-overlapping synced clips.
    const stepClips = built.timeline.tracks.find(t => t.id === "mc_3")!.clips as MediaClip[];
    expect(stepClips).toHaveLength(2);
    expect(stepClips[0]!.timelineIn).toBe(1);
    expect(stepClips[1]!.timelineIn).toBe(302.5);
  });
});

describe("switchCameraOps", () => {
  const media = [
    asset("cam_wide", "video", "Wide.mp4"),
    asset("cam_host", "video", "Host.mp4"),
    asset("cam_guest", "video", "Guest.mp4"),
    asset("mic_host", "audio", "Host.wav"),
    asset("mic_guest", "audio", "Guest.wav"),
  ];

  it("switches Program camera angles non-destructively while preserving audio tracks and dialogue cuts", () => {
    const built = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_wide", duration: 60, name: "Wide", offset: 0 },
        { mediaId: "cam_host", duration: 60, name: "Host", offset: 0 },
        { mediaId: "cam_guest", duration: 60, name: "Guest", offset: 0 },
      ],
      [
        { mediaId: "mic_host", duration: 60, name: "Host mic", offset: 0 },
        { mediaId: "mic_guest", duration: 60, name: "Guest mic", offset: 0 },
      ],
    );

    // First run dialogue ripple cuts removing [12, 15] and [30, 32] (5 s removed -> 55 s total).
    const cut = applyOps(built.timeline, [
      { op: "rippleDelete", start: 30, end: 32 },
      { op: "rippleDelete", start: 12, end: 15 },
    ]);
    const a1Before = structuredClone(cut.tracks.find(t => t.id === "a1")!);
    const a2Before = structuredClone(cut.tracks.find(t => t.id === "a2")!);

    // Switch angles across the post-cut timeline: [0..8] wide, [8..22] host (spans the dialogue cut at 12 s!), [22..40] guest (spans cut at 27 s!).
    const { ops, report } = switchCameraOps(cut, media, 30, [
      { from: 8, to: 22, mediaId: "cam_host", label: "Host" },
      { from: 22, to: 40, mediaId: "cam_guest", label: "Guest" },
    ]);
    const switched = applyOps(cut, ops);

    expect(report.programTrackId).toBe("v1");
    expect(report.switchesApplied).toBe(2);
    expect(report.detachedAudio).toEqual([]);

    // Audio tracks are 100% untouched!
    expect(switched.tracks.find(t => t.id === "a1")).toEqual(a1Before);
    expect(switched.tracks.find(t => t.id === "a2")).toEqual(a2Before);
    expect(timelineDuration(switched)).toBeCloseTo(55, 6);

    // Program `v1` clips preserve the internal dialogue cuts inside each switched range!
    const v1 = switched.tracks.find(t => t.id === "v1")!.clips as MediaClip[];
    expect(v1.map(c => [c.mediaId, Number(c.timelineIn.toFixed(2)), Number(clipEnd(c).toFixed(2)), Number(c.sourceIn.toFixed(2)), Number(c.sourceOut.toFixed(2))])).toEqual([
      ["cam_wide", 0, 8, 0, 8],
      ["cam_host", 8, 12, 8, 12],
      ["cam_host", 12, 22, 15, 25], // dialogue cut [12, 15] preserved!
      ["cam_guest", 22, 27, 25, 30],
      ["cam_guest", 27, 40, 32, 45], // dialogue cut [30, 32] preserved!
      ["cam_wide", 40, 55, 45, 60],
    ]);

    // Re-switching [14..20] back to wide works non-destructively because mc_1..3 stayed intact!
    const reswitch = switchCameraOps(switched, media, 30, [{ from: 14, to: 20, mediaId: "cam_wide", label: "Wide" }]);
    const second = applyOps(switched, reswitch.ops);
    const v1Second = second.tracks.find(t => t.id === "v1")!.clips as MediaClip[];
    expect(v1Second.some(c => c.mediaId === "cam_wide" && Math.abs(c.timelineIn - 14) < 1e-3 && Math.abs(clipEnd(c) - 20) < 1e-3 && Math.abs(c.sourceIn - 17) < 1e-3)).toBe(true);
    expect(doubledSound(second, media)).toEqual([]);
  });

  it("detaches audio and snapshots reference tracks when switching a manually-stacked timeline with live V1 audio", () => {
    const tl = emptyTimeline("prj_1");
    tl.tracks[0]!.clips = [makeMediaClip("cam_wide", 0, 30, 0, { id: "c_w", volume: 1 })];
    tl.tracks.splice(1, 0, { ...makeTrack("video", "Host", "v2"), clips: [makeMediaClip("cam_host", 2, 32, 0, { id: "c_h", volume: 0 })] });

    const { ops, report } = switchCameraOps(tl, media, 30, [{ from: 10, to: 20, mediaId: "cam_host" }]);
    const next = applyOps(tl, ops);

    expect(report.detachedAudio).toEqual(["c_w"]);
    expect(report.hiddenAngleTracks).toEqual(["v2"]);
    // Audio from cam_wide moved onto v1_dialogue and plays continuously 0..30 with zero doubled sound!
    const audioTrack = next.tracks.find(t => t.kind === "audio" && t.clips.length > 0)!;
    expect(audioTrack.clips[0]).toMatchObject({ mediaId: "cam_wide", timelineIn: 0, sourceIn: 0, sourceOut: 30, volume: 1 });
    expect(doubledSound(next, media)).toEqual([]);
    // v1 switched to cam_host during [10..20] with exact synced source [12..22].
    const v1 = next.tracks.find(t => t.id === "v1")!.clips as MediaClip[];
    expect(v1.map(c => [c.mediaId, c.timelineIn, clipEnd(c), c.sourceIn, c.sourceOut])).toEqual([
      ["cam_wide", 0, 10, 0, 10],
      ["cam_host", 10, 20, 12, 22],
      ["cam_wide", 20, 30, 20, 30],
    ]);
  });

  it("refuses switches where the chosen camera has no footage covering the interval", () => {
    const built = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_wide", duration: 60, offset: 0 },
        { mediaId: "cam_host", duration: 40, offset: 10 }, // only covers timeline 10..50
      ],
      [{ mediaId: "mic_host", duration: 60, offset: 0 }],
    );
    expect(() => switchCameraOps(built.timeline, media, 30, [{ from: 5, to: 15, mediaId: "cam_host" }]))
      .toThrow(/no synced footage for 5\.00–10\.00 s/);
  });

  it("coalesces seamless pieces when switching back to an adjacent camera", () => {
    const built = buildMulticamTimeline(
      "prj_1",
      [
        { mediaId: "cam_wide", duration: 30, offset: 0 },
        { mediaId: "cam_host", duration: 30, offset: 0 },
      ],
      [{ mediaId: "mic_host", duration: 30, offset: 0 }],
    );
    const s1 = applyOps(built.timeline, switchCameraOps(built.timeline, media, 30, [{ from: 10, to: 20, mediaId: "cam_host" }]).ops);
    const s2 = applyOps(s1, switchCameraOps(s1, media, 30, [{ from: 10, to: 20, mediaId: "cam_wide" }]).ops);
    const v1 = s2.tracks.find(t => t.id === "v1")!.clips as MediaClip[];
    expect(v1).toHaveLength(1);
    expect(v1[0]).toMatchObject({ mediaId: "cam_wide", timelineIn: 0, sourceIn: 0, sourceOut: 30 });
  });
});
