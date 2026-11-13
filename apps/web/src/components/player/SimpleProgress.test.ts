import { expect, it } from "vitest";
import { focusAround } from "./SimpleProgress";

it("zooms to a change and shades it", () => {
  expect(focusAround({ start: 100, end: 104 }, 3000, "Removed · 4.0 s")).toEqual({
    view: { start: 95, end: 109 }, band: { start: 100, end: 104 }, bandLabel: "Removed · 4.0 s",
  });
});

it("keeps the whole line when a change spans most of the video", () => {
  expect(focusAround({ start: 0, end: 3467 }, 3467)).toBeUndefined();
  expect(focusAround({ start: 3, end: 3401 }, 3401)).toBeUndefined();
});
