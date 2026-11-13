import type { TaskEvent } from "@scarlet/shared";
import { clock } from "./format";
import { pendingMediaWaits, taskActivityLabel, toolName, waitingFor } from "./taskActivity";
import { noteText } from "./taskRun";

/**
 * What Scarlet is doing this moment, in a few plain words: the one line a working request shows under its heading.
 *
 * It is the latest thing the run did, so it changes every few seconds while Scarlet works: a call on the project said
 * as the work it is ("Reading the dialogue at 12:34", "Checking how 4 joins sound", "Listening to Cut 2"), or Scarlet's
 * own latest sentence when that came after. Counts the engine keeps in the background, such as the pages of a scan or
 * how far the checked joins reach, say nothing Scarlet is doing and are passed over, and so is a saved edit: it is a
 * result, and the call that made it said what Scarlet was doing. `aim` is what Scarlet opened with (`runAim`'s `note`), which
 * reads once above this line and is not repeated on it.
 *
 * On 2026-11-10 a dialogue pass made over 100 calls in its first 9 minutes and wrote 4 sentences, so its stages read
 * as stuck between them. This line changed about every 15 seconds there.
 */
export function runNow(events: readonly TaskEvent[], aim?: string, callNumber?: CallNumber): string | undefined {
  const waits = pendingMediaWaits(events);
  // Waits that ended after the moment the walk back has reached: a wait that began before them is over.
  const ended = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    switch (event.type) {
      case "answer": return "Reading your answer";
      case "tool": {
        const name = toolName(event);
        if (name === "task_log") {
          const input = event.data?.input;
          const said = input && typeof input === "object" && "text" in input && typeof input.text === "string" ? spoken(input.text, aim) : undefined;
          if (said) return said;
          continue;
        }
        // A rule Scarlet picked up is offered in Learnings, and nothing about it is in the chat.
        if (name === "learning_suggest") continue;
        const wait = waitingFor(event, waits);
        if (wait) return taskActivityLabel(event, false, waits);
        const words = toolWords(name, event.data?.input, callNumber) ?? taskActivityLabel(event);
        if (words) return words;
        continue;
      }
      case "log": {
        const kind = event.data?.kind;
        if (kind === "init") return "Getting started";
        if (kind === "reasoning") return "Thinking";
        if (kind === "connection") return "Reconnecting to the model";
        if (kind === "media_wait") {
          const key = `${event.data?.wait}/${event.data?.mediaId}`;
          if (event.data?.done) ended.add(key);
          if (event.data?.done || ended.has(key)) continue;
          return taskActivityLabel(event);
        }
        if (kind && kind !== "editor_progress") continue;
        if (event.data?.scanPage || typeof event.data?.reviewCounter === "string") continue;
        const said = spoken(event.text, aim);
        if (said) return said;
        continue;
      }
      default: continue;
    }
  }
  return undefined;
}

/** The number of the call Scarlet made about a pass's cut, when it has asked the editor about that cut. */
export type CallNumber = (changeId: unknown, index: number) => number | undefined;

/** Scarlet's own words, unless they are what it opened with, which reads above this line (`runAim`'s `note`). */
function spoken(text: string, aim?: string) {
  const said = noteText(text);
  return said && said !== aim ? said : undefined;
}

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const field = (input: object, key: string) => key in input ? (input as Record<string, unknown>)[key] : undefined;
const count = (value: unknown) => Array.isArray(value) ? value.length : undefined;

/** A span of the recording, "1:02–1:10", or the moment it starts at. */
function span(input: object, from = "start", to = "end") {
  const start = num(field(input, from)), end = num(field(input, to));
  if (start === undefined) return "";
  return end !== undefined && end - start >= 1 ? ` ${clock(start)}–${clock(end)}` : ` at ${clock(start)}`;
}

/** A call on the project, said as the work it is. Undefined for a call with no words of its own here. */
function toolWords(name: string, raw: unknown, callNumber?: CallNumber): string | undefined {
  const input = raw && typeof raw === "object" ? raw : {};
  switch (name) {
    case "project_get": return "Looking at the project";
    case "media_list": return "Looking through your footage";
    case "notes_list": return "Reading your notes";
    case "audio_sync": return "Lining up the recordings";
    case "media_profile": return "Measuring the sound";
    case "source_audio": return "Checking the original sound";
    case "dialogue_scan": {
      const from = num(field(input, "from"));
      return !from ? "Reading the dialogue from the start" : `Reading the dialogue at ${clock(from)}`;
    }
    case "transcript_get": return `Reading the transcript${span(input, "from", "to")}`;
    case "transcript_search": {
      const query = field(input, "query");
      return typeof query === "string" && query.trim() ? `Searching the transcript for “${query.trim().slice(0, 40)}”` : "Searching the transcript";
    }
    case "media_frame": return `Looking at the picture${span(input, "t")}`;
    case "frame_contact_sheet": return `Looking at the picture${span(input)}`;
    case "frame_contact_sheet_batch": {
      const n = count(field(input, "windows"));
      return n && n > 1 ? `Looking at the picture in ${n} passages` : "Looking at the picture";
    }
    case "waveform_get": case "sound_picture": return `Looking at the waveform${span(input)}`;
    case "dialogue_check_join": {
      const n = count(field(input, "cuts"));
      return n && n > 1 ? `Checking how ${n} joins sound` : "Checking how the join sounds";
    }
    case "timeline_join_audit": return "Checking how the joins sound";
    case "dialogue_apply_cuts": {
      const n = count(field(input, "cuts"));
      const range = field(input, "range");
      const at = range && typeof range === "object" ? span(range) : "";
      const where = at.startsWith(" at ") ? at.replace(" at ", " from ") : at ? ` in${at}` : "";
      return `Saving ${n === 1 ? "1 cut" : n ? `${n} cuts` : "the cuts"}${where}`;
    }
    case "dialogue_review_inspect": {
      const index = num(field(input, "index"));
      const n = num(field(input, "count")) ?? 1;
      if (index === undefined) return "Listening to a flagged cut";
      if (n > 1 && !field(input, "wholePicture")) return `Listening to ${n} flagged cuts`;
      // "Cut 2" is a call's number, the one on its card and its dot. A cut Scarlet hasn't asked about has none.
      const call = callNumber?.(field(input, "changeId"), index);
      return call ? `Listening to Cut ${call}` : "Listening to a flagged cut";
    }
    case "dialogue_review_save": return "Saving the calls on the flagged cuts";
    case "dialogue_revise_cut": return "Moving the cut";
    case "timeline_get": case "timeline_summary": case "timeline_at": return "Looking at the timeline";
    case "timeline_transcript": return "Reading the video’s words";
    case "timeline_propose": return "Making the edit";
    case "captions_generate": return "Making captions";
    case "render_request": return "Rendering a preview";
    case "render_status": return "Waiting for the preview";
    case "skills_list": return "Reading the skills";
    default: return undefined;
  }
}
