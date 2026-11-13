import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { encodeWaveformCache, WAVEFORM_CACHE_VERSION } from "@scarlet/render";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../app.js";
import { getWaveform, readWaveformCache } from "./ingest.js";

it("keeps both microphone waveforms warm and reads replacements and legacy JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-mic-waveforms-"));
  const { ctx } = createApp({ dataDir: dir, env: {}, log() {} });
  try {
    ctx.repos.projects.insert({ ...createProject("Waveforms"), id: "p" });
    ctx.paths.ensureProject("p");
    const recording = join(ctx.paths.waveforms("p"), `recording.v${WAVEFORM_CACHE_VERSION}.waveform`);
    const samples = (n: number) => encodeWaveformCache({ duration: 1, pointsPerSecond: 1,
      peaks: Float32Array.of(n), rms: Float32Array.of(n) });
    await writeFile(recording, samples(0.5));
    await writeFile(join(ctx.paths.waveforms("p"), "mic.json"), JSON.stringify({ duration: 1, pointsPerSecond: 1, peaks: [0.75] }));
    const first = await readWaveformCache(ctx, "p", "recording");
    expect((await readWaveformCache(ctx, "p", "mic"))?.peaks).toEqual([0.75]);
    expect(await readWaveformCache(ctx, "p", "recording")).toBe(first);
    await writeFile(recording + ".part", samples(1));
    await rename(recording + ".part", recording);
    expect((await readWaveformCache(ctx, "p", "recording"))?.peaks[0]).toBe(1);
    // A request can rebuild a legacy waveform on the recording clock once the original is present.
    await writeFile(join(ctx.paths.media("p"), "mic.mkv"), "fixture");
    const decode = vi.spyOn(ctx.render, "extractWaveformFull").mockResolvedValueOnce({
      duration: 1, pointsPerSecond: 1, peaks: Float32Array.of(0.5), rms: Float32Array.of(0.25),
    });
    try {
      const updated = await getWaveform(ctx, { id: "mic", projectId: "p", name: "mic", path: "mic.mkv", kind: "video", status: "ready" });
      expect(updated?.peaks[0]).toBe(0.5);
      expect((await readWaveformCache(ctx, "p", "mic"))?.peaks[0]).toBe(0.5);
      expect(decode).toHaveBeenCalledOnce();
    } finally { decode.mockRestore(); }
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});
