// How fast new footage becomes smooth to play: the 8 s 480p source chunk, the checkpointed 540p
// source proxy, six thumbnails from the original and from the proxy, and the full waveform.
//
//   node packages/render/bench/preview-copies.mjs make-source <file.mp4> [seconds]
//     Writes a 32 s (or longer) 3840x2160 30000/1001 H.264/AAC camera-like test recording (grain keeps it from
//     compressing like a flat test card). Keep it outside the repo.
//   node packages/render/bench/preview-copies.mjs pass <source> [--dist <render dist dir>]
//     One cold pass in this process; prints timings and fingerprints of every output as JSON.
//   node packages/render/bench/preview-copies.mjs ab <source> <distA> <distB> [rounds]
//     Alternates A and B passes (ABAB...) in fresh processes and prints median and P95 per step,
//     and whether both sides made the same outputs.
// Run after pnpm --filter @scarlet/render... build. SCARLET_BENCH_HWACCEL picks the policy (default auto).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const [mode, source, ...rest] = process.argv.slice(2);
const hwaccel = process.env.SCARLET_BENCH_HWACCEL ?? "auto";
const THUMBS = [1.5, 13.2, 8.3, 2.3, 10.6, 4.8];

async function frames(file) {
  // Count every picture and read its size and the stream's length from the decoded output.
  const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_read_frames,duration,codec_name,pix_fmt", "-of", "json", file]);
  const [s] = JSON.parse(stdout).streams;
  const audio = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
    "stream=codec_name,channels,sample_rate,duration", "-of", "json", file])).stdout).streams[0] ?? null;
  // Decoded pictures and sound, so a faster path is shown to make the same copy and not only one of the same size.
  const md5 = async map => (await run("ffmpeg", ["-v", "error", "-i", file, "-map", map, "-f", "md5", "-"])).stdout.trim().slice(4, 20);
  return { width: s.width, height: s.height, frames: Number(s.nb_read_frames), duration: Number(s.duration), codec: s.codec_name, pix: s.pix_fmt, audio,
    pictures: await md5("0:v:0"), sound: audio ? await md5("0:a:0") : null };
}

async function pass(file, dist) {
  const R = await import(pathToFileURL(join(resolve(dist), "index.js")).href);
  const dir = await mkdtemp(join(tmpdir(), "scarlet-preview-copies-"));
  const times = {}, out = {};
  const measure = async (label, fn) => {
    const start = performance.now();
    const value = await fn();
    times[label] = performance.now() - start;
    return value;
  };
  try {
    const meta = await measure("probe", () => R.probeMedia(file));
    const chunk = join(dir, "chunk.mp4"), proxy = join(dir, "proxy.mp4");
    await measure("chunk", () => R.makeProxy(file, chunk, { height: 480, hwaccel, range: { start: 6, end: 14 } }));
    await measure("proxy", () => R.makeProxy(file, proxy, { height: 540, hwaccel, checkpointDir: join(dir, "parts") }));
    // "thumbsOriginal" is the editor-media benchmark's call; "thumbsIndexed" is the frame route's for an MP4 original
    // (it reads the movie's index and knows the rate), as is "thumbsProxy" for the prepared copy.
    for (const [label, input, indexed] of [["thumbsOriginal", file, false], ["thumbsIndexed", file, true], ["thumbsProxy", proxy, true]]) {
      const jpegs = await measure(label, async () => {
        const list = [];
        for (const t of THUMBS) list.push(await R.extractFrame(input, t, { width: 160, ...(indexed ? { indexedMp4: true, fps: meta.fps } : {}) }));
        return list;
      });
      out[label] = jpegs.map(j => createHash("sha256").update(j).digest("hex").slice(0, 16));
    }
    const wave = await measure("waveform", () => R.extractWaveformFull(file, meta.duration));
    out.waveform = createHash("sha256").update(Buffer.from(wave.peaks.buffer, wave.peaks.byteOffset, wave.peaks.byteLength)).digest("hex").slice(0, 16);
    out.chunk = await frames(chunk);
    out.proxy = await frames(proxy);
    return { times, out, dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { median: +((sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2).toFixed(1), p95: +q(0.95).toFixed(1), runs: sorted.length };
};

if (mode === "make-source") {
  assert(source, "Give the output file");
  const seconds = String(Number(rest[0] ?? 32.07));
  await run("ffmpeg", ["-v", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=3840x2160:r=30000/1001:d=${seconds},noise=alls=12:allf=t`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "30M", "-maxrate", "40M", "-bufsize", "60M", "-g", "60",
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", source], { maxBuffer: 1 << 26 });
  console.log(JSON.stringify(await frames(source)));
} else if (mode === "pass") {
  const dist = rest[rest.indexOf("--dist") + 1] && rest.includes("--dist") ? rest[rest.indexOf("--dist") + 1] : fileURLToPath(new URL("../dist", import.meta.url));
  const { times, out, dir } = await pass(source, dist);
  // Keep the proxy for an optional quality comparison, then clean up.
  if (process.env.SCARLET_BENCH_KEEP) {
    await run("cp", [join(dir, "proxy.mp4"), process.env.SCARLET_BENCH_KEEP + "-proxy.mp4"]);
    await run("cp", [join(dir, "chunk.mp4"), process.env.SCARLET_BENCH_KEEP + "-chunk.mp4"]);
  }
  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ times, out }));
} else if (mode === "ab") {
  const [a, b, roundsArg] = rest;
  const rounds = Number(roundsArg ?? 6);
  assert(source && a && b && Number.isSafeInteger(rounds) && rounds > 0);
  const self = fileURLToPath(import.meta.url);
  const sides = { A: { dist: a, times: {}, outs: [] }, B: { dist: b, times: {}, outs: [] } };
  for (let i = 0; i < rounds; i++) {
    for (const key of i % 2 ? ["B", "A"] : ["A", "B"]) {
      const side = sides[key];
      const { stdout } = await run(process.execPath, [self, "pass", source, "--dist", side.dist], { maxBuffer: 1 << 24, env: process.env });
      const { times, out } = JSON.parse(stdout);
      for (const [k, v] of Object.entries(times)) (side.times[k] ??= []).push(v);
      side.outs.push(JSON.stringify(out));
      process.stderr.write(`round ${i + 1} ${key}: ` + Object.entries(times).map(([k, v]) => k + "=" + v.toFixed(0)).join(" ") + "\n");
    }
  }
  const summary = {};
  for (const k of Object.keys(sides.A.times)) {
    const A = stats(sides.A.times[k]), B = stats(sides.B.times[k]);
    summary[k] = { A, B, medianChange: +((B.median / A.median - 1) * 100).toFixed(1) + "%" };
  }
  const stable = side => new Set(side.outs).size === 1;
  console.log(JSON.stringify({ hwaccel, rounds, summary,
    sameOutputWithinA: stable(sides.A), sameOutputWithinB: stable(sides.B),
    outputsA: JSON.parse(sides.A.outs[0]), outputsB: JSON.parse(sides.B.outs[0]),
    distinctA: [...new Set(sides.A.outs)].map(o => JSON.parse(o)), distinctB: [...new Set(sides.B.outs)].map(o => JSON.parse(o)) }, null, 2));
} else if (mode === "import-frame") {
  // The import's first frame as the engine asks for it: probe, then the 960 px frame at 0 s, read by scanning the file
  // ("scan") or through the MP4 index the probe found ("indexed"). One cold call per process.
  const R = await import(pathToFileURL(fileURLToPath(new URL("../dist/index.js", import.meta.url))).href);
  const start = performance.now();
  const probe = await R.probeMedia(source);
  const fields = R.probeToAssetFields(probe);
  const indexed = rest[0] === "indexed" && !!probe.previewClock && probe.videoCodec === "h264" && probe.hasAlpha === false;
  const jpeg = await R.extractFrame(source, 0, { width: 960, hdr: fields.color?.hdr, ...(indexed ? { indexedMp4: true, fps: fields.fps } : {}) });
  console.log(JSON.stringify({ ms: performance.now() - start, indexed, jpeg: createHash("sha256").update(jpeg).digest("hex").slice(0, 16) }));
} else if (mode === "import-frame-ab") {
  const rounds = Number(rest[0] ?? 10);
  const self = fileURLToPath(import.meta.url);
  const sides = { scan: [], indexed: [] }, hashes = new Set();
  for (let i = 0; i < rounds; i++) {
    for (const side of i % 2 ? ["indexed", "scan"] : ["scan", "indexed"]) {
      const { ms, jpeg } = JSON.parse((await run(process.execPath, [self, "import-frame", source, side])).stdout);
      sides[side].push(ms);
      hashes.add(jpeg);
    }
  }
  console.log(JSON.stringify({ rounds, scan: stats(sides.scan), indexed: stats(sides.indexed), sameFrame: hashes.size === 1 }));
} else {
  throw new Error("Usage: preview-copies.mjs make-source|pass|ab ...");
}
