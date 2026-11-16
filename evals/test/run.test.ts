import { expect, it } from "vitest";
import { runMarkdown, type TrialRow } from "../src/report.ts";
import { wordDigest } from "../../packages/mcp/src/transcript-digest.ts";
import { branchName, positiveNumber, selectTrialSkills, trialTranscripts } from "../src/run.ts";

it("gives repeated trials distinct branches even with long case and model names", () => {
  const caseId = "long-project-name-".repeat(5), stamp = "2026-11-15T10-30-00Z";
  const config = { agent: "codex", model: "long-model-name" };
  const name = branchName(caseId, config, 1, stamp);
  expect(name).toHaveLength(80);
  expect(name).not.toBe(branchName(caseId, config, 2, stamp));
  expect(name).not.toBe(branchName(caseId, { ...config, model: "another-model" }, 1, stamp));
});

it("binds a live trial to the ordered source words and their timing", () => {
  const a = { text: "again", start: 0.1, end: 0.4 };
  const b = { ...a, start: 0.5, end: 0.8 };
  expect(wordDigest([a, b])).not.toBe(wordDigest([b, a]));
  expect(wordDigest([a])).not.toBe(wordDigest([{ ...a, end: 0.41 }]));
  const sha256 = wordDigest([a, b]);
  const expected = [{ mediaId: "cam", count: 2, sha256, frozenSha256: sha256 }];
  const event = { type: "log", text: "", data: { kind: "eval_transcript", mediaId: "cam", count: 2, sha256 } };
  expect(trialTranscripts(expected, expected, [event]).mismatchedMedia).toEqual([]);
  expect(trialTranscripts(expected, expected, []).mismatchedMedia).toEqual(["cam"]);
  const changed = { ...event, data: { ...event.data, sha256: wordDigest([b, a]) } };
  expect(trialTranscripts(expected, expected, [event, changed, event]).mismatchedMedia).toEqual(["cam"]);
});

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

it("can run a renamed custom guide alone on a case that originally used a different guide", () => {
  const available = [{ id: "original", name: "dialogue-pass", version: 4 }, { id: "personal", name: "renamed-guide", version: 7 }];
  const wanted = { instruction: "First cut", skillIds: ["original"], skillNames: ["dialogue-pass"] };
  expect(selectTrialSkills(available, wanted, { exact: ["renamed-guide"], add: [] })).toEqual([available[1]]);
  expect(selectTrialSkills(available, { ...wanted, skillIds: ["personal"], skillNames: ["old-name"] }, { add: [] })).toEqual([available[1]]);
  expect(() => selectTrialSkills([{ ...available[1]!, enabled: false }], wanted, { exact: ["renamed-guide"], add: [] })).toThrow("unavailable");
});

it("keeps the original guide after a rename even if a new guide reuses its old name", () => {
  const renamed = { id: "original", name: "my-cut", version: 2 };
  const replacement = { id: "new", name: "dialogue-pass", version: 1 };
  const wanted = { instruction: "First cut", skillIds: ["original"], skillNames: ["dialogue-pass"] };
  expect(selectTrialSkills([renamed, replacement], wanted, { add: [] })).toEqual([renamed]);
  expect(selectTrialSkills([replacement], wanted, { add: [] })).toEqual([replacement]);
  expect(() => selectTrialSkills([{ ...renamed, enabled: false }, replacement], wanted, { add: [] })).toThrow("disabled");
  expect(() => selectTrialSkills([renamed], { ...wanted, skillIds: ["original", "missing"],
    skillNames: ["dialogue-pass", "cutaway"] }, { add: [] })).toThrow("cutaway");
});
