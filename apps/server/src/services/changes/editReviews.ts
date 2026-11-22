import { threadTimeline, type FlagEditRequest, type KeepEditsRequest, type KeptEdit, type Task, type ThreadEdit, type UnkeepEditsRequest } from "@scarlet/shared";
import { timelineDuration, type Change } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { badRequest, conflict, notFound } from "../../errors.js";
import { logActivity, quote } from "../activity.js";
import { runRoot } from "../runAttempts.js";
import { saveChange } from "./common.js";

function groupEditsByChange<T extends { changeId: string }>(ctx: Ctx, projectId: string, edits: readonly T[]): Array<{ change: Change; edits: T[] }> {
  const byChange = new Map<string, T[]>();
  for (const edit of edits) byChange.set(edit.changeId, [...byChange.get(edit.changeId) ?? [], edit]);
  const out: Array<{ change: Change; edits: T[] }> = [];
  for (const [changeId, group] of byChange) {
    const change = ctx.repos.changes.get(changeId);
    if (!change || change.projectId !== projectId) throw notFound(`change ${changeId}`);
    out.push({ change, edits: group });
  }
  return out;
}

/**
 * The editor kept these edits. Each Keep is recorded on the change it names, with the name and reason to look the
 * editor read then, so a run of the request hears that the doubt is settled (`keptEdits`). Keeping again changes
 * nothing. Caller holds the write lock.
 */
export function keepEdits(ctx: Ctx, projectId: string, body: KeepEditsRequest) {
  let added = 0;
  for (const { change, edits } of groupEditsByChange(ctx, projectId, body.edits)) {
    const kept = [...change.kept ?? []];
    for (const edit of edits) {
      if (kept.some(k => k.spot === edit.spot && k.threadId === body.threadId && k.recheck === edit.recheck)) continue;
      const named = change.timelineEdits?.[edit.spot];
      const label = edit.label ?? named?.label, check = edit.check ?? named?.check;
      kept.push({ spot: edit.spot, threadId: body.threadId, at: now(), ...(edit.recheck && { recheck: edit.recheck }),
        ...(label && { label: label.slice(0, 180) }), ...(check && { check: check.slice(0, 120) }),
        ...(edit.range && body.version && { place: { version: body.version, range: edit.range } }) });
      added++;
    }
    if (kept.length !== (change.kept?.length ?? 0)) saveChange(ctx, { ...change, kept });
  }
  return { added };
}

/** The editor took these Keeps back (⌘Z). Taking back one that isn't recorded changes nothing. Caller holds the write lock. */
export function unkeepEdits(ctx: Ctx, projectId: string, body: UnkeepEditsRequest) {
  let removed = 0;
  for (const { change, edits } of groupEditsByChange(ctx, projectId, body.edits)) {
    const kept = (change.kept ?? []).filter(k => k.threadId !== body.threadId || !edits.some(e => e.spot === k.spot && e.recheck === k.recheck));
    if (kept.length === (change.kept?.length ?? 0)) continue;
    removed += (change.kept?.length ?? 0) - kept.length;
    saveChange(ctx, { ...change, kept: kept.length ? kept : undefined });
  }
  return { removed };
}

/** What the editor kept in a request, oldest first, as its runs hear of it. */
export function keptEdits(ctx: Ctx, projectId: string, threadId: string): KeptEdit[] {
  const changes = ctx.repos.changes.select("project_id = ? AND json_extract(json, '$.kept') IS NOT NULL", [projectId]);
  return changes.flatMap(change => (change.kept ?? []).filter(k => k.threadId === threadId).map(k => ({
    changeId: change.id, spot: k.spot, label: k.label ?? change.description, at: k.at,
    ...(k.check && { check: k.check }), ...(k.place && { place: k.place }) })))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** A flagged edit as the run that flagged it hears of it: what the editor reads and which request made it. */
interface FlaggedEdit { changeId: string; spot: number; label: string; request: string; range: { start: number; end: number }; at?: number }

/**
 * A run found a doubt about an edit already in the video, its own or another request's: a black gap a cut left, a line
 * played twice. The doubt goes on that edit, and the request that raised it lists the edit as one that needs the
 * editor until they keep it there, as an edit the run flagged as it made it does. Nothing about the edit changes.
 * The edit is named by its change and place, or found on the working cut where `range` falls. The range also
 * records what the editor should inspect. Caller holds the write lock.
 */
export function flagEdit(ctx: Ctx, projectId: string, task: Task, body: FlagEditRequest): { flagged: FlaggedEdit; version: string; alsoThere?: FlaggedEdit[] } {
  const project = ctx.repos.projects.get(projectId);
  if (!project?.head) throw conflict("no_timeline", "There is no video to flag an edit in yet.");
  const read = (version: string) => ctx.repos.versions.get(projectId, version)?.timeline;
  const head = read(project.head);
  if (!head) throw conflict("no_timeline", "There is no video to flag an edit in yet.");
  let location: NonNullable<Change["flags"]>[number]["location"];
  if (body.range) {
    const version = body.version && body.version !== "head" ? body.version : head.version;
    if (body.changeId === undefined && version !== head.version) {
      throw conflict("stale_flag_range", `The working cut is now ${head.version}. Read it with timeline_get or timeline_at and give the range there, or identify the edit by changeId and spot.`,
        { currentVersion: head.version });
    }
    const timeline = version === head.version ? head : read(version);
    if (!timeline) throw notFound(`version ${version}`);
    const duration = timelineDuration(timeline);
    if (body.range.end > duration + 1e-6) {
      throw badRequest("invalid_flag_range", `The range must lie on version ${version}, which is ${duration.toFixed(3)} s long. Read that version with timeline_get or timeline_at.`);
    }
    location = { version, range: { start: Math.min(body.range.start, duration), end: Math.min(body.range.end, duration) } };
  }
  const threads = ctx.repos.projects.threads(projectId);
  const links = ctx.repos.versions.links(projectId);
  // Every applied edit on the working cut, as its own request lists it, so a revision is flagged and not what it replaced.
  const edits = threads.filter(t => t.changes.some(c => c.state === "approved")).flatMap(thread =>
    threadTimeline({ ...thread, flagged: undefined }, head, links, read, project.settings.fps, project.media).filter(e => !e.elsewhere).map(edit => ({ edit, thread })));
  const named = (e: { edit: ThreadEdit; thread: { title: string } }): FlaggedEdit => ({ changeId: e.edit.changeId, spot: e.edit.spot,
    label: e.edit.label, request: e.thread.title, range: e.edit.range, ...(e.edit.at !== undefined && { at: e.edit.at }) });
  let found: (typeof edits)[number] | undefined;
  let alsoThere: (typeof edits) = [];
  if (body.changeId !== undefined) {
    found = edits.find(e => e.edit.changeId === body.changeId && e.edit.spot === body.spot);
    if (!found) {
      // A cold-open request flagged each of its three options here, which still waited for the editor, and was told
      // only that nothing was found (2026-11-15). An option carries its doubt from when it is saved.
      const staged = ctx.repos.changes.get(body.changeId);
      if (staged?.projectId === projectId && staged.state === "ready") {
        // A dialogue pass's staged cut is a call: the editor decides it whatever is flagged, and reads its reason as the note.
        // A revision told to save a check with timeline_propose tried a review save next, refused too (2026-11-18).
        throw badRequest("not_applied", `${body.changeId} waits for the editor and isn't in the video, so edit_flag can't mark it. ` + (staged.cutReasons?.length
          ? "Its staged cuts are the editor's calls: a doubt about one goes in the reason you save it with (dialogue_revise_cut or dialogue_review_save), which the editor reads on its card."
          : "Give the doubt as the edit's check when you save it with timeline_propose, and withdraw this one there."));
      }
      throw notFound(`edit ${body.spot} of change ${body.changeId} on the working cut`);
    }
  } else {
    const { start, end } = body.range!;
    // A cut is a point, where it joins; any other edit is the footage it changed. Each is weighed by how much of the
    // stretch it shares, a join inside the stretch counting as it would cover it all.
    const near = 0.25;
    const weigh = (e: ThreadEdit) => {
      if (e.at !== undefined) return e.at >= start - near && e.at <= end + near ? 1 : 0;
      const shared = Math.min(end, e.range.end) - Math.max(start, e.range.start);
      if (end - start < 1e-6) return start >= e.range.start - near && start <= e.range.end + near ? 1 : 0;
      return shared > 0 ? shared / (Math.max(end, e.range.end) - Math.min(start, e.range.start)) : 0;
    };
    const there = edits.map(e => ({ ...e, weight: weigh(e.edit) })).filter(e => e.weight > 0).sort((a, b) => b.weight - a.weight);
    if (!there.length) throw badRequest("no_edit_there", `No applied edit is on the working cut (${project.head}) between ${start.toFixed(2)} s and ${end.toFixed(2)} s. ` +
      "Read the current version's times with timeline_get or timeline_at. If no edit made it, say so in your reply.");
    [found, ...alsoThere] = there;
  }
  const change = ctx.repos.changes.get(found!.edit.changeId)!;
  const flags = change.flags ?? [];
  // A resumed run is a new task of the same run: the doubt it flags again is the one its earlier attempt flagged.
  const root = runRoot(task);
  const sameRun = (taskId: string) => taskId === task.id || (ctx.repos.tasks.get(taskId)?.resumeRootId ?? taskId) === root;
  const existing = flags.find(f => f.spot === found!.edit.spot && f.check === body.check && sameRun(f.taskId));
  if (!existing) {
    saveChange(ctx, { ...change, flags: [...flags, { spot: found!.edit.spot, check: body.check, taskId: task.id, at: now(), location }] });
    logActivity(ctx, { projectId, actor: { type: "scarlet", name: "Scarlet" }, type: "change.flagged",
      summary: `Scarlet flagged ${quote(found!.edit.label)}: ${quote(body.check, 120)}`,
      data: { changeId: change.id, threadId: change.threadId, taskId: task.id } });
  } else if (location && !existing.location) {
    saveChange(ctx, { ...change, flags: flags.map(f => f === existing ? { ...f, location } : f) });
  }
  return { flagged: named(found!), version: project.head, ...(alsoThere.length && { alsoThere: alsoThere.slice(0, 6).map(named) }) };
}
