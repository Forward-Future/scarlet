/**
 * Where the faces are in a video's frame over time, found once and kept beside its waveform. A video is decoded four
 * frames a second, a minute at a time, and its faces are looked for twice a second, and four times where they move
 * (faceModel.ts). Each face is followed from frame to frame as a track, and a track's time is split into spans over
 * which its box barely moves, so a long talking head comes back as a few dozen spans. This is evidence for the model:
 * the framing is its call.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { probeMedia, screenFrameSize } from "@scarlet/render";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { audioWorker } from "../transcribe/audioWorker.js";
import { FACE_MODEL, FACE_SIDE, iou, type Face } from "../transcribe/faceModel.js";
import { LocalWhisperModel } from "../transcribe/localModel.js";
import { pictureReader, r3, rememberLast, withFrames, type VideoMedia } from "./pictureReading.js";

/** Bump when the reading changes: the model, the sampling or what a frame keeps. Kept readings are read again. */
const FACES_VERSION = 1;
/** Seconds of a video read and kept together. */
const FACES_WINDOW = 60;
/** Frames a second decoded. Half are looked at, and the rest where the faces moved between them. */
const FACES_FPS = 4;
/** Frames handed to the detector in one go: ten seconds, 40 frames of 640 by 360, about 28 MB. */
const BATCH_FRAMES = 40;

/** A face missing from frames for up to this long keeps its span: the detector misses a frame now and then. */
const GAP = 1.5;
/** A face missing for up to this long keeps its track wherever it moved within its own width. Longer, it must reappear over its last or its usual box. */
const NEAR = 3;
/**
 * A span holds a face while its box stays within this many times the span's smallest box, each way. A presenter at a
 * desk moves their head by a third of its width every few seconds: at 1.3 a 4K talking head made a span every 4 s, at
 * 1.5 one every 9 s (2026-11-15).
 */
const HOLD = 1.5;
/** A face turned this far from where its span looks, in two frames running, starts another span. A presenter glancing at a screen beside the camera turns 20-30°. */
const TURN = 45;

/** The faces in one frame looked at: its source second and each face as [left, top, right, bottom, score, yaw]. */
export interface FaceSample { at: number; faces: Array<[number, number, number, number, number, number]> }

/** One face over a stretch of time: source seconds, a box (fractions of the frame) that holds it throughout, roughly where it looks and how sure the detector was. */
export interface FaceSpan { track: number; start: number; end: number; box: [number, number, number, number]; yaw: number; confidence: number }

/** A face followed through the video: when it is first and last seen, for how long, its usual box and how sure the detector usually was. */
export interface FaceTrack { track: number; start: number; end: number; seconds: number; box: [number, number, number, number]; confidence: number }

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** A frame's faces as kept: fractions to three places, scores to two and yaw to the degree. */
export function faceSample(at: number, faces: readonly Face[]): FaceSample {
  return { at: r3(at), faces: faces.map(f => [...f.box.map(r3), Math.round(f.score * 100) / 100, f.yaw] as FaceSample["faces"][number]) };
}

interface Seen { at: number; next: number; box: [number, number, number, number]; score: number; yaw: number }

/**
 * Tracks and spans from the windows read so far, in order. A face in one frame is the same as one in the frame before
 * when their boxes overlap, or when it is within its own width of a face seen in the last 3 s; after that, only when
 * it reappears over its last box or its usual one. That follows position, not who it is: two people who swap places
 * swap tracks. A face seen in one frame without another sighting of it within 1.5 s is left out. A span lasts from the
 * first frame that shows the face to the next frame looked at after its last, or the end of what has been read.
 */
export function faceTracks(windows: ReadonlyArray<{ start: number; end: number; samples: readonly FaceSample[] }>): { tracks: FaceTrack[]; spans: FaceSpan[] } {
  const ordered = [...windows].sort((a, b) => a.start - b.start);
  const tracks: Array<{ seen: Seen[]; usual?: Seen["box"] }> = [];
  // Where a track's face usually is: the middle of each side of its boxes, worked out once it has gone a while.
  const usual = (track: typeof tracks[number]) => track.usual ??= [0, 1, 2, 3].map(i => median(track.seen.map(s => s.box[i]!))) as Seen["box"];
  ordered.forEach((window, w) => {
    const following = ordered[w + 1];
    const joined = following && Math.abs(following.start - window.end) < 1e-6 && following.samples.length ? following.samples[0]!.at : window.end;
    window.samples.forEach((sample, s) => {
      const next = s + 1 < window.samples.length ? window.samples[s + 1]!.at : joined;
      const faces = sample.faces.map(([x0, y0, x1, y1, score, yaw]) => ({ at: sample.at, next, box: [x0, y0, x1, y1] as Seen["box"], score, yaw }));
      // Every pair a face and a track could make, best first: an overlap with a recent track, then with an old one, then
      // a recent track merely near. A presenter who walked off and back was otherwise taken for whoever stood up first.
      const pairs: Array<{ face: number; track: number; rank: number }> = [];
      faces.forEach((face, f) => tracks.forEach((track, t) => {
        const last = track.seen.at(-1)!, recent = sample.at - last.at <= NEAR;
        const overlap = recent ? iou(last.box, face.box) : Math.max(iou(last.box, face.box), iou(usual(track), face.box));
        const width = last.box[2] - last.box[0];
        const near = Math.hypot((last.box[0] + last.box[2] - face.box[0] - face.box[2]) / 2, (last.box[1] + last.box[3] - face.box[1] - face.box[3]) / 2) <= width;
        if (overlap >= 0.3) pairs.push({ face: f, track: t, rank: (recent ? 3 : 2) + overlap });
        else if (recent && near) pairs.push({ face: f, track: t, rank: 1 + overlap });
      }));
      pairs.sort((a, b) => b.rank - a.rank);
      const used = new Set<number>(), taken = new Set<number>();
      for (const { face, track } of pairs) {
        if (used.has(face) || taken.has(track)) continue;
        used.add(face);
        taken.add(track);
        tracks[track]!.seen.push(faces[face]!);
        tracks[track]!.usual = undefined;
      }
      faces.forEach((face, f) => { if (!used.has(f)) tracks.push({ seen: [face] }); });
    });
  });
  // A face seen in one frame with no other sighting of it nearby is a passing likeness: a pattern, a face mid-turn.
  const kept = tracks.map(t => ({ seen: t.seen.filter((s, k) => (k > 0 && s.at - t.seen[k - 1]!.at <= GAP) || (k + 1 < t.seen.length && t.seen[k + 1]!.at - s.at <= GAP)) }))
    .filter(t => t.seen.length).sort((a, b) => a.seen[0]!.at - b.seen[0]!.at);
  const spans: FaceSpan[] = [], summary: FaceTrack[] = [];
  kept.forEach(({ seen }, i) => {
    const track = i + 1, own: FaceSpan[] = [];
    let run: Seen[] = [], union = [0, 0, 0, 0], narrowest = 0, shortest = 0, looks = 0;
    const close = () => {
      if (!run.length) return;
      own.push({ track, start: run[0]!.at, end: run.at(-1)!.next, box: union.map(r3) as FaceSpan["box"],
        yaw: Math.round(median(run.map(s => s.yaw)) / 5) * 5, confidence: Math.round(median(run.map(s => s.score)) * 100) / 100 });
      run = [];
    };
    seen.forEach((face, k) => {
      const [x0, y0, x1, y1] = face.box;
      if (run.length) {
        const w = Math.max(union[2]!, x1) - Math.min(union[0]!, x0), h = Math.max(union[3]!, y1) - Math.min(union[1]!, y0);
        const holds = w <= HOLD * Math.min(narrowest, x1 - x0) && h <= HOLD * Math.min(shortest, y1 - y0);
        const after = seen[k + 1];
        const turned = Math.abs(face.yaw - looks) >= TURN && (!after || Math.abs(after.yaw - looks) >= TURN);
        // How long the face was missing counts from the first frame looked at without it.
        if (face.at - run.at(-1)!.next > GAP || !holds || turned) close();
      }
      if (!run.length) { union = [x0, y0, x1, y1]; narrowest = x1 - x0; shortest = y1 - y0; }
      else {
        union = [Math.min(union[0]!, x0), Math.min(union[1]!, y0), Math.max(union[2]!, x1), Math.max(union[3]!, y1)];
        narrowest = Math.min(narrowest, x1 - x0);
        shortest = Math.min(shortest, y1 - y0);
      }
      run.push(face);
      // Where the span looks: the middle of its first five frames.
      if (run.length <= 5) looks = median(run.map(s => s.yaw));
    });
    close();
    spans.push(...own);
    const seconds = own.reduce((n, s) => n + s.end - s.start, 0);
    const weighted = (side: number) => {
      const sorted = own.map(s => ({ v: s.box[side]!, w: s.end - s.start })).sort((a, b) => a.v - b.v);
      let total = 0;
      for (const { v, w } of sorted) if ((total += w) >= seconds / 2) return v;
      return sorted.at(-1)!.v;
    };
    summary.push({ track, start: own[0]!.start, end: own.at(-1)!.end, seconds: r3(seconds), box: [0, 1, 2, 3].map(weighted) as FaceTrack["box"],
      confidence: Math.round(median(seen.map(s => s.score)) * 100) / 100 });
  });
  spans.sort((a, b) => a.start - b.start || a.track - b.track);
  return { tracks: summary, spans };
}

const models = new Map<string, LocalWhisperModel>();

function modelFor(ctx: Ctx) {
  let model = models.get(ctx.paths.root);
  if (!model) models.set(ctx.paths.root, model = new LocalWhisperModel(join(ctx.paths.root, "models"), FACE_MODEL, ctx.log));
  return model;
}

function identity(media: MediaAsset) {
  return createHash("sha256").update(JSON.stringify([FACES_VERSION, media.hash ?? media.path, media.duration,
    FACE_MODEL.sha256, FACES_FPS, FACES_WINDOW])).digest("hex");
}

/**
 * Find the faces in one window: decode it in one pass, four frames a second at 640 on its longer side, and hand the
 * frames to the detector ten seconds at a time while the rest decode.
 */
async function readWindow(ctx: Ctx, media: VideoMedia, file: string, { start, end }: { start: number; end: number }, signal: AbortSignal): Promise<FaceSample[]> {
  const source = media.width && media.height ? { width: media.width, height: media.height } : await probeMedia(file);
  const { width, height } = screenFrameSize(source.width, source.height, FACE_SIDE);
  const model = await modelFor(ctx).get(signal);
  const batches = await withFrames(ctx, media, file, "faces", { start, end, fps: FACES_FPS, width, height, signal, batch: BATCH_FRAMES }, () => true, async (frames, times) => {
    const found = await audioWorker.request<Array<Face[] | null>>({ kind: "faces", frames, width, height, model }, { signal });
    return times.flatMap((at, i) => found[i] ? [faceSample(at, found[i]!)] : []);
  });
  return batches.flat();
}

const reading = pictureReader<FaceSample[]>({ name: "faces", window: FACES_WINDOW, identity, read: readWindow });
/** The tracks followed through each video's windows, for the 32 videos asked about last. */
const followed = new Map<string, { windows: string; result: ReturnType<typeof faceTracks> }>();
const MAX_FOLLOWED = 32;

export interface FacesResult {
  mediaId: string;
  from: number; to: number;
  /** The video's frame in pixels, so a box's fractions give its shape. */
  width?: number; height?: number;
  tracks: FaceTrack[];
  spans: FaceSpan[];
  /** Seconds of the range read so far, and whether the whole range has been. */
  readSeconds: number; done: boolean;
  /** Why reading stopped, when it did. */
  error?: string;
}

/**
 * The faces in a range of a video, finding what hasn't been found yet. Waits up to `waitMs` for it, then returns what
 * is ready; reading carries on in the background. Tracks are followed through everything read so far, so a track's
 * number is the same in any range, and can change only while earlier parts of the video are still being read.
 */
export async function faces(ctx: Ctx, media: MediaAsset & { projectId: string }, range: { from?: number; to?: number },
  opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<FacesResult> {
  const read = await reading.read(ctx, media, range, opts);
  // Following the faces through an hour took 50 ms: done again only when more of the video has been read.
  const key = `${ctx.paths.root}\0${media.id}\0${identity(media)}`, windows = read.all.map(w => w.index).join(",");
  let all = followed.get(key)?.windows === windows ? followed.get(key)!.result : undefined;
  all ??= faceTracks(read.all.map(w => ({ start: w.start, end: w.end, samples: w.value })));
  rememberLast(followed, key, { windows, result: all }, MAX_FOLLOWED);
  const spans = all.spans.filter(s => s.end > read.from && s.start < read.to);
  const shown = new Set(spans.map(s => s.track));
  const tracks = all.tracks.filter(t => shown.has(t.track)).map(t => {
    const own = spans.filter(s => s.track === t.track);
    return { ...t, start: own[0]!.start, end: own.at(-1)!.end, seconds: r3(own.reduce((n, s) => n + Math.min(read.to, s.end) - Math.max(read.from, s.start), 0)) };
  });
  return { mediaId: media.id, from: read.from, to: read.to, ...(media.width && media.height && { width: media.width, height: media.height }),
    tracks, spans, readSeconds: read.readSeconds, done: read.done, ...(read.error && { error: read.error }) };
}
