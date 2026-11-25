/**
 * Whether a recording's sound keeps time with its own picture, from a face talking in it: a few stretches across the
 * recording, each measured on its own (render/lipSync.ts), so a steady offset shows as the same answer everywhere and
 * a drifting one as answers that grow. Each stretch is measured once and kept beside the waveform. This is evidence
 * for the model, never a verdict: whether and how far to shift the sound is its call.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { curvePeak, fileInDirectory, heardAudio, heardAudioKey, lipSyncStretch, type CropBox, type LipSyncReading } from "@scarlet/render";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { atomicWriteFile, rememberLast } from "../util.js";
import { logId } from "../logText.js";
import { faceSamples, type FaceSample } from "./faces.js";
import { r3, readingIdentity, type VideoMedia } from "./pictureReading.js";
import { pictureDecoder, pictureLane } from "./pictureWork.js";

/** Bump when the measurement changes. Kept stretches are measured again. */
const LIP_SYNC_VERSION = 3;
/** Seconds either way a stretch looks for the sound's shift. */
const MAX_SHIFT = 1.5;
/** Stretches measured by default, and their length: six of 30 s found the same 0.65 s on a 35-minute recording, each 0.6-0.7 s. */
export const LIP_SYNC_STRETCHES = 6;
export const LIP_SYNC_SECONDS = 30;

export interface LipSyncStretch {
  /** Source seconds measured. */
  from: number; to: number;
  /** The face measured: where its mouth was looked at (fractions of the frame), roughly where it looks and its seconds in frame in the stretch. */
  face?: { mouth: [number, number, number, number]; yaw: number; seconds: number };
  /** The measurement, when there is one. */
  reading?: LipSyncReading;
  /** The match at each shift a frame apart, kept to read the stretches together. */
  curve?: number[];
  /** Why the stretch wasn't measured. */
  unmeasured?: string;
}

export interface LipSyncResult {
  mediaId: string;
  /** Seconds a frame lasts: a measurement finer than about half of it is noise. */
  frameSeconds: number;
  stretches: Array<Omit<LipSyncStretch, "curve">>;
  /**
   * The stretches measured, read together: the match at each shift averaged over them, and where that peaks. One
   * stretch's peak can wander a few tenths of a second where the speaker moves their head or pauses; together they
   * settle on the shift they share.
   */
  together?: LipSyncReading & { stretches: number };
  /** Whether every stretch has an answer. Stretches still being measured go on in the background: ask again. */
  done: boolean;
}

/** The stretches to measure across `from`-`to`: `count` of `seconds` each, spread evenly, or the whole range when it is shorter. */
export function lipSyncStretches(from: number, to: number, count = LIP_SYNC_STRETCHES, seconds = LIP_SYNC_SECONDS): Array<{ from: number; to: number }> {
  const length = to - from;
  if (!(length > 0)) return [];
  if (length <= seconds * count) {
    const n = Math.max(1, Math.min(count, Math.round(length / seconds)));
    return Array.from({ length: n }, (_, i) => ({ from: r3(from + i * length / n), to: r3(from + (i + 1) * length / n) }));
  }
  return Array.from({ length: count }, (_, i) => {
    const middle = from + (i + 0.5) * length / count;
    return { from: r3(middle - seconds / 2), to: r3(middle + seconds / 2) };
  });
}

/**
 * The face to measure in a stretch and its mouth's area: the face in frame most often, its box where it usually is
 * (the middle of each side over the frames it was seen in). Faces are kept as tracks only in `faces`; here a frame's
 * faces are told apart by place, the one nearest where the face was last seen. The detector's box runs from about the
 * hairline to under the chin; the mouth is in its lower third, a little past the chin when it opens.
 */
export function mouthOf(samples: readonly FaceSample[], from: number, to: number) {
  const seen = samples.filter(s => s.at >= from && s.at < to);
  const groups: Array<Array<{ box: number[]; yaw: number }>> = [];
  const centre = (box: readonly number[]) => [(box[0]! + box[2]!) / 2, (box[1]! + box[3]!) / 2] as const;
  for (const sample of seen) {
    for (const [x0, y0, x1, y1, , yaw] of sample.faces) {
      const box = [x0, y0, x1, y1], [cx, cy] = centre(box);
      const near = groups.find(g => {
        const last = g.at(-1)!.box, [lx, ly] = centre(last);
        return Math.hypot(cx - lx, cy - ly) <= last[2]! - last[0]!;
      });
      (near ?? (groups[groups.length] = [])).push({ box, yaw });
    }
  }
  const group = groups.sort((a, b) => b.length - a.length)[0];
  if (!group || seen.length < 2) return;
  const median = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return v[v.length >> 1]!; };
  const [x0, y0, x1, y1] = [0, 1, 2, 3].map(i => median(group.map(g => g.box[i]!))) as [number, number, number, number];
  const w = x1 - x0, h = y1 - y0;
  const mouth = [Math.max(0, x0 + 0.15 * w), Math.max(0, y0 + 0.62 * h), Math.min(1, x1 - 0.15 * w), Math.min(1, y1 + 0.08 * h)].map(r3) as [number, number, number, number];
  // Frames are looked at about twice a second: the face's seconds in frame are its share of the frames looked at.
  return { mouth, yaw: Math.round(median(group.map(g => g.yaw)) / 5) * 5, seconds: r3((to - from) * group.length / seen.length) };
}

interface Kept { identity: string; stretches: Record<string, LipSyncStretch> }

const keptFiles = new Map<string, Promise<Kept>>();
const measuring = new Map<string, Promise<LipSyncStretch>>();
/** The save of each file under way, the next waiting for it. */
const saving = new Map<string, Promise<void>>();
const MAX_KEPT = 32;
const STILL_FINDING = "The faces in this stretch are still being found: ask again.";
const STILL_MEASURING = "Still being measured: ask again.";

function identity(media: MediaAsset) {
  // A reading against a track the editor chose is that track's. The first track's readings keep their name.
  const heard = heardAudioKey(heardAudio(media));
  return readingIdentity(LIP_SYNC_VERSION, media, MAX_SHIFT, ...heard === null ? [] : [heard]);
}

/** Measure each stretch of a recording not measured yet, waiting up to `waitMs` for the answers; the rest carry on and are kept. */
export async function lipSync(ctx: Ctx, media: VideoMedia, range: { from?: number; to?: number; count?: number; seconds?: number },
  opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<LipSyncResult> {
  if (media.kind !== "video") throw new Error("Only a video has a picture to keep time with.");
  if (media.hasAudio === false) throw new Error("This video has no sound of its own to measure against its picture.");
  const duration = media.duration;
  if (!duration || !media.width || !media.height || !media.fps) throw new Error("The recording is still being prepared. Ask again in a moment.");
  const file = fileInDirectory(ctx.paths.media(media.projectId), media.path);
  if (!file) throw new Error("The recording's file is missing.");
  const fps = media.fps, width = media.width, height = media.height;
  const from = Math.max(0, range.from ?? 0), to = Math.min(duration, range.to ?? duration);
  const stretches = lipSyncStretches(from, to, range.count, range.seconds);

  const path = join(ctx.paths.waveforms(media.projectId), `${media.id}.lip-sync.json`);
  const fileKey = `${path}\0${identity(media)}`;
  const kept = await rememberLast(keptFiles, fileKey, keptFiles.get(fileKey) ?? (async (): Promise<Kept> => {
    try {
      const read = JSON.parse(await readFile(path, "utf8")) as Kept;
      if (read.identity === identity(media) && read.stretches) return read;
    } catch { /* Not measured yet. */ }
    return { identity: identity(media), stretches: {} };
  })(), MAX_KEPT);
  // Stretches finish together, so their saves go one after another, each with all that is kept by then: run side by
  // side, an earlier save that landed last would leave the file without stretches measured after it.
  const save = () => {
    const next = (saving.get(path) ?? Promise.resolve()).catch(() => {})
      .then(() => atomicWriteFile(path, JSON.stringify(kept), `${path}.${randomUUID()}.tmp`));
    saving.set(path, next);
    void next.catch(error => ctx.log(`[media] lip-sync-save-failed id=${logId(media.id)} project=${logId(media.projectId)} ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (saving.get(path) === next) saving.delete(path); });
    return next;
  };

  const measure = (stretch: { from: number; to: number }) => {
    const key = `${stretch.from}-${stretch.to}`;
    if (kept.stretches[key]) return Promise.resolve(kept.stretches[key]!);
    const running = measuring.get(`${fileKey}\0${key}`);
    if (running) return running;
    const job = ctx.track((async (): Promise<LipSyncStretch> => {
      const signal = ctx.projectSignal(media.projectId);
      // The faces in the stretch say where the mouth is: found once for the video and kept, as `faces` answers.
      const found = await faceSamples(ctx, media, stretch, { waitMs: 120_000, signal });
      // Not kept: asked again, the faces may be found by then.
      if (!found.done) return { ...stretch, unmeasured: found.error ? `Faces couldn't be found: ${found.error}` : STILL_FINDING };
      const face = mouthOf(found.samples, stretch.from, stretch.to);
      const length = stretch.to - stretch.from;
      let result: LipSyncStretch;
      if (!face || face.seconds < length / 2) {
        result = { ...stretch, ...(face && { face }), unmeasured: face ? `A face is in frame for only ${face.seconds.toFixed(1)} of ${length.toFixed(0)} s.` : "No face is in frame." };
      } else {
        const decoder = await pictureDecoder(ctx.settings().render.hwaccel);
        const reading = await pictureLane(ctx).run(() => lipSyncStretch(file, { start: stretch.from, end: stretch.to },
          { box: face.mouth satisfies CropBox, width, height, fps, maxShift: MAX_SHIFT, decoder, signal, audio: heardAudio(media) }), { signal });
        const { curve, ...measured } = reading;
        result = { ...stretch, face, reading: measured, curve };
      }
      kept.stretches[key] = result;
      await save();
      return result;
    })(), media.projectId).finally(() => measuring.delete(`${fileKey}\0${key}`));
    measuring.set(`${fileKey}\0${key}`, job);
    return job;
  };

  const jobs = stretches.map(s => measure(s).catch((error: unknown): LipSyncStretch =>
    ({ ...s, unmeasured: `Couldn't measure: ${error instanceof Error ? error.message : String(error)}` })));
  const answers: Array<LipSyncStretch | undefined> = stretches.map(() => undefined);
  jobs.forEach((job, i) => void job.then(a => { answers[i] = a; }));
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, opts.waitMs ?? 60_000);
    function done() { clearTimeout(timer); opts.signal?.removeEventListener("abort", done); resolve(); }
    opts.signal?.addEventListener("abort", done, { once: true });
    void Promise.all(jobs).then(done);
  });
  // A moment for answers that settled with the last of them.
  await Promise.resolve();
  const curves = answers.flatMap(a => a?.curve && a.reading ? [{ curve: a.curve, frames: a.reading.frames }] : []);
  const lags = curves[0]?.curve.length ?? 0;
  const together = curves.length > 1 && curves.every(c => c.curve.length === lags)
    ? { ...curvePeak(Array.from({ length: lags }, (_, i) => curves.reduce((n, c) => n + c.curve[i]!, 0) / curves.length), fps,
        curves.reduce((n, c) => n + c.frames, 0)), stretches: curves.length }
    : undefined;
  return {
    mediaId: media.id, frameSeconds: r3(1 / fps),
    stretches: stretches.map((s, i) => { const { curve: _, ...shown } = answers[i] ?? { ...s, unmeasured: STILL_MEASURING }; return shown; }),
    ...(together && { together }),
    done: answers.every(a => a && a.unmeasured !== STILL_FINDING),
  };
}
