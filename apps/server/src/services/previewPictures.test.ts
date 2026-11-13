import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeProxy, probeMedia, probeToAssetFields, resolveFfmpeg, runCapture } from "@scarlet/render";
import { previewIdentity, previewPictures, sourceCheckpointDir } from "./previewPictures.js";

it("uses complete, frame-aligned source checkpoints before the full proxy is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "scarlet-early-proxy-"));
  try {
    const media = join(root, "media"), proxies = join(root, "proxies");
    await mkdir(media);
    const file = join(media, "input.mp4"), fps = 30000 / 1001;
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i",
      "nullsrc=s=96x54:r=30000/1001:d=63,geq=lum='16+mod(N*37,210)':cb=128:cr=128",
      "-f", "lavfi", "-i", "sine=duration=63:sample_rate=48000", "-c:v", "libx264", "-threads", "1", "-crf", "0", "-c:a", "aac", file]);
    const m = await probeMedia(file);
    const asset = { id: "camera", path: "input.mp4", name: "Input", kind: "video" as const, ...probeToAssetFields(m), previewClock: m.previewClock };
    const { local } = await previewIdentity(media, asset);
    const dir = sourceCheckpointDir(proxies, local, ""), second = join(dir, "libx264-54", "1.mp4");
    const cancel = new AbortController(), output = join(root, "full.mp4");
    await expect(makeProxy(file, output, { checkpointDir: dir, height: 54, signal: cancel.signal,
      onProgress() { if (existsSync(second)) cancel.abort(); } })).rejects.toThrow();
    expect(existsSync(output)).toBe(false);
    const resolve = previewPictures(media);
    const at = 31.7, part = await resolve(asset, at, at + 1 / fps, 54);
    expect(part?.file).toBe(second);
    const boundary = Math.round(30 * fps) / fps;
    expect(part?.start).toBeCloseTo(boundary, 8);
    const luma = async (path: string, time: number) => (await runCapture(resolveFfmpeg(), ["-v", "error", "-ss", String(time), "-i", path,
      "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "gray", "-an", "-f", "rawvideo", "-"])).stdout[0]!;
    expect(Math.abs(await luma(file, at) - await luma(second, at - part!.start))).toBeLessThan(4);
    expect(await resolve(asset, boundary - .2, boundary + .2, 54)).toBeUndefined();
    expect(await resolve(asset, at, at + 1, 55)).toBeUndefined();
    await writeFile(join(dir, "libx264-54", "2.mp4.uuid.part.mp4"), "unpublished");
    expect(await resolve(asset, 61, 62, 54)).toBeUndefined();
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    expect(await resolve(asset, at, at + 1, 54)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
