import { expect, it } from "vitest";
import { runMarkdown, type TrialRow } from "../src/report.ts";
import { positiveNumber } from "../src/run.ts";

it("averages only the trials that finished, and still lists the ones that didn't", () => {
  const row = (trial: number, state: string, tokens: number, error?: string): TrialRow =>
    ({ caseId: "interview", config: "claude:default:high", trial, state, headline: { tokens }, error });
  // A trial cancelled for asking a question is scored from the untouched video: few tokens, no clipped words.
  const md = runMarkdown("Run", [row(1, "done", 1000), row(2, "done", 3000), row(3, "cancelled", 10, "ended cancelled")]);
  const cells = md.split("\n").find(line => line.startsWith("| interview"))!.split("|").map(cell => cell.trim());
  expect(cells[3]).toBe("3 (2)");
  expect(cells.at(-2)).toBe("2000.0 ± 1414.2");
  expect(md).toContain("- interview · claude:default:high · trial 3: ended cancelled");
});

it("refuses a count or a time limit that isn't a positive number, rather than running none or waiting forever", () => {
  expect(positiveNumber("--trials", undefined, 3)).toBe(3);
  expect(positiveNumber("--timeout-min", "90", 120)).toBe(90);
  for (const bad of ["abc", "0", "-5", ""]) expect(() => positiveNumber("--timeout-min", bad, 120)).toThrow(/--timeout-min/);
});
