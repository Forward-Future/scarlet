import type { Task, User } from "@scarlet/shared";
import { clock, newId, type Note } from "@scarlet/timeline";
import { cleanupNote } from "../cleanup.js";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { createTask, parseAssignTo } from "./tasks.js";
import { ensureHead } from "./timeline.js";
import { actorFor, agentName, logActivity, quote } from "./activity.js";

export interface CreateNoteInput {
  version?: string;
  time: number;
  end?: number;
  clipIds?: string[];
  skillIds?: string[];
  text: string;
  voiceTranscript?: string;
  audioPath?: string;
  assignTo?: string;
  effort?: string;
  serviceTier?: string;
  changeId?: string;
}

/** Create a review note; optionally dispatch it to an agent as a `note` task. Never touches the timeline. */
export async function createNote(ctx: Ctx, user: User, projectId: string, input: CreateNoteInput, signal?: AbortSignal): Promise<{ note: Note; task?: Task }> {
  const { project, head } = ensureHead(ctx, projectId);
  let text = input.text;
  if (input.voiceTranscript) {
    const cleaned = await cleanupNote(ctx, input.voiceTranscript, { time: input.time, end: input.end, clipIds: input.clipIds }, signal);
    if (cleaned) text = cleaned;
  }
  const ts = now();
  const target = input.assignTo ? parseAssignTo(input.assignTo, ctx.settings().defaultAgent) : null;
  let note: Note = {
    id: newId("note"),
    projectId: project.id,
    version: input.version ?? head,
    time: input.time,
    end: input.end,
    clipIds: input.clipIds ?? [],
    text,
    voiceTranscript: input.voiceTranscript,
    audioPath: input.audioPath,
    author: actorFor(user),
    assignedTo: target ? (target.model ? `${target.agent}:${target.model}` : target.agent) : undefined,
    changeId: input.changeId,
    state: target ? "in_progress" : "open",
    createdAt: ts,
    updatedAt: ts,
  };
  // The task names the note, so a note that fails to save must not leave its task queued.
  return ctx.db.transaction(() => {
    let task: Task | undefined;
    if (target) {
      task = createTask(ctx, {
        projectId: project.id,
        kind: "note",
        agent: target.agent,
        model: target.model,
        effort: input.effort,
        serviceTier: input.serviceTier,
        instruction: text,
        context: {
          skillIds: input.skillIds,
          noteIds: [note.id],
          time: note.time,
          end: note.end,
          clipIds: note.clipIds,
          version: note.version,
          changeId: note.changeId,
        },
        createdBy: actorFor(user),
      });
    }
    note = ctx.repos.notes.put(note);
    ctx.bus.publish({ type: "note.updated", projectId: note.projectId, note });
    logActivity(ctx, {
      projectId: note.projectId,
      actor: actorFor(user),
      type: "note.added",
      summary: `${user.name} ${input.voiceTranscript ? "said" : "noted"} at ${clock(note.time)}: ${quote(note.text, 120)}${task ? ` (sent to ${agentName(task.agent)})` : ""}`,
      data: { noteId: note.id, taskId: task?.id, threadId: task?.context.threadId },
    });
    return { note, task };
  }, "immediate")();
}
