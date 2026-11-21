import { describe, expect, it } from "vitest";
import { unmatchedTests } from "../src/ledger.ts";

describe("unmatchedTests", () => {
  const cmd = "cd packages/mcp && ../../node_modules/.bin/vitest run src/x.test.ts -t 'a test'";
  it("fails a filtered vitest run in which no test passed", () => {
    expect(unmatchedTests(cmd, " Test Files  1 skipped (1)\n      Tests  5 skipped (5)\n")).toBe(true);
    expect(unmatchedTests(cmd, "      Tests  \u001b[32m1 passed\u001b[39m | 4 skipped (5)\n")).toBe(false);
  });
  it("leaves other commands alone", () => {
    expect(unmatchedTests("node scripts/check.mjs", "")).toBe(false);
    expect(unmatchedTests("cd packages/mcp && ../../node_modules/.bin/vitest run src/x.test.ts", "Tests  5 skipped (5)")).toBe(false);
  });
});
