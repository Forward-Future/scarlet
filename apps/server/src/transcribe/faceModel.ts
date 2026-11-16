/**
 * Finding faces in a frame: YuNet (OpenCV Zoo, 2023mar, MIT), a 230 KB detector that also places five landmarks (the
 * eyes, the nose tip and the mouth's corners), through ONNX Runtime in the audio helper (audioWorker.ts), which keeps
 * it loaded between requests. Its input is 640 by 640: a frame shrunk so its longer side is 640 sits in the top left
 * and the rest is black, as OpenCV pads it. On a 4K talking head (M-series CPU, 2026-11-15) a frame took about 6 ms.
 */
import { readFile } from "node:fs/promises";
import { loadRuntime, withInference, type Sessions } from "./uhm.js";
import type { PinnedModel } from "./localModel.js";

/** The face detector, pinned by revision, size and checksum. */
export const FACE_MODEL = {
  name: "yunet-2023mar-8f2383e4.onnx",
  url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
  size: 232589, sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
} satisfies PinnedModel;

/** The detector's input side. */
export const FACE_SIDE = 640;
/** A face the detector is less sure of than this is left out. OpenCV's default; small faces score 0.6-0.7. */
const MIN_SCORE = 0.6;
/** Boxes overlapping more than this are one face (OpenCV's default). */
const SAME_FACE = 0.3;
const STRIDES = [8, 16, 32] as const;

/**
 * A face in a frame: its box as fractions of the frame (left, top, right, bottom), how sure the detector was (0..1),
 * and roughly where it looks: degrees from facing the camera, positive toward the frame's right.
 */
export interface Face { box: [number, number, number, number]; score: number; yaw: number }

/** How much `a` and `b` overlap, as a share of both together. */
export function iou(a: readonly number[], b: readonly number[]) {
  const w = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!), h = Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!);
  if (w <= 0 || h <= 0) return 0;
  const both = w * h, area = (r: readonly number[]) => (r[2]! - r[0]!) * (r[3]! - r[1]!);
  return both / (area(a) + area(b) - both);
}

/**
 * Roughly where a face looks, from its landmarks (x of the right eye, the left eye and the nose tip, in pixels): the
 * nose sits between the eyes on a face toward the camera and moves toward the side it turns to. On a head the nose tip
 * stands about half the eyes' span in front of them, so its offset over the span is about half the turn's tangent.
 */
export function faceYaw(rightEye: number, leftEye: number, nose: number) {
  const span = Math.abs(leftEye - rightEye), offset = nose - (rightEye + leftEye) / 2;
  if (span < 1e-6) return offset === 0 ? 0 : Math.sign(offset) * 90;
  return Math.round(Math.atan(2 * offset / span) * 180 / Math.PI);
}

type Outputs = Record<string, { data: unknown }>;

/**
 * The faces in YuNet's outputs, for a picture `width` by `height` in the top left of its input. Each anchor's score is
 * the root of its class and object scores; its box and landmarks are offsets from the anchor in units of its stride.
 */
export function decodeFaces(outputs: Outputs, width: number, height: number, minScore = MIN_SCORE): Face[] {
  const found: Face[] = [];
  for (const stride of STRIDES) {
    const cols = FACE_SIDE / stride;
    const data = (name: string) => outputs[`${name}_${stride}`]!.data as Float32Array;
    const cls = data("cls"), obj = data("obj"), bbox = data("bbox"), kps = data("kps");
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)));
      if (score < minScore) continue;
      const col = i % cols, row = (i - col) / cols;
      const cx = (col + bbox[i * 4]!) * stride, cy = (row + bbox[i * 4 + 1]!) * stride;
      const w = Math.exp(bbox[i * 4 + 2]!) * stride, h = Math.exp(bbox[i * 4 + 3]!) * stride;
      const x = (k: number) => (col + kps[i * 10 + k * 2]!) * stride;
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      found.push({ box: [clamp((cx - w / 2) / width), clamp((cy - h / 2) / height), clamp((cx + w / 2) / width), clamp((cy + h / 2) / height)],
        score, yaw: faceYaw(x(0), x(1), x(2)) });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const face of found) if (!kept.some(k => iou(k.box, face.box) > SAME_FACE)) kept.push(face);
  return kept.filter(f => f.box[2] > f.box[0] && f.box[3] > f.box[1]);
}

/** Whether the faces of two frames differ: a face came or went, moved off most of its box, or turned by 20° or more. */
export function facesDiffer(a: readonly Face[], b: readonly Face[]) {
  if (a.length !== b.length) return true;
  return a.some(f => !b.some(g => iou(f.box, g.box) >= 0.6 && Math.abs(f.yaw - g.yaw) < 20));
}

/**
 * Find the faces in every frame in `frames` (packed RGB, `width` by `height`, one after another, each side at most
 * 640). Every other frame is looked at; a frame between two is looked at too when their faces differ, so faces that
 * hold still cost half and faces that move are followed at the full rate. A frame not looked at is null.
 */
export async function runFaceWorker(frames: string, width: number, height: number, model: string, sessions?: Sessions): Promise<Array<Face[] | null>> {
  if (width > FACE_SIDE || height > FACE_SIDE) throw new Error(`Frames for the face detector are at most ${FACE_SIDE} pixels a side.`);
  const ort = loadRuntime();
  const all = await readFile(frames);
  const size = width * height * 3, count = Math.floor(all.length / size), plane = FACE_SIDE * FACE_SIDE;
  const input = new Float32Array(3 * plane);
  const detect = async (f: number) => {
    const rgb = all.subarray(f * size, (f + 1) * size);
    // OpenCV hands YuNet blue, green and red, 0 to 255.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3, q = y * FACE_SIDE + x;
      input[q] = rgb[p + 2]!;
      input[plane + q] = rgb[p + 1]!;
      input[2 * plane + q] = rgb[p]!;
    }
    return withInference(ort, model, async session => {
      const result = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, FACE_SIDE, FACE_SIDE]) });
      return decodeFaces(result, width, height);
    }, { sessions, gpu: false });
  };
  const out: Array<Face[] | null> = Array.from({ length: count }, () => null);
  for (let f = 0; f < count; f += 2) out[f] = await detect(f);
  for (let f = 1; f < count; f += 2) {
    if (f + 1 >= count || facesDiffer(out[f - 1]!, out[f + 1]!)) out[f] = await detect(f);
  }
  return out;
}
