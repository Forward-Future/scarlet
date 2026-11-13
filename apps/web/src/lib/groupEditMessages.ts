import { namedTimelineEdits, type Thread, type ThreadEdit } from "@scarlet/shared";
import { appliedReviewChange, cutSummary, dialogueReceipt } from "@scarlet/timeline";
import { editConfirmation } from "./taskActivity";
import type { EditDetail, ThreadEntry } from "./threads";

type Saved = Extract<ThreadEntry, { kind: "change" }>;

/** Project the chronological log into one result per saved change or batch. Only explicit
 * replacement references can fold an older result into a newer one. */
export function groupEditMessages(entries: ThreadEntry[], thread: Thread, edits: ThreadEdit[]): ThreadEntry[] {
  const saved = new Map<string, Saved>();
  const replies = new Map(entries.flatMap(entry => entry.kind === "agent" && entry.change ? [[entry.change.id, entry.text] as const] : []));
  for (const entry of entries) {
    if (entry.kind !== "change") continue;
    const c = entry.change;
    // A completed reply explains the outcome. Partial approvals and dialogue batches have
    // authoritative receipts for exactly what landed, independent of the proposed work.
    const text = (c.state === "approved" || c.state === "ready") && !c.appliedReview && !c.approvedSpots && !dialogueReceipt(c)
      ? replies.get(c.id) ?? entry.text : entry.text;
    saved.set(entry.change.id, { ...entry, text });
  }
  const replaced = new Map<string, Map<number, Saved>>();
  for (const edit of edits) {
    const latest = saved.get(edit.changeId);
    if (!latest) continue;
    for (const ref of edit.previous) {
      const spots = replaced.get(ref.changeId) ?? new Map<number, Saved>();
      spots.set(ref.spot, latest);
      replaced.set(ref.changeId, spots);
    }
  }
  const owners = new Map(saved);
  const requests = new Map<string, string>();
  for (const task of thread.tasks) {
    const root = task.resumeRootId ?? task.id;
    requests.set(task.id, root);
    for (const id of task.changeIds) requests.set(id, root);
  }
  const requestOf = (row: Saved) => requests.get(row.change.taskId ?? "") ?? requests.get(row.change.id);
  for (const [id, spots] of replaced) {
    const row = saved.get(id);
    if (!row) continue;
    const ranges = namedTimelineEdits(row.change) ?? appliedReviewChange(row.change).ranges;
    const request = requestOf(row);
    if (request && ranges.length && ranges.every((_, i) => {
      const replacement = spots.get(i);
      return replacement && requestOf(replacement) === request;
    })) {
      // A batch can be revised in several passes. Keep its shared receipt once.
      const latest = [...spots.values()].reduce((a, b) => a.at > b.at ? a : b);
      owners.set(id, latest);
    }
  }

  const taskResults = new Map<string, Saved>();
  for (const task of thread.tasks) {
    if (task.state !== "done") continue;
    const result = thread.changes.findLast(c => (c.taskId === task.id || task.changeIds.includes(c.id)) && owners.has(c.id));
    if (result) taskResults.set(task.id, owners.get(result.id)!);
  }

  const seen = new Map<Saved, Set<string>>();
  function explain(row: Saved, detail: EditDetail) {
    // Equal prose can still link different spots or carry a transcript excerpt.
    const prose = detail.text.trim().replace(/\.$/, "");
    if (prose === row.text.trim().replace(/\.$/, "") && detail.change?.id === row.change.id && !detail.edits?.length && !detail.excerpt) return;
    const key = JSON.stringify([prose, detail.excerpt, detail.change?.id, detail.edits?.map(ref => [ref.change.id, ref.spot, ref.end])]);
    const keys = seen.get(row) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    seen.set(row, keys);
    (row.details ??= []).push(detail);
  }

  const visible: ThreadEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "change") {
      const row = owners.get(entry.change.id)!;
      explain(row, { text: entry.text, change: entry.change });
      const description = editConfirmation(cutSummary(entry.change.description), undefined, "full");
      if (description && description !== entry.text) explain(row, { text: description, change: entry.change });
      if (row.change.id === entry.change.id) visible.push(row);
      continue;
    }
    if (entry.kind === "progress") {
      if (entry.edits?.length) {
        // A report can mention several edits. Keep the report once with all of its links.
        const targets = entry.edits.map(ref => {
          const original = owners.get(ref.change.id);
          const latest = replaced.get(ref.change.id)?.get(ref.spot);
          return latest && original && requestOf(original) === requestOf(latest) ? latest : original;
        });
        if (targets.every(Boolean)) {
          explain(targets[0]!, { text: entry.text, edits: entry.edits, excerpt: entry.excerpt });
          continue;
        }
      } else {
        const row = taskResults.get(entry.taskId);
        if (row) {
          (row.activity ??= []).push(entry);
          continue;
        }
      }
    }
    if (entry.kind === "agent" && entry.change) {
      const row = owners.get(entry.change.id);
      if (row) {
        explain(row, { text: entry.text, change: entry.change });
        continue;
      }
    }
    if (entry.kind === "firstCut" && entry.delivery.state === "ready" && entry.delivery.version && entry.delivery.change) {
      const row = owners.get(entry.delivery.change.id);
      if (row && !row.delivery) {
        row.delivery = entry.delivery;
        continue;
      }
    }
    visible.push(entry);
  }
  // A follow-up may be queued while the earlier request is finishing. Replay finished
  // turns together so its results don't read as the answer to the next request.
  const finished = new Map(thread.tasks.filter(t => t.state === "done").map(t => [t.id, t.resumeRootId ?? t.id]));
  const turns = new Map<string, ThreadEntry[]>();
  const ordered: ThreadEntry[] = [];
  function flush() {
    for (const turn of turns.values()) ordered.push(...turn);
    turns.clear();
  }
  for (const row of visible) {
    const turn = row.taskId && finished.get(row.taskId);
    if (!turn) { flush(); ordered.push(row); continue; }
    const items = turns.get(turn);
    if (items) items.push(row);
    else turns.set(turn, [row]);
  }
  flush();
  return ordered;
}
