import { isLearningCheck, isSkillEdit, type ApproveLearningRequest, type Learning, type ReviseLearningRequest, type RunChoice, type Skill, type SuggestLearningRequest, type TaskSkillDraft, type Task, type User } from "@scarlet/shared";
import { stripFrontmatter, type LearningCheckContext } from "@scarlet/mcp/prompt";
import { clock, newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { clip } from "../logText.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { latestSkillEdit } from "./skills.js";
import { createTask, FINISHED_TASK } from "./tasks.js";

/**
 * Learnings: standing rules Scarlet picked up from the editor's requests. Every request is read for one as it is
 * sent, by a learning check: a short run beside the request that sees what they said and their skills, and offers a
 * rule, with what the skill already says that it would change, or does nothing. Each rule waits for the editor, who
 * approves or declines it. Approving one has an agent revise the skill around it, as a skill edit, on the model the
 * editor has chosen when they approve it; a skill's edits run one at a time, so a second approval for the same skill
 * starts when the first has saved.
 */

function save(ctx: Ctx, learning: Learning): Learning {
  const saved = ctx.repos.learnings.put(learning);
  ctx.bus.publish({ type: "learning.updated", projectId: saved.projectId, learning: saved });
  return saved;
}

/** The ones the editor hasn't settled: waiting for their call, or being saved. */
export function openLearnings(ctx: Ctx, projectId: string): Learning[] {
  return ctx.repos.learnings.select("project_id = ? AND state IN ('suggested', 'saving')", [projectId], "created_at ASC, rowid ASC");
}

/** What the editor said in the request, as they said it. */
function wordsOf(task: Task): string {
  return (task.context.message ?? task.instruction).trim();
}

const enabledSkills = (ctx: Ctx) => ctx.repos.skills.select("1=1", [], "name ASC").filter(s => s.enabled);

/** A message that only names a skill to run ("/dialogue-pass") says nothing about how the editor wants it done. */
const ONLY_A_SKILL = /^\/[\w-]+$/;

/**
 * Read what the editor just asked for a standing rule. The check is a run of its own with the request's agent and
 * model: it starts with the request, outside the project's queue, and edits nothing. A request Scarlet made itself, a
 * resumed run and a message with no words of the editor's aren't read.
 */
export function startLearningCheck(ctx: Ctx, task: Task): Task | undefined {
  if (!["edit", "note", "revise"].includes(task.kind) || task.createdBy.type !== "human" || task.resumeRootId || task.agent === "api") return;
  // The check is Scarlet's own. Whatever goes wrong starting it, the request it reads is already saved and runs.
  try {
    if (ONLY_A_SKILL.test(wordsOf(task)) || !enabledSkills(ctx).length) return;
    return createTask(ctx, {
      projectId: task.projectId, kind: "learning_check", agent: task.agent, model: task.model, fast: task.fast,
      instruction: wordsOf(task), context: { checksTaskId: task.id }, createdBy: task.createdBy,
    });
  } catch {
    ctx.log(`[learning] ${task.id} wasn’t read for a rule`);
  }
}

const RECENT_REQUESTS = 6;
const KNOWN_RULES = 30;

/** What a learning check is shown: the request, what it was about, the editor's skills and the rules already offered. */
export function learningCheckContext(ctx: Ctx, check: Task): LearningCheckContext {
  const asked = check.context.checksTaskId ? ctx.repos.tasks.get(check.context.checksTaskId) : null;
  if (!asked || asked.projectId !== check.projectId) throw notFound("the request this check reads");
  const skills = enabledSkills(ctx);
  const named = (id: string) => ctx.repos.skills.get(id)?.name ?? "a skill since deleted";
  const c = asked.context;
  const at = c.time !== undefined ? ` at ${clock(Math.floor(c.time))}` : "";
  const about = c.changeId && (c.cutIndex !== undefined || c.editIndex !== undefined)
    ? `They said it about one ${c.cutIndex !== undefined ? "cut" : "edit"} Scarlet made${at}.`
    : c.changeId ? "They said it about an edit Scarlet made."
    : at ? `They said it about the moment${at} in the video.` : undefined;
  const earlier = ctx.repos.tasks.select("project_id = ? AND kind IN ('edit', 'note', 'revise') AND json_extract(json, '$.createdBy.type') = 'human' AND json_extract(json, '$.resumeRootId') IS NULL AND rowid < (SELECT rowid FROM tasks WHERE id = ?)",
    [asked.projectId, asked.id], `created_at DESC, rowid DESC LIMIT ${RECENT_REQUESTS}`).reverse().map(t => clip(wordsOf(t), 400));
  const rules = ctx.repos.learnings.select("state != 'declined'", [], `created_at DESC, rowid DESC LIMIT ${KNOWN_RULES}`).reverse()
    .map(l => ({ rule: l.rule, skill: named(l.skillId), state: l.state === "saved" ? "saved" as const : "offered" as const }));
  return {
    said: wordsOf(asked), about, earlier, rules,
    usedSkills: (c.skillIds ?? []).map(named),
    skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description })),
  };
}

/** Text as it reads, so a quote matches its skill whatever quote marks, emphasis or line breaks either has. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[*`]/g, "")
    .replace(/^[\s"'…]+|[\s"'…]+$/g, "").replace(/\.\.\.$/, "").replace(/\s+/g, " ").trim();
}

/**
 * What the skill already says that a rule would change, as the check quoted it. Each passage must be in the skill, so
 * the editor reads the skill's words and not the model's account of them; one that isn't is sent back to be quoted.
 */
function quotedFrom(skill: Skill, quotes: string[] | undefined): string[] | undefined {
  const text = plain(skill.description + "\n" + stripFrontmatter(skill.content));
  const kept: string[] = [];
  for (const quote of quotes ?? []) {
    const at = plain(quote);
    if (!at) continue;
    if (!text.includes(at)) throw badRequest("not_in_skill", `“${clip(quote, 100)}” isn’t in ${skill.name} word for word. Quote each passage as the skill has it, one stretch of text each, or leave it out.`);
    if (!kept.some(k => plain(k).includes(at))) kept.push(quote);
  }
  return kept.length ? kept : undefined;
}

/** A learning can insert the approved wording and remove passages the editor saw. The agent chooses where it fits.
 * Compare prose tokens to allow Markdown emphasis, list markers, spacing and line wrapping around those edits. */
export function requireApprovedLearningEdit(skill: Skill, draft: TaskSkillDraft, learning: Learning): void {
  const tokens = (value: string): string[] => plain(value.replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)]|>)[ \t]+/gm, ""))
    .match(/[\p{L}\p{M}\p{N}]+|[^\s]/gu) ?? [];
  const at = (source: string[], index: number, passage: string[]) => passage.every((word, j) => source[index + j] === word);
  const quotes = (learning.replaces ?? []).map(tokens).filter(q => q.length).sort((a, b) => b.length - a.length);
  const rule = tokens(learning.rule);

  // Each original token must survive, except a quoted passage which can survive or be removed as one piece.
  function matches(original: string[], revised: string[], insertRule: boolean) {
    const pieces: { words: string[]; optional: boolean }[] = [];
    for (let i = 0; i < original.length;) {
      const quoted = quotes.find(passage => at(original, i, passage));
      const words = quoted ?? [original[i]!];
      pieces.push({ words, optional: !!quoted });
      i += words.length;
    }
    // Match from both ends. At the insertion point the only space between the two matches must hold the rule.
    const suffix = [revised.length];
    for (let i = pieces.length - 1, end = revised.length; i >= 0; i--) {
      const { words, optional } = pieces[i]!;
      if (end >= words.length && at(revised, end - words.length, words)) end -= words.length;
      else if (!optional) end = -1;
      suffix.push(end);
    }
    if (suffix.at(-1) === 0) return !insertRule || revised.some((_, i) => at(revised, i, rule));
    if (!insertRule) return false;
    for (let i = 0, start = 0; i <= pieces.length; i++) {
      const end = suffix[pieces.length - i]!;
      if (at(revised, start, rule)) {
        const afterRule = start + rule.length;
        if (end === afterRule) return true;
        // A sentence can share an existing full stop, or supply one for a rule the editor typed without punctuation.
        if (rule.at(-1) === "." && end === afterRule - 1) return true;
        if (rule.at(-1) !== "." && revised[afterRule] === "." && end === afterRule + 1) return true;
      }
      const piece = pieces[i];
      if (!piece) break;
      if (at(revised, start, piece.words)) start += piece.words.length;
      else if (!piece.optional) break;
    }
    return false;
  }
  if (rule.length && matches(tokens(skill.description), tokens(draft.description), false)
      && matches(tokens(stripFrontmatter(skill.content)), tokens(draft.instructions), true)) return;
  throw conflict("unapproved_skill_rewrite",
    "Save the rule in the editor’s approved wording, keeping the rest of the skill except for approved quotations. If another passage must change, quote it in your closing message for the editor to approve. If the rule needs different wording, ask the editor to reword it in Learnings.");
}

/**
 * A learning check offers a rule from the request it reads; the rule is that request's, with the editor's words and
 * what the skill already says that it would change. Offering the same rule again returns the first offer.
 */
export function suggestLearning(ctx: Ctx, from: Task, body: SuggestLearningRequest): { learning: Learning; skill: Skill } {
  if (!isLearningCheck(from)) throw conflict("not_a_check", "Rules are offered by the check that reads each request, not by the run that edits.");
  if (FINISHED_TASK.has(from.state)) throw conflict("task_finished", `task is already ${from.state}`);
  const task = from.context.checksTaskId ? ctx.repos.tasks.get(from.context.checksTaskId) : null;
  if (!task || task.projectId !== from.projectId) throw notFound("the request this check reads");
  const skills = enabledSkills(ctx);
  const skill = skills.find(s => s.id === body.skill) ?? skills.find(s => s.name === body.skill);
  if (!skill) throw notFound(`a skill named "${body.skill}". Use skills_list to find the editor's skills`);
  const replaces = quotedFrom(skill, body.replaces);
  const same = ctx.repos.learnings.select("project_id = ? AND json_extract(json, '$.taskId') = ?", [task.projectId, task.id])
    .find(l => l.rule.toLowerCase() === body.rule.toLowerCase());
  if (same) return { learning: same, skill: ctx.repos.skills.get(same.skillId) ?? skill };
  const learning = save(ctx, {
    id: newId("lrn"), projectId: task.projectId, rule: body.rule, said: wordsOf(task), taskId: task.id, skillId: skill.id,
    ...(replaces && { replaces }), state: "suggested", createdAt: now(),
  });
  ctx.log(`[learning] ${learning.id} suggested by ${from.id} from ${task.id} for ${skill.id}${replaces ? `, replacing ${replaces.length} passage${replaces.length === 1 ? "" : "s"}` : ""}`);
  return { learning, skill };
}

/**
 * The editor rewords a rule that waits on them. Approve saves it to the skill as they wrote it. A reason it wasn't
 * saved before was about the old wording, so it goes.
 */
export function reviseLearning(ctx: Ctx, learning: Learning, user: User, body: ReviseLearningRequest): Learning {
  if (learning.state !== "suggested") throw conflict("learning_settled", `this learning is already ${learning.state}`);
  if (body.rule === learning.rule) return learning;
  ctx.log(`[learning] ${learning.id} revised`);
  logActivity(ctx, { projectId: learning.projectId, actor: actorFor(user), type: "learning.revised",
    summary: `${user.name} revised the rule ${quote(learning.rule, 120)} to ${quote(body.rule, 120)}`, data: { learningId: learning.id } });
  return save(ctx, { ...learning, rule: body.rule, error: undefined });
}

export function declineLearning(ctx: Ctx, learning: Learning, user: User): Learning {
  if (learning.state !== "suggested") throw conflict("learning_settled", `this learning is already ${learning.state}`);
  ctx.log(`[learning] ${learning.id} declined`);
  logActivity(ctx, { projectId: learning.projectId, actor: actorFor(user), type: "learning.declined",
    summary: `${user.name} declined the rule ${quote(learning.rule, 120)}`, data: { learningId: learning.id } });
  return save(ctx, { ...learning, state: "declined", error: undefined });
}

/**
 * The editor approves a rule, for the skill it was suggested for or another they chose, and the save runs on the
 * model chosen as they approve it. The request the rule came from may have run on a model they have since left. What
 * the rule replaces was quoted from the skill it was offered for, so it goes when they choose another. Approving
 * again after a save that changed nothing, they have read why, and the next save is told so.
 */
export function approveLearning(ctx: Ctx, learning: Learning, user: User, body: ApproveLearningRequest = {}): Learning {
  if (learning.state !== "suggested") throw conflict("learning_settled", `this learning is already ${learning.state}`);
  const { skillId, ...choice } = body;
  const skill = ctx.repos.skills.get(skillId ?? learning.skillId);
  if (!skill) throw notFound("the skill to save this to");
  const runWith = choice.agent ? choice : undefined;
  // On a repeat approval the editor has also seen the passages quoted in the previous save's closing message.
  const shown = [...(learning.error ?? "").matchAll(/“([^”]+)”|"([^"]+)"/g)].map(match => match[1] ?? match[2]!);
  const current = plain(skill.description + "\n" + stripFrontmatter(skill.content));
  const replaces = skill.id === learning.skillId
    ? [...new Set([...(learning.replaces ?? []), ...shown.filter(passage => current.includes(plain(passage)))])]
    : [];
  const approved = save(ctx, { ...learning, skillId: skill.id, replaces: replaces.length ? replaces : undefined, state: "saving", approvedBy: actorFor(user), runWith, editTaskId: undefined,
    error: undefined, approvedAfter: learning.error });
  ctx.log(`[learning] ${learning.id} approved for ${skill.id}`);
  logActivity(ctx, { projectId: learning.projectId, actor: actorFor(user), type: "learning.approved",
    summary: `${user.name} approved the rule ${quote(learning.rule, 120)} for the skill ${quote(skill.name)}`, data: { learningId: learning.id, skillId: skill.id } });
  startNextSave(ctx, skill.id);
  return ctx.repos.learnings.get(approved.id)!;
}

/**
 * What the agent revising the skill is told: the rule, the editor's words it came from, what in the skill they were
 * shown it would replace, and why the last save changed nothing when they approved again after reading it.
 */
export function learningInstruction(ctx: Ctx, learning: Learning): string {
  const project = ctx.repos.projects.header(learning.projectId);
  return [
    `Work this standing rule into the skill: “${learning.rule}”`,
    "",
    `It comes from a request the editor made while editing${project ? ` “${project.name}”` : ""}. They said: “${learning.said}”`,
    learning.replaces?.length
      ? `They have approved saving the rule to this skill, shown that it replaces what the skill says here:\n${learning.replaces.map(q => `- “${q}”`).join("\n")}`
      : "They have approved saving the rule to this skill, shown nothing in it that the rule would replace.",
    ...(learning.approvedAfter ? ["", `The last attempt to save it changed nothing and said: “${learning.approvedAfter}” They read that and approved again.`] : []),
  ].join("\n");
}

/** A rule approved without a choice of model (from an older client) is saved on its request's. */
function requestRun(ctx: Ctx, learning: Learning): RunChoice {
  const asked = ctx.repos.tasks.get(learning.taskId);
  const agent = asked && asked.agent !== "api" ? asked.agent : ctx.settings().defaultAgent;
  return { agent, model: asked?.agent === agent ? asked.model : undefined };
}

/** Start the oldest approved learning for this skill, unless the skill is being revised already. */
export function startNextSave(ctx: Ctx, skillId: string): void {
  const running = latestSkillEdit(ctx, skillId);
  if (running && !FINISHED_TASK.has(running.state)) return;
  const [next] = ctx.repos.learnings.select("state = 'saving' AND json_extract(json, '$.skillId') = ? AND json_extract(json, '$.editTaskId') IS NULL",
    [skillId], "created_at ASC, rowid ASC");
  if (!next) return;
  if (!ctx.repos.skills.get(skillId) || !ctx.repos.projects.header(next.projectId) || !next.approvedBy) {
    save(ctx, { ...next, state: "suggested", error: "The skill or the project is gone." });
    return startNextSave(ctx, skillId);
  }
  const run = next.runWith ?? requestRun(ctx, next);
  const task = createTask(ctx, {
    projectId: next.projectId, kind: "skill_edit", agent: run.agent ?? ctx.settings().defaultAgent,
    model: run.model, effort: run.effort, fast: run.fast, serviceTier: run.serviceTier,
    instruction: learningInstruction(ctx, next), context: { skillId, learningId: next.id },
    // The save is authorized for whoever approved the rule.
    createdBy: next.approvedBy,
  });
  save(ctx, { ...next, editTaskId: task.id });
}

/** A run and the attempts that resumed it are one request. */
const rootOf = (task: Task) => task.resumeRootId ?? task.id;

/**
 * A skill edit ended. The learning it was saving is saved, or goes back to the editor with why it wasn't. A run cut
 * short and resumed is the same request: when the attempt that carried on saves the skill, the learning is saved.
 */
export function skillEditEnded(ctx: Ctx, task: Task): void {
  if (!isSkillEdit(task) || !task.context.skillId || !FINISHED_TASK.has(task.state)) return;
  const learning = task.context.learningId ? ctx.repos.learnings.get(task.context.learningId) : null;
  const saving = learning?.editTaskId ? ctx.repos.tasks.get(learning.editTaskId) : null;
  if (learning && saving && rootOf(saving) === rootOf(task)) {
    if (task.state === "done" && task.resultSkillId) {
      if (learning.state === "saving" || learning.state === "suggested") {
        save(ctx, { ...learning, state: "saved", error: undefined });
        ctx.log(`[learning] ${learning.id} saved by ${task.id}`);
      }
    } else if (learning.state === "saving") {
      const why = task.state === "done" ? task.summary?.trim() || "Scarlet left the skill as it is."
        : task.state === "cancelled" ? "Saving was stopped." : task.interrupted ? "Saving was interrupted." : task.error?.trim() || "Scarlet couldn’t save it.";
      save(ctx, { ...learning, state: "suggested", error: why });
      ctx.log(`[learning] ${learning.id} not saved by ${task.id} (${task.state})`);
    }
  }
  startNextSave(ctx, task.context.skillId);
}
