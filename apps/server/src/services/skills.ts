import { randomUUID } from "node:crypto";
import { lstatSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Skill, skillExtends, type UpsertSkillRequest, type User } from "@scarlet/shared";
import type { Author } from "@scarlet/timeline";
import { newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { BUNDLED_SKILLS } from "../bundledSkills.js";
import { badRequest, conflict, HttpError } from "../errors.js";
import { atomicWriteFileSync } from "../util.js";
import { actorFor, authorName, logActivity, quote } from "./activity.js";
import { RETIRED_WORKFLOWS } from "./skillSeed.js";

export { migrateGlobalSkills, retireMergedSkills, seedSkillList, seedSkills } from "./skillSeed.js";

type MirrorLocation = Pick<Skill, "id" | "name"> & {
  scope: "project" | "personal" | "team";
  projectId?: string | null;
  ownerId?: string | null;
};

/** Scoped paths are read only to clean up pre-global skill mirrors. */
function skillDiskPath(ctx: Ctx, skill: MirrorLocation): string {
  const parts: string[] = [skill.scope];
  if (skill.scope === "personal") parts.push(skill.ownerId ?? "");
  if (skill.scope === "project") parts.push(skill.projectId ?? "");
  parts.push(skill.name, "SKILL.md");
  let path = ctx.paths.skills;
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw badRequest("unsafe_skill_path", "invalid skills root");
  for (const part of parts) {
    if (part !== "SKILL.md" && !/^[a-z0-9_-]+$/i.test(part)) throw badRequest("unsafe_skill_path", "invalid skill path component");
    path = join(path, part);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw badRequest("unsafe_skill_path", "skill paths cannot contain symlinks");
  }
  return path;
}

export function mirrorSkill(ctx: Ctx, skill: Skill) {
  const p = skillDiskPath(ctx, skill);
  atomicWriteFileSync(p, skill.content, join(dirname(p), randomUUID() + ".tmp"), { flag: "wx", mode: 0o600 });
}

export function unmirrorSkill(ctx: Ctx, skill: MirrorLocation) {
  let file: string;
  try {
    file = skillDiskPath(ctx, skill);
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== "unsafe_skill_path") throw err;
    ctx.log(`[skills] skipped unsafe legacy mirror for ${skill.id}`);
    return;
  }
  rmSync(file, { force: true });
  try {
    rmdirSync(dirname(file));
  } catch (err) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

/** Parse `name:` / `description:` from YAML-ish frontmatter. */
export function parseFrontmatter(content: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as "name" | "description"] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * A skill's text with a new description and instructions. The model supplies those two; the name and anything else
 * in the header (its category, say) stay as the editor has them.
 */
export function reviseSkillContent(skill: Pick<Skill, "name" | "content">, draft: { description: string; instructions: string }): string {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.content);
  // A description the revision left alone stays as it was written.
  const replaced = parseFrontmatter(skill.content).description === draft.description ? /^(["']?)name\1:/ : /^(["']?)(name|description)\1:/;
  const kept: string[] = [];
  let dropping = false;
  for (const line of header?.[1]!.split(/\r?\n/) ?? []) {
    // A value can run on over indented lines. They go with their key.
    if (replaced.test(line)) dropping = true;
    else if (dropping && (/^[ \t]/.test(line) || !line.trim())) continue;
    else dropping = false;
    if (!dropping) kept.push(line);
  }
  const description = kept.some(line => /^(["']?)description\1:/.test(line)) ? []
    : [`description: ${/^\w[\w .,-]*$/.test(draft.description) ? draft.description : JSON.stringify(draft.description)}`];
  return ["---", `name: ${skill.name}`, ...description, ...kept, "---", "", draft.instructions.trim(), ""].join("\n");
}

/** The latest request to revise this skill with a prompt, whatever state it is in. */
export function latestSkillEdit(ctx: Ctx, skillId: string) {
  return ctx.repos.tasks.select("kind = 'skill_edit' AND json_extract(json, '$.context.skillId') = ?", [skillId], "created_at DESC, rowid DESC LIMIT 1")[0];
}

/** Every request to revise this skill with a prompt, in the order asked: the conversation on the skill's page. */
export function skillEdits(ctx: Ctx, skillId: string) {
  return ctx.repos.tasks.select("kind = 'skill_edit' AND json_extract(json, '$.context.skillId') = ?", [skillId], "created_at ASC, rowid ASC");
}

/** A skill's text in its parts: when to use it, the opening before the first heading, and each section by its heading. */
function skillParts(content: string): Map<string, string> {
  const parts = new Map<string, string>();
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  parts.set("when to use it", parseFrontmatter(content).description ?? "");
  let title = "the opening";
  for (const line of content.slice(header?.[0].length ?? 0).split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) title = heading[1]!;
    parts.set(title, `${parts.get(title) ?? ""}${line.trim()}\n`);
  }
  return parts;
}

// A section goes by its heading, in quotes; the two parts every skill has go by what they are.
const named = (title: string) => title === "when to use it" || title === "the opening" ? title : `“${title}”`;
const listed = (titles: string[]) => {
  const words = titles.map(named);
  return words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
};

/** What one version changed from the one before, in one line, said by the parts of the skill it touched. */
export function versionChange(before: string, after: string): string {
  const was = skillParts(before), now = skillParts(after);
  const key = (title: string) => title.toLowerCase();
  const wasByKey = new Map([...was].map(([title, text]) => [key(title), text]));
  const nowKeys = new Set([...now.keys()].map(key));
  const added = [...now.keys()].filter(title => !wasByKey.has(key(title)));
  const removed = [...was.keys()].filter(title => !nowKeys.has(key(title)));
  const changed = [...now].filter(([title, text]) => wasByKey.has(key(title)) && wasByKey.get(key(title))!.trim() !== text.trim()).map(([title]) => title);
  const touched = added.length + removed.length + changed.length;
  if (!touched) return "Changed the header";
  const sections = Math.max(was.size, now.size) - 1;
  if (sections >= 4 && touched - (changed.includes("when to use it") ? 1 : 0) > sections * 0.6) return "Rewrote most of it";
  const said = [
    added.length && `added ${listed(added)}`,
    removed.length && `removed ${listed(removed)}`,
    changed.length && `changed ${listed(changed)}`,
  ].filter(Boolean) as string[];
  const line = said.join(", ");
  // A long list says how many parts, not which.
  const short = line.length <= 80 ? line : `changed ${touched} parts`;
  return short[0]!.toUpperCase() + short.slice(1);
}

/**
 * The skill's versions, each with a line that says what it changed: for the history on the skill's page. A version
 * Scarlet wrote is matched to the request that asked for it, the latest one that saved this skill after the version before.
 */
export function skillHistory(ctx: Ctx, skillId: string) {
  const versions = ctx.repos.skillVersions.list(skillId);
  const saves = skillEdits(ctx, skillId).filter(task => task.resultSkillId === skillId);
  return versions.map((v, i) => {
    const before = versions[i - 1];
    if (v.author?.type === "agent" && v.createdAt) {
      const after = before?.createdAt ?? "";
      const task = saves.filter(t => t.createdAt && t.createdAt > after && t.createdAt <= v.createdAt!).at(-1);
      const learning = task?.context.learningId ? ctx.repos.learnings.get(task.context.learningId) : undefined;
      if (learning) return { ...v, note: learning.rule, from: "learning" as const };
      if (task) return { ...v, note: task.instruction, from: "request" as const };
    }
    if (!before) return { ...v, note: v.author?.type === "scarlet" ? "Came with Scarlet" : "First version" };
    const same = versions.slice(0, i - 1).findLast(earlier => earlier.content === v.content);
    return { ...v, note: same ? `Restored v${same.version}` : versionChange(before.content, v.content) };
  });
}

export function findDuplicateSkill(ctx: Ctx, name: string, excludeId?: string) {
  return ctx.repos.skills.select("name = ?", [name]).find(skill => skill.id !== excludeId);
}

/** A skill Scarlet came with that the editor hasn't edited. Editing its text makes it theirs (`updateSkill`). */
export function outOfBoxSkill(skill: Skill) {
  return skill.source === "bundled" || skill.source === "seed";
}

export function createSkill(ctx: Ctx, user: User | null, body: UpsertSkillRequest, extra: { source?: string } = {}): Skill {
  const dup = findDuplicateSkill(ctx, body.name);
  if (dup) throw conflict("skill_exists", `a skill named "${body.name}" already exists`, { skillId: dup.id });
  const ts = now();
  const fm = parseFrontmatter(body.content);
  const skill = Skill.parse({
    id: newId("skl"),
    name: body.name,
    description: body.description ?? fm.description ?? "",
    content: body.content,
    scope: "team",
    enabled: body.enabled ?? true,
    version: 1,
    source: extra.source,
    bundledName: extra.source === "bundled" || extra.source === "seed" ? body.name : undefined,
    createdAt: ts,
    updatedAt: ts,
  });
  mirrorSkill(ctx, skill);
  ctx.repos.skills.put(skill);
  ctx.repos.skillVersions.append(skill.id, { version: 1, content: skill.content, author: actorFor(user), createdAt: ts });
  ctx.bus.publish({ type: "skill.updated", skill });
  if (user) logActivity(ctx, { projectId: skill.projectId ?? null, actor: actorFor(user), type: "skill.created", summary: `${user.name} added the skill ${quote(skill.name)}`, data: { skillId: skill.id } });
  return skill;
}

/** `author`: the agent that wrote this version at the editor's request. Otherwise the editor wrote it. */
export function updateSkill(ctx: Ctx, user: User | null, existing: Skill, body: Partial<UpsertSkillRequest>, extra: { author?: Author } = {}): Skill {
  const next = {
    ...existing,
    name: body.name ?? existing.name,
    description: body.description ?? existing.description,
    content: body.content ?? existing.content,
    enabled: body.enabled ?? existing.enabled,
    updatedAt: now(),
  };
  const dup = findDuplicateSkill(ctx, next.name, existing.id);
  if (dup) throw conflict("skill_exists", `a skill named "${next.name}" already exists`, { skillId: dup.id });
  const contentChanged = next.content !== existing.content;
  if (contentChanged) next.version = existing.version + 1;
  // A skill Scarlet came with is the editor's own once they edit it. A later release leaves it alone.
  if (contentChanged && user && outOfBoxSkill(existing)) next.source = undefined;
  const parsed = Skill.parse(next);
  mirrorSkill(ctx, parsed);
  if (parsed.name !== existing.name) {
    unmirrorSkill(ctx, existing);
  }
  const saved = ctx.repos.skills.put(parsed);
  if (contentChanged) {
    ctx.repos.skillVersions.append(saved.id, { version: saved.version, content: saved.content, author: extra.author ?? actorFor(user), createdAt: saved.updatedAt });
  }
  ctx.bus.publish({ type: "skill.updated", skill: saved });
  const version = contentChanged ? ` (now v${saved.version})` : "";
  if (user) logActivity(ctx, { projectId: saved.projectId ?? null, actor: extra.author ?? actorFor(user), type: "skill.updated", data: { skillId: saved.id, version: saved.version },
    summary: extra.author ? `${authorName(extra.author)} changed the skill ${quote(saved.name)} as ${user.name} asked${version}` : `${user.name} edited the skill ${quote(saved.name)}${version}` });
  return saved;
}

export function deleteSkill(ctx: Ctx, skill: Skill, user?: User | null) {
  // The entry for a skill Scarlet comes with names it, which is how seeding knows the editor deleted it and leaves it
  // deleted. One they had edited is theirs by then, and is known by its name.
  const stockSkill = skill.bundledName ?? (outOfBoxSkill(skill) || BUNDLED_SKILLS.some(s => s.folder === skill.name) ? skill.name : undefined);
  if (user) logActivity(ctx, { projectId: skill.projectId ?? null, actor: actorFor(user), type: "skill.deleted", summary: `${user.name} deleted the skill ${quote(skill.name)}`, data: { skillId: skill.id, stockSkill } });
  unmirrorSkill(ctx, skill);
  ctx.repos.skillVersions.removeAll(skill.id);
  ctx.repos.skills.remove(skill.id);
}

// Pinned skills guide the prompt. The agent can look up any enabled skill.
export function assistantSkills(skills: Skill[], selected: string[] | undefined, forPrompt: boolean) {
  // A chosen skill that builds on others brings them along, first and in the order it names them, each with the
  // guides it builds on in turn: the editor's own style is read on top of the guides.
  if (forPrompt && selected?.length) {
    const seen = new Set(selected);
    const under = (skill: Skill | undefined): Skill[] => !skill ? [] : skillExtends(skill).flatMap(base => {
      const found = skills.find(s => s.name === base && s.enabled);
      if (!found || seen.has(found.id)) return [];
      seen.add(found.id);
      return [...under(found), found];
    });
    const bases = selected.flatMap(id => under(skills.find(s => s.id === id)));
    const chosen = skills.filter(s => selected.includes(s.id));
    return [...new Map([...bases, ...chosen].map(s => [s.id, s])).values()].filter(skill => skill.enabled);
  }
  const available = forPrompt ? skills.filter(s => !s.source?.startsWith("quick-action:")) : skills;
  return available.filter(skill => skill.enabled).map(skill => {
    // House rules and explicitly selected skills belong in the initial prompt.
    // Workflows, customized or not, are read one pass at a time.
    if (!forPrompt) return skill;
    const workflow = BUNDLED_SKILLS.some(s => s.folder === skill.name || s.folder === skill.bundledName) ||
      skill.bundledName === "first-cut-dialogue" ||
      RETIRED_WORKFLOWS.includes(skill.name);
    if (!workflow) return skill;
    return { ...skill, content: `Read this workflow when it applies using skills_list with skillId "${skill.id}".` };
  });
}
