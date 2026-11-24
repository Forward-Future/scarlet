import { isLearningCheck, isSkillEdit, namedTimelineEdits, REJECT_MESSAGE, sameRun, type ApproveLearningRequest, type Learning, type LearningDecision, type ReviseLearningRequest, type RunChoice, type Skill, type SuggestLearningRequest, type TaskSkillDraft, type Task, type User } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { stripFrontmatter, type LearningCheckContext } from "@scarlet/mcp/prompt";
import { clock, newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { clip } from "../logText.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { latestSkillEdit } from "./skills.js";
import { createTask, editsDialogue, FINISHED_TASK } from "./tasks.js";

/**
 * Learnings: standing rules Scarlet picked up from the editor's requests and decisions. Every request is read for one
 * as it is sent, by a learning check: a short run beside the request that sees what they said, what they decided lately
 * on the cuts and edits Scarlet made, and their skills, and offers a rule, with what the skill already says that it
 * would change, or does nothing. The editor finishing what a request left them to decide starts one too, when they
 * decided something no check has read. A rule from their decisions cites them, and the editor sees them under it. Each rule waits for the editor, who
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
  if (!editsDialogue(task.kind) || task.createdBy.type !== "human" || task.resumeRootId || task.agent === "api") return;
  // The check is Scarlet's own. Whatever goes wrong starting it, the request it reads is already saved and runs.
  try {
    if (ONLY_A_SKILL.test(wordsOf(task)) || !enabledSkills(ctx).length) return;
    return createTask(ctx, {
      projectId: task.projectId, kind: "learning_check", agent: task.agent, model: task.model, fast: task.fast,
      instruction: wordsOf(task), context: { checksTaskId: task.id }, createdBy: task.createdBy,
    });
  } catch (err) {
    ctx.log(`[learning] ${task.id} wasn’t read for a rule: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const RECENT_REQUESTS = 12;
const KNOWN_RULES = 30;
/** How many of the editor's latest decisions a check reads, and how far back a cited one is looked for. */
const RECENT_DECISIONS = 40;
const CITABLE_DECISIONS = 200;
/** How many changes of each kind are read for decisions, newest first. */
const DECISION_CHANGES = 40;

/** A decision as a check reads it: what it was about, what Scarlet measured, which skills made it and when it was made. */
interface Decided extends LearningDecision { at: string; details: string[]; changeId?: string }

const seconds = (s: number) => `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
const LIVE_PROJECT = "project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)";

/** What Scarlet said of an edit it made: why, and what it asked the editor to check. */
function editDetails(edit: { reason?: string; check?: string } | undefined): string[] {
  return [edit?.reason && `Scarlet’s reason: “${clip(edit.reason, 200)}”`, edit?.check && `it asked the editor to check: “${clip(edit.check, 120)}”`]
    .filter((d): d is string => !!d);
}

/**
 * The editor's decisions on cuts and edits Scarlet made, in every project, newest first: the edits they kept and the
 * ones they rejected, their calls on a pass's cuts once it went in, and the revisions they asked of one. Each has an id
 * a rule cites it by, and what Scarlet measured and said of it, so a check can tell a pattern from a coincidence.
 */
function recentDecisions(ctx: Ctx, limit: number): Decided[] {
  const out: Decided[] = [];
  const recent = (where: string) => ctx.repos.changes.select(`${LIVE_PROJECT} AND ${where}`, [],
    `json_extract(json, '$.updatedAt') DESC, rowid DESC LIMIT ${DECISION_CHANGES}`);
  const named = new Map<string, Change["timelineEdits"]>();
  const edits = (change: Change) => {
    if (!named.has(change.id)) named.set(change.id, namedTimelineEdits(change));
    return named.get(change.id);
  };
  for (const change of recent("json_extract(json, '$.kept') IS NOT NULL")) {
    for (const k of change.kept ?? []) {
      const edit = edits(change)?.[k.spot];
      out.push({ id: `kept:${change.id}:${k.spot}`, decision: "kept", label: k.label ?? edit?.label ?? change.description, projectId: change.projectId,
        threadId: k.threadId, ref: { changeId: change.id, spot: k.spot }, time: k.place?.range.start ?? edit?.range.start, at: k.at, changeId: change.id,
        details: editDetails({ reason: edit?.reason, check: k.check ?? edit?.check }) });
    }
  }
  for (const rejection of recent("json_extract(json, '$.rejects') = 1")) {
    for (const edit of rejection.timelineEdits ?? []) {
      if (!edit.replaces) continue;
      const made = ctx.repos.changes.get(edit.replaces.changeId);
      const was = made && edits(made)?.[edit.replaces.spot];
      out.push({ id: `rejected:${edit.replaces.changeId}:${edit.replaces.spot}`, decision: "rejected", label: was?.label ?? edit.label,
        projectId: rejection.projectId, threadId: rejection.threadId ?? made?.threadId, ref: edit.replaces, time: edit.range.start,
        at: rejection.createdAt ?? rejection.updatedAt ?? "", changeId: edit.replaces.changeId, details: editDetails(was || undefined) });
    }
  }
  for (const pass of recent("state = 'approved' AND json_extract(json, '$.cutChoices') IS NOT NULL")) {
    for (const choice of pass.cutChoices ?? []) {
      const assessed = pass.cutAssessments?.find(a => a.index === choice.index);
      const staged = pass.cutReasons?.find(r => r.start < choice.end && r.end > choice.start);
      const joined = choice.choice === "cut" ? pass.appliedReview?.joins.findIndex(j => j.reviewIndex === choice.index) ?? -1 : -1;
      out.push({ id: `call:${pass.id}:${choice.index}`, decision: choice.choice === "cut" ? "kept" : "rejected",
        label: assessed?.summary ?? staged?.summary ?? `Cut ${seconds(choice.end - choice.start)}`, projectId: pass.projectId, threadId: pass.threadId,
        ...(joined >= 0 && { ref: { changeId: pass.id, spot: joined } }), time: joined >= 0 ? pass.appliedReview!.joins[joined]!.at : choice.start,
        at: pass.updatedAt ?? pass.createdAt ?? "", changeId: pass.id,
        details: [`a call on a ${staged?.kind ? `${staged.kind} ` : ""}cut of ${seconds(choice.end - choice.start)}`,
          ...editDetails({ reason: assessed?.reason ?? staged?.reason, check: staged?.check }),
          ...(staged?.held ? [`what Scarlet measured at its edges: “${clip(staged.held, 200)}”`] : [])] });
    }
  }
  // Revise on an applied edit sends a request in its thread (kind edit), since only a proposal takes kind revise. The ×
  // that asks Scarlet to put an edit back is sent the same way, and is a rejection, not a revision.
  const revisions = ctx.repos.tasks.select(`${LIVE_PROJECT} AND kind IN ('edit', 'revise') AND json_extract(json, '$.createdBy.type') = 'human' AND json_extract(json, '$.resumeRootId') IS NULL
    AND json_extract(json, '$.context.changeId') IS NOT NULL AND json_extract(json, '$.context.message') IS NOT ?`, [REJECT_MESSAGE], `created_at DESC, rowid DESC LIMIT ${DECISION_CHANGES}`);
  for (const task of revisions) {
    const c = task.context;
    const spot = c.editIndex ?? c.cutIndex;
    const made = ctx.repos.changes.get(c.changeId!);
    const edit = made && spot !== undefined ? edits(made)?.[spot] : undefined;
    out.push({ id: `revised:${task.id}`, decision: "revised", label: edit?.label ?? made?.description ?? "an edit", projectId: task.projectId,
      threadId: c.threadId, ...(spot !== undefined && c.editIndex !== undefined && { ref: { changeId: c.changeId!, spot } }), time: c.time,
      note: clip(wordsOf(task), 300), at: task.createdAt ?? "", changeId: c.changeId, details: editDetails(edit) });
  }
  const seen = new Set<string>();
  return out.sort((a, b) => b.at.localeCompare(a.at)).filter(d => !seen.has(d.id) && !!seen.add(d.id)).slice(0, limit);
}

/** The rule already offered from each decision, by the decision's id. */
function rulesFromDecisions(ctx: Ctx): Map<string, string> {
  const rules = new Map<string, string>();
  for (const l of ctx.repos.learnings.select("json_extract(json, '$.learnedFrom') IS NOT NULL", [], "created_at ASC, rowid ASC"))
    for (const d of l.learnedFrom?.decisions ?? []) rules.set(d.id, l.rule);
  return rules;
}

/**
 * The skills that made the change a request is about. A revision names none of its own, but a correction to a cut is a
 * correction to the skill that cut it, so the rule belongs there.
 */
function skillsBehind(ctx: Ctx, changeId: string | undefined): string[] {
  const change = changeId ? ctx.repos.changes.get(changeId) : null;
  let maker = change?.taskId ? ctx.repos.tasks.get(change.taskId) : null;
  // A pass resumed or continued keeps the skills of the request that started it.
  for (let hops = 0; maker && !maker.context.skillIds?.length && hops < 5; hops++) {
    const root = maker.resumeRootId ?? maker.context.threadId;
    maker = root && root !== maker.id ? ctx.repos.tasks.get(root) : null;
  }
  return maker?.context.skillIds ?? [];
}

/** What a learning check is shown: the request, what it was about, the editor's skills and the rules already offered. */
export function learningCheckContext(ctx: Ctx, check: Task): LearningCheckContext {
  const asked = check.context.checksTaskId ? ctx.repos.tasks.get(check.context.checksTaskId) : null;
  if (!asked || asked.projectId !== check.projectId) throw notFound("the request this check reads");
  const skills = enabledSkills(ctx);
  const named = (id: string) => ctx.repos.skills.get(id)?.name ?? "a skill since deleted";
  const aimedAt = (task: Task) => {
    const c = task.context;
    const kind = c.cutIndex !== undefined ? "cut" : c.editIndex !== undefined ? "edit" : c.changeId ? "edit" : undefined;
    const makers = kind ? skillsBehind(ctx, c.changeId).map(named) : [];
    return { kind, makers };
  };
  const c = asked.context;
  const at = c.time !== undefined ? ` at ${clock(Math.floor(c.time))}` : "";
  const target = aimedAt(asked);
  const madeBy = target.makers.length ? ` with ${target.makers.join(", ")}` : "";
  const about = c.changeId && (c.cutIndex !== undefined || c.editIndex !== undefined)
    ? `They said it about one ${c.cutIndex !== undefined ? "cut" : "edit"} Scarlet made${madeBy}${at}.`
    : c.changeId ? `They said it about an edit Scarlet made${madeBy}.`
    : at ? `They said it about the moment${at} in the video.` : undefined;
  // A correction that keeps coming back is the rule, and it comes back across videos, so the list isn't this project's
  // alone. Each line says what it was about and which skill made that, as the request above does.
  const earlier = ctx.repos.tasks.select("kind IN ('edit', 'note', 'revise') AND json_extract(json, '$.createdBy.type') = 'human' AND json_extract(json, '$.resumeRootId') IS NULL AND rowid < (SELECT rowid FROM tasks WHERE id = ?)",
    [asked.id], `created_at DESC, rowid DESC LIMIT ${RECENT_REQUESTS * 3}`)
    .filter(t => !ONLY_A_SKILL.test(wordsOf(t))).slice(0, RECENT_REQUESTS).reverse()
    .map(t => {
      const { kind, makers } = aimedAt(t);
      return { said: clip(wordsOf(t), 400), ...(kind && { about: `${kind === "cut" ? "a cut" : "an edit"} ${makers.length ? makers.join(", ") : "Scarlet"} made` }),
        ...(t.projectId !== asked.projectId && { elsewhere: true }) };
    });
  // A rule the editor declined is listed too, so it isn't offered again in other words.
  const rules = ctx.repos.learnings.select("1=1", [], `created_at DESC, rowid DESC LIMIT ${KNOWN_RULES}`).reverse()
    .map(l => ({ rule: l.rule, skill: named(l.skillId), state: l.state === "saved" ? "saved" as const : l.state === "declined" ? "declined" as const : "offered" as const }));
  const offered = rulesFromDecisions(ctx);
  const decided = recentDecisions(ctx, RECENT_DECISIONS).reverse().map(d => {
    const madeBy = d.changeId ? skillsBehind(ctx, d.changeId).map(named) : [];
    return { id: d.id, decision: d.decision, label: clip(d.label, 180), ...(d.details.length && { details: d.details }), ...(d.note && { note: d.note }),
      ...(madeBy.length && { madeBy }), ...(d.projectId !== asked.projectId && { elsewhere: true }), ...(offered.has(d.id) && { ruleFrom: offered.get(d.id) }) };
  });
  return {
    said: wordsOf(asked), about, earlier, rules, ...(decided.length && { decided }), ...(check.context.readsDecisions && { readsDecisions: true }),
    usedSkills: (c.skillIds ?? []).map(named),
    skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description })),
  };
}

/** Text as it reads, so a quote matches its skill whatever quote marks, emphasis or line breaks either has. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[*`]/g, "")
    .replace(/^[\s"'…]+|[\s"'…]+$/g, "").replace(/\.\.\.$/, "").replace(/\s+/g, " ").trim();
}

/** A skill's description and instructions as they read, to find a quoted passage in. */
const skillText = (skill: Skill) => plain(skill.description + "\n" + stripFrontmatter(skill.content));

/**
 * What the skill already says that a rule would change, as the check quoted it. Each passage must be in the skill, so
 * the editor reads the skill's words and not the model's account of them; one that isn't is sent back to be quoted.
 */
function quotedFrom(skill: Skill, quotes: string[] | undefined): string[] | undefined {
  const text = skillText(skill);
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
  // The editor's decline stands: the same rule isn't put to them again for the same skill.
  const rule = plain(body.rule);
  if (ctx.repos.learnings.select("state = 'declined' AND json_extract(json, '$.skillId') = ?", [skill.id]).some(l => plain(l.rule) === rule))
    throw conflict("declined", `The editor declined this rule for ${skill.name}. Don’t offer it again.`);
  const same = ctx.repos.learnings.select("project_id = ? AND json_extract(json, '$.taskId') = ?", [task.projectId, task.id])
    .find(l => l.rule.toLowerCase() === body.rule.toLowerCase());
  if (same) return { learning: same, skill: ctx.repos.skills.get(same.skillId) ?? skill };
  const learnedFrom = body.from && citedDecisions(ctx, body.from);
  const learning = save(ctx, {
    id: newId("lrn"), projectId: task.projectId, rule: body.rule, said: wordsOf(task), taskId: task.id, skillId: skill.id,
    ...(learnedFrom && { learnedFrom }), ...(replaces && { replaces }), state: "suggested", createdAt: now(),
  });
  ctx.log(`[learning] ${learning.id} suggested by ${from.id} from ${task.id} for ${skill.id}${replaces ? `, replacing ${replaces.length} passage${replaces.length === 1 ? "" : "s"}` : ""}` +
    `${learnedFrom ? `, from ${learnedFrom.decisions.length} decision${learnedFrom.decisions.length === 1 ? "" : "s"}` : ""}`);
  return { learning, skill };
}

/**
 * The decisions a rule cites, as they are now, so the editor can open each one under the rule. Each must be one of the
 * editor's decisions a check is shown; one that isn't is sent back to be cited as listed.
 */
function citedDecisions(ctx: Ctx, from: NonNullable<SuggestLearningRequest["from"]>): NonNullable<Learning["learnedFrom"]> {
  const known = new Map(recentDecisions(ctx, CITABLE_DECISIONS).map(d => [d.id, d]));
  const decisions: LearningDecision[] = [];
  for (const id of new Set(from.decisions)) {
    const found = known.get(id);
    if (!found) throw badRequest("unknown_decision", `“${clip(id, 100)}” isn’t one of the editor’s decisions. Cite each by its id as your prompt lists it, or leave from out.`);
    const { at: _at, details: _details, changeId: _changeId, ...decision } = found;
    decisions.push(decision);
  }
  return { what: from.what, decisions: decisions.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)) };
}

/**
 * The editor finished deciding what a request left them: a pass's calls went in, or they kept or rejected the last of
 * what it flagged. Called as a decision is recorded, so a check reads their decisions for a rule, on the model of the
 * request's latest run. It isn't started while the project's editing is paused, nor while a check that hasn't begun is
 * waiting, since that one reads them as it begins. Whatever goes wrong, the decision stands.
 */
export function startDecisionCheck(ctx: Ctx, projectId: string, threadId: string | undefined): Task | undefined {
  if (!threadId) return;
  try {
    const project = ctx.repos.projects.header(projectId);
    if (!project || project.editingPaused || !enabledSkills(ctx).length) return;
    const asked = ctx.repos.tasks.get(threadId);
    if (!asked || asked.projectId !== projectId || !editsDialogue(asked.kind) || asked.createdBy.type !== "human") return;
    const latest = ctx.repos.tasks.select("project_id = ? AND json_extract(json, '$.context.threadId') = ? AND json_extract(json, '$.createdBy.type') = 'human'",
      [projectId, threadId], "created_at DESC, rowid DESC LIMIT 1")[0] ?? asked;
    if (latest.agent === "api" || threadWaitsOnEditor(ctx, projectId, threadId)) return;
    if (ctx.repos.tasks.count("kind = 'learning_check' AND state = 'queued'")) return;
    const check = createTask(ctx, {
      projectId, kind: "learning_check", agent: latest.agent, model: latest.model, fast: latest.fast,
      instruction: "Read the editor’s decisions for a standing rule.", context: { checksTaskId: asked.id, readsDecisions: true }, createdBy: latest.createdBy,
    });
    ctx.log(`[learning] ${check.id} reads the decisions on ${asked.id}`);
    return check;
  } catch (err) {
    ctx.log(`[learning] the decisions on ${threadId} weren’t read for a rule: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Whether a request still waits on the editor, or on Scarlet: a run of it is still at work or waits on them, a pass or
 * suggestion of it waits, or an edit it flagged is neither kept nor rejected nor revised since. When in doubt it waits,
 * so a check starts once their deciding is done.
 */
function threadWaitsOnEditor(ctx: Ctx, projectId: string, threadId: string): boolean {
  if (ctx.repos.tasks.count(`project_id = ? AND json_extract(json, '$.context.threadId') = ? AND kind IN ('edit', 'note', 'revise')
    AND state NOT IN (${[...FINISHED_TASK].map(s => `'${s}'`).join(",")})`, [projectId, threadId])) return true;
  const changes = ctx.repos.changes.select("project_id = ? AND json_extract(json, '$.threadId') = ?", [projectId, threadId]);
  if (changes.some(c => c.state === "ready" || c.state === "revising")) return true;
  const key = (changeId: string, spot: number) => `${changeId}:${spot}`;
  // Rejected or revised since: a later edit of the request replaces it.
  const replaced = new Set(changes
    .flatMap(c => (c.timelineEdits ?? []).flatMap(e => e.replaces ? [key(e.replaces.changeId, e.replaces.spot)] : [])));
  const keptHere = (change: Change, spot: number, after = "") => (change.kept ?? []).some(k => k.threadId === threadId && k.spot === spot && k.at >= after);
  for (const change of changes) {
    if (change.state !== "approved" || change.rejects) continue;
    if (change.appliedReview) {
      // A pass's applied cuts are named by where they joined: those it asked the editor to check against those settled.
      const settled = new Set([...(change.kept ?? []).filter(k => k.threadId === threadId).map(k => k.spot),
        ...change.appliedReview.joins.flatMap((_, spot) => replaced.has(key(change.id, spot)) ? [spot] : [])]);
      if ((change.cutReasons ?? []).filter(r => r.check).length > settled.size) return true;
      continue;
    }
    for (const [spot, edit] of (namedTimelineEdits(change) ?? []).entries())
      if (edit.check && !keptHere(change, spot) && !replaced.has(key(change.id, spot))) return true;
  }
  // Doubts this request raised about edits other requests made.
  const flagged = ctx.repos.changes.select("project_id = ? AND json_extract(json, '$.flags') IS NOT NULL", [projectId]);
  for (const change of flagged) {
    for (const flag of change.flags ?? []) {
      if (ctx.repos.tasks.get(flag.taskId)?.context.threadId !== threadId) continue;
      if (!keptHere(change, flag.spot, flag.at) && !replaced.has(key(change.id, flag.spot))) return true;
    }
  }
  return false;
}

/** Only a rule that waits on the editor can be reworded, declined or approved. */
function requireSuggested(learning: Learning): void {
  if (learning.state === "suggested") return;
  throw conflict("learning_settled", learning.state === "saving" ? "This rule is already being saved."
    : learning.state === "saved" ? "This rule was already approved." : "This rule was already declined.");
}

/**
 * The editor rewords a rule that waits on them. Approve saves it to the skill as they wrote it. A reason it wasn't
 * saved before was about the old wording, so it goes.
 */
export function reviseLearning(ctx: Ctx, learning: Learning, user: User, body: ReviseLearningRequest): Learning {
  requireSuggested(learning);
  if (body.rule === learning.rule) return learning;
  ctx.log(`[learning] ${learning.id} revised`);
  logActivity(ctx, { projectId: learning.projectId, actor: actorFor(user), type: "learning.revised",
    summary: `${user.name} revised the rule ${quote(learning.rule, 120)} to ${quote(body.rule, 120)}`, data: { learningId: learning.id } });
  return save(ctx, { ...learning, rule: body.rule, error: undefined });
}

export function declineLearning(ctx: Ctx, learning: Learning, user: User): Learning {
  requireSuggested(learning);
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
  requireSuggested(learning);
  const { skillId, ...choice } = body;
  const skill = ctx.repos.skills.get(skillId ?? learning.skillId);
  if (!skill) throw notFound("the skill to save this to");
  const runWith = choice.agent ? choice : undefined;
  // On a repeat approval the editor has also seen the passages quoted in the previous save's closing message.
  const shown = [...(learning.error ?? "").matchAll(/“([^”]+)”|"([^"]+)"/g)].map(match => match[1] ?? match[2]!);
  const current = skillText(skill);
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
function learningInstruction(ctx: Ctx, learning: Learning): string {
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
function startNextSave(ctx: Ctx, skillId: string): void {
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

/**
 * A skill edit ended. The learning it was saving is saved once the run saved the skill, however the run ended, or goes
 * back to the editor with why it wasn't. A run cut short and resumed is the same request: when the attempt that carried
 * on saves the skill, the learning is saved.
 */
export function skillEditEnded(ctx: Ctx, task: Task): void {
  if (!isSkillEdit(task) || !task.context.skillId || !FINISHED_TASK.has(task.state)) return;
  const learning = task.context.learningId ? ctx.repos.learnings.get(task.context.learningId) : null;
  const saving = learning?.editTaskId ? ctx.repos.tasks.get(learning.editTaskId) : null;
  if (learning && sameRun(task, saving ?? undefined)) {
    if (task.resultSkillId) {
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
