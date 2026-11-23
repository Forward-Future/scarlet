import { describe, expect, it } from "vitest";
import type { PictureMark } from "@scarlet/shared";
import { boxOf, framePoint, isClosedDraw, polylinePoints, thin, translateMark, type FramePoint } from "./pictureMarkGeometry";

describe("picture mark geometry", () => {
  it("keeps a point inside the frame, rounded to four places", () => {
    expect(framePoint(-0.2, 1.3)).toEqual([0, 1]);
    expect(framePoint(0.123456, 0.987654)).toEqual([0.1235, 0.9877]);
  });

  it("lists a line's points as an SVG polyline does", () => {
    expect(polylinePoints([[0.1, 0.2], [0.3, 0.4]])).toBe("0.1,0.2 0.3,0.4");
  });

  it("boxes points and thins a long line to 200 evenly picked points", () => {
    expect(boxOf([[0.5, 0.2], [0.1, 0.6]])).toEqual({ x: 0.1, y: 0.2, w: 0.4, h: 0.4 });
    const long = Array.from({ length: 401 }, (_, i): FramePoint => [i / 400, 0]);
    const thinned = thin(long);
    expect(thinned).toHaveLength(200);
    expect(thinned[0]).toBe(long[0]);
    expect(thinned[199]).toBe(long[400]);
    expect(thin(long.slice(0, 10))).toEqual(long.slice(0, 10));
  });

  it("tells a freehand loop from an open stroke", () => {
    const loop: PictureMark = { kind: "draw", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.2], [0.3, 0.3], [0.1, 0.3], [0.11, 0.11]] };
    const open: PictureMark = { ...loop, points: [[0.1, 0.1], [0.15, 0.15], [0.2, 0.2], [0.25, 0.25], [0.28, 0.28], [0.3, 0.3]] };
    expect(isClosedDraw(loop)).toBe(true);
    expect(isClosedDraw(open)).toBe(false);
    expect(isClosedDraw({ kind: "box", box: loop.box })).toBe(false);
  });

  it("moves a mark without letting any of it leave the frame", () => {
    const box: PictureMark = { kind: "box", box: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } };
    expect(translateMark(box, 0.5, -0.5).box).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.2 });
    const line: PictureMark = { kind: "draw", box: { x: 0.6, y: 0.4, w: 0.2, h: 0.2 }, points: [[0.6, 0.4], [0.8, 0.6]] };
    const moved = translateMark(line, 0.5, 0);
    expect(moved.points).toEqual([[0.8, 0.4], [1, 0.6]]);
    expect(moved.box).toEqual({ x: 0.8, y: 0.4, w: 0.2, h: 0.2 });
  });
});
