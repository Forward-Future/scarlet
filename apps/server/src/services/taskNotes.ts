import { isProjectEditTask, type Task, type TaskNote } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, conflict } from "../errors.js";
import { FINISHED_TASK, saveTask } from "./tasks.js";

/**
 * Notes the editor adds to a request while Scarlet works on it ("Add a note" on its working line). A note is the
 * editor's words, kept on the run's latest attempt and carried on by each attempt that resumes it, so a quit, a restart
 * or a pause doesn't lose one. The run hears each note once: at the top of its next Scarlet tool result, or with the
 * instruction its next attempt starts with. What the note means is the model's to read; Scarlet only delivers it.
 */

/** The attempt of a run that is current: a resumed or retried run carries on under the attempt its last one names. */
function latestAttempt(ctx: Ctx, task: Task): Task {
  let current = task;
  for (let hops = 0; current.retryTaskId && hops < 100; hops++) {
    const next = ctx.repos.tasks.get(current.retryTaskId);
    if (!next || next.projectId !== task.projectId) break;
    current = next;
  }
  return current;
}

/**
 * Saves the editor's note on the request `task` belongs to. A request that has finished takes none: it answers
 * `task_finished`, and the app sends the words as a request of their own. Called with the write lock held.
 */
export function addTaskNote(ctx: Ctx, task: Task, text: string): Task {
  if (!isProjectEditTask(task)) throw badRequest("not_a_request", "Only a request that edits the video takes a note.");
  const current = latestAttempt(ctx, task);
  if (FINISHED_TASK.has(current.state)) throw conflict("task_finished", "Scarlet has finished this request, so the note goes as a request of its own.");
  const words = text.trim();
  if (!words) throw badRequest("empty_note", "A note needs words.");
  const notes = current.notes ?? [];
  if (notes.length >= 50) throw conflict("too_many_notes", "This request has as many notes as it can take. Send the words as a request of their own.");
  const note: TaskNote = { id: newId("tnt"), text: words, at: now() };
  ctx.log(`[task] ${current.id} the editor added a note`);
  return saveTask(ctx, { ...current, notes: [...notes, note] });
}

/** Marks these notes of `task` heard, and returns the task as saved. Called with the write lock held. */
export function markNotesHeard(ctx: Ctx, task: Task, ids: ReadonlySet<string>): Task {
  if (!ids.size || !task.notes?.some(n => ids.has(n.id) && !n.heardAt)) return task;
  const at = now();
  return saveTask(ctx, { ...task, notes: task.notes.map(n => ids.has(n.id) && !n.heardAt ? { ...n, heardAt: at } : n) });
}

/** The notes the run working on `task` hasn't heard, which it hears now. Called with the write lock held. */
export function takeUnheardNotes(ctx: Ctx, task: Task): TaskNote[] {
  const unheard = (task.notes ?? []).filter(n => !n.heardAt);
  if (unheard.length) markNotesHeard(ctx, task, new Set(unheard.map(n => n.id)));
  return unheard;
}

/** The editor's notes as the run hears them, in their own words as said. Undefined when there are none. */
export function editorNotesText(notes: readonly Pick<TaskNote, "text">[]): string | undefined {
  if (!notes.length) return undefined;
  if (notes.length === 1) return `The editor added a note to this request while you worked: “${notes[0]!.text}”`;
  return ["The editor added notes to this request while you worked:", ...notes.map(n => `- “${n.text}”`)].join("\n");
}
