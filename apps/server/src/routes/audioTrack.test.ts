import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type MediaAsset, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { ffmpeg } from "../render/ffmpeg.js";

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
