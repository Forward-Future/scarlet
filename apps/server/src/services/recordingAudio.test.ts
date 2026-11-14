import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as ffmpeg from "../render/ffmpeg.js";
import { emissionStore, recordingWav } from "./recordingAudio.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-recording-audio-")); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const ctx = () => ({ paths: { tmp: dir, waveforms: () => dir } });
const signal = new AbortController().signal;

/** Three seconds at 16 kHz where each sample is its own index, behind the LIST chunk FFmpeg writes. */
function decodeAsFfmpeg() {
  return vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, target) => {
    const samples = 3 * 16000, list = Buffer.from("LIST\x04\x00\x00\x00INFO", "latin1");
    const head = Buffer.alloc(36);
    head.write("RIFF", 0); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
    head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    const data = Buffer.alloc(8 + samples * 2);
    data.write("data", 0); data.writeUInt32LE(samples * 2, 4);
    for (let i = 0; i < samples; i++) data.writeInt16LE(i % 30000, 8 + i * 2);
    await writeFile(target, Buffer.concat([head, list, data]));
  });
}

it("decodes a recording once for every reader and cuts windows from that decode", async () => {
  const source = join(dir, "interview.mp4");
  await writeFile(source, "recording");
  const decode = decodeAsFfmpeg();
  const [first, second] = await Promise.all([recordingWav(ctx(), source, signal), recordingWav(ctx(), source, signal)]);
  expect(decode).toHaveBeenCalledTimes(1);
  expect(first.wav).toBe(second.wav);
  expect(first.samples).toBe(48000);
  // Half a second from 1 s: samples 16000 to 23999.
  const pcm = await first.pcm(1, 1.5);
  expect([pcm.length, pcm[0], pcm.at(-1)]).toEqual([8000, 16000, 23999]);
  // Past the end reads what there is.
  expect((await first.pcm(2.5, 9)).length).toBe(8000);
  const window = join(dir, "window.wav");
  await first.writeWindow(window, 1, 2);
  const bytes = await readFile(window);
  expect(bytes.length).toBe(44 + 32000);
  expect([bytes.toString("latin1", 0, 4), bytes.toString("latin1", 36, 40), bytes.readUInt32LE(24), bytes.readUInt32LE(40)]).toEqual(["RIFF", "data", 16000, 32000]);
  expect([bytes.readInt16LE(44), bytes.readInt16LE(44 + 31998)]).toEqual([16000, 31999 % 30000]);
  first.release(); second.release();
});

it("shares emissions across directory aliases while keeping different audio streams separate", async () => {
  const media = join(dir, "media");
  const alias = join(dir, "linked-media");
  await mkdir(media);
  await symlink(media, alias, "junction");
  const source = join(media, "interview.wav"), otherPath = join(alias, "interview.wav");
  await writeFile(source, "recording");
  const store = await emissionStore(ctx(), "p", source, 1);
  expect(await emissionStore(ctx(), "p", otherPath, 1)).toBe(store);
  expect(await emissionStore(ctx(), "p", otherPath, 0)).not.toBe(store);
});

it("keeps the decode for the next reader, then removes it once nobody has read it for two minutes", async () => {
  vi.useFakeTimers();
  const source = join(dir, "interview.mp4");
  await writeFile(source, "recording");
  const decode = decodeAsFfmpeg();
  const decoded = async () => (await readdir(dir)).filter(name => name.startsWith("recording-"));
  const page = await recordingWav(ctx(), source, signal);
  page.release();
  await vi.advanceTimersByTimeAsync(60_000);
  const next = await recordingWav(ctx(), source, signal);
  expect(decode).toHaveBeenCalledTimes(1);
  next.release();
  next.release();
  await vi.advanceTimersByTimeAsync(119_000);
  expect(await decoded()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.waitFor(async () => expect(await decoded()).toEqual([]));
  // A replaced recording is another decode, and another emission store.
  const before = await emissionStore(ctx(), "p", source);
  expect(await emissionStore(ctx(), "p", source)).toBe(before);
  await writeFile(source, "a different recording");
  expect(await emissionStore(ctx(), "p", source)).not.toBe(before);
  (await recordingWav(ctx(), source, signal)).release();
  expect(decode).toHaveBeenCalledTimes(2);
});

it("lets the next reader decode again after a decode fails", async () => {
  const source = join(dir, "interview.mp4");
  await writeFile(source, "recording");
  const decode = vi.spyOn(ffmpeg, "extractWav").mockRejectedValueOnce(new Error("unreadable audio"));
  await expect(recordingWav(ctx(), source, signal)).rejects.toThrow("unreadable audio");
  decode.mockRestore();
  decodeAsFfmpeg();
  const again = await recordingWav(ctx(), source, signal);
  expect(again.samples).toBe(48000);
  again.release();
});

it("leaves a decode it can't delete where it is, without an unhandled failure that would stop the engine", async () => {
  vi.useFakeTimers();
  const source = join(dir, "interview.mp4");
  await writeFile(source, "recording");
  decodeAsFfmpeg();
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const page = await recordingWav(ctx(), source, signal);
    // Something else holds the file, as a virus scanner does on Windows: stand in a folder, which the delete refuses.
    await rm(page.wav, { force: true });
    await mkdir(page.wav);
    page.release();
    await vi.advanceTimersByTimeAsync(121_000);
    vi.useRealTimers();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off("unhandledRejection", unhandled); }
});
