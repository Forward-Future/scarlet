import { describe, expect, it } from "vitest";
import { changedAreas, detailCells } from "./screenMotion.js";

describe("changedAreas", () => {
  it("makes one area of cells that touch or nearly do, and keeps a lone cell apart, largest first", () => {
    const cols = 10, rows = 6, cells = new Uint8Array(cols * rows);
    for (const [x, y] of [[1, 1], [2, 1], [4, 2], [2, 3], [8, 5]]) cells[y * cols + x] = 1;
    expect(changedAreas(cells, cols, rows)).toEqual([[0.1, 0.167, 0.5, 0.667, 0.067], [0.8, 0.833, 0.9, 1, 0.017]]);
  });
});

describe("detailCells", () => {
  it("marks the cells with something in them, and leaves a flat background and a soft gradient out", () => {
    const width = 40, height = 20, rgb = Buffer.alloc(width * height * 3, 20);
    // A gradient across the whole frame, a few levels from one cell to the next, and a white ring's edge in the cell at column 3, row 1 of a 4 × 2 grid.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.fill(20 + Math.floor(x / 4), (y * width + x) * 3, (y * width + x) * 3 + 3);
    for (let y = 12; y < 15; y++) for (let x = 33; x < 36; x++) rgb.fill(240, (y * width + x) * 3, (y * width + x) * 3 + 3);
    const bits = detailCells(rgb, width, height, 4, 2);
    expect([...Array(8).keys()].map(i => (bits[i >> 3]! >> (i & 7)) & 1)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });
});
