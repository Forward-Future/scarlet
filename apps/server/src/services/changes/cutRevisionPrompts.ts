import { z } from "zod/v3";
import { agentTarget, beginRevision, ReviseRequest as ReviseRequestSchema, type Task, type User } from "@scarlet/shared";
import { mergeRanges, newId, type Change, type Note } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { badRequest, conflict } from "../../errors.js";
import { actorFor, logActivity, quote } from "../activity.js";
import { createTask, parseAssignTo } from "../tasks.js";
import { authorsAgent, saveChange, threadOfChange } from "./common.js";

type ReviseRequest = z.output<typeof ReviseRequestSchema>;

/**
 * Where the stretch the editor marked sits in the cut their words are about, when it is only part of it: "leave this
 * part in" with the cut's first 0.3 s marked means that part, not the whole cut (2026-11-14).
 */
function markedPart(position: ReviseRequest["position"], start: number | undefined, end: number | undefined) {
  const marked = onPositionClock(position);
  if (!marked || start === undefined || end === undefined || end <= start) return undefined;
  const from = Math.max(marked.start, start), to = Math.min(marked.end, end);
  if (to - from < 0.005 || (marked.start <= start + 0.005 && marked.end >= end - 0.005)) return undefined;
  const where = from <= start + 0.005 ? "its first" : to >= end - 0.005 ? "its last" : "a middle";
  return `The editor marked ${marked.start.toFixed(2)}–${marked.end.toFixed(2)} s with these words: ${where} ${(to - from).toFixed(2)} s of the cut's ${(end - start).toFixed(2)} s.`;
}

/** The stretch the editor marked, when it is on the same timeline version as the request's position. */
function onPositionClock(position: ReviseRequest["position"]) {
  const marked = position?.markedRange;
  return marked && !marked.mediaId && !position.mediaId && (marked.version ?? position.version) === position.version ? marked : undefined;
}

/** Name the one staged cut a revision is about, with why it was proposed and how it was assessed. */
export function cutRevisionReference(change: Change, position: ReviseRequest["position"]): string {
  const index = position?.cutIndex;
  if (index === undefined) return "";
  const assessment = change.cutAssessments?.find(a => a.index === index);
  const staged = mergeRanges((change.cutReasons ?? []).map(({ start, end }) => ({ start, end })));
  const start = assessment?.start ?? staged[index]?.start ?? position?.time;
  const end = assessment?.end ?? staged[index]?.end ?? position?.end;
  const edit = change.cutEdits?.find(e => e.index === index);
  const span = edit ? `, at ${edit.range.start.toFixed(2)}–${edit.range.end.toFixed(2)} s on version ${edit.version}`
    : start !== undefined && end !== undefined ? `, removing ${start.toFixed(2)}–${end.toFixed(2)} s` : "";
  const proposed = start !== undefined && end !== undefined
    ? change.cutReasons?.find(r => r.start < end + 0.01 && r.end > start - 0.01) : undefined;
  const lines = [`This feedback is about one staged cut only: cut index ${index} of change ${change.id}${span}. Leave the other cuts as they are.`];
  const marked = markedPart(position, start, end);
  if (marked) lines.push(marked);
  const summary = assessment?.summary ?? proposed?.summary;
  if (summary) lines.push(`Summary shown in chat: "${summary}"`);
  if (proposed?.reason) lines.push(`Why this cut was proposed: "${proposed.reason.trim()}"`);
  if (assessment) lines.push(`Review note on this cut (${assessment.verdict}): "${assessment.reason.trim()}"`);
  return `\n\n${lines.join("\n")}`;
}

export function reviseChange(ctx: Ctx, user: User, change: Change, body: ReviseRequest): { change: Change; note: Note; task: Task } {
  if (change.state === "approved") throw conflict("invalid_state", "cannot revise an approved change");
  const position = body.position;
  if (position?.version && !ctx.repos.versions.exists(change.projectId, position.version)) throw badRequest("unknown_version", "The selected version does not belong to this project.");
  if (position?.mediaId && ctx.repos.projects.getMedia(position.mediaId)?.projectId !== change.projectId) throw badRequest("unknown_media", "The selected footage does not belong to this project.");
  const first = change.ranges[0];
  const ts = now();
  const target = body.assignTo
    ? parseAssignTo(body.assignTo, ctx.settings().defaultAgent)
    : change.author.type === "agent" && change.author.id
      ? authorsAgent(ctx, change.author)
      : { agent: ctx.settings().defaultAgent, model: undefined };
  const assignedTo = agentTarget(target.agent, target.model);
  // The editor's words sit on the part of the cut or edit they marked, when they marked one inside it: that is what
  // they are about. A stretch marked elsewhere is besides it, and the note stays on the cut or edit.
  const onClock = onPositionClock(position);
  const marked = onClock && position?.end !== undefined && onClock.start >= position.time - 0.005 && onClock.end <= position.end + 0.005 ? onClock : undefined;
  const note = ctx.repos.notes.put({
    id: newId("note"),
    projectId: change.projectId,
    version: position?.version ?? change.toVersion,
    time: marked?.start ?? position?.time ?? first?.start ?? 0,
    end: marked ? marked.end : position ? position.end : first?.end,
    clipIds: position?.clipIds ?? [],
    text: body.text,
    voiceTranscript: body.voiceTranscript,
    author: actorFor(user),
    assignedTo,
    changeId: change.id,
    state: "in_progress",
    createdAt: ts,
    updatedAt: ts,
  });
  ctx.bus.publish({ type: "note.updated", projectId: note.projectId, note });
  const task = createTask(ctx, {
    projectId: change.projectId,
    kind: "revise",
    agent: target.agent,
    model: target.model,
    effort: body.effort,
    serviceTier: body.serviceTier,
    instruction: body.text + cutRevisionReference(change, position),
    context: { skillIds: body.skillIds, changeId: change.id, noteIds: [note.id], ...position, version: note.version, time: position?.time ?? note.time, end: position ? position.end : note.end, threadId: threadOfChange(ctx, change), message: body.text },
    createdBy: actorFor(user),
  });
  const saved = saveChange(ctx, { ...beginRevision(change, task), noteIds: [...change.noteIds, note.id] });
  logActivity(ctx, {
    projectId: saved.projectId,
    actor: actorFor(user),
    type: "change.revise_requested",
    summary: `${user.name} asked for a new version of ${quote(change.description)}: ${quote(body.text, 120)}`,
    data: { changeId: change.id, threadId: saved.threadId, taskId: task.id },
  });
  return { change: saved, note, task };
}
