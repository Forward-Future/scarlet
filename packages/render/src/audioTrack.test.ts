import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Project, Timeline } from "@scarlet/timeline";
import { audioMixStreamsFilter, resolveAudioTrack } from "./audioTrack.js";
import { runFfmpeg } from "./exec.js";
import { buildFilterGraph } from "./graph.js";
import { probeMedia, probeToAssetFields } from "./probe.js";
import { renderRange } from "./render.js";
import { segmentKey } from "./segmentKey.js";
import { extractWaveform } from "./waveform.js";

describe("resolveAudioTrack", () => {
  it("defaults to stream 0 and clamps or mixes based on stream count", () => {
    expect(resolveAudioTrack(undefined, 2)).toEqual({ mode: "single", stream: 0 });
    expect(resolveAudioTrack(0, 2)).toEqual({ mode: "single", stream: 0 });
    expect(resolveAudioTrack(1, 2)).toEqual({ mode: "single", stream: 1 });
    expect(resolveAudioTrack(5, 2)).toEqual({ mode: "single", stream: 1 });
    expect(resolveAudioTrack("all", 3)).toEqual({ mode: "mix", count: 3 });
    expect(resolveAudioTrack("all", 1)).toEqual({ mode: "single", stream: 0 });
  });

  it("builds a non-attenuating amix filter across streams", () => {
    const filter = audioMixStreamsFilter(0, 2, { sampleRate: 48000, channelLayout: "stereo", outLabel: "mix" });
    expect(filter).toContain("[0:a:0]");
    expect(filter).toContain("[0:a:1]");
    expect(filter).toContain("amix=inputs=2:normalize=0:duration=longest:dropout_transition=0[mix]");
  });
});

describe("multi-audio-track media end-to-end", () => {
  let dir: string;
  let multiTrackFile: string;
  let singleTrackFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scarlet-multitrack-"));
    multiTrackFile = join(dir, "obs-two-tracks.mkv");
    singleTrackFile = join(dir, "single-track.mp4");
    // Track 0 (Host): 440 Hz tone from 0..1s, silence 1..2s
    // Track 1 (Guest): silence 0..1s, 880 Hz tone from 1..2s
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
      "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a0];[3:a][4:a]concat=n=2:v=0:a=1[a1]",
      "-map", "0:v", "-map", "[a0]", "-map", "[a1]",
      "-metadata:s:a:0", "title=Host Mic",
      "-metadata:s:a:1", "title=Guest",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
      multiTrackFile,
    ]);
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
      singleTrackFile,
    ]);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("probes every audio stream and exposes audioStreams on multi-track assets only", async () => {
    const multi = await probeMedia(multiTrackFile);
    expect(multi.hasAudio).toBe(true);
    expect(multi.audioStreams).toHaveLength(2);
    expect(multi.audioStreams?.[0]).toMatchObject({ index: 0, title: "Host Mic", channels: 1 });
    expect(multi.audioStreams?.[1]).toMatchObject({ index: 1, title: "Guest", channels: 1 });
    expect(probeToAssetFields(multi).audioStreams).toHaveLength(2);

    const single = await probeMedia(singleTrackFile);
    expect(single.audioStreams).toHaveLength(1);
    expect(probeToAssetFields(single).audioStreams).toBeUndefined();
  });

  it("extracts waveforms for Track 1, Track 2, and all tracks mixed", async () => {
    const wf0 = await extractWaveform(multiTrackFile, { from: 0, to: 2, points: 4, audioTrack: 0, audioStreamCount: 2 });
    const wf1 = await extractWaveform(multiTrackFile, { from: 0, to: 2, points: 4, audioTrack: 1, audioStreamCount: 2 });
    const wfAll = await extractWaveform(multiTrackFile, { from: 0, to: 2, points: 4, audioTrack: "all", audioStreamCount: 2 });

    // Track 0: loud in first second, quiet in second second (FFmpeg sine default is ~0.088 RMS)
    expect(wf0.rms[0]).toBeGreaterThan(0.05);
    expect(wf0.rms[3]).toBeLessThan(0.01);
    // Track 1: quiet in first second, loud in second second
    expect(wf1.rms[0]).toBeLessThan(0.01);
    expect(wf1.rms[3]).toBeGreaterThan(0.05);
    // All mixed: loud in BOTH halves
    expect(wfAll.rms[0]).toBeGreaterThan(0.05);
    expect(wfAll.rms[3]).toBeGreaterThan(0.05);
  });

  it("renders selected track or mixed tracks and varies segment keys accordingly", async () => {
    const probed = await probeMedia(multiTrackFile);
    const makeProject = (audioTrack?: number | "all") => Project.parse({
      id: "prj_mt",
      name: "Multi-track test",
      settings: { width: 64, height: 64, fps: 24, sampleRate: 48000, audioChannels: 2 },
      media: [{
        id: "med_mt",
        kind: "video",
        name: "obs-two-tracks.mkv",
        path: "obs-two-tracks.mkv",
        hash: "abc123",
        duration: 2,
        fps: 24,
        width: 64,
        height: 64,
        hasAudio: true,
        audioStreams: probed.audioStreams,
        audioTrack,
      }],
    });
    const timeline = Timeline.parse({
      projectId: "prj_mt",
      version: "v1",
      tracks: [{
        id: "trk_v",
        kind: "video",
        name: "V1",
        clips: [{
          id: "clp_1",
          kind: "media",
          mediaId: "med_mt",
          timelineIn: 0,
          sourceIn: 0,
          sourceOut: 2,
        }],
      }],
    });

    // Cache keys differ for audio renders, stay equal for picture-only renders
    const k0 = segmentKey(makeProject(0), timeline, { start: 0, end: 2 }, { quality: "preview" });
    const k1 = segmentKey(makeProject(1), timeline, { start: 0, end: 2 }, { quality: "preview" });
    const kAll = segmentKey(makeProject("all"), timeline, { start: 0, end: 2 }, { quality: "preview" });
    expect(k0).not.toBe(k1);
    expect(k1).not.toBe(kAll);
    expect(segmentKey(makeProject(0), timeline, { start: 0, end: 2 }, { quality: "preview", pictureOnly: true }))
      .toBe(segmentKey(makeProject("all"), timeline, { start: 0, end: 2 }, { quality: "preview", pictureOnly: true }));

    // Filter graph maps the chosen track
    const g1 = await buildFilterGraph(makeProject(1), timeline, { start: 0, end: 2 }, { mediaRoot: dir });
    expect(g1.graph).toContain("[0:a:1]");
    await g1.cleanup();

    // Render Track 1 only -> silent first half, loud second half
    const out1 = join(dir, "out-track1.mp4");
    await renderRange(makeProject(1), timeline, { start: 0, end: 2 }, out1, { mediaRoot: dir, quality: "preview" });
    const out1Wf = await extractWaveform(out1, { from: 0, to: 2, points: 4 });
    expect(out1Wf.rms[0]).toBeLessThan(0.01);
    expect(out1Wf.rms[3]).toBeGreaterThan(0.05);

    // Render All tracks -> loud in BOTH halves
    const outAll = join(dir, "out-all.mp4");
    await renderRange(makeProject("all"), timeline, { start: 0, end: 2 }, outAll, { mediaRoot: dir, quality: "preview" });
    const outAllWf = await extractWaveform(outAll, { from: 0, to: 2, points: 4 });
    expect(outAllWf.rms[0]).toBeGreaterThan(0.05);
    expect(outAllWf.rms[3]).toBeGreaterThan(0.05);
  });
});
