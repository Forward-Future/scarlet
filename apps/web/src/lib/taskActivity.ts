import { taskDialogueOperation, type Task, type TaskEvent } from "@scarlet/shared";
import { clock } from "./format";

const toolActivity: Record<string, string> = {
  project_get: "Reviewing your project",
  media_list: "Looking through your footage",
  media_frame: "Inspecting frame",
  frame_contact_sheet: "Comparing frames",
  frame_contact_sheet_batch: "Comparing passages",
  source_audio: "Checking the original sound",
  audio_sync: "Checking whether the sound lines up",
  transcript_get: "Reading transcript",
  transcript_search: "Searching transcript",
  dialogue_scan: "Scanning dialogue",
  dialogue_check_join: "Checking how the cut sounds",
  dialogue_review_inspect: "Checking a suggested cut",
  dialogue_review_save: "Saving cut recommendations",
  dialogue_revise_cut: "Moving the cut",
  change_review_cut: "Reviewing edit",
  dialogue_apply_cuts: "Applying edits and preparing review",
  waveform_get: "Checking the sound",
  sound_picture: "Checking the sound",
  timeline_get: "Reading timeline",
  timeline_summary: "Reviewing timeline",
  timeline_at: "Inspecting timeline",
  timeline_diff: "Comparing versions",
  timeline_transcript: "Reading the video’s words",
  timeline_join_audit: "Checking how the cuts sound",
  dialogue_check_repeats: "Checking the finished dialogue for repeats",
  media_profile: "Measuring the sound",
  screen_text: "Reading the text on screen",
  timeline_propose: "Proposing edit",
  timeline_crossfade_audio: "Smoothing dialogue",
  timeline_first_cut: "Building first edit",
  captions_generate: "Generating captions",
  change_get: "Reviewing change",
  change_list: "Looking through your edits",
  notes_list: "Reading notes",
  note_reply: "Replying to note",
  note_resolve: "Resolving note",
  render_request: "Preparing your video",
  render_status: "Checking your video",
  asset_add: "Adding media",
  export_otio: "Exporting timeline",
  task_question: "Asking question",
  skill_save_from_change: "Saving skill",
  skill_save_edit: "Saving skill",
  skills_list: "Reading skills",
  learning_suggest: "Noting a rule",
};

// New progress messages start with a short action. Older hosts also send
// free-form commentary and diagnostics, which shouldn't displace a useful label.
function progressLabel(text: string): string | undefined {
  const heading = text.trim().split(/[:;.!?…\n—]/, 1)[0]?.trim().replace(/\s+/g, " ").replace(/^found \d+ /i, "Found ") ?? "";
  if (technical.test(heading) || command.test(heading)) return;
  if (heading.length <= 48 && /^(?:[a-z]+ing|found|read|check|inspect|find|trim|cut|review|apply|render|export)(?: [\p{L}\p{N}][\p{L}\p{N}’'-]*){1,2}$/iu.test(heading)) {
    return heading.charAt(0).toUpperCase() + heading.slice(1);
  }
  // Accept a leading action from older logs such as "Reading the transcript for clip 4".
  const action = /^(?:I['’]m |now )?([a-z]+ing)\s+(?:(?:the|a|an|your)\s+)?(transcript|waveform|timeline|captions|clips?|frames?|audio|footage|pauses|silence|notes|project|skills?|instruction)\b/i.exec(text.trim());
  if (!action) return undefined;
  const label = (action[1] + " " + action[2]).toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function toolName(event: TaskEvent): string {
  const name = typeof event.data?.tool === "string" ? event.data.tool : event.text.trim().split(/\s+/, 1)[0] ?? "";
  return name.replace(/^(?:mcp__scarlet__|mcp_scarlet_|scarlet(?:__|[./]))/i, "").replaceAll(".", "_").toLowerCase();
}

export function isDialogueScanTool(event: TaskEvent) {
  return event.type === "tool" && toolName(event) === "dialogue_scan";
}

const waitLabels: Record<string, string> = { transcript: "the transcript", sound: "the sound analysis", dialogue: "dialogue analysis" };
/** The live line while a run waits for a transcript. */
export const TRANSCRIPT_WAIT = `Waiting for ${waitLabels.transcript}`;
/** Tools an agent calls again to collect media work that is still being prepared. */
const waitTools: Record<string, string> = { transcript_get: "transcript", transcript_search: "transcript", waveform_get: "sound", dialogue_scan: "dialogue" };

function waitKey(wait: unknown, mediaId: unknown) {
  return typeof wait === "string" && typeof mediaId === "string" ? `${wait}/${mediaId}` : undefined;
}

/** Media work the run is still waiting on, as `wait/mediaId` keys. */
export function pendingMediaWaits(events: readonly TaskEvent[] = []): Set<string> {
  const waits = new Set<string>();
  for (const event of events) {
    if (event.type !== "log" || event.data?.kind !== "media_wait") continue;
    const key = waitKey(event.data.wait, event.data.mediaId);
    if (key) event.data.done ? waits.delete(key) : waits.add(key);
  }
  return waits;
}

/** The media work this tool call is collecting, when that work is still being prepared. */
export function waitingFor(event: TaskEvent, waits: ReadonlySet<string>): string | undefined {
  if (event.type !== "tool" || !waits.size) return;
  const wait = waitTools[toolName(event)];
  const input = event.data?.input;
  const mediaId = input && typeof input === "object" && "mediaId" in input ? input.mediaId : undefined;
  const key = waitKey(wait, mediaId);
  return key && waits.has(key) ? wait : undefined;
}

function toolLabel(name: string, event: TaskEvent, hasScanHistory: boolean): string | undefined {
  if (!Object.hasOwn(toolActivity, name)) return;
  const label = name === "dialogue_scan" && hasScanHistory ? "Reviewing dialogue" : toolActivity[name]!;
  const input = event.data?.input;
  if (!input || typeof input !== "object") return label;
  if ("index" in input && typeof input.index === "number" && Number.isSafeInteger(input.index) && input.index >= 0) {
    const count = "count" in input && typeof input.count === "number" && Number.isSafeInteger(input.count) && !("wholePicture" in input && input.wholePicture) ? input.count : 1;
    if (name === "dialogue_review_inspect" && count > 1) return `Checking suggested cuts · Cuts ${input.index + 1}–${input.index + count}`;
    return `${label} · ${name === "dialogue_review_inspect" ? "Cut" : "Edit"} ${input.index + 1}`;
  }
  const time = "from" in input ? input.from : "start" in input ? input.start : "t" in input ? input.t : undefined;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) return label;
  // A range says how much is being read: "0:00–57:47" rather than a start that never moves.
  const end = "to" in input ? input.to : "end" in input ? input.end : undefined;
  return typeof end === "number" && Number.isFinite(end) && end - time >= 1 ? `${label} ${clock(time)}–${clock(end)}` : `${label} at ${clock(time)}`;
}

/** Keep the latest inspected source frame through subsequent progress updates. */
export function latestInspectedFrame(events: readonly TaskEvent[] = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "tool" || toolName(event) !== "media_frame") continue;
    const input = event.data?.input;
    if (input && typeof input === "object" && "mediaId" in input && typeof input.mediaId === "string"
      && "t" in input && typeof input.t === "number" && Number.isFinite(input.t) && input.t >= 0) {
      return { mediaId: input.mediaId, time: input.t };
    }
  }
}

export function taskActivityLabel(event: TaskEvent, hasScanHistory = false, waits: ReadonlySet<string> = new Set()): string | undefined {
  switch (event.type) {
    case "tool": {
      const wait = waitingFor(event, waits);
      if (wait) return `Waiting for ${waitLabels[wait]}`;
      const tool = toolName(event);
      if (tool === "task_log") {
        const input = event.data?.input;
        return input && typeof input === "object" && "text" in input && typeof input.text === "string" ? progressLabel(input.text) : undefined;
      }
      return toolLabel(tool, event, hasScanHistory);
    }
    case "log":
      if (event.data?.kind === "editor_progress") return event.data.scanPage ? "Scanning dialogue" : event.text.trim() || undefined;
      if (event.data?.kind === "init") return "Getting started";
      if (event.data?.kind === "reasoning") return "Planning next step";
      if (event.data?.kind === "connection") return "Reconnecting to the model";
      if (event.data?.kind === "media_wait") {
        const label = typeof event.data.wait === "string" ? waitLabels[event.data.wait] : undefined;
        return label && !event.data.done ? `Waiting for ${label}` : undefined;
      }
      return progressLabel(event.text);
    case "change": return "Proposed change";
    case "question": return "Awaiting your answer";
    case "answer": return "Reviewing your answer";
    // The task state handles failures. Recoverable tool errors stay in the event log.
  }
}

const technical = /[{}`\n\r\\]|<\/?[a-z!][^<>]*>|[-=]>|https?:\/\/|\b\w+_\w+|(?:^|\s)\/\S|\b(?:MCP|stdout|stderr|JSON|ffmpeg|ffprobe|stack trace|tool call|exit code|API endpoint)\b/i;
const command = /(?:^|\s)(?:[$%] |(?:bash|zsh|git|npm|pnpm|npx|node|python3?|curl|cargo|sudo|exec_command|ls|cd|chmod|mkdir)\s+\S)|^(?:ran|running|executed) (?:the )?(?:terminal |shell )?commands?\b|&&|\|\|/i;

const savedPlaybackAllClear = /^(?:the )?playback (?:audio|repeat) check found no (?:outstanding accidental )?repeats[.!]?(?: no edits were needed[.!]?)?$/i;

/** Older passes saved the automatic recheck's all-clear as a chat message. Keep any other words for the editor. */
export function taskChatText(task: Task, text = task.summary) {
  const audit = task.repeatAudit;
  if (!text || task.state !== "done" || audit?.remaining !== 0 || audit.noFindings === false || audit.unavailable?.length) return text;
  if (taskDialogueOperation(task) === "first-cut") {
    const words = text.replace(/\*\*/g, "").trim().replace(/\s+/g, " ");
    if (savedPlaybackAllClear.test(words)) return undefined;
  }
  return text;
}

/** Keep the receipt brief, or retain the complete editorial reply without tool transcripts. */
export function editConfirmation(value?: string | null, instruction?: string, mode: "brief" | "full" = "brief"): string | undefined {
  if (!value) return;
  const normalize = (text: string) => text.toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  const requested = normalize(instruction ?? "");
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of value.replace(/```[\s\S]*?(?:```|$)/g, "\n").split(/\r?\n/)) {
    if (!line.trim() && mode === "full" && lines.at(-1)) lines.push("");
    const sentences: string[] = [];
    for (const part of line.trim().replace(/^[-*]\s+/, "").split(/(?<=[.!?])\s+/u)) {
      const text = part.trim().replace(/\*\*/g, "");
      if (!text || (mode === "brief" && text.length > 320) || technical.test(text) || command.test(text) || normalize(text) === requested) continue;
      const sentence = /[.!?…”"]$/.test(text) ? text : text + ".";
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      sentences.push(sentence);
      if (mode === "brief" && seen.size === 3) break;
    }
    if (sentences.length) lines.push((mode === "full" && /^\s*[-*]\s+/.test(line) ? "• " : "") + sentences.join(" "));
    if (mode === "brief" && seen.size === 3) break;
  }
  return lines.join(mode === "full" ? "\n" : " ").trim() || undefined;
}

/** Histories and live events are kept in chronological order. */
export function latestTaskActivity(events: readonly TaskEvent[] | undefined): string | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const label = taskActivityLabel(events[i]!);
    if (label) return label;
  }
  return undefined;
}

/** A socket update can arrive while the saved history is in flight. */
export function mergeTaskEvents(history: TaskEvent[], live: TaskEvent[]): TaskEvent[] {
  const ids = new Set(history.map((event) => event.id));
  return [...history, ...live.filter((event) => !event.id || !ids.has(event.id))]
    .sort((a, b) => (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0));
}

const compactTools: Record<string, string> = {
  project_get: "Reading project", media_list: "Reviewing footage", media_frame: "Inspecting frame",
  source_audio: "Checking audio", audio_sync: "Aligning audio", dialogue_check_join: "Checking join", timeline_join_audit: "Checking joins", dialogue_check_repeats: "Checking repeated dialogue", media_profile: "Measuring audio",
  dialogue_review_inspect: "Checking cut", dialogue_review_save: "Saving recommendations", dialogue_revise_cut: "Moving cut",
  dialogue_apply_cuts: "Editing dialogue", waveform_get: "Checking waveform", sound_picture: "Checking waveform", timeline_first_cut: "Assembling footage",
  change_list: "Reviewing edits", render_request: "Rendering preview", render_status: "Checking render",
  change_review_cut: "Reviewing cut", timeline_propose: "Applying edit", skill_save_from_change: "Saving skill",
};

/** Compact activity from a single event, when one is available. */
export function compactActivity(ev: TaskEvent): string | undefined {
  const explicit = ev.data?.activity;
  if (typeof explicit === "string" && /^[\p{L}][\p{L}’-]*(?: [\p{L}][\p{L}’-]*)?$/u.test(explicit)) return explicit;
  if (ev.type === "tool") {
    const name = toolName(ev);
    const label = compactTools[name] ?? toolActivity[name];
    if (label && label.split(" ").length <= 2) return label;
  }
  if (ev.data?.kind === "reasoning") return "Planning edit";
  if (ev.data?.kind === "media_wait") return ev.data.done ? undefined : "Waiting";
  if (ev.data?.scanPage) return "Scanning dialogue";
  const label = progressLabel(ev.text);
  if (label && label.split(" ").length <= 2) return label;
  if (ev.type === "change") return "Finishing edit";
}
