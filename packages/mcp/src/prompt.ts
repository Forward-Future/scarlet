/**
 * System prompt given to the editor's CLI (Claude Code / Codex / Gemini) when
 * Scarlet runs it headlessly. Explains how Scarlet works, states the task,
 * provides context (timestamps, clip ids, notes, the change being revised)
 * and includes the applicable skills verbatim.
 */
import { CHECK_IN_SHARE, taskDialogueOperation, agentCapabilities, changeEdits, namedTimelineEdits, skillExtends, type AgentCapabilities, type CheckIn, type PictureMark, type Skill, type Task } from "@scarlet/shared";
import type { Change, Note, Project, Timeline, TimelineDiff } from "@scarlet/timeline";
import { clipById, describeDiff, formatTimecode } from "@scarlet/timeline";
import { summarizeProject } from "./analysis.js";

/** What a learning check is shown about the request it reads. */
export interface LearningCheckContext {
  /** The editor's words, as they said them. */
  said: string;
  /** What the words were about, when they were aimed at a cut, an edit or a moment. */
  about?: string;
  /** Skills the editor chose for the request. */
  usedSkills: string[];
  /** What they asked before, in any project, oldest first: their words, what they were aimed at, and whether it was in another video. */
  earlier: Array<{ said: string; about?: string; elsewhere?: boolean }>;
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
  /** What an area_check task looks at. Such a task edits no video, so its prompt is about one frame. */
  areaCheck?: { mediaId: string; at: number };
  /** The editor's setting for how many of a pass's cuts they are asked to check. Omitted = balanced. */
  checkIn?: CheckIn;
  /** Directory the agent may use for temp files; mentioned in the prompt. */
  workDir?: string;
  /** How long the host lets this run take, in minutes. Omitted when the host doesn't say. */
  timeLimitMinutes?: number;
  /** What the running harness delivers to the model (see agentCapabilities). Omitted = conservative defaults. */
  capabilities?: AgentCapabilities;
  /** Files the editor attached to this request, where they are on disk. */
  attachments?: Array<{ id: string; name: string; size: number; mime?: string; path: string }>;
  /** The project's style guide: pasted text in full, or the file it is in. */
  styleGuide?: { name: string; text?: string; path?: string; mime?: string };
}

/** A size the editor reads, for a file. */
function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const FILE_KINDS: Array<[RegExp, string]> = [[/pdf/, "PDF"], [/^image\//, "image"], [/^font\/|ttf|otf|woff/, "font file"], [/^text\/|json/, "text"]];
const fileKind = (mime: string | undefined, name: string) => FILE_KINDS.find(([test]) => test.test(mime ?? "") || test.test(name.toLowerCase()))?.[1] ?? "file";

/** The project's style guide, as the editor gave it. */
function styleGuideSection(guide: NonNullable<PromptContext["styleGuide"]>): string {
  const lines = [`# Style guide\n\nThe editor gave this project a style guide, "${guide.name}", for every graphic made in it.`];
  if (guide.path) lines.push(`It is in the ${fileKind(guide.mime, guide.path)} at ${guide.path}.`);
  if (guide.text?.trim()) lines.push(guide.path ? `What they wrote with it:\n\n${guide.text.trim()}` : guide.text.trim());
  return lines.join("\n\n");
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
- Use requested intent for authorized edits, suggestion for optional or preview-only changes, and alternative for competing options. Check the returned state when reporting what applied. When Scarlet adjusts a submitted edit, such as moving an edge onto measured silence, the result lists each adjustment with its evidence. An edit can name its individual ranges in \`timelineEdits\`. A revision can link to its prior change and spot with \`replaces\` and to feedback with \`noteIds\`.
- \`task_log\` can show the current activity, a finding, or both. Attach a saved change ID and spot to the exact phrase the editor can select to see the change. \`task_question\` hands a decision to the editor and pauses the task; the answer comes back as your next message.
- Scarlet renders project media. \`render_request\` supports a short range or an explicitly requested full delivery.
- A motion graphic is an HTML/CSS page Scarlet draws into a video with alpha (\`graphic_render\`). It goes over the picture on a track of its own with \`timeline_propose\`, as an edit like any other. A project has one style guide, saved with \`style_guide_save\` when the editor gives you one.

## Writing for the editor

- Before your first tool call, say in one sentence what the request will come to when you are done, such as “I’ll take the retakes, false starts and dead air out of the interview and bring you any cut I’m unsure of.” Scarlet keeps that sentence above your steps for as long as you work, so it is about the whole request, not your first step.
- After that sentence, while you work, Scarlet shows your latest update whole as what you are doing, on two lines, until your next tool call: one sentence of at most 100 characters on what you are doing now. A longer update is cut off there.
- Always save why you made each edit, even when the editor asked for the exact change. Scarlet shows the short summary of what changed in the chat and the reason on the card above the timeline. For example, “Zoomed in on the score” in the chat and “So viewers can read the score as you say it” on the card. Ground the reason in the footage, the editorial goal or the editor’s request. For an exact request, a short reference to that request is enough. Write the reason as you would say it to the editor beside them: everyday words, “you” for them, what they will hear named by the words said (“your first try”, “the second time you say it”), never your own terms for the footage (delivery, take, start, surviving, edge, join). For a cut that waits on them, say in one or two short sentences what you chose and what might make them choose otherwise: “Your second try says the whole thing, so I took out the first. The first makes it clearer the model did the bug squash, so check the second still does.”, not “The second line gives the full task. Check who does the bug pass in the surviving delivery.” Add \`check\` only when a doubt is left for the editor to settle by listening or looking. Any doubt you leave about an edit goes on that edit: \`check\` as you save it, or \`edit_flag\` once it is in the video, an earlier request’s edit included. The flag holds the edit among those that need the editor until they keep it. A doubt about something you leave in, such as a restart that may not be meant, reaches the editor the same way, as an edit they can approve or skip: in a dialogue pass, a cut staged for review.
- End with one or two short, plain sentences that sum up at the highest level what you did to the video, as you would tell the editor in person, such as “Tightened the talk to 10:29 and punched in on each demo.” Scarlet shows them first under the request, on two lines of about 120 characters, and folds the rest away until the editor clicks. Nothing you want the editor to look at, listen to or decide goes in them: they reach what needs them from For you, which lists edits only, so each doubt goes on its edit (\`check\` or \`edit_flag\`) and a decision you need goes to \`task_question\`. No times, edit numbers or lists. A request you finish without an edit says why in those sentences.
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
/**
 * One frame, one question. A pass asked to find the window while it framed a whole video answered in bulk from small
 * pictures and took a browser's edge for the app's; asked this about one full-size frame, the same model boxed the
 * window to a fifth of a percent (2026-11-16).
 */
function buildAreaCheckPrompt(check: { mediaId: string; at: number }, prefix: string): string {
  return [
    "# You are looking at one frame of a screen recording for Scarlet, a video editor",
    `Look at the frame of recording \`${check.mediaId}\` at ${check.at} s: call \`${prefix}media_frame\` with \`t\` ${check.at} and \`width\` 1920. Call it yourself and look at the picture it returns.`,
    "The recording was made for a video. The presenter is showing viewers one application window. Other things are on screen too: the desktop, a taskbar or dock, a recording app, a video call, other windows behind it, and bars or controls that float over it.",
    "Decide the box that holds only the window being presented, so that nothing else shows when the video is cropped to it. For a web browser, that is the page, without its tabs and toolbars. Where the window runs off the picture, the box ends at the picture's edge. When the whole picture is what viewers should see (a camera, a full-screen app), the box is the whole picture.",
    `Save it with \`${prefix}screen_area\`: one area in \`set\`, at ${check.at}, for \`${check.mediaId}\`, as [left, top, right, bottom] in percent of the picture to one decimal place, with \`pictures\` 0. Then stop: no other frames, no edits, no reply beyond a few words naming the window.`,
  ].join("\n\n");
}

function buildLearningCheckPrompt(check: LearningCheckContext): string {
  const list = (lines: string[]) => lines.map(l => `- ${l}`).join("\n");
  return [
    `# You are listening for standing rules in Scarlet

Scarlet is a video editor in which an AI agent edits for an editor. A skill is the editor’s standing brief to that agent for one kind of work: what they want kept, cut, changed and asked about. The agent reads it before it edits.

The editor just sent the agent the message that is your instruction. Another run is doing what it asks; you edit nothing and answer nothing. Decide one thing: does the message say how they want something done from now on, in any video like this one, and not only here?

It does in only two cases:
- They said it as a rule themselves: their words are about every video or every time (“always”, “never”, “from now on”, how they like their videos), not about this one.
- The same kind of fix keeps coming back: at least two of their earlier requests below asked for the same kind of change to what a skill made as this one does. That fix is how they want the skill to work. Offer it for that skill and name the requests it comes from.

Anything else is not a rule, so call nothing: a note about this video, this moment or this cut that hasn’t come up before, however general it could be made; a rule the skill or a rule listed below already says, in any wording; and a rule that only tells the agent to do its work well (check, play back, adjust as needed) without saying what the editor wants.

When it is a rule, read the skill it belongs in, in full, with \`skills_list\`, then offer it with \`learning_suggest\`: once, or once for each separate rule. The editor reviews what you offer beside what the skill says that it would change, and nothing changes in a skill unless they approve it.

A rule is for every video the skill edits, so write the principle behind what they said, not its instances: no words, names, times or moments from this video or the requests, and a number they gave stays a guide, not a fixed amount. If what they asked can't be put that way, it isn't a rule.

End with one short line: the rule you offered, or “No rule.”`,
    `# The request\n\n${[
      check.about,
      check.usedSkills.length ? `They chose ${check.usedSkills.length === 1 ? "this skill" : "these skills"} for it: ${check.usedSkills.join(", ")}.` : undefined,
      check.earlier.length ? `What they asked before, oldest first:\n${list(check.earlier.map(e => `“${e.said}”${[e.about && `about ${e.about}`, e.elsewhere && "in another video"].filter(Boolean).map(w => ` (${w})`).join("")}`))}` : "It is the first thing they asked.",
    ].filter(Boolean).join("\n\n")}`,
    `# The editor’s skills\n\n${list(check.skills.map(s => `${s.name} (${s.id}): ${s.description.trim() || "no description"}`))}`,
    ...(check.rules.length ? [`# Rules Scarlet already has\n\n${list(check.rules.map(r => `“${r.rule}” (${r.state === "saved" ? "saved in" : "offered for"} ${r.skill})`))}`] : []),
  ].join("\n\n");
}

/** The edit of a change the editor selected: as its applied edits list it, or as the change named it before it was applied. */
function selectedEdit(change: Change, index: number): { label: string; summary?: string; reason?: string; check?: string } | undefined {
  const edit = changeEdits(change).find(edit => edit.spot === index) ?? namedTimelineEdits(change)?.[index];
  // A later request may have raised a doubt about it once it was in the video: that is the check the editor saw last.
  const flag = change.flags?.findLast(f => f.spot === index);
  return edit && flag ? { ...edit, check: flag.check } : edit;
}

/**
 * Said only to a run launched with its harness's to-do tool (`capabilities.plan`), which the engine does when the chat
 * will show the plan. Given the tool and no word about it, the agent made no plan in six real requests, two of them in
 * several parts (2026-11-08). With this, it listed its steps before its first call on the project in each of eleven,
 * and kept the list as written in nine. It asks for the agent's own steps and sets none.
 */
export const PLAN_STEPS = `# Your steps

Right after the sentence on what the request will come to, and before your first Scarlet tool call, lay out the steps you will take with your to-do tool, one short line each. Mark each step as you start it and as you finish it. Scarlet shows the editor that list while you work, so keep it as you first wrote it unless the work truly changes.`;

/** How many clips a prompt lists one by one before it lists only those near the request's position. */
const PROMPT_CLIPS = 40;

/** The timeline seconds a request points at: the stretch marked, or the position or range given with it. */
function requestRange(task: PromptContext["task"]): { start: number; end: number } | undefined {
  const c = task?.context;
  if (!c) return undefined;
  const points = [
    ...(c.markedRange && !c.markedRange.mediaId ? [c.markedRange.start, c.markedRange.end] : []),
    ...(!c.mediaId && c.time !== undefined ? [c.time, c.end ?? c.time] : []),
  ];
  return points.length ? { start: Math.min(...points), end: Math.max(...points) } : undefined;
}

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
  if (ctx.areaCheck) return buildAreaCheckPrompt(ctx.areaCheck, ctx.capabilities?.toolPrefix ?? "");
  const parts: string[] = [SCARLET_INTRO];
  // Only a caller that says the run has the tool is asked: a harness's default says what it can do, not how this run was launched.
  if (ctx.capabilities?.plan) parts.push(PLAN_STEPS);

  // Only a harness with file tools can put anything in the artifact directory.
  const caps = ctx.capabilities ?? agentCapabilities(ctx.task?.agent);
  if (ctx.workDir && caps.files && caps.shell) {
    // A request launched with its harness's own tools. What to use them for is the model's call; that B-roll and graphics
    // are the editor's to ask for is the editor's standing word (2026-11-21), said here once.
    parts.push(`Your task artifact directory is: ${ctx.workDir}\nBeside Scarlet's tools you have your harness's own: a shell, sandboxed to this task's folder, with ffmpeg and ffprobe on its PATH where this machine has them, file tools${caps.web ? ", and web search" : ""}. Use them for what Scarlet's tools don't give: a file built for the edit, something looked up. \`web_capture\` takes the picture of a page on the web, \`graphic_render\` draws a page you write, and \`asset_add\` brings a finished file into the project, with \`source\` for anything taken from the web. The project's footage and the video are read through Scarlet's tools: the shell can't reach them. B-roll and graphics are made when the editor asked for them, in their words or in a skill of theirs, never on your own initiative.`);
  } else if (ctx.workDir && caps.files) {
    parts.push(`Your task artifact directory is: ${ctx.workDir}\n\`asset_add\` imports a graphic, animation or music bed you made there, with how you made it.`);
  }

  if (caps.toolPrefix) {
    parts.push(`This harness prefixes Scarlet’s tool names with \`${caps.toolPrefix}\`. For example, call \`${caps.toolPrefix}project_get\` when a skill names \`project_get\`.`);
  }

  // Project summary. A long timeline lists only the clips near where the request points, if it points anywhere.
  const summary = typeof ctx.project === "string" ? ctx.project : summarizeProject(ctx.project.project, ctx.project.timeline, { most: PROMPT_CLIPS, near: requestRange(ctx.task) });
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
    if (operation === "first-cut" && c.cutIndex === undefined && c.editIndex === undefined) {
      ctxLines.push("- The editor chose a dialogue first cut. Check the resulting playback for repeats within the requested scope.");
      // A pass names no doubt of its own: asked how sure it was of each cut, one called all twelve certain, two of them
      // mistakes the editor had reported on that footage. It is not unsure of those cuts, so the question finds nothing.
      // Asked to order its cuts by how likely each is to be wrong, it leaves the plain false starts at the bottom: on
      // 4.5 minutes of that recording, three passes flagged 2 or 3 of about ten word cuts at one in four, one of the two
      // mistakes among them in two passes, and a pass at half flagged five, both among them (2026-11-18). So the order
      // is the model's, and how far down it the editor is asked to look is their setting.
      // Once, in the run that made the cuts. The closing check that may follow runs in a fresh session with no memory of
      // that order: asked again, it flagged a second share of the same cuts, 27-60% of the word cuts on three passes at
      // "about one in four" (2026-11-20). Its own doubts it stages as any run does.
      if (!t.repeatAudit?.returns) ctxLines.push(`- Before the pass is done, read back what the video plays where your cuts took words out, and order those cuts from the most likely to be wrong to the least: a cut is wrong when the editor, hearing the result, would put words back, take more out or choose the other delivery. The editor asked to check ${CHECK_IN_SHARE[ctx.checkIn ?? "balanced"]} of them: flag that many from the top of your order, each with what could be wrong. A cut you already flagged or staged for them counts.`);
      // A repeat kept with dialogue_check_repeats plays on and is never shown to the editor. Across his ten edits of
      // 2026-11-20, 9 of 10 passes kept 7-30 listed repeats each, plain restarts among them ("Gemini four and | Gemini
      // four just came out", kept as "the first use names the model family"), while 1 of 166 phrases playing twice was
      // never listed. Each run orders only the repeats it keeps itself, so a later run doesn't stage a second share.
      ctxLines.push(`- Order the repeats dialogue_check_repeats lists that you would keep, from the most likely to be a restart or a retake the editor would take out to the least. Stage ${CHECK_IN_SHARE[ctx.checkIn ?? "balanced"]} of them from the top with removeRepeat and decision review, so the editor decides them, and keep the rest with your reason.`);
    }
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
    // A stretch marked with nothing open is already the position above. Marked with a cut or an edit open, it is said
    // besides it: the editor chose both, and which the request means is theirs to say.
    const marked = c.markedRange;
    if (marked && !(marked.start === c.time && marked.end === c.end)) {
      ctxLines.push(`- Stretch the editor marked on the ${marked.mediaId ? "source" : "timeline"}: ${marked.start.toFixed(2)} s (${formatTimecode(marked.start, fps)}) to ${marked.end.toFixed(2)} s (${formatTimecode(marked.end, fps)})${marked.version ? ` on version ${marked.version}` : ""}`);
    }
    // The editor paused the video with the cut or edit open, and wrote while stopped there: the frame is on the timeline
    // the player showed them, which may not be the edit's version.
    const stopped = c.messageTime;
    if (stopped && c.changeId) {
      ctxLines.push(`- Where the editor stopped the video as they wrote this: ${stopped.mediaId ? "source" : "timeline"} ${stopped.time.toFixed(2)} s (${formatTimecode(stopped.time, fps)})${stopped.version ? ` on version ${stopped.version}` : ""}`);
    }
    if (c.clipIds?.length) ctxLines.push(`- Clip ids under the playhead: ${c.clipIds.join(", ")}`);
    if (c.noteIds?.length) ctxLines.push(`- Note ids to address: ${c.noteIds.join(", ")} (pass them as noteIds when proposing)`);
    if (c.changeId) ctxLines.push(`- Change being revised: ${c.changeId}`);
    if (c.changeId && c.editIndex !== undefined) {
      // The editor sees what changed in the chat and why on the card, along with any review check.
      const about = ctx.change?.change.id === c.changeId ? selectedEdit(ctx.change.change, c.editIndex) : undefined;
      const listed = c.editNumber !== undefined ? ` (edit ${c.editNumber} in the editor's list)` : "";
      ctxLines.push(`- Selected edit index: ${c.editIndex}${listed}${about ? `, "${about.label.trim()}"` : ""}`);
      if (about?.summary?.trim()) ctxLines.push(`- What you told the editor this edit did: "${about.summary.trim()}"`);
      if (about?.reason?.trim()) ctxLines.push(`- Why you made this edit: "${about.reason.trim()}"`);
      if (about?.check?.trim()) ctxLines.push(`- What you asked the editor to check on this edit: "${about.check.trim()}"`);
    }
    // The editor looked at a moment of the list, where edits that overlap play as one change, and wrote about all of it.
    if (c.momentEdits?.length) {
      const others = c.momentEdits.map(e => `edit index ${e.spot} of ${e.changeId}${e.label?.trim() ? ` ("${e.label.trim()}")` : ""}`).join("; ");
      ctxLines.push(`- The editor's words are about the whole moment this edit is in, which plays as one change and also has: ${others}. Which of them the words mean is for you to work out.`);
    }
    if (c.changeId && c.cutIndex !== undefined) ctxLines.push(`- Staged cut being revised: index ${c.cutIndex} of ${c.changeId}. \`dialogue_revise_cut\` saves its new range.`);
    if (c.changeId && c.cutIndex !== undefined && ctx.replacedPass) ctxLines.push(`- The request names this cut in ${ctx.replacedPass}, the pass as the editor saw it. A revision or a later part of the pass replaced that pass since with ${c.changeId}, where the cut is index ${c.cutIndex} and may have moved.`);
    if (c.reviewAllCuts) ctxLines.push("- The editor requested individual review of every cut.");
    for (const file of ctx.attachments ?? []) {
      ctxLines.push(`- File the editor attached: "${file.name}" (${fileKind(file.mime, file.name)}, ${fileSize(file.size)}), attachment ${file.id}, at ${file.path}`);
    }
    // What the editor drew on the picture. What the marks are for is in their words, for the model to read.
    const drawn = c.pictureMarks;
    if (drawn) {
      const picture = ctx.attachments?.find(a => a.id === drawn.attachmentId);
      const where = `${drawn.mediaId ? "source" : "timeline"} ${drawn.time.toFixed(2)} s (${formatTimecode(drawn.time, fps)})${drawn.version ? ` on version ${drawn.version}` : ""}`;
      ctxLines.push(`- The editor drew ${drawn.marks.length === 1 ? "a mark" : `${drawn.marks.length} numbered marks`} on the picture at ${where}, in fractions of the frame from its top left: ${drawn.marks.map((m, i) => pictureMarkLine(m, i + 1, drawn.marks.length > 1)).join("; ")}.` +
        (picture ? ` The frame with the marks drawn on it is attachment ${picture.id} ("${picture.name}").` : ""));
    }
    if (ctxLines.length) {
      lines.push("");
      lines.push("## Context");
      lines.push(...ctxLines);
    }
    parts.push(`# Your task\n\n${lines.join("\n")}`);
  }

  if (ctx.styleGuide) parts.push(styleGuideSection(ctx.styleGuide));

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
    const desc = ctx.change.description ?? (diff ? describeDiff(diff, undefined, clipById) : []);
    const lines = [
      `Change ${change.id} [${change.state}] by ${change.author.name}${change.author.model ? ` (${change.author.model})` : ""}`,
      `Description: ${change.description}`,
      ...(change.reason?.trim() && ctx.task?.context?.editIndex === undefined ? [`Reason: ${change.reason.trim()}`] : []),
      `From version ${change.fromVersion} to ${change.toVersion}`,
      `Affected ranges: ${change.ranges.map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`).join(", ") || "none"}`,
    ];
    // A request about one staged cut has that cut's range above: the whole pass's diff is not what it is about.
    if (desc.length && ctx.task?.context?.cutIndex === undefined) lines.push("Diff:", ...desc.map((d) => `- ${d}`));
    lines.push(
      "",
      ctx.task?.context?.cutIndex !== undefined
        ? "The feedback is about one staged cut of this pending pass."
        : "Revise it by proposing a NEW change against the current head that addresses the feedback (the original stays in history). Reference the note ids.",
    );
    parts.push(`# Change being revised\n\n${lines.join("\n")}`);
  }

  parts.push(...earlierAnswers(ctx.qa));

  // Skills
  if (ctx.skills.length) {
    const blocks = ctx.skills.map((s) => {
      const bases = skillExtends(s).filter(base => ctx.skills.some(o => o.name === base));
      const named = bases.length > 1 ? `${bases.slice(0, -1).join(", ")} and ${bases.at(-1)}` : bases[0];
      // A guide the skill calls by name is in the prompt whether or not this request needs it, such as one the skill
      // keeps for when the editor asks: the skill's own words say when each applies.
      const layered = !named ? "" : `\n\nThis builds on ${named}, above${/(?:^|[\s(])\/[a-z0-9]/im.test(stripFrontmatter(s.content)) ? ", and calls each as /name where it applies, with what it changes beside the call" : ""}. Where ${bases.length > 1 ? "it and one of them" : "the two"} differ, follow this one.`;
      return `## ${s.name}\n\n${s.description}${layered}\n\n${stripFrontmatter(s.content).trim()}`;
    });
    parts.push(`# Your skills\n\nThe editor’s request and selected skills give the brief. Consult other enabled guides through skills_list as needed. Preserve the editor’s stated preferences and protected moments.\n\n${blocks.join("\n\n---\n\n")}`);
  }

  return parts.join("\n\n");
}

/** Remove the YAML frontmatter block from a SKILL.md so it reads as prose. */
export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

const fraction = (n: number) => n.toFixed(2);
/** One mark the editor drew, as the prompt says it: what it is and the stretch of the frame it covers. */
function pictureMarkLine(mark: PictureMark, n: number, numbered: boolean): string {
  const { x, y, w, h } = mark.box;
  const name = numbered ? `mark ${n}, ` : "";
  if (mark.kind === "point") return `${name}a point at ${fraction(x)} across, ${fraction(y)} down`;
  const span = `${fraction(x)}–${fraction(x + w)} across and ${fraction(y)}–${fraction(y + h)} down`;
  return mark.kind === "box" ? `${name}a box over ${span}` : `${name}a line drawn by hand over ${span}`;
}
