// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { needNumbers } from "./needNumbers";

beforeEach(() => localStorage.clear());
const of = (keys: string[], root = "run") => [...needNumbers("prj", "thread", root, keys)].filter(([key]) => keys.includes(key));

it("numbers what is shown first in the order given, and gives what arrives later the next number", () => {
  expect(of(["ask/1", "ask/2", "edit/a"])).toEqual([["ask/1", 1], ["ask/2", 2], ["edit/a", 3]]);
  // A call that arrives later, and an edit earlier in the video, don't move the ones already numbered.
  expect(of(["ask/1", "ask/2", "ask/3", "edit/0", "edit/a"])).toEqual([["ask/1", 1], ["ask/2", 2], ["edit/a", 3], ["ask/3", 4], ["edit/0", 5]]);
  // One that has gone leaves its number unused, and has it back if it returns.
  expect(of(["ask/2", "edit/b"])).toEqual([["ask/2", 2], ["edit/b", 6]]);
  expect(of(["ask/1"])).toEqual([["ask/1", 1]]);
});

it("starts from 1 for another pass, and for another request", () => {
  of(["ask/1", "ask/2"]);
  expect(of(["ask/1"], "another run")).toEqual([["ask/1", 1]]);
  expect([...needNumbers("prj", "other thread", "run", ["ask/9"])]).toEqual([["ask/9", 1]]);
});

it("keeps the numbers for the session when storage refuses them", () => {
  const refused = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  try {
    expect(of(["ask/1", "edit/a"], "refused")).toEqual([["ask/1", 1], ["edit/a", 2]]);
    expect(of(["ask/2", "ask/1", "edit/a"], "refused")).toEqual([["ask/1", 1], ["edit/a", 2], ["ask/2", 3]]);
  } finally { refused.mockRestore(); }
});
