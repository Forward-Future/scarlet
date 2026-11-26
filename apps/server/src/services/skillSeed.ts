import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Skill, skillRuns, taskNeedsTranscripts } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { BUNDLED_SKILLS, RETIRED_SKILLS } from "../bundledSkills.js";
import { errorMessage } from "../util.js";
import {
  createSkill,
  deleteSkill,
  findDuplicateSkill,
  latestSkillEdit,
  mirrorSkill,
  outOfBoxSkill,
  parseFrontmatter,
  unmirrorSkill,
  updateSkill,
} from "./skills.js";

// What upgrading needs to know about skills Scarlet used to ship is data, kept with the skills (skills/retired.json):
// no skill's name is written here.
const retiredGuideRevisions = new Set(RETIRED_SKILLS.guides.revisions);
const retiredWorkflowRevisions = new Set(RETIRED_SKILLS.workflows.revisions);
const shortcutRevisions = new Set(RETIRED_SKILLS.shortcuts.revisions);

/** Workflows Scarlet no longer ships. An unedited copy leaves the library; one the editor changed stays theirs. */
export const RETIRED_WORKFLOWS = RETIRED_SKILLS.workflows.names;

/** The names a shipped skill went by before, oldest first. */
export function formerNames(name: string): string[] {
  return Object.entries(RETIRED_SKILLS.renamed).filter(([, renamed]) => renamed.to === name).map(([old]) => old);
}

/** A name with the ones it replaced: the current skill first. */
const withFormerNames = (name: string) => [name, ...formerNames(name)];

/** The skill a retired name now goes by, if it was renamed. */
export function renamedTo(name: string): string | undefined {
  return Object.hasOwn(RETIRED_SKILLS.renamed, name) ? RETIRED_SKILLS.renamed[name]!.to : undefined;
}

/** Placeholders for a list in SQL. */
const marks = (list: readonly unknown[]) => list.map(() => "?").join(", ");

function contentHash(content: string) {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

// Before bundledName was recorded, the first revision identified a customized stock guide.
function withBundledName(ctx: Ctx, skill: Skill | undefined) {
  if (!skill || skill.bundledName) return skill;
  const first = ctx.repos.skillVersions.list(skill.id)[0];
  if (!outOfBoxSkill(skill) && (skill.source || first?.author?.type !== "scarlet")) return skill;
  return ctx.repos.skills.put({ ...skill, bundledName: first && parseFrontmatter(first.content).name || skill.name });
}

/** Keep an existing global definition, then prefer personal and most recently edited copies. */
export function migrateGlobalSkills(ctx: Ctx) {
  ctx.db.transaction(() => {
    const rows = ctx.db.prepare(`SELECT json FROM skills WHERE scope IN ('personal', 'project')
      ORDER BY scope = 'personal' DESC, updated_at DESC, id`).all() as { json: string }[];
    const replacements = new Map<string, string>();
    for (const row of rows) {
      const old = JSON.parse(row.json);
      const promoted = Skill.parse({ ...old, scope: "team", ownerId: null, projectId: null });
      const [global] = ctx.repos.skills.select("scope = 'team' AND name = ?", [promoted.name]);
      if (!global) {
        mirrorSkill(ctx, promoted);
        ctx.repos.skills.put(promoted);
      } else {
        // Retain distinct historical instructions as restorable revisions, leaving
        // the global skill's current text and enabled setting in effect.
        const history = ctx.repos.skillVersions.list(global.id);
        const known = new Set([global.content, ...history.map(v => v.content)]);
        const revisions = ctx.repos.skillVersions.list(promoted.id);
        revisions.push({ version: promoted.version, content: promoted.content, createdAt: promoted.updatedAt });
        let version = global.version;
        for (const revision of revisions) {
          if (known.has(revision.content)) continue;
          known.add(revision.content);
          ctx.repos.skillVersions.append(global.id, { ...revision, version: ++version });
        }
        if (version !== global.version) {
          ctx.repos.skillVersions.append(global.id, { ...history.at(-1), version: ++version, content: global.content });
          ctx.repos.skills.put({ ...global, version });
        }
        replacements.set(promoted.id, global.id);
        ctx.repos.skillVersions.removeAll(promoted.id);
        ctx.repos.skills.remove(promoted.id);
      }
      unmirrorSkill(ctx, old);
    }
    if (replacements.size) {
      for (const task of ctx.repos.tasks.select("json_type(json, '$.context.skillIds') IS NOT NULL OR json_type(json, '$.resultSkillId') IS NOT NULL")) {
        const ids = task.context.skillIds;
        if (ids?.some(id => replacements.has(id)) || (task.resultSkillId && replacements.has(task.resultSkillId))) {
          ctx.repos.tasks.put({ ...task, resultSkillId: task.resultSkillId && (replacements.get(task.resultSkillId) ?? task.resultSkillId),
            context: { ...task.context, skillIds: ids && [...new Set(ids.map(id => replacements.get(id) ?? id))] } });
        }
      }
    }
    // Older libraries recorded the shipped name only in the first version. An editor could have renamed
    // the skill since, so looking it up by its current command while seeding would miss that history.
    const renamed = [...new Set(Object.entries(RETIRED_SKILLS.renamed).flatMap(([old, { to }]) => [to, old]))];
    const origins = !renamed.length ? [] : ctx.db.prepare(`SELECT skills.id, v.content FROM skills
      JOIN skill_versions v ON v.skill_id = skills.id AND v.version = 1
      WHERE json_extract(skills.json, '$.bundledName') IS NULL AND json_extract(v.author, '$.type') = 'scarlet'
      AND coalesce(json_extract(skills.json, '$.source'), '') IN ('', 'bundled', 'seed')
      AND (${renamed.map(() => "v.content LIKE ?").join(" OR ")})`).all(...renamed.map(name => `%${name}%`)) as { id: string; content: string }[];
    for (const origin of origins) {
      const name = parseFrontmatter(origin.content).name;
      if (name && renamed.includes(name)) {
        ctx.db.prepare("UPDATE skills SET json = json_set(json, '$.bundledName', ?) WHERE id = ?").run(name, origin.id);
      }
    }
    ctx.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skills_name ON skills(name)");
  }, "immediate")();
}

/** Seed team skills from a directory of `<name>/SKILL.md` folders (skipped when absent/empty or already seeded). */
export function seedSkills(ctx: Ctx, dir: string | undefined): number {
  if (!dir || !existsSync(dir)) return 0;
  const root = realpathSync(dir);
  const list: Array<{ folder: string; content: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "SKILL.md");
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.nlink !== 1 || realpathSync(file) !== file) continue;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.isFile() && opened.nlink === 1 && opened.dev === info.dev && opened.ino === info.ino) {
        list.push({ folder: entry.name, content: readFileSync(fd, "utf8") });
      }
    } finally { closeSync(fd); }
  }
  return seedSkillList(ctx, list, "seed");
}

export function retireMergedSkills(ctx: Ctx) {
  ctx.db.transaction(() => {
    const movesTo = RETIRED_SKILLS.shortcuts.movesTo;
    const dialogue = movesTo ? withFormerNames(movesTo).map(name => findDuplicateSkill(ctx, name)).find(Boolean) : undefined;
    const retired = new Map<string, string | undefined>();
    const guides = RETIRED_SKILLS.guides.names;
    for (const skill of guides.length ? ctx.repos.skills.select(`name IN (${marks(guides)})`, guides) : []) {
      const hash = contentHash(skill.content);
      const stockGuide = outOfBoxSkill(skill) && retiredGuideRevisions.has(hash);
      const shortcut = dialogue && skill.source?.startsWith("quick-action:") && shortcutRevisions.has(hash);
      if (!stockGuide && !shortcut) continue;
      retired.set(skill.id, shortcut ? dialogue.id : undefined);
      deleteSkill(ctx, skill);
    }
    for (const skill of RETIRED_WORKFLOWS.length ? ctx.repos.skills.select(`name IN (${marks(RETIRED_WORKFLOWS)})`, RETIRED_WORKFLOWS) : []) {
      if (!outOfBoxSkill(skill) || !retiredWorkflowRevisions.has(contentHash(skill.content)) ||
          skill.description !== parseFrontmatter(skill.content).description) continue;
      // Preserve edits explicitly requested for this skill, including its revision history and learnings awaiting a decision.
      if (latestSkillEdit(ctx, skill.id) || ctx.repos.learnings.select("state != 'declined' AND json_extract(json, '$.skillId') = ?", [skill.id]).length ||
          ctx.repos.skillVersions.list(skill.id).some(v => !retiredWorkflowRevisions.has(contentHash(v.content)))) continue;
      // A queued or resumable request still needs the workflow the editor picked.
      if (ctx.repos.tasks.select(
        "EXISTS (SELECT 1 FROM json_each(tasks.json, '$.context.skillIds') WHERE value = ?)", [skill.id],
      ).some(task => task.state !== "done" || taskNeedsTranscripts(task))) continue;
      const successor = Object.hasOwn(RETIRED_SKILLS.workflows.replacedBy, skill.name) ? RETIRED_SKILLS.workflows.replacedBy[skill.name] : undefined;
      const replacement = successor ? findDuplicateSkill(ctx, successor) : undefined;
      retired.set(skill.id, skill.enabled && replacement?.enabled ? replacement.id : undefined);
      deleteSkill(ctx, skill);
    }
    if (!retired.size) return;
    for (const task of ctx.repos.tasks.select("json_type(json, '$.context.skillIds') = 'array'")) {
      const ids = task.context.skillIds ?? [];
      if (!ids.some(id => retired.has(id))) continue;
      const mapped = ids.flatMap(id => retired.has(id) ? retired.get(id) ?? [] : id);
      ctx.repos.tasks.put({ ...task, context: { ...task.context, skillIds: [...new Set(mapped)] } });
    }
  }, "immediate")();
}

/**
 * The stock skills the editor deleted, by name. The activity log keeps every deletion for good, so it is the record
 * of them: Scarlet retiring a skill itself logs none.
 */
function deletedStockSkills(ctx: Ctx): Set<string> {
  const deletions = ctx.repos.activity.select("type = 'skill.deleted' AND json_extract(json, '$.data.stockSkill') IS NOT NULL");
  return new Set(deletions.map(entry => String(entry.data.stockSkill)));
}

/** A shipped skill filed under Examples in its header: one editor's own style, to read or copy, not to run by default. */
export const exampleSkill = (content: string) =>
  /^category:\s*["']?examples["']?\s*$/im.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "");

/**
 * Add the skills Scarlet comes with (the bundled set compiled into the engine binary). Each is an ordinary skill
 * once added. A copy the editor hasn't edited takes the text this release ships; an edited one is theirs and is
 * left alone, as is any skill of their own that shares a name.
 */
export function seedSkillList(ctx: Ctx, list: Array<{ folder: string; content: string }>, source = "bundled"): number {
  let count = 0;
  for (const { folder, content } of list) {
    const fm = parseFrontmatter(content);
    const name = (fm.name ?? folder).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "");
    if (!name) continue;
    try {
      count += ctx.db.transaction(() => {
        let existing = withBundledName(ctx, findDuplicateSkill(ctx, name));
        // A skill Scarlet shipped under another name before (skills/retired.json) keeps its copy, history and pins.
        const former = formerNames(name);
        const renamedStock = former.length > 0 && (source === "bundled" ||
          BUNDLED_SKILLS.some(s => s.folder === name && contentHash(s.content) === contentHash(content)));
        if (!existing) {
          const deleted = deletedStockSkills(ctx);
          if (deleted.has(name)) return 0;
          if (renamedStock) {
            // The editor may have renamed this skill. Its ID still owns its preferences and history.
            if (ctx.repos.skills.select("json_extract(json, '$.bundledName') = ?", [name]).length) return 0;
            if (former.some(old => deleted.has(old))) return 0;
            for (const old of former) {
              const legacy = withBundledName(ctx, findDuplicateSkill(ctx, old));
              const shipped = new Set(RETIRED_SKILLS.renamed[old]!.seedRevisions ?? []);
              // Directory seeds can include a personal workflow. Only rename one with a known shipped text.
              if (legacy?.bundledName === old && (legacy.source === "bundled" ||
                  legacy.source === "seed" && shipped.has(contentHash(legacy.content)))) {
                existing = legacy;
                break;
              }
            }
          }
          if (!existing) {
            // An example shows how one editor's style builds on the shipped guides. It arrives switched off, so it
            // shapes nobody's edits until they turn it on.
            createSkill(ctx, null, { name, description: fm.description ?? "", content, scope: "team", enabled: !exampleSkill(content) },
              { source: renamedStock ? "bundled" : source });
            return 1;
          }
        }
        // An editor's copy set back to the text this release ships is the stock skill again, and follows later releases.
        // Edited once, a copy kept its old text for good: the editor's own talking-head skill missed four releases of
        // its shipped revisions, the camera inset among them, with no way back short of deleting it (2026-11-20).
        if (!outOfBoxSkill(existing) && existing.content === content && existing.name === name) {
          ctx.repos.skills.put({ ...existing, source, bundledName: name });
          return 0;
        }
        if (!outOfBoxSkill(existing) || (existing.content === content && existing.name === name)) return 0;
        // A directory seed may have given this command its own instructions before Scarlet used the name.
        if (renamedStock && existing.name === name && existing.source === "seed" &&
            contentHash(existing.content) !== contentHash(content)) return 0;
        const description = existing.description === parseFrontmatter(existing.content).description ? fm.description : existing.description;
        // Keep the old name for unmirroring. Pins, revision history and learnings already use the stable id.
        const stock = existing.name === name ? existing : { ...existing, bundledName: name, source: "bundled" };
        updateSkill(ctx, null, stock, { name, content, description });
        return 1;
      }, "immediate")();
    } catch (e) {
      ctx.log(`[skills] could not seed ${folder}: ${errorMessage(e)}`);
    }
  }
  return count;
}

/**
 * A copy of a shipped skill that guides one of Scarlet's built-in commands, made before the skill said so in its header,
 * gets the line it now ships with (`runs:`), so the editor's own wording of it keeps guiding the command. An unedited
 * copy already took the new text when seeding.
 */
export function addCommandHeaders(ctx: Ctx) {
  for (const { folder, content } of BUNDLED_SKILLS) {
    const runs = skillRuns({ content });
    if (!runs.length) continue;
    const names = withFormerNames(parseFrontmatter(content).name ?? folder);
    const copies = ctx.repos.skills.select(`json_extract(json, '$.bundledName') IN (${marks(names)}) OR
      (json_extract(json, '$.bundledName') IS NULL AND coalesce(json_extract(json, '$.source'), '') IN ('bundled', 'seed') AND name IN (${marks(names)}))`, [...names, ...names]);
    for (const copy of copies) {
      if (skillRuns(copy).length) continue;
      const line = `runs: ${runs.join(", ")}`;
      const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(copy.content);
      const updated = header
        ? copy.content.replace(header[0], () => `---\n${header[1]}\n${line}\n---`)
        : `---\nname: ${copy.name}\n${line}\n---\n\n${copy.content}`;
      updateSkill(ctx, null, copy, { content: updated });
    }
  }
}
