import { join } from "node:path";
import { buildSystemPrompt, type EarlierRequest } from "@scarlet/mcp/prompt";
import { agentCapabilities, isAsideTask, isHandOff, isLearningCheck, isListenCheck, isProjectEditTask, isSkillEdit, PROJECT_EDIT_TASK_KINDS, taskRunKind, workspaceCapabilities, type Task, type TaskEvent, type TaskPrompt } from "@scarlet/shared";
import type { Project } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { notFound } from "../errors.js";
import { errorMessage } from "../util.js";
import { changeDiff, cutRevisionReference, passToRevise } from "./changes.js";
import { mimeFor, styleGuidePath } from "./graphics.js";
import { learningCheckContext } from "./learnings.js";
import { assistantSkills } from "./skills.js";
import { runAttempts, runRoot } from "./runAttempts.js";
import { handOffTypes } from "./taskModels.js";
import { answerHandoffInstruction, recoveryInstruction, savedChanges } from "./taskRecap.js";
import { resolveTimeline } from "./timeline.js";

/**
 * CLIs whose sessions Scarlet resumes after an answer, a quit or a pause of the project's editing. A Codex run keeps
 * its thread in a private Codex home beside its task folder, out of the user's own Codex thread list. Started afresh, a
 * pass resumed after a quit spent 120 more turns and 13.7M tokens finding its place again (2026-11-18). agy keeps a
 * Gemini session across its process (`session/resume`): two revisions restarted afresh after a quit measured their
 * edges all over again, four more minutes each (2026-11-23).
 */
export const RESUMABLE = new Set<string>(["claude", "codex", "gemini"]);

/** What a run hears when it carries on in its own CLI session after Scarlet closed on it. */
const INTERRUPTED = "Scarlet closed while you were working on this request, and it is open again. Carry on from where you stopped. " +
  "What you saved is kept. Read the current project and change states first: the editor may have decided some of it since.";

/** What a run hears when it carries on in its own CLI session after the editor paused editing on it and resumed. */
const PAUSED = "The editor paused editing while you were working on this request, and has resumed it. Carry on from where you stopped. " +
  "What you saved is kept. Read the current project and change states first: the editor may have decided some of it since.";

/**
 * What a host tells the model after refusing it a tool that isn't Scarlet's, with `{tool}` for the tool's name. Gemini's
 * harness offers its own shell and file tools whatever it is launched with, so its hosts refuse them in the turn: all of
 * them on a side check, and on a request one that reaches outside the task folder.
 */
const REFUSED_TOOL = "Scarlet refused {tool}: only Scarlet's own tools (the scarlet MCP server) run here, with no shell or file tools. " +
  "Carry on with the request using Scarlet's tools.";
const REFUSED_OUTSIDE = "Scarlet refused {tool}: it reaches outside your task folder. Keep your files in the task folder, " +
  "and read the project's footage and the video through Scarlet's tools. Carry on.";

/** Pair each `question` event with the `answer` that followed it. */
export function pairQuestionsAndAnswers(events: Pick<TaskEvent, "type" | "text">[]): Array<{ question: string; answer: string }> {
  const out: Array<{ question: string; answer: string }> = [];
  let pending: string | null = null;
  for (const e of events) {
    if (e.type === "question") pending = e.text;
    else if (e.type === "answer" && pending !== null) {
      out.push({ question: pending, answer: e.text });
      pending = null;
    }
  }
  return out;
}

/**
 * What the agent is told. Every host fetches this, so there is one prompt.
 * After an answer, a host that still has the CLI session that asked continues
 * it with just the answer; otherwise the answers go in the system prompt.
 */
export function taskPrompt(ctx: Ctx, task: Task, opts: { workDir?: string; fresh?: boolean; timeLimitMinutes?: number } = {}): TaskPrompt {
  const project = ctx.repos.projects.get(task.projectId);
  if (!project) throw notFound("project");
  const c = task.context;
  const editSkill = isSkillEdit(task) ? ctx.repos.skills.get(c.skillId ?? "") : undefined;
  if (isSkillEdit(task) && !editSkill) throw notFound("the skill this request revises");
  // A run that edits no video is told nothing of the video's timeline, the edit it's about or the editor's skills: a
  // look at one frame, a read for a rule, a skill's revision. An edit's area checks each asked for a prompt, up to 20.
  // A hand-off edits the video for the request that handed it the work, so it is told what a request is.
  const handOff = isHandOff(task);
  const aside = (isAsideTask(task) && !handOff) || task.kind === "skill_from_change";
  const notes = c.noteIds?.length ? ctx.repos.notes.select("project_id = ? AND id IN (SELECT value FROM json_each(?))", [task.projectId, JSON.stringify(c.noteIds)]) : undefined;
  // A request about one staged cut names the pass as it stood when the editor sent it. A revision ahead of it in the
  // queue, or a later part of the pass, has replaced that pass since, so the agent is told about the pass that waits now
  // and the cut's index there.
  const named = !aside && c.changeId ? ctx.repos.changes.get(c.changeId) : undefined;
  const now = named?.projectId === task.projectId && c.cutIndex !== undefined ? passToRevise(ctx, named, task.id, c.cutIndex) : undefined;
  const record = now?.change ?? named;
  let change: { change: NonNullable<typeof record>; diff?: ReturnType<typeof changeDiff> } | undefined;
  // A request about one staged cut isn't shown the whole pass's diff, so it isn't worked out.
  if (record?.projectId === task.projectId && c.cutIndex !== undefined) change = { change: record };
  else if (record?.projectId === task.projectId) {
    try {
      change = { change: record, diff: changeDiff(ctx, record) };
    } catch (err) {
      ctx.log(`[task] ${task.id} is told about ${record.id} without its diff: ${errorMessage(err)}`);
      change = { change: record };
    }
  }
  const events = ctx.repos.taskEvents.list(task.id, "questionsAndAnswers");
  const last = events.at(-1);
  const answered = last?.type === "answer";
  // A run interrupted before it finished carries on in the CLI session it was working in, when its host still has it.
  const interrupted = !last && !!task.resumeRootId;
  const resumeSession = !opts.fresh && (answered || interrupted) && task.session?.agent === task.agent && RESUMABLE.has(task.agent) ? task.session.id : undefined;
  // A resumed attempt is told where its run stands as it starts, not as it stood when it was put back in line: the
  // editor may have decided some of what it saved while it waited behind other requests or a pause. One that carries on
  // in its own session is told it too, since the session never had it: the edits refused after its last save, the cuts
  // a later part replaced while it was away.
  const recap = !!task.resumeRootId && !(resumeSession && answered);
  const before = recap ? ctx.repos.tasks.select("project_id = ? AND json_extract(json, '$.retryTaskId') = ?", [task.projectId, task.id])[0] : undefined;
  const instruction = answered && !resumeSession
    ? answerHandoffInstruction(ctx, task, before)
    : before ? recoveryInstruction(ctx, before, task.resumeRootId, task.id) : task.instruction;
  // The run is launched with its harness's to-do tool, and asked to lay out its steps, when the harness has one and the
  // chat will show the plan. A dialogue pass shows the stages Scarlet measures and a request about one staged cut its
  // own two, and a skill edit changes no video: none is given the tool or asked, so each runs exactly as it did.
  const plans = task.kind !== "skill_from_change" && !isAsideTask(task) && !taskRunKind(task)
    && agentCapabilities(task.agent, (ctx.options.env ?? process.env).SCARLET_AGENT_CAPS).plan;
  const listens = isListenCheck(task);
  const told = { ...task, instruction };
  const systemPrompt = buildSystemPrompt({
    project: { project, timeline: !aside && project.head ? resolveTimeline(ctx, project, "head") : null },
    task: now ? { ...told, context: { ...c, changeId: now.change.id, cutIndex: now.index } } : told,
    notes,
    change,
    replacedPass: now && named?.id,
    // A resumed session already holds the earlier questions and answers.
    qa: resumeSession ? undefined : pairQuestionsAndAnswers(events),
    earlier: earlierRequests(ctx, task),
    skills: aside ? [] : assistantSkills(ctx.repos.skills.select("1=1", [], "name ASC"), c.skillIds, true),
    editSkill: editSkill ?? undefined,
    learningCheck: isLearningCheck(task) ? learningCheckContext(ctx, task) : undefined,
    areaCheck: task.kind === "area_check" ? task.context.areaCheck : undefined,
    listenCheck: isListenCheck(task) ? task.context.listenCheck : undefined,
    checkIn: ctx.settings().checkIn,
    // A run that edits no video writes nothing the editor reads as Scarlet talking to them.
    talkingToYou: aside ? undefined : ctx.settings().talkingToYou,
    workDir: opts.workDir,
    timeLimitMinutes: opts.timeLimitMinutes,
    // A request has its harness's own shell, file and web tools; a run that edits no video has Scarlet's alone.
    capabilities: { ...(aside && !listens ? agentCapabilities(task.agent) : workspaceCapabilities(agentCapabilities(task.agent, undefined, task.model))), plan: plans },
    ...graphicsContext(ctx, project, task),
    // The kinds of work the editor gave other models, for a request to hand off; what a hand-off is doing, for one.
    ...(handOff && c.handOff ? { handOff: { name: c.handOff.name, description: c.handOff.description,
      request: (c.checksTaskId && ctx.repos.tasks.get(c.checksTaskId)?.context.message) || c.message || task.instruction } }
      : { taskModels: handOffTypes(ctx, task) }),
  });
  // Whether the host launches the CLI with its own to-do tool on, with its shell, file and web tools (every request:
  // the editor's decision of 2026-11-21 that no rule in Scarlet's code picks which run gets them, so what to use them
  // for is the model's call), and what it says when it refuses a tool.
  // A listen is launched with its harness's own tools as well: Gemini hears a passage only by opening its file there.
  const launch = { ...(plans && { plan: true }), ...((!aside || listens) && { workspace: true }), refusedTool: aside ? REFUSED_TOOL : REFUSED_OUTSIDE };
  if (resumeSession) {
    return { systemPrompt, instruction: answered ? `The editor answered: "${last!.text.trim()}"\nContinue the task with that answer.`
      : `${task.resumesAfterProjectStop ? PAUSED : INTERRUPTED}\n\n${instruction.trim()}`, resumeSession, ...launch };
  }
  return { systemPrompt, instruction: firstMessage(instruction.trim()), ...launch };
}

/**
 * What the editor gave a request for its graphics: the files attached to it and the project's style guide. A request that edits no video is given none.
 */
function graphicsContext(ctx: Ctx, project: Project, task: Task) {
  if (task.kind === "skill_from_change" || (isAsideTask(task) && !isHandOff(task))) return {};
  const attachments = (task.context.attachments ?? []).map(a => ({ ...a, mime: a.mime ?? mimeFor(a.name), path: join(ctx.paths.attachments(project.id), a.id, a.name) }));
  const guide = project.styleGuide;
  const guidePath = styleGuidePath(ctx, project.id, guide);
  return {
    ...(attachments.length && { attachments }),
    ...(guide && { styleGuide: { name: guide.name, text: guide.text, ...(guidePath && { path: guidePath, mime: mimeFor(guidePath) }) } }),
  };
}

/**
 * The request as a CLI's first message. Claude Code takes a message that begins with "/" for one of its own slash
 * commands. Finding none of that name, it tells the model the command did not run and to say it isn't installed, and
 * a pass then opened its reply with "The /first-cut-dialogue command isn't installed in this session" (2026-11-07).
 * A lead-in keeps the editor's words as typed and out of the CLI's command parser. The system prompt carries the
 * instruction as well, unchanged.
 */
function firstMessage(instruction: string) {
  return instruction.startsWith("/") ? `The editor's request: ${instruction}` : instruction;
}

/**
 * How much of the chat a request is told: its latest requests, and of each what fits on a screen. A pass can post
 * hundreds of updates and save dozens of parts, and the newest say where it ended.
 */
const CHAT = { requests: 6, chars: 6000, asked: 600, told: 3, message: 800, edits: 3 };

const clipped = (text: string, max: number) => (text.trim().length > max ? `${text.trim().slice(0, max).trimEnd()}…` : text.trim());

/** The latest things Scarlet showed the editor while it worked on a request, over all its attempts, each said once. */
function toldEditor(ctx: Ctx, attempts: Task[]): string[] {
  const said = attempts.flatMap(t => ctx.repos.taskEvents.list(t.id, "conversation")).filter(e => e.type === "log").map(e => clipped(e.text, CHAT.message));
  return said.filter((text, i) => text && text !== said[i - 1]).slice(-CHAT.told);
}

/**
 * The project's chat before `task`, oldest first: what the editor asked in its latest earlier requests and what
 * Scarlet told them. The requests of the task's own thread are left out: its words carry them (`followUpInstruction`).
 * A run that edits no video is told none of it.
 */
export function earlierRequests(ctx: Ctx, task: Task): EarlierRequest[] {
  if (!isProjectEditTask(task)) return [];
  const root = runRoot(task);
  const thread = task.context.threadId ?? root;
  // A resumed attempt is told the chat as it stood when its request was first sent.
  const since = (task.resumeRootId && ctx.repos.tasks.get(task.resumeRootId)?.createdAt) || task.createdAt;
  const before = ctx.repos.tasks.select("project_id = ? AND created_at < ? AND kind IN (SELECT value FROM json_each(?))",
    [task.projectId, since, JSON.stringify(PROJECT_EDIT_TASK_KINDS)], "created_at DESC, rowid DESC LIMIT 60");
  const roots = [...new Set(before.filter(t => runRoot(t) !== root && (t.context.threadId ?? runRoot(t)) !== thread).map(runRoot))];
  const out: EarlierRequest[] = [];
  let chars = 0;
  for (const id of roots) {
    if (out.length === CHAT.requests) break;
    const run = runAttempts(task.projectId, id);
    const attempts = ctx.repos.tasks.select(run.where, run.params, "created_at, rowid");
    const first = attempts[0], last = attempts.at(-1);
    // A request the editor had Scarlet try again is said once, by the try that took its place.
    if (!first || !last || last.retryTaskId) continue;
    const told = toldEditor(ctx, attempts);
    const answers = attempts.flatMap(t => pairQuestionsAndAnswers(ctx.repos.taskEvents.list(t.id, "questionsAndAnswers"))).slice(-2)
      .map(p => ({ question: clipped(p.question, CHAT.message), answer: clipped(p.answer, CHAT.message) }));
    const replied = clipped(last.summary?.trim() || last.reply?.trim() || "", CHAT.message);
    // A proposal a later part or a revision took over is closed by Scarlet: what replaced it is listed instead.
    const saved = savedChanges(ctx, attempts).filter(c => !(c.state === "rejected" && c.replacedBy));
    const edits = saved.slice(-CHAT.edits).map(c => `"${clipped(c.description, 200)}" (change ${c.id}, ${c.state})`);
    if (saved.length > edits.length) edits.unshift(`${saved.length - edits.length} earlier`);
    const request: EarlierRequest = {
      asked: clipped(first.context.asked ?? first.context.message ?? first.instruction, CHAT.asked),
      ...(told.length && { told }),
      ...(answers.length && { answers }),
      ...(replied && { replied }),
      ...(edits.length && { edits }),
      ...(last.state === "failed" || last.state === "cancelled" ? { standing: "It stopped before it finished." }
        : last.state !== "done" && { standing: "It hasn’t finished yet." }),
    };
    chars += JSON.stringify(request).length;
    if (out.length && chars > CHAT.chars) break;
    out.unshift(request);
  }
  return out;
}

/**
 * A follow-up in a thread that already has history: give the agent the gist of
 * what happened so far, keep what the person said in context.message. An earlier request the app worded for the
 * person reads as what it asked: its name in the chat, "Undo", doesn't say which edit was put back.
 */
export function followUpInstruction(ctx: Ctx, projectId: string, threadId: string, text: string, before?: string): string {
  const thread = ctx.repos.tasks.select("project_id = ? AND coalesce(json_extract(json, '$.context.threadId'), id) = ?", [projectId, threadId], "created_at ASC, rowid ASC");
  // A request reworded in the queue is told what came before it, as it was when first asked.
  const at = before ? thread.findIndex(t => t.id === before) : -1;
  const tasks = at < 0 ? thread : thread.slice(0, at);
  if (!tasks.length) return text;
  const recentChanges = ctx.repos.changes
    .select("project_id = ? AND json_extract(json, '$.threadId') = ?", [projectId, threadId], "created_at DESC, rowid DESC LIMIT 5")
    .reverse();
  const lines = ["This continues an earlier request in the same thread."];
  // Carry recent Q&A decisions from earlier turns in the thread so a follow-up (including on another model) honors them.
  const qaByTask = new Map<string, Array<{ question: string; answer: string }>>();
  let qaTotal = 0;
  for (let i = tasks.length - 1; i >= 0 && qaTotal < 6; i--) {
    const t = tasks[i]!;
    const pairs = pairQuestionsAndAnswers(ctx.repos.taskEvents.list(t.id, "questionsAndAnswers"));
    if (!pairs.length) continue;
    const kept = pairs.slice(-(6 - qaTotal));
    qaByTask.set(t.id, kept);
    qaTotal += kept.length;
  }
  // What Scarlet showed the editor while it worked on the latest of them: its closing words can point back at it
  // ("I shared the links above"), and the editor's next words can too.
  const recent = new Set(tasks.slice(-CHAT.told).map(t => t.id));
  for (const t of tasks) {
    lines.push(`- Asked: ${t.context.asked ?? t.context.message ?? t.instruction}`);
    if (recent.has(t.id)) for (const told of toldEditor(ctx, [t])) lines.push(`  You told the editor: ${told.replace(/\n+/g, "\n  ")}`);
    for (const { question, answer } of qaByTask.get(t.id) ?? []) {
      lines.push(`  Asked editor: ${question}`);
      lines.push(`  Editor answered: ${answer}`);
    }
    const summary = t.summary?.trim();
    const reply = t.reply?.trim();
    if (summary) lines.push(`  You replied: ${summary}`);
    else if (reply) lines.push(`  You replied: ${reply}`);
    if (summary && reply && reply !== summary) lines.push(`  Your reply to the editor: ${reply}`);
  }
  if (recentChanges.length) {
    // A proposal a revision replaced is stored as rejected, though the editor decided nothing about it.
    const changeState = (c: (typeof recentChanges)[number]) =>
      c.state === "rejected" && c.replacedBy ? `replaced by ${c.replacedBy}, which holds its cuts now; the editor made no decision on it` : c.state;
    for (const change of recentChanges.slice(0, -1)) {
      lines.push(`Earlier change: "${change.description}" (${changeState(change)}).`);
    }
    const last = recentChanges.at(-1)!;
    lines.push(`Latest change: "${last.description}" (${changeState(last)}).`);
  }
  lines.push("", `Now: ${text}`);
  return lines.join("\n");
}

/**
 * What Scarlet told the editor about the one staged cut a request is about, as a revision sent from that cut's card
 * says it: why it was proposed and how it was assessed. A call can be sent back this way while its pass still runs.
 * Empty when the request isn't about one.
 */
export function aboutStagedCut(ctx: Ctx, projectId: string, context: Task["context"]): string {
  const { changeId, cutIndex, time } = context;
  const pass = changeId && cutIndex !== undefined && time !== undefined ? ctx.repos.changes.get(changeId) : undefined;
  return pass?.projectId === projectId ? cutRevisionReference(pass, { cutIndex, time: time!, end: context.end, clipIds: context.clipIds ?? [],
    version: context.version, mediaId: context.mediaId, markedRange: context.markedRange }) : "";
}
