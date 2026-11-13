import { createHash, randomUUID } from "node:crypto";
import { open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractWav } from "../render/ffmpeg.js";
import { alignmentVersion } from "../transcribe/wordAlign.js";

type Paths = { paths: { tmp: string; waveforms(projectId: string): string } };

async function stamp(file: string, audioStream?: number) {
  // Ingestion and inspection can reach the same recording through different spellings of the library path.
  const source = await realpath(file);
  const info = await stat(source);
  return [source, info.size, info.mtimeMs, info.ctimeMs, audioStream ?? null] as const;
}

function emissionPath(ctx: Paths, projectId: string, identity: readonly unknown[]) {
  const key = createHash("sha256").update(JSON.stringify([alignmentVersion, identity])).digest("hex");
  return join(ctx.paths.waveforms(projectId), `emissions-${key.slice(0, 32)}.bin`);
}

/**
 * Where a recording's aligner emissions are kept (transcribe/emissions.ts): beside its waveform, named for the file
 * as it is now, so a replaced recording starts a new store. The transcript's alignment and every scan page of the
 * recording read and fill the same one.
 */
export async function emissionStore(ctx: Paths, projectId: string, file: string, audioStream?: number) {
  return emissionPath(ctx, projectId, await stamp(file, audioStream));
}

/** Older engines wrote under the import path during transcription and the resolved path during a scan. */
export async function emissionStorePaths(ctx: Paths, projectId: string, file: string, imported: string, audioStream?: number) {
  const [source, ...identity] = await stamp(file, audioStream);
  return [...new Set([source, file, imported])].map(path => emissionPath(ctx, projectId, [path, ...identity]));
}

/** How long a recording's decode is kept after its last reader, for the next scan page to find it. */
const KEEP_MS = 120_000;
const RATE = 16000;

/** A recording decoded to 16 kHz mono PCM. Times are seconds from its start. */
export interface RecordingAudio {
  wav: string;
  samples: number;
  /** Samples of [from, to), clipped to the recording. */
  pcm(from: number, to: number): Promise<Int16Array>;
  /** Write [from, to) as a WAV of its own, as extractWav would cut it from the source. */
  writeWindow(target: string, from: number, to: number): Promise<void>;
  /** Call when done with it. The file goes two minutes after its last reader. */
  release(): void;
}

type Decode = { wav: string; samples: number; data: number };
const decodes = new Map<string, { decoded: Promise<Decode>; users: number; timer?: ReturnType<typeof setTimeout> }>();

/** Where the samples start in a 16 kHz mono 16-bit WAV, and how many there are. FFmpeg may write LIST chunks first. */
async function wavLayout(path: string) {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const size = (await handle.stat()).size;
    for (let at = 12; at + 8 <= bytesRead;) {
      const id = head.toString("ascii", at, at + 4), bytes = head.readUInt32LE(at + 4), start = at + 8;
      if (id === "data") return { data: start, samples: Math.floor(Math.min(bytes, size - start) / 2) };
      at = start + bytes + bytes % 2;
    }
    throw new Error("The recording's decoded audio has no samples.");
  } finally { await handle.close(); }
}

/**
 * The whole recording as 16 kHz mono PCM, decoded once for everything that reads it while a pass runs: an hour
 * takes about two seconds to decode and 110 MB of scratch space. Cutting each scan page's minute out of the source
 * instead took ffmpeg 0.5 to 0.9 s a page on an 8 GB recording, twice over (the page's audio, and its speech
 * detection), which was as long as the models then ran.
 */
export async function recordingWav(ctx: Paths, file: string, signal: AbortSignal, audioStream?: number): Promise<RecordingAudio> {
  const key = JSON.stringify([ctx.paths.tmp, await stamp(file, audioStream)]);
  let entry = decodes.get(key);
  if (!entry) {
    const wav = join(ctx.paths.tmp, `recording-${randomUUID()}.wav`);
    // The decode outlives the request that started it, so that request's signal doesn't stop it for the others.
    const decoded = extractWav(file, wav, { audioStream }).then(async () => ({ wav, ...await wavLayout(wav) }));
    const created = entry = { decoded, users: 0 };
    decodes.set(key, created);
    decoded.catch(() => { if (decodes.get(key) === created) decodes.delete(key); return rm(wav, { force: true }); });
  }
  const held = entry;
  clearTimeout(held.timer);
  held.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--held.users > 0) return;
    held.timer = setTimeout(() => {
      if (decodes.get(key) === held) decodes.delete(key);
      void held.decoded.then(({ wav }) => rm(wav, { force: true }), () => {});
    }, KEEP_MS);
    held.timer.unref?.();
  };
  try {
    const decoded = await held.decoded;
    signal.throwIfAborted();
    return { ...pcmWindows(decoded), release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Seekable samples and WAV windows in an already decoded recording. The caller owns the file. */
export async function decodedRecording(wav: string) {
  return pcmWindows({ wav, ...await wavLayout(wav) });
}

function pcmWindows({ wav, samples, data }: Decode): Omit<RecordingAudio, "release"> {
  const bytes = async (from: number, to: number) => {
    const first = Math.min(samples, Math.max(0, Math.round(from * RATE))), last = Math.min(samples, Math.max(first, Math.round(to * RATE)));
    const out = Buffer.alloc((last - first) * 2);
    if (out.length) {
      const handle = await open(wav, "r");
      try { await handle.read(out, 0, out.length, data + first * 2); } finally { await handle.close(); }
    }
    return out;
  };
  return {
    wav, samples,
    async pcm(from, to) {
      const out = await bytes(from, to);
      return new Int16Array(out.buffer, out.byteOffset, out.length / 2);
    },
    async writeWindow(target, from, to) {
      const pcm = await bytes(from, to);
      const head = Buffer.alloc(44);
      head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVEfmt ", 8);
      head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
      head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
      head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
      await writeFile(target, Buffer.concat([head, pcm]));
    },
  };
}
