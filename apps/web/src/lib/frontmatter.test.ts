import { expect, it } from "vitest";
import { composeSkill, splitFrontmatter } from "./frontmatter";

it("preserves unknown skill metadata and comments during body and property edits", () => {
  const header = ["---", "name: custom-edit", "description: >-", "  Original description",
    "# shared provenance", "metadata:", "  license: MIT", "  tags:", "    - pacing", 'example: "a: b"', "---", ""].join("\r\n");
  const source = splitFrontmatter(header + "\r\nOriginal body");
  const fields = { name: "custom-edit", description: source.frontmatter.description! };
  expect(composeSkill(fields, "\r\nEdited body", source)).toBe(header + "\r\nEdited body");
  expect(composeSkill({ ...fields, description: "Shorter description" }, source.body, source)).toBe(
    (header + source.body).replace("description: >-\r\n  Original description", "description: Shorter description"));
});

it("reads back a description with a quote, a backslash and a line break as it was written", () => {
  const fields = { name: "tighten", description: 'Use it when I say "tighten this".\nKeep C:\\clips as is.' };
  const written = composeSkill(fields, "Body");
  const read = splitFrontmatter(written);
  // Restoring a version puts this in the field, and Save stores it: escape codes would show in the library and double.
  expect(read.frontmatter.description).toBe(fields.description);
  expect(composeSkill(fields, read.body, read)).toBe(written);
});
