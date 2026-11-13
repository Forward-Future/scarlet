import { describe, expect, it } from "vitest";
import { layerPlacement, comparePicture, layoutOf, locate, resize, summarizePicture, type Gray, type PictureSample, type Placement } from "../src/picture.ts";

const W = 320, H = 180;
/** A picture with detail at every size: hard-edged shapes large and small over a soft gradient, different for each seed. */
function picture(seed: number): Gray {
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const shapes = Array.from({ length: 90 }, (_, i) => ({ x: next() * W, y: next() * H, w: (i < 12 ? 40 : 4) + next() * (i < 12 ? 80 : 22), h: (i < 12 ? 24 : 3) + next() * (i < 12 ? 50 : 14), v: 20 + next() * 215 }));
  const tilt = next() - 0.5;
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 110 + tilt * (x - W / 2) * 0.3;
    for (const s of shapes) if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) v = s.v;
    data[y * W + x] = Math.max(0, Math.min(255, v + (next() - 0.5) * 6));
  }
  return { width: W, height: H, data };
}
/** Draw the part `shown` of a picture (fractions of it) into a frame, the whole picture being `scale` of the frame with its top left at (x, y). */
function draw(frame: Gray, source: Gray, scale: number, x: number, y: number, shown = { x: 0, y: 0, w: 1, h: 1 }) {
  const w = Math.round(W * scale), h = Math.round(H * scale), scaled = resize(source, w, h);
  for (let v = Math.round(shown.y * h); v < Math.round((shown.y + shown.h) * h); v++) for (let u = Math.round(shown.x * w); u < Math.round((shown.x + shown.w) * w); u++) {
    const fx = x + u, fy = y + v;
    if (fx >= 0 && fy >= 0 && fx < W && fy < H) frame.data[fy * W + fx] = scaled.data[v * w + u]!;
  }
}
const flat = (): Gray => ({ width: W, height: H, data: new Float32Array(W * H).fill(70) });

describe("finding a recording in a finished frame", () => {
  const camera = picture(3), screen = picture(11);

  it("finds a cropped inset over a card, and the card under it", () => {
    const frame = flat();
    // The screen as a card at 0.7 of the frame, and the middle half of the camera at half size in the top right.
    draw(frame, screen, 0.7, 20, 27);
    draw(frame, camera, 0.5, 200, -10, { x: 0.25, y: 0.1, w: 0.5, h: 0.8 });
    const inset = locate(frame, camera, { maxScale: 1.8 })!;
    expect(inset.scale).toBeCloseTo(0.5, 1);
    // The shown part is read in blocks of 8 pixels, so its edges are good to a block or two.
    expect(Math.abs(inset.rect.x - 240 / W)).toBeLessThan(0.06);
    expect(inset.shown.w).toBeCloseTo(0.5, 1);
    expect(inset.score).toBeGreaterThan(0.9);
    const card = locate(frame, screen, { ignore: [inset.rect] })!;
    expect(card.scale).toBeCloseTo(0.7, 1);
    expect(card.x).toBeCloseTo((20 + 0.35 * W) / W - 0.5, 1);
  });

  it("finds a zoom that shows only part of the recording", () => {
    const frame = flat();
    draw(frame, screen, 2, -200, -90);
    const zoom = locate(frame, screen)!;
    expect(zoom.scale).toBeCloseTo(2, 1);
    expect(zoom.shown.w).toBeCloseTo(0.5, 1);
    expect(zoom.shown.x).toBeCloseTo(200 / (2 * W), 1);
  });

  it("finds nothing in a frame that shows something else", () => {
    expect(locate(picture(99), camera)).toBeUndefined();
  });
});

describe("layouts", () => {
  const CAM = "med_cam", SCREEN = "med_screen";
  const at = (t: number, layers: Record<string, Placement | undefined>): PictureSample =>
    ({ t, mediaId: CAM, source: t, layers: Object.fromEntries(Object.entries(layers).filter(([, p]) => p)) as Record<string, Placement> });

  it("reads a clip's transform as the frame would show it", () => {
    // A quarter-size inset bottom right, cropped a little on every side: the crop is fitted, then scaled.
    const inset = layerPlacement({ x: 0.35, y: 0.35, scale: 0.25, cropLeft: 0.11, cropRight: 0.11, cropTop: 0.14, cropBottom: 0.08 })!;
    expect(inset.rect).toEqual({ x: 0.725, y: 0.725, w: 0.25, h: 0.25 });
    expect(inset.shown).toEqual({ x: 0.11, y: 0.14, w: 0.78, h: 0.78 });
    expect(inset.scale).toBeCloseTo(0.25 / 0.78, 2);
    // A zoom to 2× on the upper left shows a quarter of the picture.
    expect(layerPlacement({ scale: 2, x: 0.5, y: 0.5 })!.shown).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  it("names each moment's layout and compares two cuts moment by moment", () => {
    const full = layerPlacement()!, inset = layerPlacement({ x: 0.35, y: -0.28, scale: 0.25 })!, low = layerPlacement({ x: 0.35, y: 0.35, scale: 0.25 })!;
    const wide = layerPlacement()!, tight = layerPlacement({ scale: 2 })!;
    const published = [at(0, { [CAM]: full }), at(2, { [CAM]: inset, [SCREEN]: tight }), at(4, { [CAM]: inset, [SCREEN]: wide }), at(6, {})];
    expect(published.map(layoutOf)).toEqual(["camera", "inset", "inset", "other"]);
    expect(summarizePicture(published)).toMatchObject({ layouts: { camera: 0.25, inset: 0.5, screen: 0, other: 0.25 }, cameraScale: 1 });
    // The candidate keeps the inset throughout, lower down, and never zooms the screen.
    const c = comparePicture(published, s => at(s.t, { [CAM]: low, [SCREEN]: wide }));
    expect(c).toMatchObject({ compared: 3, layoutAgreement: 0.667, confusion: { "inset→inset": 2, "camera→inset": 1 } });
    expect(c.inset).toMatchObject({ moments: 2, widthRatio: 1 });
    expect(c.inset!.distance).toBeCloseTo(0.63, 2);
    expect(c.main).toMatchObject({ moments: 2, sameFraming: 0.5 });
  });
});
