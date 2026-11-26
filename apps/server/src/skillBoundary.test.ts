/**
 * Skills, the engine and the models stay apart. A skill is an editable file: the editor can rename, rewrite or delete
 * it, or write their own from scratch, and Scarlet works the same. So code never knows a skill by its name: it reads
 * what a skill's file says (`runs:`, `extends:`, `category:`), and what upgrading needs about skills Scarlet used to
 * ship is kept with the skills (skills/retired.json). This test fails when a skill's name shows up in code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_COMMANDS } from "@scarlet/shared";
import { expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const skillsDir = join(root, "skills");

/** Every name a skill Scarlet ships, or once shipped, goes by. */
function skillNames(): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    names.add(entry.name);
    const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
    if (name) names.add(name);
  }
  const retired = JSON.parse(readFileSync(join(skillsDir, "retired.json"), "utf8"));
  for (const [old, { to }] of Object.entries(retired.renamed as Record<string, { to: string }>)) names.add(old).add(to);
  for (const name of [...retired.workflows.names, ...Object.values(retired.workflows.replacedBy as Record<string, string>), ...retired.guides.names]) names.add(name);
  if (retired.shortcuts.movesTo) names.add(retired.shortcuts.movesTo);
  return [...names];
}

/**
 * Words that are also a skill's name but mean something else where code uses them. Each says what it is instead.
 * The engine's own commands (`BUILT_IN_COMMANDS`) are written once, where they are defined.
 */
const OTHER_MEANINGS: Record<string, string> = {
  "b-roll": "the label of an edit kind (editKind.ts)",
  "motion-graphics": "the id of a kind of work in Settings → Models (taskModels.ts)",
};
const COMMANDS_FILE = "packages/shared/src/skillCommands.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "target", "gen", ".turbo"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mjs|rs)$/.test(entry.name) && !/\.test\.(ts|tsx|mjs)$|\.testkit\.ts$|\.d\.ts$/.test(entry.name) &&
      entry.name !== "bundledSkills.ts" && statSync(path).size < 2_000_000) out.push(path);
  }
  return out;
}

it("names no skill in code", () => {
  const commands = new Set(BUILT_IN_COMMANDS.map(command => command.name));
  const names = skillNames().filter(name => !Object.hasOwn(OTHER_MEANINGS, name));
  expect(names.length).toBeGreaterThan(0);
  const escaped = names.map(name => name.replace(/[-]/g, "\\-")).join("|");
  // A name as a whole string, or called as a command.
  const pattern = new RegExp(`(["'\`])(${escaped})\\1|(?:^|[\\s("'\`])/(${escaped})(?![\\w-])`, "gm");
  const dirs = ["apps", "packages", "evals"].flatMap(top => readdirSync(join(root, top), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).flatMap(entry => ["src", "scripts", "src-tauri/src"].map(sub => join(root, top, entry.name, sub))))
    .concat(join(root, "evals", "src"))
    .filter(dir => existsSync(dir));
  const found: string[] = [];
  for (const file of [...new Set(dirs.flatMap(dir => sourceFiles(dir)))]) {
    const path = relative(root, file);
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const match of line.matchAll(pattern)) {
        const name = match[2] ?? match[3]!;
        if (path === COMMANDS_FILE && commands.has(name)) continue;
        found.push(`${path}:${i + 1}: ${name}`);
      }
    });
  }
  expect(found).toEqual([]);
});

it("ships every skill in its own words, with nothing a skill needs from code", () => {
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    expect(/^name:\s*(.+)$/m.exec(text)?.[1]?.trim(), file).toBe(entry.name);
    // A skill names no model or provider: which model does a kind of work is the editor's choice (Settings → Models).
    expect(text, file).not.toMatch(/\b(claude|gemini|gpt-\d|codex|opus|sonnet|openai|anthropic)\b/i);
  }
});
