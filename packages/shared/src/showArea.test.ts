import { describe, expect, it } from "vitest";
import { areaAt, assignAreas, edgeBits, sideFits, wholePicture, type AreaBox, type ShowArea } from "./showArea.js";

const W = 160, H = 90;
/** A dark desktop with one lighter window on it, as packed RGB. */
function desktop(window?: AreaBox): Uint8Array {
  const rgb = new Uint8Array(W * H * 3).fill(20);
  if (window) for (let y = Math.round(window[1] * H); y < Math.round(window[3] * H); y++) for (let x = Math.round(window[0] * W); x < Math.round(window[2] * W); x++) rgb.fill(90, (y * W + x) * 3, (y * W + x) * 3 + 3);
  return rgb;
}
const fits = (window: AreaBox | undefined, area: AreaBox) => sideFits(edgeBits(desktop(window), W, H), area, W, H);
const box: AreaBox = [0.1, 0.1, 0.8, 0.9];

describe("an area's edges on a frame", () => {
  it("are lines while the window stays and gone when it moves", () => {
    expect(Math.min(...Object.values(fits(box, box)))).toBeGreaterThan(0.9);
    expect(fits([0.1, 0.1, 0.7, 0.9], box).right).toBeLessThan(0.5);
  });
  it("count as there on the frame's own edge", () => {
    expect(fits([0, 0.1, 0.8, 0.9], [0, 0.1, 0.8, 0.9]).left).toBe(1);
    expect(wholePicture([0, 0, 1, 1])).toBe(true);
    expect(wholePicture(box)).toBe(false);
  });
});

describe("where each area holds", () => {
  const moved: AreaBox = [0.2, 0.1, 0.6, 0.9];
  // Six frames, 5 s apart: the window, the window, nothing, the moved window twice, the first window again.
  const frames = [box, box, undefined, moved, moved, box].map(w => edgeBits(desktop(w), W, H));
  const fitsAt = (frame: number, area: AreaBox) => sideFits(frames[frame]!, area, W, H);
  const area = (at: number, a: AreaBox, noLine: ShowArea["noLine"] = []): ShowArea => ({ at, area: a, noLine });

  it("gives each frame to the box whose edges are there, and leaves the rest unset", () => {
    const { areas, unset } = assignAreas(6, 27.5, [area(0, box), area(15, moved)], fitsAt);
    expect(areas[0]!.holds).toEqual([[0, 7.5], [22.5, 27.5]]);
    expect(areas[1]!.holds).toEqual([[12.5, 22.5]]);
    expect(unset).toEqual([[7.5, 12.5]]);
    expect(areaAt(areas, 24)?.at).toBe(0);
    expect(areaAt(areas, 10)).toBeUndefined();
  });
  it("lets the whole picture hold only where no window's box does", () => {
    const { areas, unset } = assignAreas(6, 27.5, [area(0, box), area(10, [0, 0, 1, 1])], fitsAt);
    expect(areas[0]!.holds).toEqual([[0, 7.5], [22.5, 27.5]]);
    expect(areas[1]!.holds).toEqual([[7.5, 22.5]]);
    expect(unset).toEqual([]);
  });
  it("holds the last frame's area to the end of a recording that runs past it", () => {
    const { areas, unset } = assignAreas(6, 31, [area(10, [0, 0, 1, 1])], fitsAt);
    expect(unset).toEqual([]);
    expect(areaAt(areas, 30.9)?.at).toBe(10);
  });
  it("holds a box with no line under any edge on its own frame only", () => {
    const { areas } = assignAreas(6, 27.5, [area(10, [0.3, 0.3, 0.5, 0.5], ["left", "top", "right", "bottom"])], fitsAt);
    expect(areas[0]!.holds).toEqual([[7.5, 12.5]]);
  });
  it("holds a box on the frame it was given on when that step's edges don't fit it", () => {
    // Given at 11 s on the window, where the frame read at 10 s shows nothing.
    const { areas, unset } = assignAreas(6, 27.5, [area(0, box), area(11, box)], fitsAt);
    expect(areas[1]!.holds).toEqual([[7.5, 12.5], [22.5, 27.5]]);
    expect(unset).toEqual([[12.5, 22.5]]);
    // A frame some box fits keeps going to it: the moved window given at 6 s, where the frame read at 5 s is the first.
    const fit = assignAreas(6, 27.5, [area(0, box), area(6, moved)], fitsAt);
    expect(areaAt(fit.areas, 6)?.at).toBe(0);
    expect(fit.areas[1]!.holds).toEqual([[12.5, 22.5]]);
  });
  it("does not need an edge marked as having no line", () => {
    const { areas } = assignAreas(6, 27.5, [area(0, [0.1, 0.1, 0.8, 0.7], ["bottom"])], fitsAt);
    expect(areas[0]!.holds).toEqual([[0, 7.5], [22.5, 27.5]]);
  });
  it("gives a frame two boxes fit to the one given nearest in time", () => {
    // A pane inside the window shares its right and bottom edges; its left has no line.
    const pane = area(25, [0.4, 0.1, 0.8, 0.9], ["left"]);
    const { areas } = assignAreas(6, 27.5, [area(0, box), pane], fitsAt);
    expect(areas[0]!.holds).toEqual([[0, 7.5]]);
    expect(areas[1]!.holds).toEqual([[22.5, 27.5]]);
  });

  it("holds a box with one edge to find until the picture changes at once", () => {
    // The whole screen but its menu bar: the one line under the bar is on every frame, whatever app is up.
    const screen: AreaBox = [0, 0.05, 1, 1];
    const shots = Array.from({ length: 6 }, () => edgeBits(desktop(screen), W, H));
    const at = (frame: number, a: AreaBox) => sideFits(shots[frame]!, a, W, H);
    // Before the picture has been read, it holds on its own frame only.
    expect(assignAreas(6, 27.5, [area(5, screen)], at).areas[0]!.holds).toEqual([[2.5, 7.5]]);
    // A switch of app at 13 s ends it there, and a box given after the switch holds from it.
    const changes = { read: [[0, 27.5]] as Array<[number, number]>, at: [13] };
    const one = assignAreas(6, 27.5, [area(5, screen)], at, 5, changes);
    expect(one.areas[0]!.holds).toEqual([[0, 13]]);
    expect(one.unset).toEqual([[13, 27.5]]);
    const two = assignAreas(6, 27.5, [area(5, screen), area(20, screen)], at, 5, changes);
    expect(two.areas[1]!.holds).toEqual([[13, 27.5]]);
    expect(two.unset).toEqual([]);
    // It doesn't hold where the picture hasn't been read.
    expect(assignAreas(6, 27.5, [area(5, screen)], at, 5, { read: [[0, 10]], at: [] }).areas[0]!.holds).toEqual([[0, 7.5]]);
  });
});
