import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Skill, taskNeedsTranscripts, type UpsertSkillRequest, type User } from "@scarlet/shared";
import type { Author } from "@scarlet/timeline";
import { newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { BUNDLED_SKILLS } from "../bundledSkills.js";
import { badRequest, conflict, HttpError } from "../errors.js";
import { actorFor, authorName, logActivity, quote } from "./activity.js";

type MirrorLocation = Pick<Skill, "id" | "name"> & {
  scope: "project" | "personal" | "team";
  projectId?: string | null;
  ownerId?: string | null;
};

/** Scoped paths are read only to clean up pre-global skill mirrors. */
export function skillDiskPath(ctx: Ctx, skill: MirrorLocation): string {
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
  mkdirSync(dirname(p), { recursive: true });
  const temp = join(dirname(p), randomUUID() + ".tmp");
  try {
    writeFileSync(temp, skill.content, { flag: "wx", mode: 0o600 });
    renameSync(temp, p);
  } finally {
    rmSync(temp, { force: true });
  }
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
    const origins = ctx.db.prepare(`SELECT skills.id, v.content FROM skills
      JOIN skill_versions v ON v.skill_id = skills.id AND v.version = 1
      WHERE json_extract(skills.json, '$.bundledName') IS NULL AND json_extract(v.author, '$.type') = 'scarlet'
      AND coalesce(json_extract(skills.json, '$.source'), '') IN ('', 'bundled', 'seed')
      AND (v.content LIKE '%dialogue-pass%' OR v.content LIKE '%first-cut-dialogue%')`).all() as { id: string; content: string }[];
    for (const origin of origins) {
      const name = parseFrontmatter(origin.content).name;
      if (name === "dialogue-pass" || name === "first-cut-dialogue") {
        ctx.db.prepare("UPDATE skills SET json = json_set(json, '$.bundledName', ?) WHERE id = ?").run(name, origin.id);
      }
    }
    ctx.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skills_name ON skills(name)");
  }, "immediate")();
}

function findDuplicate(ctx: Ctx, name: string, excludeId?: string) {
  return ctx.repos.skills.select("name = ?", [name]).find(skill => skill.id !== excludeId);
}

// Before bundledName was recorded, the first revision identified a customized stock guide.
function withBundledName(ctx: Ctx, skill: Skill | undefined) {
  if (!skill || skill.bundledName) return skill;
  const first = ctx.repos.skillVersions.list(skill.id)[0];
  if (!outOfBox(skill) && (skill.source || first?.author?.type !== "scarlet")) return skill;
  return ctx.repos.skills.put({ ...skill, bundledName: first && parseFrontmatter(first.content).name || skill.name });
}

export function createSkill(ctx: Ctx, user: User | null, body: UpsertSkillRequest, extra: { source?: string } = {}): Skill {
  const dup = findDuplicate(ctx, body.name);
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
  const dup = findDuplicate(ctx, next.name, existing.id);
  if (dup) throw conflict("skill_exists", `a skill named "${next.name}" already exists`, { skillId: dup.id });
  const contentChanged = next.content !== existing.content;
  if (contentChanged) next.version = existing.version + 1;
  // A skill Scarlet came with is the editor's own once they edit it. A later release leaves it alone.
  if (contentChanged && user && outOfBox(existing)) next.source = undefined;
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
  const stockSkill = skill.bundledName ?? (outOfBox(skill) || BUNDLED_SKILLS.some(s => s.folder === skill.name) ? skill.name : undefined);
  if (user) logActivity(ctx, { projectId: skill.projectId ?? null, actor: actorFor(user), type: "skill.deleted", summary: `${user.name} deleted the skill ${quote(skill.name)}`, data: { skillId: skill.id, stockSkill } });
  unmirrorSkill(ctx, skill);
  ctx.repos.skillVersions.removeAll(skill.id);
  ctx.repos.skills.remove(skill.id);
}

/** Seed team skills from a directory of `<name>/SKILL.md` folders (skipped when absent/empty or already seeded). */
export function seedSkills(ctx: Ctx, dir: string | undefined, source = "seed"): number {
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
  return seedSkillList(ctx, list, source);
}

// The exact texts of the guide that shipped before the workflows replaced it.
const retiredGuideRevisions = new Set([
  "e7d5250ce7ede476e94c451dbfd892c4779b33b37f1341823d939be39bfd8802",
  "6b2bfacace57bdede90b654bf040fee068d7ee1c9c74d4f1a7bbbaae6d891105",
  "3fb31154652223f6eac760ad944325f7c90fe931e5e3457291c2537e40195dbd",
  "4734c0da59fa30a7659215b2426bc0299178d23c170f71962203a4f82c59f77a",
  "2f89d437aa3718f9dfc2c72e01790c8e5b33ef05f671056957f342e2bad776d7",
  "086380c316e6020e7071094f35803a4269da8eb1ba80147abb028160dad85e06",
  "94008074f287c04d30f3a5303b7193376e7f2c500629e727b6ef3afd03b02a7f",
  "a74e1c5429365f6f04c0dcbc46d6352ec321cf54c1736be77625279bd6b3c67d",
]);

// Workflows Scarlet no longer ships. An unedited copy leaves the library; one the editor changed stays theirs.
const RETIRED_WORKFLOWS = ["render-verify", "screen-recording", "clean-dialogue", "edit-interview", "smooth-audio-cuts", "visual-pass"];

// A seed directory can also supply personal workflows under these names. Only retire texts Scarlet shipped.
const retiredWorkflowRevisions = new Set([
  // render-verify
  "8b9a9f13923420a900d766cc030b1502aa0ef387e1f363a0b59ed5dde5a5beea",
  "cf10bf2800acf4483e230aa24c3245f4b344de387c9de0a8698dd914e6dd63d2",
  "ba2692e5f8b86d593e1540f9d43ba16d7813177910f184e1a8751fe70bcd868a",
  "4d19866542e48a199c1ac9c3a06bca56bc08c35dbe7610bcab1618027277f056",
  "cd2945c1e86aaf33e859ac19d843860efd9fc0f16d76599856ff4f7c6f671f77",
  "6476348ce50535eb431ca8525b18c3c30a4bc0b7b6574579324847c5af7a7ac0",
  "d870d391ef3e757b1a29c264bded0ac1ad0dd7bd832391ebbe3933de3a714365",
  "007dd84d8027fff4289d79f336a74df87fea8a04406e24da596dec6a769eb639",
  "81f62600af19a8d3f50af7d0e1e6dd0ad7723878341c289e838195c6f44f826b",
  "5bc17554908541f1a042bddd2a15e302e4bdf9c8f1b6b3ab1a4a8dfdf177cb1c",
  // screen-recording
  "bafcccb8568e6513c69479a89ea9c16354a3962278cb968fdb2fa9fea9d89d8c",
  "3e16d0d5b304ad9e8a79288a01bc14095d8be7e4c2d38f1466d782b50de07277",
  "13352c9c542369863173772008998cd88f0dd3cced30a9756c65844387d08d00",
  "6e67cdc666c9c69d5c6e15591827d99e76b43027391bfdcb904fd3cb59792370",
  "641d6d61a997699a115e2a1decd03fe03bfee7382ff623b9b4ea1867c98ce206",
  "f6e6aef6dadf88242335b473fb13e641d3b4b3bc48c384c93ade8ed3fd0a274d",
  "c3b937680e98e686b29b85f5ab954d3b782f0084ea2bf57c0e998536b49a5515",  // clean-dialogue
  "6942012139a0e5d56ade6b8eb2a4da8c3053ea9acf1d22965ccd165992278d75",
  "7296ee5e46e21830c89e978487d263113e1cdb08640a6c12de5205c1b1451db3",
  "75032a3ede61ee010d307b4aaf8397ed8871e62f7e3b92f034659b7612681f30",
  "01cf8ca6283d77d41804241bbd7ab3b03ea1feb66ec6d7b63d93ac4c95be4399",
  "d4930d9b042fe164d95e05d4d72749457d46baffa92ca1d555fda267ffe224e5",
  "0b137b7ab00e04560bf18e7020726d45383f55346d5c5f1b24bb27a16eeabac0",
  "786353d66e38996a25c926ab4699eaf605435dda09cf3b7b014000ff4a848836",
  "7c6f8b3c8525835cd35b7c01e43d30e5a10bbfb1c9a6c76119358caf005a5d3f",
  "fa1b20c28b81f1e24ed10f6ed49747099cd9a9acc39dd2e6664cd41c52fa91b5",
  "bd8104713b68df46a111155e5937216afcd733d389e2494821cdddd52e2922d6",
  "d5828836869cb72787d6719d05b6a79e161100403e12187b28362b77b18ebe0c",
  // edit-interview
  "0da9596d93d9516dda1849ba214395b99d8f7588693b783849efccad4abca222",
  "8b54d460579ae59b7a99eb1dd2530b1842e9fad8ffbddeaca887ca959e3111f6",
  "a1b2f8f2fa8b83766705fe878dd812e0647faee9122a3e5faa5e5b6f417c3c7a",
  "87d3dfffcaea445e86171b4c5dc52bb60c7eab1bf1351260bc363eec5b646574",
  "c5d17ae80504c7f0c77b12085339bec53024e7f32f380b8307277e2ee8eaff42",
  "544ee5195eed687b7dff2ccc33b6c79c902c9fe73216bd566a64a97a1493d5d5",
  "9cc48460c94a88b481d94d43f361ad4263064cbc2377c2e921a41db9cbc5be09",
  "051ee7762cfa2d8e1f973b5c1ff8c326b18af8f334ba250c086e42d12e9e68a5",
  "310ff3a6daeb13018765b654fd9f7b214ead918b615653b5a7ab47e589449e4e",
  // smooth-audio-cuts
  "6f24552c2cc18df50a39efedea79ce1677c0fb17bc2b8f561c1356ae935c938a",
  "3f2c8798ea970d7a975e83e12f2da974f00e6cddc747e888a3b343ca44632c57",
  "de364b141eaa9c2f63cc72d06763af8b0b88b8d9e62e84ca646e7bd8dde9b530",
  "a1d2cebfa699da97e62ecd2ac9bdb60319ac6055e5684eef9dce7e5c72eca8f0",
  "d2d532485261415d1bd48191fd895c8f57a2bbe61ed9a4184805f87f921ed490",
  "50e8696cf1d35ced249982b9dd9ca2f98bd7e2aee6b8117625feef8cfb5c9f8e",
  "69640af2ee5424617ee205cda85e5c61b52fe92ac0bd4d484fce8b2cb1f9a424",
  "387863a33c98f559a5939482b05c366293152c637f0a6ef45558c87a593c6703",
  "d4b7b712cf744e29c715c39134659265865d37bbce2c2b56ba099c510723454c",
  "8b26dcab409f323eaae5d05b90f90847b9b13c43da86abb6e1e9b004c566f14f",
  "ec02e58f199b47a6029893a07fe4065fa5a29c11facda6d8e5068db4ef166feb",
  "65d28192320b28b2d3ac064a64c0a8bc53634441f6c93f58494d3f256790c218",
  // visual-pass
  "1539696daf08473316c6b9e4539b81412f4e675146fb830360838fba26ff39cb",
  "fb1ac47c6233db9294411c99cbdb18220f720812b6e09fc1b6d9fe3008384d20",
  "5d4607f09de164ef41b7372ec30dd542b7ecc648936607c0990d9e24eb0484d3",
  "944891a0ca564872c32a52e6f30672954f2248c970e6fd332d4e00277dabbd0a",
  "91fab3a5af266906b1d1656261a1b3e32148d8f3536f49ff66f5d767ba4a3bdf",
  "f735437da1f94cbd494493702428f0152b5a00b95afcd5bfdc87c06ed56febd7",
  "45d31c15aab681d6ab82fa8d39578d1a989e819082207172c13aeb9eab01d338",
  "59c379896b2403cdcbd06ac2eb2376d5296b792889f202a41c98cc23a13d431b",
  "8e44d9f5f39dac1cf0c52f725d5fc286afc40d61762e19d55206d1948dd38a8c",
  "2e553426b4307d3df9d423d3128029397f61c40228fe7643014851dc97f453b0",
  "8ef2641984557868aa411a0985ce3864a14fada054440cf4fa598196c547fd8a",
  "d07ce568c1630d9bc683767334dfd30f63a7fc9cb2b1947f598dbb8be9ebcd57",
  "09c4725bb0f6e9e49f7bbf9e94fa6d4a692f3afa8a33b36fa8200c61099db0b1",
]);

// Source builds could seed either the shipped first-cut guide or a local file under its name.
const legacyDialogueRevisions = new Set([
  "06c9b66bd73f3a15f2d8f111c062871229e4c1b23e655e5e76d421fd153bc81b",
  "2b74f4ef437f8d065ec38ae9e900f6fa987b5f5a2f994b65ef7f7326a5fd4308",
  "2d8c23eb5f3ce04a6e6f6462abab5e6d6623a9456d226374f46cab75b4a65ad8",
  "30d58b69f3df74c2f2d74e4ff3d22c14acc163ec67ca3c50ab5f281d330c03d3",
  "33475e839457d70eeff589c0760732c7033fd408ef9965d8c535f8a5349ff6c9",
  "3b26546649a9c298247a2c094cdac4d86ae48a69ca0cdbd9eac27c4b5d96d017",
  "3ed79810ecb4c3caf2b606491c0cff91a500a35592bc63df9342062d659cc6e7",
  "40d7380bc7720c73348e07936eca27a043128836b3dbedd38ebac947fde69fa1",
  "4256aa8be18a0826dd51f79b0538fee947e3b71bb0e59e4f73e9db1eac190a4a",
  "4f4a986d5c5ebf6ef1548679a555081bec2f5c12d22e011bc48c890fd133188a",
  "66bda9b89341a2973cb3b5e294c883f3c2e65ac9d2c40b4183a536312dffb741",
  "6aa46bffa0f92de58f36f7a98c92fece206f3a871ac268863c0ea94b64e1547f",
  "73a39f81a6bc6d76fbf361830d10320fb35762cb3c682eec410a699e2131769d",
  "8481094e0cbc28633c7bd8aebf0e43b700cb78501d9148255e3cd7140abbf617",
  "89349a3f36528c2919fe4ee0feb04fba7b7386f16fd7e9a9e5f1f483c0383d85",
  "8bff7c44cc2d0d8bf5c7d8c21cf5cc0f1c1361fc95c6e37950cf9e8894c4c0f7",
  "9c9f4d4a1e5aa63027ae0ba9181df15998aaf0a176d7d05f90a233499b0574b6",
  "a07d0230b0b6215a5da16035798794bf85aac94fd815e5500caab3cf6cb44948",
  "a9ce21c7dc508069f2a7bb8025e82050910f61b8d95ff7001f12d094c9064e05",
  "b2150dfc5773e4449023c9cd80fcb45af02ccc222064894a9e5cb9193ade0c3d",
  "bc04ce0b87694d720c2d74ea9b8a25eeb117c1866f731d2cf03439b6289048f7",
  "bcbcb096c55650e342c0fbf76eb9d1bd4a7a99a100a3a68a37b555560756758c",
  "bf74d337abf35bd4b35fb97fee290c7c1fd7b7dc09b68a96c0dab8c08255d4c6",
  "c80b6f85c84522718316acd68f77c3361161f2be0b13eddd619bf014d9014b55",
  "cbd67e2187e503cd5d71d2100a3f040445ca210ac2afddbc62916d258fcd6d0c",
  "d68a84a6efa20d2bda9369fa75b5ac5c7da59474db0db6848167e576a592b74e",
  "e392826d56c9455479ad61ccb893e746a60c0aa321567f308dc815979eab32ed",
  "e779aa885c4144309765bf684fd5d802ae4d6f492fe6213dbe440c842deacc6d",
  "f24f53c0d7b2e4035cafce0347d71a50807952904aff07c245e59570f5f2a44d",
]);

// Only retire shipped shortcuts. A user-authored workflow may share a name.
const shortcutRevisions = new Set([
  "41b82b403b75bae0f7f96477ea3f420d1e91f66d64af58d5c26702fc4392c0c6",
  "746563b47f865ea41f1442a76f8d7bc2068830e5eabb6c4f14c94d826aeae61c",
  "518d48bd237a227a3bafb04d2565c566e2cdcc9474a606692c72e1d70b2cb1f7",
  "e717791a3c793e1f7a981424c49e3cef858be25388bf5fe76e1da3e1f1ddcae5",
]);

function contentHash(content: string) {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

/** A skill Scarlet came with that the editor hasn't edited. Editing its text makes it theirs (`updateSkill`). */
function outOfBox(skill: Skill) {
  return skill.source === "bundled" || skill.source === "seed";
}

export function retireMergedSkills(ctx: Ctx) {
  ctx.db.transaction(() => {
    const dialogue = findDuplicate(ctx, "dialogue-pass") ?? findDuplicate(ctx, "first-cut-dialogue");
    const retired = new Map<string, string | undefined>();
    for (const skill of ctx.repos.skills.select("name IN ('scarlet-basics', 'tighten-pauses-here', 'remove-dead-air-and-repeated-lines')")) {
      const hash = contentHash(skill.content);
      const stockGuide = outOfBox(skill) && retiredGuideRevisions.has(hash);
      const shortcut = dialogue && skill.source?.startsWith("quick-action:") && shortcutRevisions.has(hash);
      if (!stockGuide && !shortcut) continue;
      retired.set(skill.id, shortcut ? dialogue.id : undefined);
      deleteSkill(ctx, skill);
    }
    for (const skill of ctx.repos.skills.select(`name IN (${RETIRED_WORKFLOWS.map(name => `'${name}'`).join(", ")})`)) {
      if (!outOfBox(skill) || !retiredWorkflowRevisions.has(contentHash(skill.content)) ||
          skill.description !== parseFrontmatter(skill.content).description) continue;
      // Preserve edits explicitly requested for this skill, including its revision history and learnings awaiting a decision.
      if (latestSkillEdit(ctx, skill.id) || ctx.repos.learnings.select("state != 'declined' AND json_extract(json, '$.skillId') = ?", [skill.id]).length ||
          ctx.repos.skillVersions.list(skill.id).some(v => !retiredWorkflowRevisions.has(contentHash(v.content)))) continue;
      // A queued or resumable request still needs the workflow the editor picked.
      if (ctx.repos.tasks.select(
        "EXISTS (SELECT 1 FROM json_each(tasks.json, '$.context.skillIds') WHERE value = ?)", [skill.id],
      ).some(task => task.state !== "done" || taskNeedsTranscripts(task))) continue;
      const replacement = skill.name === "screen-recording" ? findDuplicate(ctx, "frame-screen") : undefined;
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
        let existing = withBundledName(ctx, findDuplicate(ctx, name));
        const publicDialogue = name === "dialogue-pass" && (source === "bundled" ||
          BUNDLED_SKILLS.some(s => s.folder === name && contentHash(s.content) === contentHash(content)));
        if (!existing) {
          const deleted = deletedStockSkills(ctx);
          if (deleted.has(name)) return 0;
          if (publicDialogue) {
            // The editor may have renamed this guide. Its ID still owns the dialogue preferences and history.
            if (ctx.repos.skills.select("json_extract(json, '$.bundledName') = 'dialogue-pass'").length) return 0;
            if (deleted.has("first-cut-dialogue")) return 0;
            const legacy = withBundledName(ctx, findDuplicate(ctx, "first-cut-dialogue"));
            // Directory seeds can include a personal workflow. Only rename one with a known shipped text.
            if (legacy?.bundledName === "first-cut-dialogue" && (legacy.source === "bundled" ||
                legacy.source === "seed" && legacyDialogueRevisions.has(contentHash(legacy.content)))) {
              existing = legacy;
            }
          }
          if (!existing) {
            createSkill(ctx, null, { name, description: fm.description ?? "", content, scope: "team" },
              { source: publicDialogue ? "bundled" : source });
            return 1;
          }
        }
        if (!outOfBox(existing) || (existing.content === content && existing.name === name)) return 0;
        // A directory seed may have given this command its own instructions before Scarlet used the name.
        if (publicDialogue && existing.name === name && existing.source === "seed" &&
            contentHash(existing.content) !== contentHash(content)) return 0;
        const description = existing.description === parseFrontmatter(existing.content).description ? fm.description : existing.description;
        // Keep the old name for unmirroring. Pins, revision history and learnings already use the stable id.
        const stock = existing.name === name ? existing : { ...existing, bundledName: name, source: "bundled" };
        updateSkill(ctx, null, stock, { name, content, description });
        return 1;
      }, "immediate")();
    } catch (e) {
      ctx.log(`[skills] could not seed ${folder}: ${(e as Error).message}`);
    }
  }
  return count;
}

// Pinned skills guide the prompt. The agent can look up any enabled skill.
export function assistantSkills(skills: Skill[], selected: string[] | undefined, forPrompt: boolean) {
  const available = forPrompt && selected?.length ? skills.filter(s => selected.includes(s.id)) :
    forPrompt ? skills.filter(s => !s.source?.startsWith("quick-action:")) : skills;
  return available.filter(skill => skill.enabled).map(skill => {
    // House rules and explicitly selected skills belong in the initial prompt.
    // Workflows, customized or not, are read one pass at a time.
    if (!forPrompt || selected?.length) return skill;
    const workflow = BUNDLED_SKILLS.some(s => s.folder === skill.name) ||
      skill.bundledName === "first-cut-dialogue" ||
      RETIRED_WORKFLOWS.includes(skill.name);
    if (!workflow) return skill;
    return { ...skill, content: `Read this workflow when it applies using skills_list with skillId "${skill.id}".` };
  });
}
