import type { PictureMark } from "@scarlet/shared";

/** A point on the frame, in fractions of its width and height. */
export type FramePoint = [number, number];

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** A point inside the frame, rounded as marks are kept. */
export function framePoint(x: number, y: number): FramePoint {
  return [round(clamp(x)), round(clamp(y))];
}

/** A line's points as an SVG polyline lists them. */
export function polylinePoints(points: readonly FramePoint[]): string {
  return points.map(p => p.join(",")).join(" ");
}

/** True when a freehand mark loops close to where it started, so clicking inside the loop also grabs it. */
export function isClosedDraw(mark: PictureMark): boolean {
  if (mark.kind !== "draw" || !mark.points || mark.points.length < 6) return false;
  const diag = Math.hypot(mark.box.w, mark.box.h);
  if (diag < 0.03) return false;
  const first = mark.points[0]!, last = mark.points[mark.points.length - 1]!;
  return Math.hypot(first[0] - last[0], first[1] - last[1]) <= diag * 0.5;
}

export function boxOf(points: FramePoint[]) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: round(x), y: round(y), w: round(Math.max(...xs) - x), h: round(Math.max(...ys) - y) };
}

/** A line keeps at most 200 points, as the engine takes them, evenly picked along it. */
export function thin(points: FramePoint[]): FramePoint[] {
  if (points.length <= 200) return points;
  return Array.from({ length: 200 }, (_, i) => points[Math.round(i * (points.length - 1) / 199)]!);
}

/** Move a mark by (dx, dy) in fractions of the frame while keeping its entire shape inside [0, 1]. */
export function translateMark(mark: PictureMark, dx: number, dy: number): PictureMark {
  if (mark.kind === "draw" && mark.points?.length) {
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const [px, py] of mark.points) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const cdx = Math.min(1 - maxX, Math.max(-minX, dx));
    const cdy = Math.min(1 - maxY, Math.max(-minY, dy));
    const points = mark.points.map(([px, py]) => framePoint(px + cdx, py + cdy));
    return { ...mark, box: boxOf(points), points };
  }
  const x = round(Math.min(Math.max(0, 1 - mark.box.w), Math.max(0, mark.box.x + dx)));
  const y = round(Math.min(Math.max(0, 1 - mark.box.h), Math.max(0, mark.box.y + dy)));
  return { ...mark, box: { x, y, w: mark.box.w, h: mark.box.h } };
}
