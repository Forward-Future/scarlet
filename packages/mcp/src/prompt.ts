/**
 * System prompt given to the editor's CLI (Claude Code / Codex / Gemini) when
 * Scarlet runs it headlessly. Explains how Scarlet works, states the task,
 * provides context (timestamps, clip ids, notes, the change being revised)
 * and includes the applicable skills verbatim.
 */
import { taskDialogueOperation, agentCapabilities, changeEdits, namedTimelineEdits, type AgentCapabilities, type Skill, type Task } from "@scarlet/shared";
import type { Change, Note, Project, Timeline, TimelineDiff } from "@scarlet/timeline";
import { describeDiff, formatTimecode } from "@scarlet/timeline";
import { summarizeProject } from "./analysis.js";

/** What a learning check is shown about the request it reads. */
export interface LearningCheckContext {
  /** The editor's words, as they said them. */
  said: string;
  /** What the words were about, when they were aimed at a cut, an edit or a moment. */
  about?: string;
  /** Skills the editor chose for the request. */
  usedSkills: string[];
  /** What they asked earlier in this project, oldest first. */
  earlier: string[];
  /** Rules already offered to the editor or saved in a skill, oldest first. */
  rules: Array<{ rule: string; skill: string; state: "offered" | "saved" }>;
  /** The editor's skills a rule can go into. */
  skills: Array<{ id: string; name: string; description: string }>;
}

export interface PromptContext {
  /** The project (settings + media) and its head timeline, or a pre-rendered summary string. */
  project: { project: Project; timeline: Timeline | null } | string;
  /** The task being run (instruction, kind, context). Optional for one-shot runs. */
  task?: Pick<Task, "instruction" | "kind" | "context" | "agent" | "model"> & Partial<Task>;
  /** Review notes the task responds to. */
  notes?: Note[];
  /** Change being revised, with its diff. */
  change?: { change: Change; diff?: TimelineDiff; description?: string[] };
  /** The pass a request about one staged cut named, when revisions or later parts of the pass have replaced it with `change` since it was sent. */
  replacedPass?: string;
  /** Earlier question/answer pairs when the task was paused and resumed. */
  qa?: Array<{ question: string; answer: string }>;
  skills: Skill[];
  /** The skill a skill_edit task revises. Such a task edits no video, so its prompt is about the skill alone. */
  editSkill?: Skill;
  /** What a learning_check task reads. Such a task edits no video, so its prompt is about the request alone. */
  learningCheck?: LearningCheckContext;
  /** Directory the agent may use for temp files; mentioned in the prompt. */
  workDir?: string;
  /** How long the host lets this run take, in minutes. Omitted when the host doesn't say. */
  timeLimitMinutes?: number;
  /** What the running harness delivers to the model (see agentCapabilities). Omitted = conservative defaults. */
  capabilities?: AgentCapabilities;
}

/**
 * Scarlet's contract with the agent: who decides, what context exists and how edits and messages
 * work. How each tool works belongs in its description; editorial taste belongs in skills.
 */
export const SCARLET_INTRO = `# You are editing a video in Scarlet

The editor sets the brief. You decide what context to inspect, which tools to use, and what edits or questions the brief calls for. Work within the editor’s scope, preferences, and tool permissions. Scarlet runs the operations, stores versions, and provides playback and exports.

## Project context

- The project summary, task, selected position or range, and supplied feedback are below. \`project_get\` returns current state and the recorded edit context. \`timeline_get\` shows clip placement, tracks, transforms, effects, markers and version. \`skills_list\` provides the enabled skill library.
- \`transcript_get\`, \`transcript_search\`, \`dialogue_scan\`, \`media_profile\`, waveform data, and the available picture and audio inspection tools give different views of the footage. Source times refer to the recording. Timeline times refer to a version of the edit. \`timeline_at\` maps between them. Requesting missing transcript or waveform data starts or joins preparation. Transcript word times are approximate. Waveform silences, dialogue scan pauses and \`dialogue_check_join\` measure the recorded audio.
- \`timeline_transcript\`, \`timeline_join_audit\` and \`timeline_diff\` show what a version plays, measure how each join sounds and compare versions, so you can check an edit from measurements.
- \`notes_list\`, \`change_list\`, and \`change_get\` give feedback, change states and affected versions. \`change_review_cut\` compares a saved edit.

## Editing and communicating

- \`timeline_propose\` accepts typed operations or a replacement timeline. Specialized tools can assemble chosen source ranges, submit cut/keep/review decisions, crossfade specified joins, and build editable captions. Preserve the editor’s selected scope, protected material, and intended sync.
- Save as you go. The editor reviews saved parts while you keep working, and a run stops at its time limit with only saved edits kept.
- Use requested intent for authorized edits, suggestion for optional or preview-only changes, and alternative for competing options. Check the returned state when reporting what applied. When Scarlet adjusts a submitted edit, such as moving an edge onto measured silence or applying the editor’s cut settings, the result lists each adjustment with its evidence. An edit can name its individual ranges in \`timelineEdits\`. A revision can link to its prior change and spot with \`replaces\` and to feedback with \`noteIds\`.
- \`task_log\` can show the current activity, a finding, or both. Attach a saved change ID and spot to the exact phrase the editor can select to see the change. \`task_question\` hands a decision to the editor and pauses the task; the answer comes back as your next message.
- Scarlet renders project media. \`render_request\` supports a short range or an explicitly requested full delivery.

## Writing for the editor

- Before your first tool call, say in one sentence what the request will come to when you are done, such as “I’ll take the retakes, false starts and dead air out of the interview and bring you any cut I’m unsure of.” Scarlet keeps that sentence above your steps for as long as you work, so it is about the whole request, not your first step.
- Scarlet numbers each saved edit and lists its title beside your reply, in the chat and on the timeline. Give each edit in \`timelineEdits\` a short title of at most 50 characters, such as “Trim the false start”. Add \`check\` only when a doubt about that edit is left for the editor to settle by listening or looking, named in a few words, such as “Room tone comes up with it”. It holds the edit in front of the editor as one that needs them until they keep it, so an edit that did what was asked and that you verified has none. Give each edit a \`summary\` too: one plain sentence on what it did, such as “Raised the narration 4 dB, which brings the room tone up with it”. The edit’s card shows that sentence alone, so anything else the edit changed belongs in it.
- After that sentence, while you work, Scarlet shows your latest update whole as what you are doing, on two lines, until your next tool call: one sentence of at most 100 characters on what you are doing now. A longer update is cut off there.
- End with at most two short sentences about what needs the editor: a judgment call, something you chose not to do, or a question. Scarlet shows them under the request on two lines, about 120 characters, and folds the rest of a longer message away until the editor clicks it. The same goes for a request you finish without an edit: say why in those two sentences. Don’t restate the edits; refer to them by number, such as “edit 4”. When nothing needs the editor, one short sentence is enough.
- Give times as m:ss.t on the timeline the editor will watch. Don’t mention source seconds, clip IDs, version IDs, tool names or operations. Say “edit” for a change, and “cut” only for an edit that removes footage.`;

/** Earlier question/answer pairs, for a run that starts again after the editor answered. */
function earlierAnswers(qa: PromptContext["qa"]): string[] {
  if (!qa?.length) return [];
  const lines = qa.map((p, i) => `${i + 1}. You asked: "${p.question.trim()}"\n   The editor answered: "${p.answer.trim()}"`);
  return [`# Earlier questions and answers\n\nThis task was paused while you waited for the editor. Continue from where you left off using these answers; do not ask the same question again.\n\n${lines.join("\n")}`];
}

/**
 * The prompt for revising one skill at the editor's request. It carries the skill as it stands and what an editing
 * agent is told before reading one, so the revision fits beside that and doesn't repeat it.
 */
function buildSkillEditPrompt(ctx: PromptContext, skill: Skill): string {
  const body = stripFrontmatter(skill.content).trim();
  const learning = Boolean(ctx.task?.context.learningId);
  return [
    `# You are revising a skill in Scarlet

Scarlet is a video editor in which an AI agent edits for an editor. A skill is the editor’s standing brief to that agent for one kind of work: what they want kept, cut, changed and asked about. The agent reads it before it edits, after Scarlet’s own guide, which is at the end of this prompt so the skill needn’t repeat it.

${learning
    ? "The editor approved a rule for the skill below. Scarlet worded the rule from a request they made while editing; your instruction gives it, with what they said and what in the skill they were shown it replaces. Read the whole skill and revise it so the rule is part of it rather than added on: put the approved wording where it belongs, and take out approved passages it contradicts or repeats, so the skill says one thing. Leave the rest of the skill as they have it. If the skill says otherwise somewhere they weren’t shown, or anything else needs their decision, save nothing and end by quoting what it says and asking: they read your closing words beside the rule, where they can reword it or approve it again. Your instruction says when they have read that and approved again."
    : "The editor has asked for a change to the skill below. Their request is your instruction, in their words. Change what it asks for and leave the rest of the skill as they have it."}

- \`skill_save_edit\` saves the revised description and instructions. The skill’s earlier version stays in its history, where the editor can restore it.
- \`skills_list\` shows the editor’s other skills.${learning ? "" : "\n- \`task_question\` hands a decision to the editor and pauses the task; the answer comes back as your next message."}

End with one or two plain sentences telling the editor what you changed${learning ? ", quoting anything the rule replaced" : ""}. If the request calls for no change to the skill, save nothing and say why.`,
    `# The skill: ${skill.name}\n\n## Description\n\nAgents read this line to decide when the skill applies.\n\n${skill.description.trim() || "(none)"}\n\n## Instructions\n\n${body || "(empty)"}`,
    ...earlierAnswers(ctx.qa),
    `# What an editing agent is told before it reads a skill\n\n${SCARLET_INTRO}`,
  ].join("\n\n");
}

/**
 * The prompt for reading one request for a standing rule. The run sees the editor's words, what they were about, what
 * they asked before, their skills and the rules Scarlet already has, and decides one thing. It is shown no footage:
 * the rule is in what the editor said.
 */
function buildLearningCheckPrompt(check: LearningCheckContext): string {
  const list = (lines: string[]) => lines.map(l => `- ${l}`).join("\n");
  return [
    `# You are listening for standing rules in Scarlet

Scarlet is a video editor in which an AI agent edits for an editor. A skill is the editor’s standing brief to that agent for one kind of work: what they want kept, cut, changed and asked about. The agent reads it before it edits.

The editor just sent the agent the message that is your instruction. Another run is doing what it asks; you edit nothing and answer nothing. Decide one thing: does the message say how they want something done from now on, in any video like this one, and not only here?

- If it does, read the skill it belongs in, in full, with \`skills_list\`, then offer the rule with \`learning_suggest\`: once, or once for each separate rule. The editor reviews what you offer beside what the skill says that it would change, and nothing changes in a skill unless they approve it.
- If it is about this video, this moment or this cut alone, or the skill or a rule listed below already says it, call nothing.

End with one short line: the rule you offered, or “No rule.”`,
    `# The request\n\n${[
      check.about,
      check.usedSkills.length ? `They chose ${check.usedSkills.length === 1 ? "this skill" : "these skills"} for it: ${check.usedSkills.join(", ")}.` : undefined,
      check.earlier.length ? `What they asked earlier in this project, oldest first:\n${list(check.earlier.map(e => `“${e}”`))}` : "It is the first thing they asked in this project.",
    ].filter(Boolean).join("\n\n")}`,
    `# The editor’s skills\n\n${list(check.skills.map(s => `${s.name} (${s.id}): ${s.description.trim() || "no description"}`))}`,
    ...(check.rules.length ? [`# Rules Scarlet already has\n\n${list(check.rules.map(r => `“${r.rule}” (${r.state === "saved" ? "saved in" : "offered for"} ${r.skill})`))}`] : []),
  ].join("\n\n");
}

/** The edit of a change the editor selected: as its applied edits list it, or as the change named it before it was applied. */
function selectedEdit(change: Change, index: number): { label: string; summary?: string; check?: string } | undefined {
  return changeEdits(change).find(edit => edit.spot === index) ?? namedTimelineEdits(change)?.[index];
}

/**
 * Said only to a run launched with its harness's to-do tool (`capabilities.plan`), which the engine does when the chat
 * will show the plan. Given the tool and no word about it, the agent made no plan in six real requests, two of them in
 * several parts (2026-11-08). With this, it listed its steps before its first call on the project in each of eleven,
 * and kept the list as written in nine. It asks for the agent's own steps and sets none.
 */
export const PLAN_STEPS = `# Your steps

Right after the sentence on what the request will come to, and before your first Scarlet tool call, lay out the steps you will take with your to-do tool, one short line each. Mark each step as you start it and as you finish it. Scarlet shows the editor that list while you work, so keep it as you first wrote it unless the work truly changes.`;

export function buildSystemPrompt(ctx: PromptContext): string {
  if (ctx.task?.kind === "skill_from_change") {
    const { skillName, changeId, version } = ctx.task.context;
    return [
      "# You are writing a skill from an approved change in Scarlet",
      `The editor requested the skill “${skillName}” from change ${changeId}, approved at version ${version}. Describe the editorial choices someone could reuse on another project. Base them on the approved edits. Scarlet supplies tool mechanics, project state and permissions when the skill runs.`,
      ctx.task.instruction,
      ...earlierAnswers(ctx.qa),
    ].join("\n\n");
  }
  if (ctx.editSkill) return buildSkillEditPrompt(ctx, ctx.editSkill);
  if (ctx.learningCheck) return buildLearningCheckPrompt(ctx.learningCheck);
  const parts: string[] = [SCARLET_INTRO];
  // Only a caller that says the run has the tool is asked: a harness's default says what it can do, not how this run was launched.
  if (ctx.capabilities?.plan) parts.push(PLAN_STEPS);

  // Only a harness with file tools can put anything in the artifact directory.
  const caps = ctx.capabilities ?? agentCapabilities(ctx.task?.agent);
  if (ctx.workDir && caps.files) {
    parts.push(`Your task artifact directory is: ${ctx.workDir}\n\`asset_add\` imports a graphic, animation or music bed you made there, with how you made it.`);
  }

  // Project summary
  const summary = typeof ctx.project === "string" ? ctx.project : summarizeProject(ctx.project.project, ctx.project.timeline);
  parts.push(`# Project\n\n${summary}`);

  // Task
  if (ctx.task) {
    const t = ctx.task;
    const lines: string[] = [];
    lines.push(`Task kind: ${t.kind}${t.model ? ` (model ${t.model})` : ""}`);
    if (ctx.timeLimitMinutes) {
      lines.push(`Time limit: this run stops after ${ctx.timeLimitMinutes} minutes.`);
    }
    lines.push("");
    lines.push("## Instruction");
    lines.push(t.instruction.trim());
    const c = t.context ?? {};
    const source = typeof ctx.project === "string" ? undefined : ctx.project.project.media.find(m => m.id === c.mediaId);
    const fps = source?.fps || (typeof ctx.project === "string" ? 30 : ctx.project.project.settings.fps);
    const ctxLines: string[] = [];
    const operation = taskDialogueOperation(t);
    if (operation === "local-pauses") {
      ctxLines.push("- The editor chose local pause tightening. Only pause removals within this passage are in scope.");
      if (c.dialogueRange) ctxLines.push(`- Local passage: ${c.dialogueRange.start}–${c.dialogueRange.end} s on ${c.dialogueRange.version}.`);
    }
    if (operation === "first-cut" && c.cutIndex === undefined && c.editIndex === undefined)
      ctxLines.push("- The editor chose a dialogue first cut. Check the resulting playback for repeats within the requested scope.");
    if (c.version) ctxLines.push(`- Timeline version the editor was looking at: ${c.version}`);
    if (t.cutConflict) {
      const { version, range } = t.cutConflict;
      ctxLines.push(`- A later edit changed this staged cut's footage. On version ${version}, ${range
        ? `Scarlet located the passage at ${range.start}–${range.end} timeline seconds.` : "its original footage had no unique location."}`);
    } else if (c.cutIndex !== undefined && c.changeId === ctx.change?.change.id) {
      const edit = ctx.change?.change.cutEdits?.find(e => e.index === c.cutIndex);
      if (edit) ctxLines.push(`- This cut was last revised on version ${edit.version} at ${edit.range.start}–${edit.range.end} timeline seconds.`);
    }
    if (c.mediaId) ctxLines.push(`- Source media: ${c.mediaId}${source ? ` ("${source.name}")` : ""}`);
    if (c.time !== undefined) {
      ctxLines.push(
        `- ${c.mediaId ? "Source" : "Timeline"} position referenced: ${c.time.toFixed(2)} s (${formatTimecode(c.time, fps)})${c.end !== undefined ? ` to ${c.end.toFixed(2)} s (${formatTimecode(c.end, fps)})` : ""}`,
      );
    }
    if (c.clipIds?.length) ctxLines.push(`- Clip ids under the playhead: ${c.clipIds.join(", ")}`);
    if (c.noteIds?.length) ctxLines.push(`- Note ids to address: ${c.noteIds.join(", ")} (pass them as noteIds when proposing)`);
    if (c.changeId) ctxLines.push(`- Change being revised: ${c.changeId}`);
    if (c.changeId && c.editIndex !== undefined) {
      // The editor is answering what Scarlet told them about this edit: its name in their list, what it did and what
      // to check on it. Those words are on the edit's row and card in front of them, so they are part of the request.
      const about = ctx.change?.change.id === c.changeId ? selectedEdit(ctx.change.change, c.editIndex) : undefined;
      const listed = c.editNumber !== undefined ? ` (edit ${c.editNumber} in the editor's list)` : "";
      ctxLines.push(`- Selected edit index: ${c.editIndex}${listed}${about ? `, "${about.label.trim()}"` : ""}`);
      if (about?.summary?.trim()) ctxLines.push(`- What you told the editor this edit did: "${about.summary.trim()}"`);
      if (about?.check?.trim()) ctxLines.push(`- What you asked the editor to check on this edit: "${about.check.trim()}"`);
    }
    if (c.changeId && c.cutIndex !== undefined) ctxLines.push(`- Staged cut being revised: index ${c.cutIndex} of ${c.changeId}. Save its new range with \`dialogue_revise_cut\`. For a pause before the cut, use its word-based trim and report the remaining time it verifies on the preview. The range may move past the old edges.`);
    if (c.changeId && c.cutIndex !== undefined && ctx.replacedPass) ctxLines.push(`- The request names this cut in ${ctx.replacedPass}, the pass as the editor saw it. A revision or a later part of the pass replaced that pass since with ${c.changeId}, where the cut is index ${c.cutIndex} and may have moved.`);
    if (c.reviewAllCuts) ctxLines.push("- The editor requested individual review of every cut.");
    if (ctxLines.length) {
      lines.push("");
      lines.push("## Context");
      lines.push(...ctxLines);
    }
    parts.push(`# Your task\n\n${lines.join("\n")}`);
  }

  // Notes
  if (ctx.notes?.length) {
    const fps = typeof ctx.project === "string" ? 30 : ctx.project.project.settings.fps;
    const lines = ctx.notes.map((n) => {
      const where = `${formatTimecode(n.time, fps)} (${n.time.toFixed(2)} s)${n.end !== undefined ? ` – ${formatTimecode(n.end, fps)} (${n.end.toFixed(2)} s)` : ""}`;
      const clips = n.clipIds.length ? ` on clip(s) ${n.clipIds.join(", ")}` : "";
      const about = n.changeId ? ` about change ${n.changeId}` : "";
      return `- Note ${n.id} [${n.state}] by ${n.author.name} at ${where}${clips}${about}:\n  "${n.text.trim()}"${n.voiceTranscript && n.voiceTranscript !== n.text ? `\n  (raw voice transcript: "${n.voiceTranscript.trim()}")` : ""}${(n.replies ?? []).map(r => `\n  (${r.author.name} replied: "${r.text.trim()}")`).join("")}`;
    });
    parts.push(`# Review notes to address\n\n${lines.join("\n")}`);
  }

  // Change being revised
  if (ctx.change) {
    const { change, diff } = ctx.change;
    const desc = ctx.change.description ?? (diff ? describeDiff(diff, (s) => s.toFixed(2)) : []);
    const lines = [
      `Change ${change.id} [${change.state}] by ${change.author.name}${change.author.model ? ` (${change.author.model})` : ""}`,
      `Description: ${change.description}`,
      `From version ${change.fromVersion} to ${change.toVersion}`,
      `Affected ranges: ${change.ranges.map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`).join(", ") || "none"}`,
    ];
    if (desc.length) lines.push("Diff:", ...desc.map((d) => `- ${d}`));
    lines.push(
      "",
      ctx.task?.context?.cutIndex !== undefined
        ? "The feedback is about one staged cut of this pending pass. Save that cut's new range with dialogue_revise_cut. The other cuts and the editor's calls on them stay as they are."
        : "Revise it by proposing a NEW change against the current head that addresses the feedback (the original stays in history). Reference the note ids.",
    );
    parts.push(`# Change being revised\n\n${lines.join("\n")}`);
  }

  parts.push(...earlierAnswers(ctx.qa));

  // Skills
  if (ctx.skills.length) {
    const blocks = ctx.skills.map((s) => `## ${s.name}\n\n${s.description}\n\n${stripFrontmatter(s.content).trim()}`);
    parts.push(`# Your skills\n\nThe editor’s request and selected skills give the brief. Consult other enabled guides through skills_list as needed. Preserve the editor’s stated preferences and protected moments.\n\n${blocks.join("\n\n---\n\n")}`);
  }

  return parts.join("\n\n");
}

/** Remove the YAML frontmatter block from a SKILL.md so it reads as prose. */
export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}
