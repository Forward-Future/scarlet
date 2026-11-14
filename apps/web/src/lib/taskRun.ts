import { DialogueScanPage, type Task, type TaskEvent } from "@scarlet/shared";
import { mergeRanges, type Change, type TimeRange } from "@scarlet/timeline";
import { appliedEditSummary, cutSummary } from "../components/review/cutReviewDetails";
import { clock, lengthLabel, plural } from "./format";
import { editConfirmation, taskChatText } from "./taskActivity";

/**
 * One agent run, shown the way Codex shows its work: short updates from the agent and one line per
 * finished step while it works, folded into a single summary line when it's done.
 */
export type RunItem =
  | { kind: "note"; at: string; text: string }
  | { kind: "step"; at: string; verb: string; detail: string; pending?: boolean; background?: boolean; edit?: boolean };

const ACTIVE = new Set(["queued", "claimed", "running", "waiting_for_user"]);

export function runIsActive(task: Task) {
  return ACTIVE.has(task.state);
}

function toolName(event: TaskEvent) {
  const name = typeof event.data?.tool === "string" ? event.data.tool : event.text.trim().split(/\s+/, 1)[0] ?? "";
  return name.replace(/^(?:mcp__scarlet__|mcp_scarlet_|scarlet(?:__|[./]))/i, "").replaceAll(".", "_").toLowerCase();
}

function input(event: TaskEvent): Record<string, unknown> {
  const value = event.data?.input;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** How many places one call looked at, for tools that take a batch. */
function places(event: TaskEvent) {
  const { windows, times, ranges, count, wholePicture } = input(event);
  const list = [windows, times, ranges].find(Array.isArray) as unknown[] | undefined;
  // One inspection can check several consecutive cuts.
  const cuts = toolName(event) === "dialogue_review_inspect" && !wholePicture && typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : undefined;
  return list?.length || cuts || 1;
}

const seconds = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Where one call looked, in seconds, when its input says. */
function spans(event: TaskEvent): TimeRange[] {
  const span = (value: unknown): TimeRange | undefined => {
    if (typeof value === "number") return seconds(value) === undefined ? undefined : { start: value, end: value };
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    const start = seconds(v.from ?? v.start ?? v.t);
    if (start === undefined) return;
    const end = seconds(v.to ?? v.end);
    return { start, end: end !== undefined && end > start ? end : start };
  };
  const { windows, times, ranges } = input(event);
  const list = [windows, times, ranges].find(Array.isArray) as unknown[] | undefined;
  return (list ?? [input(event)]).map(span).filter((s): s is TimeRange => !!s);
}

/** "at 0:24, 1:33 and 3:05" for a few places, "from 0:00 to 57:44" for many. */
function where(found: readonly TimeRange[], count: number) {
  if (!found.length) return "";
  if (count <= 3 && found.every(s => s.end - s.start < 1)) {
    const starts = [...new Set(found.map(s => clock(s.start)))];
    if (starts.length === count) return ` at ${starts.length > 1 ? starts.slice(0, -1).join(", ") + " and " + starts.at(-1) : starts[0]}`;
  }
  let start = Infinity, end = -Infinity;
  for (const range of found) { start = Math.min(start, range.start); end = Math.max(end, range.end); }
  return end - start >= 1 ? ` from ${clock(start)} to ${clock(end)}` : ` at ${clock(start)}`;
}

type StepSpec = { group: string; verb: string; doing: string; detail: (n: number, found: readonly TimeRange[], first: TaskEvent) => string; once?: boolean };

const project: StepSpec = { group: "read", verb: "Read", doing: "Reading", detail: () => "the project", once: true };
/** "the picture at 0:24 and 1:33" when the places are listed, "the picture in 12 places from 0:00 to 57:47" otherwise. */
const placesDetail = (what: string) => (n: number, found: readonly TimeRange[]) => {
  const at = where(found, n);
  return n > 1 && !at.includes(" and ") ? `${what} in ${n} places${at}` : `${what}${at}`;
};
const sound: StepSpec = { group: "sound", verb: "Checked", doing: "Checking", detail: placesDetail("the sound"), once: true };
const picture: StepSpec = { group: "picture", verb: "Looked at", doing: "Looking at", detail: placesDetail("the picture"), once: true };
const transcript: StepSpec = { group: "transcript", verb: "Read", doing: "Reading", detail: (n, found) => "the transcript" + where(found, n), once: true };

/** Tools grouped into plain steps. Tools that make an edit show up as the edit itself. `once` skips a repeat of the same call. */
const toolSteps: Record<string, StepSpec> = {
  project_get: project, timeline_get: project, timeline_summary: project, timeline_at: project, timeline_diff: project,
  skills_list: project, media_list: project, change_list: project, change_get: project, notes_list: project,
  timeline_transcript: { group: "edit-transcript", verb: "Read", doing: "Reading", detail: () => "the edit’s transcript", once: true },
  timeline_join_audit: { group: "joins", verb: "Checked", doing: "Checking", detail: n => n > 1 ? `${n} joins` : "a join", once: true },
  transcript_get: transcript,
  transcript_search: { group: "search", verb: "Searched", doing: "Searching", once: true, detail: (n, _, first) => {
    const query = n === 1 ? input(first).query : undefined;
    return typeof query === "string" && query.length <= 40 ? `the transcript for “${query}”` : n > 1 ? `the transcript ${n} times` : "the transcript";
  } },
  media_profile: sound, waveform_get: sound, sound_picture: sound, source_audio: sound,
  audio_sync: { group: "sync", verb: "Lined up", doing: "Lining up", detail: () => "the sound", once: true },
  media_frame: picture, frame_contact_sheet: picture, frame_contact_sheet_batch: picture,
  screen_text: { group: "screen-text", verb: "Read", doing: "Reading", detail: () => "the text on screen", once: true },
  dialogue_check_repeats: sound,
  dialogue_check_join: { group: "joins", verb: "Checked", doing: "Checking", detail: n => n > 1 ? `${n} joins` : "a join", once: true },
  dialogue_review_inspect: { group: "inspect", verb: "Checked", doing: "Checking", detail: n => n > 1 ? `${n} suggested cuts` : "a suggested cut", once: true },
  dialogue_review_save: { group: "save", verb: "Saved", doing: "Saving", detail: () => "the cut recommendations" },
  dialogue_revise_cut: { group: "revise", verb: "Moved", doing: "Moving", detail: () => "the cut" },
  render_request: { group: "render", verb: "Rendered", doing: "Rendering", detail: () => "a preview" },
};

/** How each step's verb reads while it's still going: "Read" → "Reading". */
const ongoing = new Map(Object.values(toolSteps).map(spec => [spec.verb, spec.doing]));

const waitNames: Record<string, string> = { transcript: "the transcript", sound: "the sound analysis", dialogue: "dialogue analysis" };

const hostLines = /^(?:Starting the editing agent\.?|Edit resumed\.?|warning:|\(thinking\)|Claude Code session started)/i;

/** The agent's own words, kept to a sentence or two and free of tool transcripts. */
export function noteText(text: string) {
  if (!text.trim() || hostLines.test(text.trim())) return undefined;
  const brief = editConfirmation(text);
  if (!brief) return undefined;
  const sentences = brief.split(/(?<=[.!?…”"])\s+/u);
  return sentences.slice(0, 2).join(" ");
}

/**
 * What the agent said the whole request will come to, before it began: its first words, when they come ahead of its
 * first look at the project. The chat keeps that one sentence above the run's steps for as long as it works. An agent
 * that went straight to work said no such thing: its first update is about a step, so it is not this. `note` is the
 * update those words make in `runItems`, so they aren't shown a second time as an update.
 */
export function runAim(events: readonly TaskEvent[]): { text: string; note: string } | undefined {
  for (const event of events) {
    // Work has begun: a tool other than the one that speaks, a page read, an edit saved.
    if (event.type === "change" || (event.type === "tool" && toolName(event) !== "task_log")) return undefined;
    if (event.type !== "log") continue;
    const kind = event.data?.kind;
    if (kind === "editor_progress" && (event.data?.scanPage || typeof event.data?.reviewCounter === "string")) return undefined;
    if (kind && kind !== "editor_progress") continue;
    const note = noteText(event.text);
    if (note) return { text: note.split(/(?<=[.!?…”"])\s+/u)[0]!, note };
  }
  return undefined;
}

function changeStep(change: Change, at: string): RunItem {
  const text = (appliedEditSummary(change) || cutSummary(change.description)).replace(/\s+/g, " ").trim();
  const [verb = "Edited", ...rest] = text.split(" ");
  return { kind: "step", at, verb, detail: rest.join(" ").replace(/\.$/, ""), edit: true };
}

/**
 * Updates and finished steps for one run, in the order they happened. `reply` is a message shown elsewhere as the
 * run's reply, so it isn't listed again as an update.
 */
export function runItems(task: Task, events: readonly TaskEvent[], changes: readonly Change[], reply?: string): RunItem[] {
  const items: RunItem[] = [];
  const notes = new Set<string>();
  const final = (task.summary ?? "").trim();
  let group: { count: number; found: TimeRange[]; first: TaskEvent; item: Extract<RunItem, { kind: "step" }>; spec: StepSpec } | undefined;
  // A batch can cover thousands of frames. Format its span once, after the last call has joined it.
  function finishGroup() {
    if (!group) return;
    group.item.detail = group.spec.detail(group.count, group.found, group.first);
    group = undefined;
  }
  const scans = new Map<string, { item: Extract<RunItem, { kind: "step" }>; start: number; ranges: TimeRange[]; end: number }>();
  const edited = new Set<string>();
  // Calls already shown, so an agent re-reading the same thing doesn't add a row each time.
  const seen = new Set<string>();
  // Media work the run is waiting on, and the row that says so.
  const waits = new Map<string, Extract<RunItem, { kind: "step" }>>();
  // The latest row of its own for each read of media work that may still be preparing.
  const reads = new Map<string, Extract<RunItem, { kind: "step" }>>();
  for (const event of events) {
    const at = event.at ?? task.createdAt ?? "";
    if (event.type === "log" && event.data?.kind === "media_wait") {
      const { wait, mediaId, done, failed } = event.data;
      const name = typeof wait === "string" ? waitNames[wait] : undefined;
      if (!name || typeof mediaId !== "string") continue;
      const key = `${wait}/${mediaId}`;
      const row = waits.get(key);
      if (!done) {
        if (row) continue;
        finishGroup();
        // The read that found the work unfinished becomes the waiting row, from when it started.
        const read = reads.get(key);
        const item = read && Date.parse(at) - Date.parse(read.at) <= 60_000 ? read : { kind: "step" as const, at, verb: "", detail: "" };
        Object.assign(item, { verb: "Waiting", detail: `for ${name}`, background: true });
        reads.delete(key);
        waits.set(key, item);
        if (item !== read) items.push(item);
      } else if (row) {
        waits.delete(key);
        const took = Math.max(0, Date.parse(at) - Date.parse(row.at));
        Object.assign(row, failed ? { verb: "Couldn’t", detail: `prepare ${name}` } : { verb: "Waited", detail: `${lengthLabel(took / 1000)} for ${name}` });
        // The next read of the same thing is the real one.
        for (const k of seen) if (k.includes(JSON.stringify(mediaId))) seen.delete(k);
      }
      continue;
    }
    if (event.type === "log" && event.data?.kind === "editor_progress") {
      const result = event.data.scanPage ? DialogueScanPage.safeParse(event.data.scanPage) : undefined;
      if (result?.success) {
        const page = result.data;
        const key = JSON.stringify([page.mediaId, page.end]);
        let scan = scans.get(key);
        if (!scan) {
          scan = { item: { kind: "step", at, verb: "Scanned", detail: "dialogue", pending: true, background: true }, start: page.from, ranges: [], end: page.end };
          scans.set(key, scan);
          items.push(scan.item);
          finishGroup();
        }
        scan.start = Math.min(scan.start, page.from);
        if (page.to !== undefined) scan.ranges = mergeRanges([...scan.ranges, { start: page.from, end: page.to }]);
        const seconds = scan.ranges.reduce((sum, r) => sum + r.end - r.start, 0);
        const total = scan.end - scan.start;
        const done = total > 0 && seconds >= total - 0.5;
        // An unfinished scan is the live row while the run works.
        Object.assign(scan.item, done
          ? { verb: "Scanned", detail: `all ${clock(total)} of dialogue`, pending: false }
          : { verb: "Scanned", detail: `${clock(seconds)} of ${clock(total)} of dialogue`, pending: true });
        continue;
      }
      if (typeof event.data.reviewCounter === "string") continue;
      const text = noteText(event.text);
      if (text && !notes.has(text)) { notes.add(text); items.push({ kind: "note", at, text }); finishGroup(); }
      continue;
    }
    if (event.type === "log" && !event.data?.kind) {
      const text = noteText(event.text);
      // The agent's last message is the reply under the bundle, not an update inside it.
      if (text && !notes.has(text) && !(final && event.text.trim() === final) && !(reply && event.text.trim() === reply)) { notes.add(text); items.push({ kind: "note", at, text }); finishGroup(); }
      continue;
    }
    if (event.type === "change") {
      const id = typeof event.data?.changeId === "string" ? event.data.changeId : undefined;
      const change = id ? changes.find(c => c.id === id) : undefined;
      if (change && !edited.has(change.id)) { edited.add(change.id); items.push(changeStep(change, at)); finishGroup(); }
      continue;
    }
    if (event.type !== "tool") continue;
    const name = toolName(event);
    const spec = toolSteps[name];
    if (!spec) continue;
    const args = input(event);
    const waitKey = waitTool[name] && typeof args.mediaId === "string" ? `${waitTool[name]}/${args.mediaId}` : undefined;
    // Calls that only collect work still being prepared are covered by the waiting row.
    if (waitKey && waits.has(waitKey)) continue;
    // Collecting a submitted picture batch looks at nothing new.
    if (typeof args.batchId === "string") continue;
    if (spec.once) {
      const key = name + JSON.stringify(args);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const count = places(event);
    if (group?.spec.group === spec.group) {
      group.count += count;
      group.found.push(...spans(event));
      for (const [key, read] of reads) if (read === group.item) reads.delete(key);
      continue;
    }
    finishGroup();
    const item = { kind: "step" as const, at, verb: spec.verb, detail: "" };
    items.push(item);
    group = { count, found: spans(event), first: event, item, spec };
    if (waitKey) reads.set(waitKey, item);
  }
  finishGroup();
  return items;
}

/** The tool an agent calls to collect each kind of media work. */
const waitTool: Record<string, string> = { transcript_get: "transcript", transcript_search: "transcript", waveform_get: "sound" };

function firstWords(text: string, words = 7) {
  const sentence = cutSummary(text).split(/(?<=[.!?])\s/u, 1)[0]!.replace(/[.!?]$/, "")
    // "From 0:03 to 56:41, a fixed zoom…" says where before what. Keep the what.
    .replace(/^(?:from|between) [\d:.]+ (?:to|and) [\d:.]+,?\s*/i, "");
  const short = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  const parts = short.split(/\s+/);
  if (parts.length <= words) return short;
  const kept = parts.slice(0, words);
  // End on a word that carries meaning, not "so" or "the".
  while (kept.length > 3 && /^(?:so|and|or|but|to|the|a|an|of|with|while|by|for|in|at|on|that|its|their)$/i.test(kept.at(-1)!)) kept.pop();
  return kept.join(" ").replace(/[,;:]$/, "") + "…";
}

/** A few words for the folded run: what it did, not how. */
export function runSummary(task: Task, change?: Change): string {
  if (task.state === "failed" && !change) return "Couldn’t finish";
  if (change) {
    const cuts = change.cutReasons ?? [];
    if (cuts.length) {
      const removed = cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
      const verb = change.state === "approved" ? "Removed" : "Suggested";
      return `${verb} ${lengthLabel(removed)} in ${plural(cuts.length, "cut")}`;
    }
    // Several named edits are listed under the reply, so the run line only counts them.
    const named = change.timelineEdits?.length ?? 0;
    if (named > 1) return `${change.state === "approved" ? "Made" : "Suggested"} ${plural(named, "edit")}`;
    const label = change.timelineEdits?.[0]?.label;
    // Edit labels are sometimes fragments ("the screen demonstrations"). Use them only when they read as a title.
    return label && label.length <= 48 && /^\p{Lu}/u.test(label) ? label : firstWords(change.description);
  }
  // Only what the chat would show as Scarlet's words: a reply that was commands, or the request said back, says
  // nothing here either.
  const said = editConfirmation(taskChatText(task), task.context.message ?? task.instruction);
  return said ? firstWords(said) : "Done";
}

/**
 * How long the run actually worked: from start to finish (or now), minus every stretch spent waiting
 * for the editor to answer a question. Time waiting on the editor is never Scarlet's work.
 */
function workClock(task: Task, events: readonly TaskEvent[]) {
  const time = (x?: string | null) => Date.parse(x ?? "") || 0;
  const start = time(task.startedAt) || time(task.createdAt);
  const waits: { from: number; to: number }[] = [];
  let asked: number | undefined;
  for (const event of events) {
    if (event.type !== "question" && event.type !== "answer") continue;
    const at = time(event.at);
    if (!at) continue;
    if (event.type === "question") asked ??= at;
    else if (asked !== undefined) { waits.push({ from: Math.max(asked, start), to: at }); asked = undefined; }
  }
  if (asked !== undefined) waits.push({ from: Math.max(asked, start), to: Infinity });
  return (end: number) => {
    if (!start || end <= start || (asked === undefined && task.state === "waiting_for_user")) return 0;
    let waiting = 0;
    for (const wait of waits) waiting += Math.max(0, Math.min(wait.to, end) - wait.from);
    return Math.max(0, end - start - waiting);
  };
}

export function workTime(task: Task, events: readonly TaskEvent[], now: number) {
  return workClock(task, events)(runIsActive(task) ? now : Date.parse(task.finishedAt ?? "") || now);
}

/** One line in an opened run: a step and how long it took, or an update from the agent. */
export type RunLine = { kind: RunItem["kind"]; text: string; took?: number; live?: boolean };

/**
 * The lines an opened run shows. A step takes until the next step starts, so the times add up to the
 * header's clock. Steps started together read as one line, because their time can't be split. Updates
 * from the agent and work that runs in the background, like a transcript, take no time of their own.
 */
export function runLines(task: Task, events: readonly TaskEvent[], items: readonly RunItem[], now: number): RunLine[] {
  // Each line also keeps how it reads while it's still going, for the live last line.
  const lines: Array<RunLine & { start?: number; parts?: string[]; doing?: string[] }> = [];
  const join = (parts: string[]) => parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
  for (const item of items) {
    if (item.kind === "note") { lines.push({ kind: "note", text: item.text }); continue; }
    const text = `${item.verb} ${item.detail}`;
    const doing = `${(!item.edit && ongoing.get(item.verb)) || item.verb} ${item.detail}`;
    if (item.background) { lines.push({ kind: "step", text }); continue; }
    const start = Date.parse(item.at) || 0;
    const previous = lines.at(-1);
    // An edit is always its own line.
    if (!item.edit && previous?.parts && previous.start !== undefined && start - previous.start < 1000) {
      previous.parts.push(lower(text));
      previous.doing?.push(lower(doing));
      continue;
    }
    lines.push({ kind: "step", text, start, ...(item.edit ? {} : { parts: [text], doing: [doing] }) });
  }
  const timed = lines.filter(line => line.start !== undefined);
  const active = runIsActive(task);
  const end = active ? now : Date.parse(task.finishedAt ?? "") || now;
  const workAt = workClock({ ...task, state: "running" }, events);
  timed.forEach((line, i) => {
    if (line.parts && line.parts.length > 1) line.text = join(line.parts);
    const next = timed[i + 1]?.start ?? end;
    line.took = Math.max(0, workAt(Math.max(next, line.start!)) - workAt(line.start!));
    // The step still going reads in the present: "Reading the transcript", not "Read".
    if (active && !timed[i + 1]) {
      line.live = true;
      if (line.doing?.length) line.text = line.doing.length === 1 ? line.doing[0]! : join(line.doing);
    }
  });
  return lines.map(({ start: _, parts: __, doing: ___, ...line }) => line);
}
