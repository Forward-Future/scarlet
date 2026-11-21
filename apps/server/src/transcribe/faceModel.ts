/**
 * Finding faces in a frame: YuNet (OpenCV Zoo, 2023mar, MIT), a 230 KB detector that also places five landmarks (the
 * eyes, the nose tip and the mouth's corners), through ONNX Runtime in the audio helper (audioWorker.ts), which keeps
 * it loaded between requests. Its input is 640 by 640: a frame shrunk so its longer side is 640 sits in the top left
 * and the rest is black, as OpenCV pads it. On a 4K talking head (M-series CPU, 2026-11-15) a frame took about 6 ms.
 *
 * Where a face's eyes look, up and down: MediaPipe's Face Landmarker (Google, Apache-2.0) as ONNX, its 478-point face
 * mesh on the face's box and the blendshape model on 146 of those points, whose eyeLookDown scores say how far the eyes
 * look down. A presenter reading a laptop below the camera drops their lids more than their head, which the detector's
 * five points can't see (2026-11-21: nose-to-mouth ratios read the same at the lens and at the laptop; eyeLookDown read
 * 0.03-0.2 at the lens and 0.45-0.8 at the laptop on every frame of a 4-minute check, at 640 as at 1920 wide).
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

const EYES_REPO = "https://huggingface.co/t9749/mediapipe-face-landmarker-onnx/resolve/5c3cc92b90fee044d05504404ed52983b3fd8eab";
/** The face mesh and the blendshape model, pinned by revision, size and checksum. */
export const EYE_MODELS = {
  mesh: { name: "face-mesh-3cdfb2d9.onnx", url: `${EYES_REPO}/face_landmarks_detector.onnx`,
    size: 4921016, sha256: "3cdfb2d9d9b3cfea1420e399e4a580b020083f91440ca68d3682bd0f2626a2e3" },
  blendshapes: { name: "face-blendshapes-3f2e7be8.onnx", url: `${EYES_REPO}/face_blendshapes.onnx`,
    size: 1883829, sha256: "3f2e7be8748d33766f8078f7165ab1da72aad0c90956ad56b0046eca96134715" },
} satisfies Record<string, PinnedModel>;
/** The mesh's input side, and how far past the detector's box it looks each way: the mesh wants the face with room round it. */
const MESH_SIDE = 256, MESH_ROOM = 1.5;
/** A face narrower than this, in pixels of the frame looked at, is too small for its eyes to be read. */
const MIN_EYES_WIDTH = 32;
/** The mesh points the blendshape model reads, in order (MediaPipe's face_blendshapes_graph.cc). */
const BLENDSHAPE_POINTS = [0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39, 40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80,
  81, 82, 84, 87, 88, 91, 93, 95, 103, 105, 107, 109, 127, 132, 133, 136, 144, 145, 146, 148, 149, 150, 152, 153, 154, 155, 157, 158, 159,
  160, 161, 162, 163, 168, 172, 173, 176, 178, 181, 185, 191, 195, 197, 234, 246, 249, 251, 263, 267, 269, 270, 276, 282, 283, 284, 285,
  288, 291, 293, 295, 296, 297, 300, 308, 310, 311, 312, 314, 317, 318, 321, 323, 324, 332, 334, 336, 338, 356, 361, 362, 365, 373, 374,
  375, 377, 378, 379, 380, 381, 382, 384, 385, 386, 387, 388, 389, 390, 397, 398, 400, 402, 405, 409, 415, 454, 466, 468, 469, 470, 471,
  472, 473, 474, 475, 476, 477];
/** eyeLookDownLeft and eyeLookDownRight among the 52 blendshapes. */
const LOOK_DOWN = [11, 12] as const;

/** The detector's input side. */
export const FACE_SIDE = 640;
/** A face the detector is less sure of than this is left out. OpenCV's default; small faces score 0.6-0.7. */
const MIN_SCORE = 0.6;
/** Boxes overlapping more than this are one face (OpenCV's default). */
const SAME_FACE = 0.3;
const STRIDES = [8, 16, 32] as const;

/**
 * A face in a frame: its box as fractions of the frame (left, top, right, bottom), how sure the detector was (0..1),
 * roughly where it looks (degrees from facing the camera, positive toward the frame's right) and the point midway
 * between its eyes, as fractions of the frame; and, where its eyes were read, how far they look down (0 level or up, 1
 * fully down).
 */
export interface Face { box: [number, number, number, number]; score: number; yaw: number; eyes: [number, number]; down?: number }

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
      const x = (k: number) => (col + kps[i * 10 + k * 2]!) * stride, y = (k: number) => (row + kps[i * 10 + k * 2 + 1]!) * stride;
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      found.push({ box: [clamp((cx - w / 2) / width), clamp((cy - h / 2) / height), clamp((cx + w / 2) / width), clamp((cy + h / 2) / height)],
        score, yaw: faceYaw(x(0), x(1), x(2)), eyes: [clamp((x(0) + x(1)) / 2 / width), clamp((y(0) + y(1)) / 2 / height)] });
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
 * A face's box from a packed RGB frame `width` by `height`, grown by MESH_ROOM into a square and drawn MESH_SIDE a side,
 * RGB from 0 to 1, as the mesh takes it. Outside the frame is black.
 */
export function meshInput(rgb: Uint8Array, width: number, height: number, box: readonly number[]) {
  const cx = (box[0]! + box[2]!) / 2 * width, cy = (box[1]! + box[3]!) / 2 * height;
  const side = Math.max((box[2]! - box[0]!) * width, (box[3]! - box[1]!) * height) * MESH_ROOM;
  const input = new Float32Array(MESH_SIDE * MESH_SIDE * 3), step = side / MESH_SIDE;
  for (let y = 0; y < MESH_SIDE; y++) {
    const sy = Math.floor(cy - side / 2 + (y + 0.5) * step);
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < MESH_SIDE; x++) {
      const sx = Math.floor(cx - side / 2 + (x + 0.5) * step);
      if (sx < 0 || sx >= width) continue;
      const p = (sy * width + sx) * 3, q = (y * MESH_SIDE + x) * 3;
      input[q] = rgb[p]! / 255; input[q + 1] = rgb[p + 1]! / 255; input[q + 2] = rgb[p + 2]! / 255;
    }
  }
  return input;
}

/** The blendshape model's input from the mesh's 478 points (x, y, z each, in its input's pixels). */
export function blendshapeInput(mesh: ArrayLike<number>) {
  const points = new Float32Array(BLENDSHAPE_POINTS.length * 2);
  BLENDSHAPE_POINTS.forEach((p, i) => { points[i * 2] = mesh[p * 3]!; points[i * 2 + 1] = mesh[p * 3 + 1]!; });
  return points;
}

/** How far the eyes look down, from the 52 blendshape scores: the mean of the two eyes' eyeLookDown, to two places. */
export function lookDown(scores: ArrayLike<number>) {
  return Math.round((scores[LOOK_DOWN[0]]! + scores[LOOK_DOWN[1]]!) / 2 * 100) / 100;
}

/**
 * Find the faces in every frame in `frames` (packed RGB, `width` by `height`, one after another, each side at most
 * 640). Every other frame is looked at; a frame between two is looked at too when their faces differ, so faces that
 * hold still cost half and faces that move are followed at the full rate. A frame not looked at is null.
 */
export async function runFaceWorker(frames: string, width: number, height: number, model: string, sessions?: Sessions,
  eyes?: { mesh: string; blendshapes: string }): Promise<Array<Face[] | null>> {
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
    const found = await withInference(ort, model, async session => {
      const result = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, FACE_SIDE, FACE_SIDE]) });
      return decodeFaces(result, width, height);
    }, { sessions, gpu: false });
    if (!eyes) return found;
    for (const face of found) {
      if ((face.box[2] - face.box[0]) * width < MIN_EYES_WIDTH) continue;
      const mesh = await withInference(ort, eyes.mesh, async session => {
        const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", meshInput(rgb, width, height, face.box), [1, MESH_SIDE, MESH_SIDE, 3]) });
        return out[session.outputNames[0]!]!.data as Float32Array;
      }, { sessions, gpu: false });
      face.down = await withInference(ort, eyes.blendshapes, async session => {
        const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", blendshapeInput(mesh), [1, BLENDSHAPE_POINTS.length, 2]) });
        return lookDown(out[session.outputNames[0]!]!.data as Float32Array);
      }, { sessions, gpu: false });
    }
    return found;
  };
  const out: Array<Face[] | null> = Array.from({ length: count }, () => null);
  for (let f = 0; f < count; f += 2) out[f] = await detect(f);
  for (let f = 1; f < count; f += 2) {
    if (f + 1 >= count || facesDiffer(out[f - 1]!, out[f + 1]!)) out[f] = await detect(f);
  }
  return out;
}
