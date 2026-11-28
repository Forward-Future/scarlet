import { expect, it } from "vitest";
import { parseSubRip } from "./subrip.js";

it("reads numbered and unnumbered multiline cues on the edited clock", () => {
  expect(parseSubRip("\uFEFF1\r\n00:00:01,125 --> 00:00:02,500\r\nFirst\r\nline\r\n\r\n01:02:03.000 --> 01:02:04.000\r\nLast")).toEqual([
    { timelineIn: 1.125, timelineOut: 2.5, text: "First\nline" },
    { timelineIn: 3723, timelineOut: 3724, text: "Last" },
  ]);
});

it("rejects the complete import if a later cue is malformed", () => {
  const valid = "00:00:01,000 --> 00:00:02,000\nFirst\n\n";
  for (const bad of ["bad", "00:00:02,000 --> 00:00:01,000\nBackwards", "00:00:01,000 --> 00:00:02,000"]) {
    expect(() => parseSubRip(valid + bad)).toThrow("cue 2");
  }
});
