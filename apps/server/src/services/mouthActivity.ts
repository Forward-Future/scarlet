/**
 * Per-face mouth movement activity over requested source stretches of a video.
 * Reuses the cached face detector (`faces.ts`) and `mouthMotion` (`@scarlet/render`)
 * so `multicam_analyze` can correlate which visible face speaks during each speaker
 * or microphone turn without guessing blindly.
 */
import { fileInDirectory, mouthMotion, type CropBox } from "@scarlet/render";
import type { Ctx } from "../context.js";
import { clip, logId, throttledPerCtx } from "../logText.js";
import { faces, type FaceTrack } from "./faces.js";
import { r3, type VideoMedia } from "./pictureReading.js";
import { pictureDecoder, pictureLane } from "./pictureWork.js";

/** A GPU decoder that fails does so for every stretch and face: its fallback is logged once a minute for each recording. */
const fellBack = throttledPerCtx();

/** Compact output rate (samples per second) for mouth movement series. */
export const MOUTH_ACTIVITY_RATE = 5;
/** Maximum stretches and total seconds measured in one request. */
export const MOUTH_MAX_STRETCHES = 6;
export const MOUTH_MAX_STRETCH_SECONDS = 30;
export const MOUTH_MAX_TOTAL_SECONDS = 90;
/** At most this many prominent faces per camera are measured. */
const MAX_FACES = 4;

export interface MouthActivityFace {
  track: number;
  box: [number, number, number, number];
  mouth: [number, number, number, number];
  seconds: number;
  confidence: number;
  stretches: Array<{ from: number; to: number; values: number[] }>;
}

export interface MouthActivityResult {
  mediaId: string;
  sampleRate: number;
  faces: MouthActivityFace[];
  done: boolean;
  error?: string;
}

/** Mouth bounding box derived from a face bounding box (matches `lipSync.ts`). */
export function mouthBoxFor(box: readonly [number, number, number, number]): [number, number, number, number] {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  return [
    r3(Math.max(0, x0 + 0.15 * w)),
    r3(Math.max(0, y0 + 0.62 * h)),
    r3(Math.min(1, x1 - 0.15 * w)),
    r3(Math.min(1, y1 + 0.08 * h)),
  ];
}

/** Downsample per-frame mouth motion values to `targetRate` Hz by averaging each bin. */
export function binMouthMotion(frameMotion: ArrayLike<number>, fps: number, targetRate = MOUTH_ACTIVITY_RATE): number[] {
  const n = frameMotion.length;
  if (!n || !(fps > 0) || !(targetRate > 0)) return [];
  const duration = n / fps;
  const bins = Math.max(1, Math.round(duration * targetRate));
  const out = new Array<number>(bins);
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b / bins) * n);
    const end = Math.max(start + 1, Math.floor(((b + 1) / bins) * n));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end && i < n; i++) {
      sum += frameMotion[i]!;
      count++;
    }
    out[b] = count ? r3(sum / count) : 0;
  }
  return out;
}

/** Pick prominent face tracks to measure: highest screen time, filtering out brief low-confidence detections. */
export function prominentFaceTracks(tracks: readonly FaceTrack[], maxFaces = MAX_FACES): FaceTrack[] {
  const ranked = [...tracks]
    .filter(t => t.seconds >= 1 && t.confidence >= 0.45)
    .sort((a, b) => b.seconds - a.seconds);
  if (!ranked.length) return [];
  const longest = ranked[0]!.seconds;
  return ranked.filter(t => t.seconds >= Math.min(3, longest * 0.2)).slice(0, maxFaces);
}

/** Measure mouth movement per prominent face across the requested source stretches. */
export async function mouthActivity(
  ctx: Ctx,
  media: VideoMedia,
  stretches: ReadonlyArray<{ from: number; to: number }>,
  opts: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<MouthActivityResult> {
  if (media.kind !== "video") throw new Error("Only a video has a picture to measure mouth movement on.");
  const duration = media.duration;
  if (!duration || !media.width || !media.height || !media.fps) {
    throw new Error("The recording is still being prepared. Ask again in a moment.");
  }
  const file = fileInDirectory(ctx.paths.media(media.projectId), media.path);
  if (!file) throw new Error("The recording's file is missing.");
  const clamped = stretches
    .map(s => ({ from: r3(Math.max(0, s.from)), to: r3(Math.min(duration, s.to)) }))
    .filter(s => s.to > s.from + 0.5);
  if (!clamped.length) return { mediaId: media.id, sampleRate: MOUTH_ACTIVITY_RATE, faces: [], done: true };

  // Ensure faces have been read over the requested stretches (reuses cached face readings).
  const minFrom = Math.min(...clamped.map(s => s.from));
  const maxTo = Math.max(...clamped.map(s => s.to));
  const found = await faces(ctx, media, { from: minFrom, to: maxTo }, { waitMs: Math.min(opts.waitMs ?? 30_000, 30_000), signal: opts.signal });
  if (!found.done && !found.tracks.length) {
    return { mediaId: media.id, sampleRate: MOUTH_ACTIVITY_RATE, faces: [], done: false, ...(found.error && { error: found.error }) };
  }

  const chosen = prominentFaceTracks(found.tracks);
  if (!chosen.length) {
    return { mediaId: media.id, sampleRate: MOUTH_ACTIVITY_RATE, faces: [], done: found.done, ...(found.error && { error: found.error }) };
  }

  const decoder = await pictureDecoder(ctx.settings().render.hwaccel);
  const fps = Math.min(media.fps, 30);
  const width = media.width;
  const height = media.height;
  const signal = opts.signal;

  const resultFaces: MouthActivityFace[] = [];
  for (const track of chosen) {
    const mouth = mouthBoxFor(track.box);
    const measuredStretches: Array<{ from: number; to: number; values: number[] }> = [];
    for (const s of clamped) {
      signal?.throwIfAborted();
      const motion = await pictureLane(ctx).run(async () => {
        try {
          return await mouthMotion(file, { start: s.from, end: s.to }, { box: mouth satisfies CropBox, width, height, fps, decoder, signal });
        } catch (err) {
          signal?.throwIfAborted();
          if (!decoder) throw err;
          fellBack(ctx)(`mouth:${media.id}`, `[media] mouth-activity id=${logId(media.id)} measured on the CPU after the ${decoder} decoder failed: ${clip(err instanceof Error ? err.message : String(err))}`);
          return await mouthMotion(file, { start: s.from, end: s.to }, { box: mouth satisfies CropBox, width, height, fps, signal });
        }
      }, { signal });
      measuredStretches.push({ from: s.from, to: s.to, values: binMouthMotion(motion, fps, MOUTH_ACTIVITY_RATE) });
    }
    resultFaces.push({
      track: track.track,
      box: track.box,
      mouth,
      seconds: track.seconds,
      confidence: track.confidence,
      stretches: measuredStretches,
    });
  }

  return {
    mediaId: media.id,
    sampleRate: MOUTH_ACTIVITY_RATE,
    faces: resultFaces,
    done: found.done,
    ...(found.error && { error: found.error }),
  };
}
