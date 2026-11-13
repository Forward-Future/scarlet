import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { extractWav, ffmpeg, FfmpegError, ffmpegPosition, ffprobe, run } from "./ffmpeg.js";

let directory: string;
let tone: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-ffmpeg-test-"));
  tone = join(directory, "tone.mka");
  // Two seconds with two audio streams: 48 kHz stereo first, then a quieter mono one.
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=2",
    "-map", "0:a", "-ac:a:0", "2", "-map", "1:a", "-ac:a:1", "1", "-c:a", "pcm_s16le", "-y", tone]);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** A script for this Node to run, standing in for a binary with a known stdout, stderr and exit code. */
const node = (script: string, opts?: Parameters<typeof run>[2]) => run(process.execPath, ["-e", script], opts);

/** Sample rate, channels and seconds of a PCM wav, from its header. */
function wav(file: string) {
  const data = readFileSync(file);
  expect(data.toString("latin1", 0, 4) + data.toString("latin1", 8, 12)).toBe("RIFFWAVE");
  const at = data.indexOf("fmt ") + 8;
  const channels = data.readUInt16LE(at + 2), rate = data.readUInt32LE(at + 4), bytes = data.readUInt16LE(at + 14) / 8;
  const size = data.readUInt32LE(data.indexOf("data") + 4);
  return { rate, channels, seconds: Math.round(size / (rate * channels * bytes) * 100) / 100 };
}

it("extracts the sound whisper wants: 16 kHz mono, of the whole file or a part of it", async () => {
  const whole = join(directory, "whole.wav");
  await extractWav(tone, whole);
  expect(wav(whole)).toEqual({ rate: 16000, channels: 1, seconds: 2 });

  const part = join(directory, "part.wav");
  const seen: number[] = [];
  await extractWav(tone, part, { start: 0.5, duration: 1, sampleRate: 8000, audioStream: 1, progress: { duration: 1, onProgress: p => seen.push(p) } });
  const cut = wav(part);
  expect(cut).toMatchObject({ rate: 8000, channels: 1 });
  expect(cut.seconds).toBeCloseTo(1, 1);
  // ffmpeg reports at least once as it ends, and progress stays short of done until the file is closed.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(p => p >= 0 && p <= 0.99)).toBe(true);
});

it("extracts from a start too small to write as a decimal", async () => {
  // Arithmetic on seconds leaves values like 5.5e-17. ffmpeg refuses "5.5e-17" as a position.
  const start = 0.1 + 0.2 - 0.3;
  expect(String(start)).toContain("e-");
  const out = join(directory, "tiny-start.wav");
  await extractWav(tone, out, { start, duration: 1 });
  expect(wav(out)).toEqual({ rate: 16000, channels: 1, seconds: 1 });
  expect([1e-7, -1e-9, 0, 0.000001, 12.5, 3600].map(ffmpegPosition)).toEqual(["0", "0", "0", "0.000001", "12.5", "3600"]);
});

it("keeps a later microphone on the recording clock in transcription WAVs", async () => {
  const camera = join(directory, "later-mic.mkv");
  await ffmpeg(["-f", "lavfi", "-i", "color=s=64x64:r=20:d=2", "-itsoffset", "0.5", "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=16000:duration=1", "-c:v", "libx264", "-c:a", "pcm_s16le", camera]);
  for (const start of [0, 0.25]) {
    const out = join(directory, `late-${start}.wav`);
    await extractWav(camera, out, { start, duration: 1 - start, audioStream: 0 });
    const data = readFileSync(out);
    const pcm = data.subarray(data.indexOf("data") + 8);
    expect(pcm.length).toBe((1 - start) * 16000 * 2);
    const lead = (0.5 - start) * 16000 * 2;
    expect(pcm.subarray(0, lead).every(byte => byte === 0)).toBe(true);
    expect(pcm.subarray(lead).some(byte => byte !== 0)).toBe(true);
  }
});

it("says which stream is missing with ffmpeg's own words when the file has no such audio", async () => {
  const failure = await extractWav(tone, join(directory, "none.wav"), { audioStream: 5 }).then(() => null, e => e as FfmpegError);
  expect(failure).toBeInstanceOf(FfmpegError);
  expect(failure!.message).toMatch(/exited with code \d+: [\s\S]*0:a:5/);
  expect(failure!.args).toContain("0:a:5");
});

it("reads a file's streams with ffprobe", async () => {
  const out = await ffprobe(["-select_streams", "a", "-show_entries", "stream=channels", "-of", "csv=p=0", tone]);
  expect(out.toString().trim().split(/\s+/)).toEqual(["2", "1"]);
});

it("returns what a program wrote, and counts it as it arrives", async () => {
  const counts: number[] = [];
  const out = await node("process.stdout.write('one'); setTimeout(() => process.stdout.write('two'), 50)", { onStdoutBytes: n => counts.push(n) });
  expect(out.toString()).toBe("onetwo");
  expect(counts.at(-1)).toBe(6);
});

it("keeps no more of a program's output than it was told to", async () => {
  const out = await node("for (let i = 0; i < 40; i++) process.stdout.write('x'.repeat(65536))", { maxStdout: 100_000 });
  // Whole chunks are kept until the limit is passed, and nothing after.
  expect(out.length).toBeGreaterThanOrEqual(100_000);
  expect(out.length).toBeLessThan(40 * 65536);
});

it("fails with the last lines a program wrote to stderr when it exits with an error", async () => {
  const failure = await node("for (let i = 1; i <= 9; i++) console.error('line ' + i); process.exit(3)").then(() => null, e => e as FfmpegError);
  expect(failure).toBeInstanceOf(FfmpegError);
  expect(failure!.message).toBe(`${process.execPath} exited with code 3: line 4\nline 5\nline 6\nline 7\nline 8\nline 9`);
  expect(failure!.stderr).toContain("line 1\n");
});

it("fails with the reason when a program can't be started", async () => {
  const failure = await run(join(directory, "no-such-binary"), ["-version"]).then(() => null, e => e as FfmpegError);
  expect(failure).toBeInstanceOf(FfmpegError);
  expect(failure!.message).toMatch(/no-such-binary failed to start: .*ENOENT/);
});

it("stops a program when it is cancelled, and doesn't start one that already was", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const running = node("console.error('ready'); setInterval(() => {}, 1000)", {
    signal: controller.signal, onStderrLine: line => { lines.push(line); controller.abort(); },
  });
  await expect(running).rejects.toThrow(`${process.execPath} cancelled`);
  expect(lines).toEqual(["ready"]);
  await expect(node("process.exit(0)", { signal: controller.signal })).rejects.toThrow(/abort/i);
});

it("hands over each whole line of stderr, however it was split on the way", async () => {
  const lines: string[] = [];
  await node("process.stderr.write('progress = 1'); setTimeout(() => process.stderr.write('0%\\n  progress = 20%  \\nunfinished'), 50)", { onStderrLine: line => lines.push(line) });
  expect(lines).toEqual(["progress = 10%", "progress = 20%"]);
});

it("turns ffmpeg's progress lines into a fraction of the expected length", async () => {
  const seen: number[] = [];
  const script = "console.log('frame=1\\nout_time_us=500000\\nprogress=continue\\nout_time_ms=1500000\\nout_time_us=9000000\\nprogress=end')";
  const out = await node(script, { duration: 2, onProgress: p => seen.push(p) });
  // Half a second and a second and a half of two; past the end is held just short of done.
  expect(seen).toEqual([0.25, 0.75, 0.99]);
  // The progress stream isn't the program's result.
  expect(out.length).toBe(0);
  // With no expected length there is nothing to measure against.
  const unknown: number[] = [];
  await node(script, { onProgress: p => unknown.push(p) });
  expect(unknown).toEqual([]);
});

it("passes on messages from a Node worker beside its result", async () => {
  const messages: unknown[] = [];
  const out = await node("process.send({ done: 0.5 }, () => { process.stdout.write('result'); process.disconnect(); })", { onMessage: m => messages.push(m) });
  expect(messages).toEqual([{ done: 0.5 }]);
  expect(out.toString()).toBe("result");
});
