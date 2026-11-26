/**
 * System prompt given to the editor's CLI (Claude Code / Codex / Gemini) when
 * Scarlet runs it headlessly. Explains how Scarlet works, states the task,
 * provides context (timestamps, clip ids, notes, the change being revised)
 * and includes the applicable skills verbatim.
 */
import { BUILT_IN_STYLE_SOUNDS, CHECK_IN_SHARE, taskDialogueOperation, agentCapabilities, changeEdits, namedTimelineEdits, skillExtends, type AgentCapabilities, type CheckIn, type PictureMark, type Skill, type StyleGuideColorLook, type StyleGuideRecord, type StyleGuideSound, type StyleGuideTransition, type Task } from "@scarlet/shared";
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
  /** The check started as the editor finished deciding what the request left them, to read their decisions; not as they sent it. */
  readsDecisions?: boolean;
  /**
   * What the editor decided lately on cuts and edits Scarlet made, in any project, oldest first: the id a rule cites it
   * by, Keep, Reject or a revision with their words, what the cut or edit was, what Scarlet measured and why it made it,
   * the skills that made it, and the rule already offered from it.
   */
  decided?: Array<{ id: string; decision: "kept" | "rejected" | "revised"; label: string; details?: string[]; note?: string;
    madeBy?: string[]; elsewhere?: boolean; ruleFrom?: string }>;
  /** Rules already offered to the editor, saved in a skill or declined by them, oldest first. */
  rules: Array<{ rule: string; skill: string; state: "offered" | "saved" | "declined" }>;
  /** The editor's skills a rule can go into. */
  skills: Array<{ id: string; name: string; description: string }>;
}

/** One earlier request of the project's chat, as the editor read it. */
export interface EarlierRequest {
  /** The editor's words. */
  asked: string;
  /** The latest things Scarlet showed the editor while it worked, in order. */
  told?: string[];
  /** The latest questions Scarlet asked the editor, with their answers. */
  answers?: Array<{ question: string; answer: string }>;
  /** Scarlet's closing words. */
  replied?: string;
  /** The edits the request saved, each with its state. */
  edits?: string[];
  /** Where the request stands when it hasn't finished: waiting, running or stopped early. */
  standing?: string;
}

export interface PromptContext {
  /** The project (settings + media) and its head timeline, or a pre-rendered summary string. */
  project: { project: Project; timeline: Timeline | null } | string;
  /** The task being run (instruction, kind, context). Optional for one-shot runs. */
  task?: Pick<Task, "instruction" | "kind" | "context" | "agent" | "model"> & Partial<Task>;
  /** Review notes the task responds to. */
  notes?: Note[];
  /** How many review notes are open in the project, for a request that names none: zero spares a turn listing them. */
  openNotes?: number;
  /** Change being revised, with its diff. */
  change?: { change: Change; diff?: TimelineDiff; description?: string[] };
  /** The pass a request about one staged cut named, when revisions or later parts of the pass have replaced it with `change` since it was sent. */
  replacedPass?: string;
  /** Earlier question/answer pairs when the task was paused and resumed. */
  qa?: Array<{ question: string; answer: string }>;
  /**
   * The project's latest earlier requests, oldest first, each with what Scarlet told the editor. The chat shows them as
   * one conversation, so the editor's words may refer to any of them.
   */
  earlier?: EarlierRequest[];
  skills: Skill[];
  /** The skill a skill_edit task revises. Such a task edits no video, so its prompt is about the skill alone. */
  editSkill?: Skill;
  /** The style guide a style_guide_edit task designs or updates. Edits no video. */
  editStyleGuide?: {
    guide: StyleGuideRecord;
    assets: Array<{ id: string; name: string; size: number; mime?: string; path: string }>;
    attachedIds?: string[];
    hasPreview: boolean;
    earlier?: Array<{ asked: string; replied?: string }>;
  };
  /** What a learning_check task reads. Such a task edits no video, so its prompt is about the request alone. */
  learningCheck?: LearningCheckContext;
  /** What an area_check task looks at. Such a task edits no video, so its prompt is about one frame. */
  areaCheck?: { mediaId: string; at: number };
  /** What a listen_check task hears for a request whose model can't. Such a task edits no video, so its prompt is about one passage. */
  listenCheck?: { mediaId: string; from: number; to: number; voice?: "me" | "other voices"; question: string };
  /** A grouped batch of edits to summarize into one short title for the edits rail. */
  batchSummary?: { key: string; prompt: string };
  /** The editor's setting for how many of a pass's cuts they are asked to check. Omitted = balanced. */
  checkIn?: CheckIn;
  /** The editor's own words, from Settings, on how Scarlet writes to them. Omitted or empty = nothing added. */
  talkingToYou?: string;
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
  /** Library-wide style guides active for this request (via @name mention or the library Default). */
  libraryStyleGuides?: Array<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    reason: "mentioned" | "default";
    assets: Array<{ id: string; name: string; size: number; mime?: string; path: string }>;
    transitions?: StyleGuideTransition[];
    sounds?: Array<StyleGuideSound & { volumeLinear: number }>;
    colorLook?: StyleGuideColorLook & { lutFile?: string; lutPath?: string };
  }>;
  /** The kinds of work the editor gave other models in Task models, signed in now: the request hands them off (`hand_off`). */
  taskModels?: Array<{ name: string; description?: string; by: { agent: string; model?: string; label?: string } }>;
  /** What a hand_off task does for the request that handed it the work: the editor's kind of work, and what they asked. */
  handOff?: { name: string; description?: string; request: string };
}

/** A size the editor reads, for a file. */
function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const FILE_KINDS: Array<[RegExp, string]> = [
  [/pdf/, "PDF"],
  [/^image\//, "image"],
  [/^font\/|ttf|otf|woff/, "font file"],
  [/^audio\/|\.(?:wav|mp3|m4a|aac|ogg|flac)$/i, "audio file"],
  [/\.(?:cube|3dl)$/i, "LUT file"],
  [/^text\/|json/, "text"],
];
const fileKind = (mime: string | undefined, name: string) => FILE_KINDS.find(([test]) => test.test(mime ?? "") || test.test(name.toLowerCase()))?.[1] ?? "file";

function formatColorAdjustments(a: StyleGuideColorLook["adjustments"]): string {
  const entries: string[] = [];
  if (a.exposure) entries.push(`exposure: ${a.exposure}`);
  if (a.contrast !== 1) entries.push(`contrast: ${a.contrast}`);
  if (a.saturation !== 1) entries.push(`saturation: ${a.saturation}`);
  if (a.warmth) entries.push(`warmth: ${a.warmth}`);
  if (a.tint) entries.push(`tint: ${a.tint}`);
  if (a.shadows) entries.push(`shadows: ${a.shadows}`);
  if (a.highlights) entries.push(`highlights: ${a.highlights}`);
  if (a.blacks) entries.push(`blacks: ${a.blacks}`);
  if (a.whites) entries.push(`whites: ${a.whites}`);
  if (a.gamma !== 1) entries.push(`gamma: ${a.gamma}`);
  return entries.length ? entries.join(", ") : "neutral (defaults)";
}

/** The project's style guide, as the editor gave it. */
function styleGuideSection(guide: NonNullable<PromptContext["styleGuide"]>): string {
  const lines = [`# Style guide\n\nThe editor gave this project a style guide, "${guide.name}", for every graphic made in it.`];
  if (guide.path) lines.push(`It is in the ${fileKind(guide.mime, guide.path)} at ${guide.path}.`);
  if (guide.text?.trim()) lines.push(guide.path ? `What they wrote with it:\n\n${guide.text.trim()}` : guide.text.trim());
  return lines.join("\n\n");
}

/** Library-wide style guides active for this request (explicit @name mention or library Default). */
function libraryStyleGuidesSection(guides: NonNullable<PromptContext["libraryStyleGuides"]>): string {
  const blocks = guides.map(g => {
    const why = g.reason === "mentioned"
      ? `Explicitly chosen for this request (@${g.name}).`
      : `The editor's default style guide (@${g.name}), which applies automatically unless another @style is named.`;
    const lines = [`## @${g.name}`, why];
    if (g.description.trim()) lines.push(`Summary: ${g.description.trim()}`);
    if (g.instructions.trim()) lines.push("", g.instructions.trim());
    if (g.transitions?.length) {
      const soundName = (soundId?: string) => {
        if (!soundId) return undefined;
        const fromGuide = g.sounds?.find(s => s.id === soundId);
        if (fromGuide) return `${fromGuide.name} (soundId="${fromGuide.id}")`;
        const slug = soundId.startsWith("builtin:") ? soundId.slice("builtin:".length) : soundId;
        const built = BUILT_IN_STYLE_SOUNDS.find(b => b.id === slug);
        return built ? `${built.name} (builtInId="${built.id}")` : soundId;
      };
      lines.push(
        "",
        "### Preferred transitions",
        "Apply these with `timeline_transition`. When a transition has a paired sound, import it with `style_guide_sound_import` and place it on an audio track centred on the join at the sound's configured level.",
        ...g.transitions.map(t => {
          const dir = (t.type === "push" || t.type === "slide" || t.type === "whip") ? ` ${t.direction}` : "";
          const col = t.type === "dip" && t.color ? ` through ${t.color}` : "";
          const paired = soundName(t.soundId);
          const bits = [
            `${t.name}${t.isDefault ? " [Default]" : ""}: ${t.type}${dir}${col}, ${t.duration} s`,
            ...(paired ? [`paired sound: ${paired}`] : []),
            ...(t.usageRule ? [`when: ${t.usageRule}`] : []),
          ];
          return `- ${bits.join(" · ")}`;
        }),
      );
    }
    if (g.sounds?.length) {
      lines.push(
        "",
        "### Sound effects (SFX)",
        `Import a sound into this project with \`style_guide_sound_import(styleGuideId="${g.id}", soundId="...")\` and place the returned mediaId on an audio track with \`timeline_propose\` (\`addClip\`, using the returned linear \`volume\`).`,
        ...g.sounds.map(s => {
          const dur = s.duration ? `, ${s.duration.toFixed(2)} s` : "";
          const rule = s.usageRule ? ` · when: ${s.usageRule}` : "";
          return `- "${s.name}" (soundId="${s.id}", ${s.volumeDb} dB / volume ${s.volumeLinear}${dur}${rule})`;
        }),
      );
    }
    if (g.colorLook) {
      const cl = g.colorLook;
      lines.push(
        "",
        "### Camera color look",
        "Apply to camera clips via `timeline_propose` (`updateClip` with `effects`: `color` for adjustments and `lut` with `{file}` for an attached look file).",
      );
      if (cl.name) lines.push(`- Look name: ${cl.name}`);
      if (cl.notes) lines.push(`- Notes: ${cl.notes}`);
      lines.push(`- Adjustments: ${formatColorAdjustments(cl.adjustments)}`);
      if (cl.lutFile) lines.push(`- LUT file: "${cl.lutName ?? cl.lutFile}" -> use effect \`{ "type": "lut", "params": { "file": "${cl.lutFile}" } }\``);
    }
    if (g.assets.length) {
      lines.push(
        "",
        "### Style guide files",
        "Link fonts and images directly by their absolute path in `graphic_render` (Scarlet copies them into the graphic). Inspect images, PDFs or text with `attachment_read(styleGuideId, assetId)`.",
        ...g.assets.map(a => `- "${a.name}" (${fileKind(a.mime, a.name)}, ${fileSize(a.size)}), styleGuideId="${g.id}", assetId="${a.id}", at ${a.path}`),
      );
    }
    return lines.join("\n");
  });
  return `# Style guides\n\nFollow these visual, motion, sound, and color style rules whenever you create or revise graphics, place transitions or sound effects, or grade cameras.\n\n${blocks.join("\n\n---\n\n")}`;
}

/** Prompt for designing or updating a library style guide in chat (with attached files and live Tabbed Stage). */
function buildStyleGuideEditPrompt(ctx: PromptContext, edit: NonNullable<PromptContext["editStyleGuide"]>): string {
  const { guide, assets, attachedIds, hasPreview, earlier } = edit;
  const attachedSet = new Set(attachedIds ?? []);
  const newFiles = assets.filter(a => attachedSet.has(a.id));
  const existingFiles = assets.filter(a => !attachedSet.has(a.id));
  const formatAsset = (a: (typeof assets)[number]) =>
    `- "${a.name}" (${fileKind(a.mime, a.name)}, ${fileSize(a.size)}), styleGuideId="${guide.id}", assetId="${a.id}", at ${a.path}`;

  const starterSfxList = BUILT_IN_STYLE_SOUNDS
    .map(s => `  - \`${s.id}\` ("${s.name}", ${s.duration} s, default ${s.defaultVolumeDb} dB — ${s.defaultUsageRule})`)
    .join("\n");

  const currentTransitions = guide.transitions.length
    ? guide.transitions.map(t => `- id="${t.id}" "${t.name}": ${t.type} ${t.duration}s ${t.direction}${t.color ? ` ${t.color}` : ""}${t.soundId ? ` sound=${t.soundId}` : ""}${t.isDefault ? " [default]" : ""}${t.usageRule ? ` — ${t.usageRule}` : ""}`).join("\n")
    : "(none yet)";
  const currentSounds = guide.sounds.length
    ? guide.sounds.map(s => `- id="${s.id}" "${s.name}": ${s.source === "builtin" ? `builtin:${s.builtInId}` : `asset:${s.assetId}`}, ${s.volumeDb} dB${s.duration ? `, ${s.duration.toFixed(2)}s` : ""}${s.usageRule ? ` — ${s.usageRule}` : ""}`).join("\n")
    : "(none yet)";
  const currentColorLook = guide.colorLook
    ? [
        guide.colorLook.name ? `Name: ${guide.colorLook.name}` : null,
        guide.colorLook.notes ? `Notes: ${guide.colorLook.notes}` : null,
        `Adjustments: ${formatColorAdjustments(guide.colorLook.adjustments)}`,
        guide.colorLook.lutAssetId ? `LUT: ${guide.colorLook.lutName ?? guide.colorLook.lutAssetId} (assetId="${guide.colorLook.lutAssetId}")` : null,
      ].filter(Boolean).join("\n")
    : "(none yet)";

  const sections: string[] = [
    `# You are designing a reusable style guide in Scarlet

The editor is building a unified look-and-feel style guide named \`@${guide.name}\` with four tabs beside this chat:
1. **Graphics** — motion graphics (chapter titles, lower thirds, stat callouts, end cards) shown as a live 16:9 preview sheet.
2. **Transitions** — preferred clip transitions (\`dissolve\`, \`dip\`, \`push\`, \`slide\`, \`whip\`), duration, direction, usage rule, and optional paired sound effect.
3. **Sounds** — built-in starter SFX or custom uploaded audio files (\`.wav\`, \`.mp3\`, \`.m4a\`) with default dB level and usage rule.
4. **Color look** — reusable camera color adjustments (\`exposure\`, \`contrast\`, \`saturation\`, \`warmth\`, \`tint\`, \`shadows\`, \`highlights\`, \`blacks\`, \`whites\`, \`gamma\`) and/or an attached \`.cube\`/\`.3dl\` LUT file.

## How to work

- When the editor attached files to their message:
  - Inspect images, SVGs, PDFs or text files with \`attachment_read(styleGuideId="${guide.id}", assetId="...")\`. Use the editor's words to know which files are brand assets to embed (logos, fonts) vs visual references to match.
  - Custom audio files (\`.wav\`, \`.mp3\`, \`.m4a\`, \`.aac\`, \`.ogg\`, \`.flac\`) can be saved into \`sounds\` with \`source: "asset"\` and their \`assetId\`, a sensible \`volumeDb\` (e.g. \`-14\`), and a clear \`usageRule\`, and optionally paired to transitions via \`soundId\`.
  - Look files (\`.cube\`, \`.3dl\`) can be saved into \`colorLook\` using \`lutAssetId\` and \`lutName\`.
- Built-in starter sound effects available to add to \`sounds\` (\`source: "builtin"\`, \`builtInId\`) or pair directly on a transition (\`soundId: "builtin:<slug>"\` or a saved sound's \`id\`):
${starterSfxList}
- Link attached fonts in \`@font-face\` and attached logos/images in \`<img>\` using their exact absolute disk \`path\` listed below.
- ${hasPreview ? "This style guide already has a Graphics preview. Call `style_guide_preview_get` before changing the visual sheet so you preserve what the editor already likes." : "This style guide has no Graphics preview yet."}
- Save updates with \`style_guide_update\`. You can update any combination of \`description\`, \`instructions\`, \`transitions\`, \`sounds\`, and \`colorLook\`; omitted sections stay as they are. When updating \`transitions\` or \`sounds\`, include existing items you want to keep alongside your changes (give each item a short stable \`id\` like \`tr_push\` or \`sfx_whoosh\`).
- Call \`style_guide_preview_render\` whenever you create or change the Graphics visual look (or when there is no preview yet). If the editor only asked to adjust transitions, sounds, or the camera color look, \`style_guide_update\` alone updates those tabs immediately.
- If \`missingFonts\` is returned by \`style_guide_preview_render\`, switch to an installed font from \`installedFonts\` or ask the editor with \`task_question\` if they requested a custom font.
- \`task_question\` pauses and asks the editor when a key creative decision truly needs their input.

End with one or two short, plain sentences telling the editor what you created or updated — no jargon, no tool names, no raw dumps unless they asked.`,
    [
      `# Style guide: @${guide.name}`,
      `Description: ${guide.description.trim() || "(none yet)"}`,
      `Current graphics rules:\n${guide.instructions.trim() || "(none yet)"}`,
      `Current transitions:\n${currentTransitions}`,
      `Current sounds:\n${currentSounds}`,
      `Current color look:\n${currentColorLook}`,
      ...(newFiles.length ? ["Files attached to this message:\n" + newFiles.map(formatAsset).join("\n")] : []),
      ...(existingFiles.length ? ["Earlier files on this style guide:\n" + existingFiles.map(formatAsset).join("\n")] : []),
    ].join("\n\n"),
  ];

  if (earlier?.length) {
    const turns = earlier.map((e, i) => `${i + 1}. Editor: "${e.asked}"${e.replied ? `\n   You replied: ${e.replied}` : ""}`);
    sections.push(`# Earlier in this style guide chat\n\n${turns.join("\n")}`);
  }
  sections.push(...earlierAnswers(ctx.qa));
  return sections.join("\n\n");
}

/** The editor's own words on how Scarlet writes to them, from "Talking to you" in Settings. */
function talkingToYouSection(words: string): string {
  return `# How the editor wants you to write to them\n\nThe editor wrote this in Scarlet's settings for everything you write to them: what you say you will do, your updates, the reason on each edit, your questions and your closing sentences. It is about how you say things; where Scarlet shows your words and how long they can be, above, still holds.\n\n${words.trim()}`;
}

const modelName = (by: { agent: string; model?: string; label?: string }) => by.label ?? (by.agent === "gemini" && !by.model ? "Gemini" : by.model ?? by.agent);

/** The kinds of work the editor gave other models (Task models), for the request that hands them off. */
function taskModelsSection(types: NonNullable<PromptContext["taskModels"]>): string {
  const list = types.map(t => `- ${t.name}, to ${modelName(t.by)}${t.description ? `: ${t.description}` : ""}`).join("\n");
  return `# Work the editor gives to other models\n\nIn Scarlet's settings the editor chose another model for these kinds of work, each with what counts as it:\n\n${list}\n\nWhen a part of this request is one of them, hand that part to its model with \`hand_off\` instead of doing it yourself, with a brief that says what to make or change and where. Its edits join this request. Do the rest yourself.`;
}

/** What a hand_off task is: one part of a request, for the model running it. */
function handOffSection(handOff: NonNullable<PromptContext["handOff"]>): string {
  return `# You are doing one part of a request

In Scarlet's settings the editor gave ${handOff.name} to you${handOff.description ? `, which they describe as: "${handOff.description}"` : ""}. Another model is running their request, and it handed you this part: its brief is your instruction above. What the editor asked: "${handOff.request.trim()}"

- Do this part, and only this part. Save your edits with Scarlet's tools as for any request: they join the editor's request, and the editor reviews them there.
- Nobody can answer a question while you work. Where something isn't settled, choose what the editor's words and skills point to, and say what you chose.
- Your closing words go to the model that handed you this, not to the editor: say what you saved, with the change ids, where it is on the timeline, and anything it should know.`;
}

/**
 * Scarlet's contract with the agent: who decides, what context exists and how edits and messages
 * work. How each tool works belongs in its description; editorial taste belongs in skills.
 */
export const SCARLET_INTRO = `# You are editing a video in Scarlet

The editor sets the brief. You decide what context to inspect, which tools to use, and what edits or questions the brief calls for. Work within the editor’s scope, preferences, and tool permissions. Scarlet runs the operations, stores versions, and provides playback and exports.

## Project context

- The project summary, task, selected position or range, and supplied feedback are below, current as this run starts: begin from them. \`project_get\` reads the project's state and the recorded edit context again later in the run. \`timeline_get\` shows clip placement, tracks, transforms, effects, markers and version. \`skills_list\` provides the enabled skill library.
- \`transcript_get\`, \`transcript_search\`, \`dialogue_scan\`, \`media_profile\`, waveform data, and the available picture and audio inspection tools give different views of the footage. Source times refer to the recording. Timeline times refer to a version of the edit. \`timeline_at\` maps between them. Requesting missing transcript or waveform data starts or joins preparation. Transcript word times are approximate. Waveform silences, dialogue scan pauses and \`dialogue_check_join\` measure the recorded audio.
- \`timeline_transcript\`, \`timeline_join_audit\` and \`timeline_diff\` show what a version plays, measure how each join sounds and compare versions, so you can check an edit from measurements.
- \`notes_list\`, \`change_list\`, and \`change_get\` give feedback, change states and affected versions. \`change_review_cut\` compares a saved edit.

## Editing and communicating

- \`timeline_propose\` accepts typed operations or a replacement timeline. Specialized tools can assemble chosen source ranges, submit cut/keep/review decisions, crossfade specified joins, and build editable captions. Preserve the editor’s selected scope, protected material, and intended sync.
- Save as you go. The editor reviews saved parts while you keep working, and a run stops at its time limit with only saved edits kept.
- Use requested intent for authorized edits, suggestion for optional or preview-only changes, and alternative for competing options. Check the returned state when reporting what applied. When Scarlet adjusts a submitted edit, such as moving an edge onto measured silence, the result lists each adjustment with its evidence. Name each individual changed spot in \`timelineEdits\` with its exact range and a spot-specific label (each punch-in, zoom, or crop gets its own entry — never one umbrella range across untouched footage), and keep unrelated multi-spot passes in separate saves. When a save makes several related edits of the same kind (cuts, graphics, zooms, reframes, B-roll, audio fixes, transitions, etc.), pass \`batchTitle\` with a short plain-English title summarizing the group together (e.g. "3 model title cards", "4 zooms on demo screens", "2 cuts: false start & tangent"). A revision can link to its prior change and spot with \`replaces\` and to feedback with \`noteIds\`.
- \`task_log\` can show the current activity, a finding, or both. Attach a saved change ID and spot to the exact phrase the editor can select to see the change. \`task_question\` hands a decision to the editor and pauses the task; the answer comes back as your next message.
- Scarlet renders project media. \`render_request\` supports a short range or an explicitly requested full delivery.
- A motion graphic is an HTML/CSS page Scarlet draws into a video with alpha (\`graphic_render\`). It goes over the picture on a track of its own with \`timeline_propose\`, as an edit like any other. A project has one style guide, saved with \`style_guide_save\` when the editor gives you one.

## Writing for the editor

- Before your first tool call, say in one sentence what the request will come to when you are done, such as “I’ll take the retakes, false starts and dead air out of the interview and bring you any cut I’m unsure of.” Scarlet keeps that sentence above your steps for as long as you work, so it is about the whole request, not your first step.
- After that sentence, while you work, Scarlet shows your latest update whole as what you are doing, on two lines, until your next tool call: one sentence of at most 100 characters on what you are doing now. A longer update is cut off there. Updates leave the chat when you finish: afterwards the editor reads your closing sentences and the edits listed under the request, so what they asked for is never only in an update.
- Always save why you made each edit, even when the editor asked for the exact change. Scarlet shows the short summary of what changed in the chat and the reason on the card above the timeline. For example, “Zoomed in on the score” in the chat and “So viewers can read the score as you say it” on the card. Ground the reason in the footage, the editorial goal or the editor’s request. For an exact request, a short reference to that request is enough. Write the reason as you would say it to the editor beside them: everyday words, “you” for them, what they will hear named by the words said (“your first try”, “the second time you say it”), never your own terms for the footage (delivery, take, start, surviving, edge, join). For a cut that waits on them, say in one or two short sentences what you chose and what might make them choose otherwise: “Your second try says the whole thing, so I took out the first. The first makes it clearer the model did the bug squash, so check the second still does.”, not “The second line gives the full task. Check who does the bug pass in the surviving delivery.” Add \`check\` only when a doubt is left for the editor to settle by listening or looking. Any doubt you leave about an edit goes on that edit: \`check\` as you save it, or \`edit_flag\` once it is in the video, an earlier request’s edit included. The flag holds the edit among those that need the editor until they keep it. A doubt about something you leave in, such as a restart that may not be meant, reaches the editor the same way, as an edit they can approve or skip: in a dialogue pass, a cut staged for review.
- Keep every card short, simple and easy to read at a glance — one or two plain sentences as you would say them out loud, never a technical spec. Leave timestamps (\`2:26.0–2:57.0\`), durations (\`~31 s\`), \`Covers "..."\` prefixes, parenthetical tags (\`(with camera inset, ...)\`), arrow chains (\`→\`), beat-by-beat scripts, and production shorthand (\`3-stage\`, \`4-beat\`, \`archival/stock\`) off the card: the card already sits over that exact spot on the timeline. For a \`todo\` marker (\`addMarker\` with \`kind: "todo"\`), the marker’s text is what the card asks of the editor: write one short, plain sentence describing what to show or add, and keep the edit’s \`reason\` to one brief sentence on why without repeating the marker’s text.
- End with one or two short, plain sentences that sum up at the highest level what you did to the video, as you would tell the editor in person, such as “Tightened the talk to 10:29 and punched in on each demo.” Keep them to at most three lines (about 160 characters) so the reply stays brief in the chat; anything past what fits folds away until the editor clicks. Nothing you want the editor to look at, listen to or decide goes in them: they reach what needs them from Needs review, which lists edits only, so each doubt goes on its edit (\`check\` or \`edit_flag\`) and a decision you need goes to \`task_question\`. No times, edit numbers or lists, and no Markdown: Scarlet shows them as plain text. When the editor asks for ideas at places in the video and not yet for the work itself, a list of them included (B-roll to add and where, spots for a graphic), each idea is a \`todo\` marker at its place (\`addMarker\` in \`timeline_propose\`) that says what you would do there, so Needs review lists them and each opens on the timeline; the sentences only say you left them. What the editor asks you to find or check at places in the video is listed the same way, one edit a place, each opening on the timeline: where an edit or a marker is already at the place, what you found goes on it (a revision that \`replaces\` it, or \`edit_flag\` when nothing about it changes), and otherwise a \`todo\` marker there says it. A web address the editor needs is written out in full, on the edit at its place or, when it has no place in the video, in your closing sentences: Scarlet makes it a link. A request you finish without an edit says why in those sentences.
- Give times as m:ss.t on the timeline the editor will watch. Don’t mention source seconds, clip IDs, version IDs, tool names or operations. Say “edit” for a change, and “cut” only for an edit that removes footage.`;

/**
 * The chat before this request. Each message reached the model alone, so "tell me the timestamps", sent after Scarlet
 * had found two clips, was answered about a sponsor read: nothing said which clips (2026-11-23).
 */
function earlierInChat(earlier: PromptContext["earlier"]): string[] {
  if (!earlier?.length) return [];
  const under = (text: string) => text.trim().replace(/\n+/g, "\n   ");
  const blocks = earlier.map((r, i) => [
    `${i + 1}. The editor asked: "${under(r.asked)}"`,
    ...(r.told ?? []).map(t => `   You told them: ${under(t)}`),
    ...(r.answers ?? []).map(p => `   You asked them: "${under(p.question)}"\n   They answered: "${under(p.answer)}"`),
    ...(r.replied?.trim() ? [`   You closed with: ${under(r.replied)}`] : []),
    ...(r.edits?.length ? [`   Edits it saved: ${r.edits.join("; ")}`] : []),
    ...(r.standing ? [`   ${r.standing}`] : []),
  ].join("\n"));
  return [`# Earlier in this chat\n\nThe editor reads their requests in this project as one conversation with you, so their words now may refer to an earlier request or to what you told them. These are the latest, oldest first.\n\n${blocks.join("\n")}`];
}

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

/** Shared system prompt for AI-authored short titles summarizing any grouped batch of edits (used by direct HTTP calls and CLI side-checks). */
export const BATCH_SUMMARY_SYSTEM = `You write one short, plain-English title for a grouped batch of video edits (cuts, graphics, zooms, reframes, captions, audio/music dips, B-roll, transitions, or other edits) shown on a single line in Scarlet's edits list.

Rules:
- Write ONE short phrase (about 3 to 7 words, max 52 characters) that captures what all the edits in the batch do together.
- Include the edit count when helpful (examples: "110 dialogue cuts: pauses & retakes", "3 model title cards", "4 zooms on key demo screens", "5 B-roll cutaways on workflow", "3 music dips under speech", "2 cuts: false start & tangent").
- Always say "cut" or "cuts" for cuts (never "removed", "trimmed", or "took out").
- Never quote a single speech fragment or copy only the first edit's name as the title for a whole batch.
- Reply with the title only: no quotes around it, no trailing period, no preamble, no tools.`;

function buildListenCheckPrompt(check: { mediaId: string; from: number; to: number; voice?: "me" | "other voices"; question: string }, caps: AgentCapabilities): string {
  const prefix = caps.toolPrefix ?? "";
  const call = `\`${prefix}source_audio\` with \`mediaId\` ${check.mediaId}, \`from\` ${check.from} and \`to\` ${check.to}${check.voice ? `, and \`voice\` "${check.voice}"` : ""}`;
  const hear = caps.audio
    ? `Call ${call}: the passage comes back as audio in its result.`
    : `Call ${call}: Scarlet writes the passage as a WAV file to your folder and says where. Open that file with your own file viewer to hear it.`;
  return [
    "# You are listening to one passage of a recording for Scarlet, a video editor",
    "Another model is editing this video and can't hear. It reads the recording as a transcript and measurements, which miss what an editor hears: a false start that reads as a finished line, a word cut off or slurred, a repeated word the transcript tidied away, a hum, a breath, a click.",
    `It asked you to listen to recording \`${check.mediaId}\` from ${check.from} s to ${check.to} s and answer:\n\n> ${check.question.trim().replace(/\n+/g, "\n> ")}`,
    `${hear} Listen to all of it, more than once if you need to.`,
    "Answer from what you hear, not from what a transcript would say. Quote what is said word for word where it matters, with hesitations, false starts, repeated and cut-off words as they sound, and give each thing you name its time in source seconds (the passage starts at " + check.from + " s). Say plainly what you are unsure of. If you couldn't hear the passage, say so and don't guess.",
    "Your reply is your answer, and it is all the editing model gets: a few plain sentences, then stop. Edit nothing and call no other tool.",
  ].join("\n\n");
}

function buildLearningCheckPrompt(check: LearningCheckContext): string {
  const list = (lines: string[]) => lines.map(l => `- ${l}`).join("\n");
  const decided = check.decided ?? [];
  const verb = { kept: "Kept", rejected: "Rejected", revised: "Revised" } as const;
  const opening = check.readsDecisions
    ? "The editor just finished deciding the cuts and edits Scarlet left for them in the request below. That work is done; you edit nothing and answer nothing. Decide one thing: do their decisions say how they want something done from now on, in any video like this one, and not only here?"
    : "The editor just sent the agent the message that is your instruction. Another run is doing what it asks; you edit nothing and answer nothing. Decide one thing: does the message, or what they have decided lately, say how they want something done from now on, in any video like this one, and not only here?";
  return [
    `# You are listening for standing rules in Scarlet

Scarlet is a video editor in which an AI agent edits for an editor. A skill is the editor’s standing brief to that agent for one kind of work: what they want kept, cut, changed and asked about. The agent reads it before it edits.

${opening}

It does in only these cases:
- They said it as a rule themselves: their words are about every video or every time (“always”, “never”, “from now on”, how they like their videos), not about this one.
- The same kind of fix keeps coming back: at least two of their earlier requests below asked for the same kind of change to what a skill made as this one does. That fix is how they want the skill to work. Offer it for that skill and name the requests it comes from.
- Their decisions keep pointing the same way: they kept, rejected or revised the same kind of cut or edit a skill made, the same way each time, so the skill keeps getting it wrong for them. Weigh what Scarlet measured and why it made each one: a pattern is the same choice on cuts or edits that are alike, not a few that happen to share a word, and a choice that what was measured explains otherwise is no pattern. Offer it for the skill that made them, with the decisions it comes from in \`from\`.

Anything else is not a rule, so call nothing: a note about this video, this moment or this cut that hasn’t come up before, however general it could be made; a rule the skill or a rule listed below already says, in any wording; a rule the editor declined, in any wording; and a rule that only tells the agent to do its work well (check, play back, adjust as needed) without saying what the editor wants.

When it is a rule, read the skill it belongs in, in full, with \`skills_list\`, then offer it with \`learning_suggest\`. Offer at most one rule for a request — or two only when it states two truly separate rules — and combine closely related preferences for the same skill into one concise sentence instead of splitting them into several offers. Never offer a rule from decisions that are already behind a rule listed below. The editor reviews what you offer beside what the skill says that it would change, and nothing changes in a skill unless they approve it.

A rule is for every video the skill edits, so write the principle behind what they said or decided, not its instances: no words, names, times or moments from this video or the requests, and a number they gave or that their decisions show stays a guide, not a fixed amount. If it can't be put that way, it isn't a rule.

End with one short line: the rule you offered, or “No rule.”`,
    `# The request\n\n${[
      check.readsDecisions ? `They asked: “${check.said}”` : undefined,
      check.about,
      check.usedSkills.length ? `They chose ${check.usedSkills.length === 1 ? "this skill" : "these skills"} for it: ${check.usedSkills.join(", ")}.` : undefined,
      check.earlier.length ? `What they asked before, oldest first:\n${list(check.earlier.map(e => `“${e.said}”${[e.about && `about ${e.about}`, e.elsewhere && "in another video"].filter(Boolean).map(w => ` (${w})`).join("")}`))}` : "It is the first thing they asked.",
    ].filter(Boolean).join("\n\n")}`,
    ...(decided.length ? [`# What they decided lately\n\nOn cuts and edits Scarlet made, oldest first, each with the id to cite it by:\n${list(decided.map(d =>
      `\`${d.id}\` ${verb[d.decision]}: ${d.label}${d.note ? `, saying “${d.note}”` : ""}${(d.details ?? []).map(x => `; ${x}`).join("")}` +
      `${d.madeBy?.length ? `; made with ${d.madeBy.join(", ")}` : ""}${d.elsewhere ? "; in another video" : ""}${d.ruleFrom ? `; already behind the rule “${d.ruleFrom}”` : ""}`))}`] : []),
    `# The editor’s skills\n\n${list(check.skills.map(s => `${s.name} (${s.id}): ${s.description.trim() || "no description"}`))}`,
    ...(check.rules.length ? [`# Rules Scarlet already has\n\n${list(check.rules.map(r => `“${r.rule}” (${r.state === "saved" ? "saved in" : r.state === "declined" ? "declined by the editor for" : "offered for"} ${r.skill})`))}`] : []),
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
  if (ctx.editStyleGuide) return buildStyleGuideEditPrompt(ctx, ctx.editStyleGuide);
  if (ctx.learningCheck) return buildLearningCheckPrompt(ctx.learningCheck);
  if (ctx.areaCheck) return buildAreaCheckPrompt(ctx.areaCheck, ctx.capabilities?.toolPrefix ?? "");
  if (ctx.listenCheck) return buildListenCheckPrompt(ctx.listenCheck, ctx.capabilities ?? agentCapabilities(ctx.task?.agent, undefined, ctx.task?.model));
  if (ctx.batchSummary) return BATCH_SUMMARY_SYSTEM;
  const parts: string[] = [SCARLET_INTRO];
  // Only a caller that says the run has the tool is asked: a harness's default says what it can do, not how this run was launched.
  if (ctx.capabilities?.plan) parts.push(PLAN_STEPS);

  // Only a harness with file tools can put anything in the artifact directory.
  const caps = ctx.capabilities ?? agentCapabilities(ctx.task?.agent, undefined, ctx.task?.model);
  if (ctx.workDir && caps.files && caps.shell) {
    // A request launched with its harness's own tools. What to use them for is the model's call; that B-roll and graphics
    // are the editor's to ask for is the editor's standing word (2026-11-21), said here once.
    parts.push(`Your task artifact directory is: ${ctx.workDir}\nBeside Scarlet's tools you have your harness's own: a shell, sandboxed to this task's folder, with ffmpeg and ffprobe on its PATH where this machine has them, file tools${caps.web ? ", and web search" : ""}. Use them for what Scarlet's tools don't give: a file built for the edit, something looked up. \`web_capture\` takes the picture of a page on the web, \`web_video\` reads a video on the web and saves a part of it, \`graphic_render\` draws a page you write, and \`asset_add\` brings a finished file into the project, with \`source\` for anything taken from the web. The project's footage and the video are read through Scarlet's tools: the shell can't reach them. B-roll and graphics are made when the editor asked for them, in their words or in a skill of theirs, never on your own initiative.`);
  } else if (ctx.workDir && caps.files) {
    parts.push(`Your task artifact directory is: ${ctx.workDir}\n\`asset_add\` imports a graphic, animation or music bed you made there, with how you made it.`);
  }

  if (caps.toolPrefix) {
    parts.push(`This harness prefixes Scarlet’s tool names with \`${caps.toolPrefix}\`. For example, call \`${caps.toolPrefix}project_get\` when a skill names \`project_get\`.`);
  }

  // Project summary. A long timeline lists only the clips near where the request points, if it points anywhere.
  const summary = typeof ctx.project === "string" ? ctx.project : summarizeProject(ctx.project.project, ctx.project.timeline, { most: PROMPT_CLIPS, near: requestRange(ctx.task), requestedAt: ctx.task?.createdAt });
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
      // A pass is done when the model says so (docs/AI-AGENTS.md rule 5): nothing sends it back. What counts as done is said
      // here, to the run that does the work. Told only to check for repeats, once the closing check that sent passes back
      // was taken out, 3 of 20 Sol Medium passes finished with findings still listed and they left twice main's silences of
      // 2 s or more, 10 to 5 (benchmarks/safety-only-sol-2026-11-21, 2026-11-21).
      ctxLines.push("- The editor chose a dialogue first cut. It is done when dialogue_check_repeats on the current playback, within the requested scope, lists nothing you haven't settled: each repeat, silence, short piece, divided sentence and picture it lists is cut or changed, kept with your reason, or staged for the editor when you doubt it.");
      // A pass names no doubt of its own: asked how sure it was of each cut, one called all twelve certain, two of them
      // mistakes the editor had reported on that footage. It is not unsure of those cuts, so the question finds nothing.
      // Asked to order its cuts by how likely each is to be wrong, it leaves the plain false starts at the bottom: on
      // 4.5 minutes of that recording, three passes flagged 2 or 3 of about ten word cuts at one in four, one of the two
      // mistakes among them in two passes, and a pass at half flagged five, both among them (2026-11-18). So the order
      // is the model's, and how far down it the editor is asked to look is their setting.
      // Every run of a pass is asked. Until 2026-11-21 the closing check the engine sent a finished pass back for wasn't:
      // in a fresh session with no memory of the order, asked again, it flagged a second share of the same cuts, 27-60%
      // of the word cuts on three passes at "about one in four" (2026-11-20). No pass is sent back now.
      ctxLines.push(`- Before the pass is done, read back what the video plays where your cuts took words out, and order those cuts from the most likely to be wrong to the least: a cut is wrong when the editor, hearing the result, would put words back, take more out or choose the other delivery. The editor asked to check ${CHECK_IN_SHARE[ctx.checkIn ?? "balanced"]} of them: flag that many from the top of your order, each with what could be wrong. A cut you already flagged or staged for them counts.`);
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
      ctxLines.push(`- Selected edit index: ${c.editIndex}${about ? `, "${about.label.trim()}"` : ""}`);
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

  if (ctx.handOff) parts.push(handOffSection(ctx.handOff));
  else if (ctx.taskModels?.length) parts.push(taskModelsSection(ctx.taskModels));

  parts.push(...earlierInChat(ctx.earlier));

  if (ctx.libraryStyleGuides?.length) parts.push(libraryStyleGuidesSection(ctx.libraryStyleGuides));
  if (ctx.styleGuide) parts.push(styleGuideSection(ctx.styleGuide));
  if (ctx.talkingToYou?.trim()) parts.push(talkingToYouSection(ctx.talkingToYou));

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
  } else if (ctx.openNotes !== undefined) {
    // 62 runs listed the notes of a library that held two, each a turn that re-read the whole run (2026-11-24).
    parts.push(`# Review notes\n\n${ctx.openNotes ? `The project has ${ctx.openNotes} open review note${ctx.openNotes === 1 ? "" : "s"}; \`notes_list\` reads them.` : "The project has no open review notes."}`);
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
