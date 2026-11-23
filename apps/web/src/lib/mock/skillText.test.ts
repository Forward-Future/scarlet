import { expect, it } from "vitest";
import type { Change } from "@scarlet/timeline";
import { skillFromChangeContent, withEditorRequest, withLearning } from "./skillText";

it("adds an editor's request as a section at the end of the instructions", () => {
  expect(withEditorRequest("# Pace\n\nKeep it tight.\n\n", "  Never cut a laugh. ")).toBe("# Pace\n\nKeep it tight.\n\n## From the editor\n\nNever cut a laugh.\n");
});

it("puts a rule in place of the first passage it replaces, drops the others, or adds it at the end", () => {
  const content = "Cut dead air.  Keep a second of pause. Trim every breath. End on the point.";
  expect(withLearning(content, "Keep a quarter second.", ["Keep a second of pause.", "Trim every breath."]))
    .toBe("Cut dead air. Keep a quarter second. End on the point.");
  // A passage the skill no longer has is skipped, so the next one takes the rule.
  expect(withLearning(content, "Keep a quarter second.", ["Gone already.", "Trim every breath."]))
    .toBe("Cut dead air.  Keep a second of pause. Keep a quarter second. End on the point.");
  expect(withLearning("# Pace\n", "Keep a laugh in.", undefined)).toBe("# Pace\n\nKeep a laugh in.\n");
});

it("writes a SKILL.md from an approved change, naming only the approved spots", () => {
  const change = { description: "Trim the \"um\"", ranges: [{ start: 1, end: 2.25 }, { start: 5, end: 6 }], approvedSpots: [1] } as Pick<Change, "description" | "ranges" | "approvedSpots"> as Change;
  expect(skillFromChangeContent("trim-ums", "chg_1", change)).toBe(
    "---\nname: trim-ums\ndescription: \"Trim the \\\"um\\\"\"\n---\n\n# trim-ums\n\nLearned from change chg_1.\n\n1. Trim the \"um\"\n2. Keep the affected range tight (5.0–6.0 s).\n",
  );
  expect(skillFromChangeContent("trim-ums", "chg_1", { ...change, ranges: [], approvedSpots: undefined })).toContain("(whole timeline)");
});
