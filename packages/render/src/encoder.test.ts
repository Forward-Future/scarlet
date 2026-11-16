import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withRenderEncoder } from "./encoder.js";
import { FfmpegError } from "./exec.js";

let dir: string;
let ffmpeg: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-encoder-"));
  // An ffmpeg that lists a hardware encoder and passes its one-frame test, so the render below starts on it.
  ffmpeg = path.join(dir, "ffmpeg");
  await fs.writeFile(ffmpeg, "#!/bin/sh\nfor a; do [ \"$a\" = -encoders ] && { echo ' V....D h264_nvenc NVIDIA'; echo ' V....D libx264 x264'; exit 0; }; done\nexit 0\n", { mode: 0o755 });
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32")("retries a preview on x264 when the hardware encoder fails, as an export does", async () => {
  const tried: string[] = [];
  const result = await withRenderEncoder({ width: 640, height: 360, fps: 30 }, { hwaccel: "auto", ffmpegPath: ffmpeg, quality: "preview" }, async attempt => {
    tried.push(attempt.videoEncoder.name);
    if (attempt.videoEncoder.name === "h264_nvenc") {
      throw new FfmpegError("ffmpeg failed", ffmpeg, ["-c:v", "h264_nvenc"], 1, "[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2)");
    }
    return { warnings: [] as string[] };
  });
  expect(tried).toEqual(["h264_nvenc", "libx264"]);
  expect(result.warnings.join("\n")).toContain("h264_nvenc could not encode this preview");
});
