// The stock editing skills a fresh library starts with: every skills/*/SKILL.md, as
// apps/server/scripts/gen-skills.mjs bundles them into the engine, named by its frontmatter.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../skills");

export function stockSkillNames(dir = skillsDir) {
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
    names.push(name ?? entry.name);
  }
  return names.sort();
}
