import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dialogueShortcut, EDITING_TOOL_GROUPS, SKILL_CATEGORIES } from "@scarlet/shared";
import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS } from "../bundledSkills.js";
import { parseFrontmatter } from "./skills.js";

// The guides under skills/ are read by the model as written. A tool renamed in the engine, a typo in a command, or a
// header the app can't place doesn't fail anything else: the model is pointed at a tool it doesn't have, or the guide
// stops being recognised as stock and no longer updates. These checks hold every shipped guide to what the product
// actually offers.

const readme = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../skills/README.md"), "utf8");
const toolNames = new Set<string>(EDITING_TOOL_GROUPS.flatMap(g => [...g.tools]));
const category = (content: string) => /^---\r?\n[\s\S]*?^category:\s*(.*?)\s*$/m.exec(content)?.[1];
const body = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");

describe("the skills Scarlet ships", () => {
  it("are bundled from skills/", () => {
    expect(BUNDLED_SKILLS.length).toBeGreaterThan(0);
  });

  it.each(BUNDLED_SKILLS.map(s => [s.folder, s.content]))("%s is named for its folder, as stock-skill upgrades assume", (folder, content) => {
    const { name, description } = parseFrontmatter(content);
    // Seeding, upgrades and the workflow listing find a stock skill by `folder === name`.
    expect(name).toBe(folder);
    // The name seeding would store, unchanged.
    expect(folder).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    // The description is the trigger the model reads when no guide is pinned.
    expect(description?.length).toBeGreaterThan(0);
  });

  it.each(BUNDLED_SKILLS.map(s => [s.folder, s.content]))("%s is in a group the Skills page draws", (_folder, content) => {
    expect(SKILL_CATEGORIES).toContain(category(content));
  });

  it.each(BUNDLED_SKILLS.map(s => [s.folder, s.content]))("%s names only tools Scarlet has", (_folder, content) => {
    const named = Array.from(body(content).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g), m => m[1]!);
    expect(named.filter(name => !toolNames.has(name))).toEqual([]);
  });

  it.each(BUNDLED_SKILLS.map(s => [s.folder, s.content]))("%s names only commands the composer resolves", (_folder, content) => {
    const shipped = new Set(BUNDLED_SKILLS.map(s => s.folder));
    const commands = Array.from(body(content).matchAll(/`\/([a-z0-9][a-z0-9-]*)`/g), m => m[1]!);
    expect(commands.filter(name => !shipped.has(name) && !dialogueShortcut(name, []))).toEqual([]);
  });

  it("are each listed once in skills/README.md, under the group the app shows them in", () => {
    const rows = Array.from(readme.matchAll(/^\|\s*([^|]+?)\s*\|\s*\[[^\]]+\]\(([a-z0-9-]+)\/SKILL\.md\)/gm), m => ({ stage: m[1]!, folder: m[2]! }));
    expect(rows.map(r => r.folder).sort()).toEqual(BUNDLED_SKILLS.map(s => s.folder).sort());
    for (const { stage, folder } of rows) expect([folder, stage]).toEqual([folder, category(BUNDLED_SKILLS.find(s => s.folder === folder)!.content)]);
  });
});
