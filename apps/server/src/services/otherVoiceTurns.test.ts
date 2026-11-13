import { expect, it } from "vitest";
import { otherVoiceTurns } from "./otherVoiceTurns.js";

it("keeps a private reply discoverable and flags presenter speech in an internal gap", () => {
  const low: [number, number, number] = [0, 0, 0];
  const me: typeof low = [1e6, 1e6, 0], other: typeof low = [1e6, 0, 1e6];
  const page = [...Array(8).fill(other), ...Array(4).fill(me), ...Array(6).fill(other), ...Array(40).fill(low), ...Array(9).fill(other)];
  const turns = otherVoiceTurns(page, { me: 2, other: 3 }, 10, 11.34);
  expect(turns).toEqual([{ start: 10, end: 10.36, meAlsoActive: true }, { start: 11.16, end: 11.34, meAlsoActive: false }]);
});
