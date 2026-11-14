import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dialogueShortcut, EDITING_TOOL_GROUPS } from "@scarlet/shared";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./skills.js";

// The guides under skills/ are read by the model as written. A tool renamed in the engine or a typo in a command fails
// nothing else: the model is pointed at a tool it doesn't have, or the editor at a command the composer can't read.
// The guides are read from disk, so an edit is checked on the next run without rebuilding the bundle.

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../skills");
const shipped = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory())
  .map(d => ({ folder: d.name, content: readFileSync(join(skillsDir, d.name, "SKILL.md"), "utf8") }));
const tools = new Set<string>(EDITING_TOOL_GROUPS.flatMap(g => [...g.tools]));
const commands = new Set(shipped.map(s => parseFrontmatter(s.content).name ?? s.folder));

/** The tool and command names in a guide that Scarlet doesn't have. */
function unknownNames(text: string): string[] {
  const named = Array.from(text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g), m => m[1]!).filter(name => !tools.has(name));
  // Every `/…` in code is a command, in the only form the composer reads (skillCommands).
  const typed = Array.from(text.matchAll(/`(\/[^`\s]*)`/g), m => m[1]!).filter(command => {
    const name = /^\/([a-z0-9][a-z0-9-]*)$/.exec(command)?.[1];
    return !name || (!commands.has(name) && !dialogueShortcut(name, []));
  });
  return [...named, ...typed];
}

describe("the skills Scarlet ships", () => {
  it("are read from skills/", () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  it.each(shipped.map(s => [s.folder, s.content]))("%s names only tools and commands Scarlet has", (_folder, content) => {
    expect(unknownNames(content)).toEqual([]);
  });

  it("catch a misspelled tool and a command the composer can't read", () => {
    expect(unknownNames("Save the cuts with `dialogue_apply_cuts`, or type `/tighten-pauses-here`.")).toEqual([]);
    expect(unknownNames("Save the cuts with `dialogue_aply_cuts`, or type `/tighten_pauses_here`."))
      .toEqual(["dialogue_aply_cuts", "/tighten_pauses_here"]);
  });
});
