import { describe, expect, it } from "vitest";
import { buildMulticamTimeline, type MediaAsset, type TranscriptWord } from "@scarlet/timeline";
import {
  correlateSpeakersToCameras,
  discoverAudibleSources,
  discoverMulticamCameras,
  mapStretchesToCameraSource,
  selectMouthActivityStretches,
  turnsFromIsolatedMics,
  turnsFromTranscripts,
  type FaceTrackReading,
  type MouthActivityReading,
} from "./multicam-analysis.js";

const asset = (id: string, kind: "video" | "audio", name: string, duration = 60, hasAudio = true): MediaAsset =>
  ({ id, name, kind, path: name, duration, hasAudio }) as MediaAsset;

describe("multicam speaker & camera analysis", () => {
  const media: MediaAsset[] = [
    asset("cam_wide", "video", "Wide.mp4"),
    asset("cam_host", "video", "HostCam.mp4"),
    asset("cam_guest", "video", "GuestCam.mp4"),
    asset("mic_host", "audio", "HostMic.wav"),
    asset("mic_guest", "audio", "GuestMic.wav"),
  ];

  const built = buildMulticamTimeline(
    "prj_pod",
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

  it("discovers all synced camera angle tracks and audible tracks", () => {
    const cams = discoverMulticamCameras(built.timeline, media);
    expect(cams.map(c => c.mediaId)).toEqual(["cam_wide", "cam_host", "cam_guest"]);
    expect(cams.every(c => c.hidden && c.coveredSeconds === 60)).toBe(true);

    const audio = discoverAudibleSources(built.timeline, media);
    expect(audio.map(a => a.mediaId)).toEqual(["mic_host", "mic_guest"]);
  });

  it("extracts diarized speaker turns and overlapping crosstalk from transcripts", () => {
    const words = (speaker: string, start: number, count: number): TranscriptWord[] =>
      Array.from({ length: count }, (_, i) => ({ text: `${speaker}_${i}`, start: start + i * 0.4, end: start + i * 0.4 + 0.3, speaker }));

    const transcripts = new Map<string, TranscriptWord[]>([
      ["mic_host", [...words("Speaker 1", 1, 10), ...words("Speaker 1", 15, 8)]],
      ["mic_guest", [...words("Speaker 2", 8, 12), ...words("Speaker 2", 25, 10)]],
    ]);
    const audible = discoverAudibleSources(built.timeline, media);
    const res = turnsFromTranscripts(built.timeline, transcripts, audible);
    expect(res.speakers.map(s => s.speaker).sort()).toEqual(["Guest mic", "Host mic"]);
    // Host speaks 15..18.1 while Guest speaks 8..12.7 — let's check a real overlap case too:
    expect(res.turns.length).toBeGreaterThanOrEqual(4);

    // Single diarized mix with overlapping speakers
    const mixBuilt = buildMulticamTimeline(
      "prj_pod",
      [
        { mediaId: "cam_wide", duration: 60, offset: 0 },
        { mediaId: "cam_host", duration: 60, offset: 0 },
      ],
      [{ mediaId: "mic_host", duration: 60, name: "Mix", offset: 0 }],
    );
    const mixAudible = discoverAudibleSources(mixBuilt.timeline, media);
    const mixWords: TranscriptWord[] = [
      ...words("Speaker 1", 0, 15),   // 0..5.9
      ...words("Speaker 2", 4, 15),   // 4..9.9 (overlaps 4..5.9!)
      ...words("Speaker 1", 12, 10),  // 12..15.9
    ];
    const mixRes = turnsFromTranscripts(mixBuilt.timeline, new Map([["mic_host", mixWords]]), mixAudible);
    expect(mixRes.speakers.map(s => s.speaker).sort()).toEqual(["Speaker 1", "Speaker 2"]);
    expect(mixRes.crosstalk.length).toBeGreaterThanOrEqual(1);
    expect(mixRes.crosstalk[0]!.from).toBeCloseTo(4, 1);
    expect(mixRes.crosstalk[0]!.to).toBeCloseTo(5.9, 1);
  });

  it("derives isolated mic turns and crosstalk from per-mic levels while rejecting mic bleed", () => {
    const sr = 50;
    const total = 30 * sr;
    const hostPeaks = new Array<number>(total).fill(0.002); // ~ -54 dBFS room floor
    const guestPeaks = new Array<number>(total).fill(0.002);
    // 2..10 s: Host speaks loud (0.35), small bleed on Guest mic (0.04 -> ~19 dB quieter -> rejected!)
    for (let i = 2 * sr; i < 10 * sr; i++) { hostPeaks[i] = 0.35; guestPeaks[i] = 0.04; }
    // 10..12 s: Crosstalk! Both speak loud (0.32 and 0.28 -> within 6 dB!)
    for (let i = 10 * sr; i < 12 * sr; i++) { hostPeaks[i] = 0.32; guestPeaks[i] = 0.28; }
    // 12..22 s: Guest speaks loud (0.38), small bleed on Host mic (0.03)
    for (let i = 12 * sr; i < 22 * sr; i++) { guestPeaks[i] = 0.38; hostPeaks[i] = 0.03; }

    const audible = discoverAudibleSources(built.timeline, media);
    const res = turnsFromIsolatedMics(audible, new Map([
      ["mic_host", { peaks: hostPeaks, sampleRate: sr }],
      ["mic_guest", { peaks: guestPeaks, sampleRate: sr }],
    ]));

    expect(res.speakers.map(s => s.speaker).sort()).toEqual(["Guest mic", "Host mic"]);
    expect(res.crosstalk).toHaveLength(1);
    expect(res.crosstalk[0]!.from).toBeCloseTo(10, 0);
    expect(res.crosstalk[0]!.to).toBeCloseTo(12, 0);
  });

  it("matches Speaker 1 and Speaker 2 to their close-up cameras and to left/right faces on the wide two-shot using mouth movement and scratch audio", () => {
    const cams = discoverMulticamCameras(built.timeline, media);
    const turns = [
      { from: 0, to: 10, duration: 10, speaker: "Speaker 1", sourceMediaId: "mic_host" },
      { from: 10, to: 20, duration: 10, speaker: "Speaker 2", sourceMediaId: "mic_guest" },
      { from: 20, to: 30, duration: 10, speaker: "Speaker 1", sourceMediaId: "mic_host" },
      { from: 30, to: 40, duration: 10, speaker: "Speaker 2", sourceMediaId: "mic_guest" },
    ];
    const speakers = [
      { speaker: "Speaker 1", sourceMediaIds: ["mic_host"], speakingSeconds: 20, turnCount: 2, shareOfSpeech: 0.5 },
      { speaker: "Speaker 2", sourceMediaIds: ["mic_guest"], speakingSeconds: 20, turnCount: 2, shareOfSpeech: 0.5 },
    ];

    const stretches = selectMouthActivityStretches(turns, [], 60);
    expect(stretches.length).toBeGreaterThan(0);
    expect(mapStretchesToCameraSource(cams[0]!, stretches).length).toBeGreaterThan(0);

    // Build 5 Hz mouth activity over [0..40]:
    // Face on cam_host moves during [0..10] & [20..30] (Speaker 1); still during [10..20] & [30..40].
    // Face on cam_guest moves during [10..20] & [30..40] (Speaker 2); still during [0..10] & [20..30].
    // cam_wide has 2 faces: track 1 (left) moves with Speaker 1, track 2 (right) moves with Speaker 2.
    const seriesFor = (activeOn: (sec: number) => boolean) =>
      Array.from({ length: 40 * 5 }, (_, i) => activeOn((i + 0.5) / 5) ? 9.5 : 1.1);
    const spk1Active = (t: number) => (t >= 0 && t < 10) || (t >= 20 && t < 30);
    const spk2Active = (t: number) => (t >= 10 && t < 20) || (t >= 30 && t < 40);

    const facesByCamera = new Map<string, { tracks: FaceTrackReading[] }>([
      ["cam_wide", {
        tracks: [
          { track: 1, start: 0, end: 60, seconds: 60, box: [0.15, 0.25, 0.30, 0.50], eyes: [0.22, 0.35], confidence: 0.92 },
          { track: 2, start: 0, end: 60, seconds: 60, box: [0.70, 0.25, 0.85, 0.50], eyes: [0.77, 0.35], confidence: 0.91 },
        ],
      }],
      ["cam_host", {
        tracks: [
          { track: 1, start: 0, end: 60, seconds: 60, box: [0.35, 0.18, 0.65, 0.62], eyes: [0.50, 0.36], confidence: 0.95 },
        ],
      }],
      ["cam_guest", {
        tracks: [
          { track: 1, start: 0, end: 60, seconds: 60, box: [0.36, 0.20, 0.64, 0.60], eyes: [0.50, 0.36], confidence: 0.94 },
        ],
      }],
    ]);

    const mouthByCamera = new Map<string, MouthActivityReading>([
      ["cam_wide", {
        mediaId: "cam_wide",
        sampleRate: 5,
        done: true,
        faces: [
          { track: 1, box: [0.15, 0.25, 0.30, 0.50], mouth: [0.17, 0.40, 0.28, 0.52], seconds: 60, confidence: 0.92, stretches: [{ from: 0, to: 40, values: seriesFor(spk1Active) }] },
          { track: 2, box: [0.70, 0.25, 0.85, 0.50], mouth: [0.72, 0.40, 0.83, 0.52], seconds: 60, confidence: 0.91, stretches: [{ from: 0, to: 40, values: seriesFor(spk2Active) }] },
        ],
      }],
      ["cam_host", {
        mediaId: "cam_host",
        sampleRate: 5,
        done: true,
        faces: [
          { track: 1, box: [0.35, 0.18, 0.65, 0.62], mouth: [0.40, 0.45, 0.60, 0.64], seconds: 60, confidence: 0.95, stretches: [{ from: 0, to: 40, values: seriesFor(spk1Active) }] },
        ],
      }],
      ["cam_guest", {
        mediaId: "cam_guest",
        sampleRate: 5,
        done: true,
        faces: [
          { track: 1, box: [0.36, 0.20, 0.64, 0.60], mouth: [0.40, 0.45, 0.60, 0.63], seconds: 60, confidence: 0.94, stretches: [{ from: 0, to: 40, values: seriesFor(spk2Active) }] },
        ],
      }],
    ]);

    const reports = correlateSpeakersToCameras({
      cameras: cams,
      speakers,
      turns,
      crosstalk: [],
      facesByCamera,
      mouthByCamera,
    });

    const wide = reports.find(r => r.mediaId === "cam_wide")!;
    const host = reports.find(r => r.mediaId === "cam_host")!;
    const guest = reports.find(r => r.mediaId === "cam_guest")!;

    expect(wide.prominentFaceCount).toBe(2);
    expect(wide.faces.map(f => f.position)).toEqual(["left", "right"]);
    expect(wide.speakerEvidence.find(e => e.speaker === "Speaker 1")?.mouthActivity?.faceTrack).toBe(1);
    expect(wide.speakerEvidence.find(e => e.speaker === "Speaker 2")?.mouthActivity?.faceTrack).toBe(2);

    expect(host.prominentFaceCount).toBe(1);
    expect(host.speakerEvidence[0]).toMatchObject({ speaker: "Speaker 1", strength: "high" });
    expect(host.speakerEvidence[0]!.mouthActivity!.correlation).toBeGreaterThan(0.9);
    expect(host.speakerEvidence[1]!.mouthActivity!.correlation).toBeLessThan(-0.9);

    expect(guest.prominentFaceCount).toBe(1);
    expect(guest.speakerEvidence[0]).toMatchObject({ speaker: "Speaker 2", strength: "high" });
    expect(guest.speakerEvidence[0]!.mouthActivity!.correlation).toBeGreaterThan(0.9);
  });
});
