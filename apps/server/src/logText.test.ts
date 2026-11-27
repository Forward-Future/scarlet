import { expect, it } from "vitest";
import { wellFormed } from "@scarlet/shared";
import { clip, humanDuration, since, throttledLog } from "./logText.js";

it("writes elapsed time in the largest two units that matter", () => {
  expect([0, 0.4, 850, 999].map(humanDuration)).toEqual(["0ms", "0ms", "850ms", "999ms"]);
  expect([1000, 12_900, 59_999].map(humanDuration)).toEqual(["1s", "12s", "59s"]);
  expect([60_000, 2_702_000].map(humanDuration)).toEqual(["1m", "45m 2s"]);
  // Past an hour the seconds no longer matter.
  expect([3_600_000, 3_780_000 + 59_000, 90_000_000].map(humanDuration)).toEqual(["1h", "1h 3m", "25h"]);
  // A clock set back between two readings is no time at all, not a negative one.
  expect(humanDuration(-5000)).toBe("0ms");
});

it("measures from a timestamp, and says nothing when there isn't a readable one", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  expect(since("2026-11-08T09:14:58.000Z", now)).toBe("45m 2s");
  expect(since("2026-11-08T10:00:00.000Z", now)).toBe("0ms");
  expect([since(undefined, now), since(null, now), since("", now), since("yesterday", now)]).toEqual(["", "", "", ""]);
});

it("makes one line of a message and cuts it at the limit", () => {
  expect(clip("  ffmpeg exited\n\twith   code 1\r\n")).toBe("ffmpeg exited with code 1");
  expect(clip("abcdefghij", 10)).toBe("abcdefghij");
  expect(clip("abcdefghijk", 10)).toBe("abcdefghi…");
  expect(clip("x".repeat(500))).toHaveLength(160);
});

it("writes a repeating failure once a minute for each thing that fails, with a count of the rest", () => {
  const lines: string[] = [];
  const log = throttledLog(line => lines.push(line));
  log("med_a", "a failed", 0);
  log("med_a", "a failed", 20_000);
  log("med_b", "b failed", 30_000);
  log("med_a", "a failed again", 59_999);
  expect(lines).toEqual(["a failed", "b failed"]);
  log("med_a", "a still failing", 60_000);
  log("med_b", "b still failing", 90_000);
  expect(lines.slice(2)).toEqual(["a still failing (and 2 more like it)", "b still failing"]);
  // The count starts again after each line.
  log("med_a", "a once more", 130_000);
  expect(lines.at(-1)).toBe("a once more");
});

it("forgets the oldest of many failing things instead of growing without end", () => {
  const lines: string[] = [];
  const log = throttledLog(line => lines.push(line));
  for (let i = 0; i <= 200; i++) log(`med_${i}`, `${i} failed`, i);
  // The first one was dropped to make room, so it is written again as new. A recent one is still held back.
  log("med_0", "0 failed", 300);
  log("med_200", "200 failed", 300);
  expect(lines).toHaveLength(202);
  expect(lines.at(-1)).toBe("0 failed");
});

it("keeps holding back many things that keep failing instead of forgetting them early", () => {
  const lines: string[] = [];
  const log = throttledLog(line => lines.push(line), 60_000, 1000);
  for (let round = 0; round < 3; round++)
    for (let i = 0; i < 500; i++) log(`tsk_${i}`, `${i} blocked`, round * 10_000 + i);
  expect(lines).toHaveLength(500);
});

it("drops expired keys before live ones when full", () => {
  const lines: string[] = [];
  const log = throttledLog(line => lines.push(line), 60_000, 2);
  log("old", "old failed", 0);
  log("a", "a failed", 70_000);
  log("b", "b failed", 70_001);
  // "old" expired and went first, so "a" is still held back.
  log("a", "a failed", 70_002);
  expect(lines).toEqual(["old failed", "a failed", "b failed"]);
});

it("shortens a line with an emoji at the cut to whole characters only, so every reader can take it", () => {
  const said = clip("a".repeat(398) + "👍 keep my jump cuts tight", 400);
  expect(wellFormed(said)).toBe(said);
  expect(said.endsWith("a…")).toBe(true);
});
