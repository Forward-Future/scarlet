import { describe, expect, it } from "vitest";
import { flagNames, stderrTail, throttledLog } from "./logText.js";

describe("log text", () => {
  it("names a command line's flags once each, never their values", () => {
    expect(flagNames(["-p", "--resume", "ses_123", "-c", 'a="b"', "-c", "x=1", "--model=opus", "-", "{\"sandbox\":{}}"]))
      .toBe("-p,--resume,-c,--model");
  });
  it("keeps the last five lines of stderr on one line", () => {
    expect(stderrTail("\n")).toBeUndefined();
    expect(stderrTail("1\n2\n\n3\n4\n5\n6\n")).toBe("2 | 3 | 4 | 5 | 6");
    expect(stderrTail("x".repeat(20), 5)).toBe("…xxxxx");
  });
  it("logs a repeating line once a minute, with a count of the rest", () => {
    const lines: string[] = [];
    const log = throttledLog((line) => lines.push(line));
    log("k", "failed", 0);
    log("k", "failed", 10_000);
    log("other", "other", 10_000);
    log("k", "failed", 61_000);
    expect(lines).toEqual(["failed", "other", "failed (and 1 more like it)"]);
  });
});
