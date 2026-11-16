import { describe, expect, it } from "vitest";
import { decodeFaces, faceYaw, facesDiffer, FACE_SIDE, type Face } from "../transcribe/faceModel.js";
import { faceSample, faceTracks, type FaceSample } from "./faces.js";

/** YuNet's outputs with nothing found, and a way to place a face on one anchor. */
function outputs() {
  const out: Record<string, { data: Float32Array }> = {};
  for (const stride of [8, 16, 32]) {
    const n = (FACE_SIDE / stride) ** 2;
    out[`cls_${stride}`] = { data: new Float32Array(n) };
    out[`obj_${stride}`] = { data: new Float32Array(n) };
    out[`bbox_${stride}`] = { data: new Float32Array(n * 4) };
    out[`kps_${stride}`] = { data: new Float32Array(n * 10) };
  }
  const place = (stride: number, col: number, row: number, score: number, size: number, nose = 0) => {
    const i = row * (FACE_SIDE / stride) + col;
    out[`cls_${stride}`]!.data[i] = score;
    out[`obj_${stride}`]!.data[i] = score;
    out[`bbox_${stride}`]!.data.set([0.5, 0.5, Math.log(size / stride), Math.log(size / stride)], i * 4);
    // Eyes a quarter of the box either side of its middle, the nose `nose` pixels to the right of between them.
    const kps = [0.5 - size / 4 / stride, 0.3, 0.5 + size / 4 / stride, 0.3, 0.5 + nose / stride, 0.5, 0.4, 0.7, 0.6, 0.7];
    out[`kps_${stride}`]!.data.set(kps, i * 10);
  };
  return { out, place };
}

describe("finding faces", () => {
  it("reads a face's box from its anchor as fractions of the picture, and keeps the surer of two boxes on one face", () => {
    const { out, place } = outputs();
    // A 640 × 360 picture: a 64-pixel face centred at (168, 88) on the 16-pixel grid, and the same face a little off on the 8-pixel one.
    place(16, 10, 5, 0.95, 64);
    place(8, 20, 10, 0.8, 64);
    place(32, 1, 1, 0.3, 32);
    const found = decodeFaces(out, 640, 360);
    expect(found).toHaveLength(1);
    expect(found[0]!.score).toBeCloseTo(0.95);
    [136 / 640, 56 / 360, 200 / 640, 120 / 360].forEach((v, i) => expect(found[0]!.box[i]).toBeCloseTo(v, 4));
    expect(found[0]!.yaw).toBe(0);
  });

  it("says roughly where a face looks from where its nose sits between its eyes", () => {
    expect(faceYaw(100, 160, 130)).toBe(0);
    // The nose over one eye is about 45°: it stands about half the eyes' span in front of them.
    expect(faceYaw(100, 160, 160)).toBe(45);
    expect(faceYaw(100, 160, 100)).toBe(-45);
    expect(faceYaw(100, 100, 108)).toBe(90);
    const { out, place } = outputs();
    place(16, 10, 5, 0.95, 64, 16);
    expect(decodeFaces(out, 640, 360)[0]!.yaw).toBe(45);
  });

  it("tells frames apart when a face comes, goes, moves off its box or turns", () => {
    const face = (x: number, yaw = 0): Face => ({ box: [x, 0.2, x + 0.2, 0.6], score: 0.9, yaw });
    expect(facesDiffer([face(0.4)], [face(0.41)])).toBe(false);
    expect(facesDiffer([face(0.4)], [])).toBe(true);
    expect(facesDiffer([face(0.4)], [face(0.5)])).toBe(true);
    expect(facesDiffer([face(0.4)], [face(0.4, 25)])).toBe(true);
  });
});

/** A face at `x` (left edge), 0.15 wide, in every sample from `from` to `to` seconds, twice a second. */
function frames(from: number, to: number, faces: (at: number) => Face[]): FaceSample[] {
  const out: FaceSample[] = [];
  for (let at = from; at < to - 1e-9; at += 0.5) out.push(faceSample(at, faces(at)));
  return out;
}
const at = (x: number, yaw = 0, y = 0.3, w = 0.15): Face => ({ box: [x, y, x + w, y + w * 16 / 9 * 0.9], score: 0.93, yaw });

describe("face tracks", () => {
  it("makes a face that barely moves one span, across the windows it was read in", () => {
    const sway = (t: number) => [at(0.42 + 0.01 * Math.sin(t))];
    const { tracks, spans } = faceTracks([{ start: 0, end: 60, samples: frames(0, 60, sway) }, { start: 60, end: 120, samples: frames(60, 120, sway) }]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ track: 1, start: 0, end: 120, yaw: 0, confidence: 0.93 });
    expect(spans[0]!.box[0]).toBeCloseTo(0.41, 2);
    expect(spans[0]!.box[2]).toBeCloseTo(0.58, 2);
    expect(tracks).toEqual([expect.objectContaining({ track: 1, start: 0, end: 120, seconds: 120 })]);
  });

  it("starts a span when the face moves off its box, and keeps its track", () => {
    const { tracks, spans } = faceTracks([{ start: 0, end: 20, samples: frames(0, 20, t => [at(t < 10 ? 0.2 : 0.3)]) }]);
    expect(spans.map(s => [s.track, s.start, s.end])).toEqual([[1, 0, 10], [1, 10, 20]]);
    expect(tracks).toHaveLength(1);
  });

  it("starts a span when the face turns away for more than a frame, not for one", () => {
    const blip = faceTracks([{ start: 0, end: 10, samples: frames(0, 10, t => [at(0.4, t === 4 ? 60 : 0)]) }]);
    expect(blip.spans).toHaveLength(1);
    const turned = faceTracks([{ start: 0, end: 10, samples: frames(0, 10, t => [at(0.4, t >= 6 ? 60 : 0)]) }]);
    expect(turned.spans.map(s => [s.start, s.end, s.yaw])).toEqual([[0, 6, 0], [6, 10, 60]]);
    // A glance aside keeps the span; its yaw is the middle of the span's.
    const glance = faceTracks([{ start: 0, end: 10, samples: frames(0, 10, t => [at(0.4, t >= 6 ? 25 : 0)]) }]);
    expect(glance.spans.map(s => [s.start, s.end, s.yaw])).toEqual([[0, 10, 0]]);
  });

  it("bridges a frame or two the detector missed, and ends a span where a longer absence starts", () => {
    const missed = faceTracks([{ start: 0, end: 10, samples: frames(0, 10, t => t === 3 || t === 3.5 ? [] : [at(0.4)]) }]);
    expect(missed.spans.map(s => [s.start, s.end])).toEqual([[0, 10]]);
    const away = faceTracks([{ start: 0, end: 20, samples: frames(0, 20, t => t >= 5 && t < 12 ? [] : [at(0.4)]) }]);
    // Gone from 5 s to 12 s: the face comes back over its old box and keeps its number.
    expect(away.spans.map(s => [s.track, s.start, s.end])).toEqual([[1, 0, 5], [1, 12, 20]]);
    expect(away.tracks).toEqual([expect.objectContaining({ track: 1, start: 0, end: 20, seconds: 13 })]);
  });

  it("keeps the number of a face that left from somewhere else and came back to its usual place", () => {
    const { tracks, spans } = faceTracks([{ start: 0, end: 60, samples: frames(0, 60, t =>
      t < 20 ? [at(0.4)] : t < 22 ? [at(0.4 + (t - 19.5) * 0.12)] : t < 40 ? [] : [at(0.41)]) }]);
    expect(tracks.map(t => [t.track, t.start, t.end])).toEqual([[1, 0, 60]]);
    expect(spans.at(-1)).toMatchObject({ track: 1, start: 40, end: 60 });
    expect(tracks[0]!.confidence).toBe(0.93);
  });

  it("numbers faces by when they appear, follows each by position, and leaves out a face seen once", () => {
    const { tracks, spans } = faceTracks([{ start: 0, end: 10, samples: frames(0, 10, t => [
      ...(t >= 2 ? [at(0.7)] : []), at(0.1), ...(t === 7 ? [at(0.4, 0, 0.05, 0.05)] : [])]) }]);
    expect(tracks.map(t => [t.track, t.start, t.end])).toEqual([[1, 0, 10], [2, 2, 10]]);
    expect(spans.find(s => s.track === 1)!.box[0]).toBeCloseTo(0.1);
    expect(spans.find(s => s.track === 2)!.box[0]).toBeCloseTo(0.7);
  });

  it("follows a face that moves steadily across the frame as one track", () => {
    const { tracks, spans } = faceTracks([{ start: 0, end: 10, samples: frames(0, 10, t => [at(0.05 + t * 0.06)]) }]);
    expect(tracks).toHaveLength(1);
    expect(spans.length).toBeGreaterThan(1);
    // Each span's box holds the face throughout it and grows no more than 1.5 times the face, each way.
    for (const s of spans) expect(s.box[2] - s.box[0]).toBeLessThanOrEqual(0.15 * 1.5 + 1e-3);
  });

  it("ends what has been read at the end of its window when the next one hasn't been read", () => {
    const steady = (t: number) => [at(0.4 + 0 * t)];
    const { spans } = faceTracks([{ start: 120, end: 180, samples: frames(120, 180, steady) }, { start: 0, end: 60, samples: frames(0, 60, steady) }]);
    expect(spans.map(s => [s.start, s.end])).toEqual([[0, 60], [120, 180]]);
  });

  it("keeps a frame's faces compactly", () => {
    expect(faceSample(1.23456, [{ box: [0.12345, 0.2, 0.3, 0.4], score: 0.9345, yaw: -12 }])).toEqual({ at: 1.235, faces: [[0.123, 0.2, 0.3, 0.4, 0.93, -12]] });
  });
});
