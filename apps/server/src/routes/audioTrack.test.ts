import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractWaveform, heardAudio, heardAudioKey } from "@scarlet/render";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { ffmpeg } from "../render/ffmpeg.js";
import { recordingWav } from "../services/recordingAudio.js";
import { waveformBase } from "../services/waveforms.js";
import { OpenAIProvider } from "../transcribe/openai.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-audiotrack-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  workspace.ctx.speakers.beside = false;
  workspace.ctx.repos.settings.update({ transcription: { provider: "none" } });
  project = workspace.ctx.repos.projects.insert(createProject("Multi-Track Podcast"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: "Bearer " + accessToken(workspace.ctx),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  });
}

it("ingests multi-track recordings, validates and switches audioTrack, and rebuilds waveforms per track", async () => {
  const src = join(directory, "obs-podcast.mkv");
  // Track 0 (Host): 440 Hz tone 0..1s, silence 1..2s
  // Track 1 (Guest): silence 0..1s, 880 Hz tone 1..2s
  await ffmpeg([
    "-y",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
    "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a0];[3:a][4:a]concat=n=2:v=0:a=1[a1]",
    "-map", "0:v", "-map", "[a0]", "-map", "[a1]",
    "-metadata:s:a:0", "title=Host",
    "-metadata:s:a:1", "title=Guest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
    src,
  ]);

  const imported = await api("POST", `/projects/${project.id}/media/import`, { path: src });
  expect(imported.status).toBe(201);
  const { media } = await imported.json() as { media: MediaAsset };
  expect(media.audioStreams).toHaveLength(2);
  expect(media.audioStreams?.[0]?.title).toBe("Host");
  expect(media.audioStreams?.[1]?.title).toBe("Guest");
  expect(media.audioTrack).toBeUndefined();

  // Default track (0): loud first half, silent second half
  const wf0Res = await api("GET", `/media/${media.id}/waveform?from=0&to=2&points=4`);
  expect(wf0Res.status).toBe(200);
  const wf0 = await wf0Res.json() as { rms: number[] };
  expect(wf0.rms[0]).toBeGreaterThan(0.05);
  expect(wf0.rms[3]).toBeLessThan(0.01);

  // Reject out-of-range track index
  const bad = await api("PUT", `/media/${media.id}/audio-track`, { audioTrack: 5 });
  expect(bad.status).toBe(400);

  // Switch to Track 2 (index 1): silent first half, loud second half
  const put1 = await api("PUT", `/media/${media.id}/audio-track`, { audioTrack: 1 });
  expect(put1.status).toBe(200);
  expect((await put1.json() as { media: MediaAsset }).media.audioTrack).toBe(1);
  const wf1 = await (await api("GET", `/media/${media.id}/waveform?from=0&to=2&points=4`)).json() as { rms: number[] };
  expect(wf1.rms[0]).toBeLessThan(0.01);
  expect(wf1.rms[3]).toBeGreaterThan(0.05);

  // Switch to "all": loud in BOTH halves
  const putAll = await api("PUT", `/media/${media.id}/audio-track`, { audioTrack: "all" });
  expect(putAll.status).toBe(200);
  expect((await putAll.json() as { media: MediaAsset }).media.audioTrack).toBe("all");
  const wfAll = await (await api("GET", `/media/${media.id}/waveform?from=0&to=2&points=4`)).json() as { rms: number[] };
  expect(wfAll.rms[0]).toBeGreaterThan(0.05);
  expect(wfAll.rms[3]).toBeGreaterThan(0.05);

  // Switching back to 0 normalizes to undefined (default track)
  const put0 = await api("PUT", `/media/${media.id}/audio-track`, { audioTrack: 0 });
  expect(put0.status).toBe(200);
  expect((await put0.json() as { media: MediaAsset }).media.audioTrack).toBeUndefined();
});

/** A video whose Track 1 is silent mono and Track 2 a stereo tone. Neither is marked default, so FFmpeg left to itself plays Track 2. */
async function firstTrackSilent() {
  const src = join(directory, "first-silent.mkv");
  await ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=3",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-ac:a:1", "2", "-disposition:a:0", "0", "-disposition:a:1", "0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", src]);
  const { media } = await (await api("POST", `/projects/${project.id}/media/import`, { path: src })).json() as { media: MediaAsset };
  await settle();
  expect(workspace.ctx.repos.projects.getMedia(media.id)?.status).toBe("ready");
  return media;
}

const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };

/** RMS of the 16-bit samples in a WAV. */
function rmsOf(wav: Buffer) {
  const pcm = wav.subarray(wav.indexOf("data") + 8);
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length / 2));
}

it("hears the chosen track in everything that listens, and makes its previews and transcript again from it", async () => {
  const { ctx } = workspace;
  const media = await firstTrackSilent();
  const file = join(ctx.paths.media(project.id), ctx.repos.projects.getMedia(media.id)!.path);
  /** The playback cache, made now for the track the recording hears. */
  const playbackCache = async () => {
    await api("POST", `/media/${media.id}/playback-cache`, {});
    await settle();
    const { fileKey } = await (await api("GET", `/media/${media.id}/playback-cache`)).json() as { fileKey: string };
    return join(ctx.paths.proxies(project.id), fileKey);
  };
  const heard = async () => {
    const cache = await playbackCache();
    const played = join(directory, `played-${ctx.repos.projects.getMedia(media.id)!.audioTrack ?? 0}.mp4`);
    writeFileSync(played, Buffer.from(await (await api("GET", `/media/${media.id}/proxy`)).arrayBuffer()));
    const current = ctx.repos.projects.getMedia(media.id)!;
    const source = await (await api("POST", `/projects/${project.id}/source-audio`, { mediaId: media.id, from: 1, to: 2 })).json() as { wav: string };
    const loudness = await (await api("GET", `/projects/${project.id}/media/${media.id}/loudness`)).json() as { integratedLufs: number | null };
    const beats = await (await api("GET", `/projects/${project.id}/media/${media.id}/music-beats`)).json() as { levels: { db: number[] } };
    const recording = await recordingWav(ctx, file, AbortSignal.timeout(30_000), heardAudio(current));
    try {
      const pcm = await recording.pcm(1, 2);
      return {
        cutInspector: rmsOf(Buffer.from(source.wav, "base64")) > 0.05,
        loudness: (loudness.integratedLufs ?? -Infinity) > -40,
        beats: Math.max(...beats.levels.db) > -40,
        pausesAndSpeech: pcm.some(s => Math.abs(s) > 1000),
        playbackCache: (await extractWaveform(cache, { from: 1, to: 2, points: 1 })).rms[0]! > 0.05,
        played: (await extractWaveform(played, { from: 1, to: 2, points: 1 })).rms[0]! > 0.05,
        cache,
      };
    } finally { recording.release(); }
  };
  // Nothing chosen: Track 1, named by number, everywhere. The previews made on import hear it too.
  const first = await heard();
  expect(first).toMatchObject({ cutInspector: false, loudness: false, beats: false, pausesAndSpeech: false, playbackCache: false, played: false });

  // The recording was transcribed. Picking another track transcribes it again from that track.
  const old = ctx.repos.transcripts.put({ id: "trs_track1", projectId: project.id, mediaId: media.id, language: "en", provider: "openai",
    createdAt: "2026-01-01T00:00:00.000Z", segments: [{ id: "s", text: "silence", start: 0, end: 1, words: [] }] });
  const ready = ctx.repos.projects.getMedia(media.id)!;
  ctx.repos.projects.putMedia(project.id, { ...ready, transcriptId: old.id }, "ready");
  ctx.env.openaiKey = "unused-fixture";
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  // Speaker analysis follows a transcript; it isn't what this is about.
  vi.spyOn(ctx.speakers, "ensure").mockResolvedValue();
  const transcribed: unknown[] = [];
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(async input => {
    transcribed.push(heardAudioKey(input.audio));
    return { language: "en", segments: [] };
  });

  const put = await api("PUT", `/media/${media.id}/audio-track`, { audioTrack: 1 });
  expect(put.status).toBe(200);
  await settle();
  expect(transcribed).toEqual([1]);
  expect(ctx.repos.projects.getMedia(media.id)?.transcriptId).not.toBe(old.id);
  // Every reading that listens now hears Track 2: none is the first track's kept from before. (The first track's cache
  // stays under the recording's hash for any other copy of it that hears that track.)
  const second = await heard();
  expect(second).toMatchObject({ cutInspector: true, loudness: true, beats: true, pausesAndSpeech: true, playbackCache: true, played: true });
  expect(second.cache).not.toBe(first.cache);
  // A part made on demand for playback hears it too.
  const part = join(directory, "part.mp4");
  writeFileSync(part, Buffer.from(await (await api("GET", `/media/${media.id}/preview/0`)).arrayBuffer()));
  expect((await extractWaveform(part, { from: 1, to: 2, points: 1 })).rms[0]).toBeGreaterThan(0.05);

  // Picking the track it already hears changes nothing.
  expect((await api("PUT", `/media/${media.id}/audio-track`, { audioTrack: 1 })).status).toBe(200);
  await settle();
  expect(transcribed).toEqual([1]);
});

it("takes every track's waveform out with a file it couldn't read", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  writeFileSync(join(ctx.paths.media(project.id), "broken.mkv"), "x");
  ctx.repos.projects.putMedia(project.id, { id: "broken", name: "broken.mkv", path: "broken.mkv", kind: "video", duration: 60, hasAudio: true,
    audioStreams: [{ index: 0 }, { index: 1 }], audioTrack: 1 }, "failed", "Unreadable");
  const kept = [waveformBase(ctx, project.id, "broken"), waveformBase(ctx, project.id, "broken", 1), waveformBase(ctx, project.id, "broken", "all")]
    .map(base => base + ".waveform");
  const other = waveformBase(ctx, project.id, "broken2", 1) + ".waveform";
  for (const path of [...kept, other]) writeFileSync(path, "w");
  expect((await api("DELETE", `/projects/${project.id}/media/broken`)).status).toBe(200);
  expect(kept.filter(path => existsSync(path))).toEqual([]);
  expect(existsSync(other)).toBe(true);
});
