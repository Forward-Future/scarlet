/**
 * A recording's aligner emissions, kept on disk so the audio is inferred once.
 *
 * Word alignment is one wav2vec2 pass over the audio and a cheap Viterbi search over its output. A dialogue pass
 * aligns the same audio twice: the transcript's words, and each scan page's verbatim words. The model pass is nearly
 * all of the time (0.8 s per 30 s window on eight cores, against milliseconds for the search), so its output is saved
 * here and both read it. The windows sit on one grid for the whole recording (`planChunks` over its length), so a
 * frame is the same whoever asked for it first, and a window nobody's words fall in is never inferred.
 *
 * Layout: a 16-byte header (magic, version, samples, window count), one done flag per window, then one row of
 * CLASSES float32 log-probabilities per frame. A window's flag is set after its rows are on disk.
 */
import { open, type FileHandle } from "node:fs/promises";
import { CLASSES, FRAME_SECONDS, framesFor, planChunks } from "./ctcAlign.js";

const MAGIC = 0x4d454353; // "SCEM"
const VERSION = 1;
const HEADER = 16;
const ROW = CLASSES * 4;

export class EmissionFile {
  readonly chunks: ReturnType<typeof planChunks>;
  readonly frames: number;
  private readonly data: number;

  private constructor(private readonly handle: FileHandle, readonly samples: number, private readonly flags: Uint8Array) {
    this.chunks = planChunks(samples);
    this.frames = framesFor(samples);
    this.data = dataOffset(this.chunks.length);
  }

  /**
   * Open a recording's store. With `samples` (the length of its 16 kHz decode) a missing or mismatched store is
   * created empty. Without it, null means there is nothing saved to read.
   */
  static async open(path: string, samples?: number): Promise<EmissionFile | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, samples === undefined ? "r" : "r+");
        const head = Buffer.alloc(HEADER);
        const { bytesRead } = await handle.read(head, 0, HEADER, 0);
        const saved = bytesRead === HEADER && head.readUInt32LE(0) === MAGIC && head.readUInt32LE(4) === VERSION ? head.readUInt32LE(8) : undefined;
        const count = saved === undefined ? -1 : planChunks(saved).length;
        if (saved !== undefined && head.readUInt32LE(12) === count && (samples === undefined || samples === saved)) {
          const flags = Buffer.alloc(count);
          if (count) await handle.read(flags, 0, count, HEADER);
          const file = new EmissionFile(handle, saved, flags);
          handle = undefined;
          return file;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally { await handle?.close(); }
      if (samples === undefined) return null;
      // Absent, from another version, or of a recording that has since changed length: start it empty.
      const count = planChunks(samples).length;
      const fresh = await open(path, "w");
      try {
        const head = Buffer.alloc(dataOffset(count));
        head.writeUInt32LE(MAGIC, 0);
        head.writeUInt32LE(VERSION, 4);
        head.writeUInt32LE(samples, 8);
        head.writeUInt32LE(count, 12);
        await fresh.write(head, 0, head.length, 0);
        await fresh.truncate(head.length + framesFor(samples) * ROW);
      } finally { await fresh.close(); }
    }
    throw new Error("Could not prepare the recording's alignment store.");
  }

  /** Global frame range [from, to) covering the given seconds of the recording. */
  frameRange(start: number, end: number): [number, number] {
    const from = Math.min(this.frames, Math.max(0, Math.floor(start / FRAME_SECONDS + 1e-6)));
    return [from, Math.min(this.frames, Math.max(from, Math.ceil(end / FRAME_SECONDS - 1e-6)))];
  }

  /** Windows that hold frames [from, to) and are not saved yet. */
  missing(from: number, to: number): number[] {
    const out: number[] = [];
    this.chunks.forEach((chunk, i) => {
      if (!this.flags[i] && chunk.keep[0] < to && chunk.keep[1] > from) out.push(i);
    });
    return out;
  }

  /** Save one window's kept frames: `rows` is (keep[1] − keep[0]) × CLASSES log-probabilities. */
  async write(index: number, rows: Float32Array) {
    const [from, to] = this.chunks[index]!.keep;
    if (rows.length !== (to - from) * CLASSES) throw new Error("Alignment window has the wrong number of frames.");
    await this.handle.write(Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength), 0, rows.byteLength, this.data + from * ROW);
    // The flag says the rows can be trusted, so they reach the disk first.
    await this.handle.datasync();
    this.flags[index] = 1;
    await this.handle.write(this.flags, index, 1, HEADER + index);
  }

  /** Log-probabilities of frames [from, to). Every window holding them must be saved. */
  async read(from: number, to: number): Promise<Float32Array> {
    if (this.missing(from, to).length) throw new Error("Alignment frames were read before they were saved.");
    const bytes = Buffer.alloc(Math.max(0, to - from) * ROW);
    if (bytes.length) await this.handle.read(bytes, 0, bytes.length, this.data + from * ROW);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  }

  close() { return this.handle.close(); }
}

/** Rows start on a 16-byte boundary after the flags. */
function dataOffset(chunks: number) {
  return Math.ceil((HEADER + chunks) / 16) * 16;
}
