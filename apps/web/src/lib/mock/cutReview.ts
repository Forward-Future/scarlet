import { ScarletApiError } from "@scarlet/shared";
import { applyReviewRemovals, contentHash, makeStagedCutMapper, planCutReview, reviewedTimeline } from "@scarlet/timeline";
import type { Change, Project, Timeline, TimeRange } from "@scarlet/timeline";
import type { MockDb } from "./fixtures";
import type { MockStore } from "./store";
import { notFound } from "./util";

/**
 * The cuts of a pass to review one by one, and, with the cuts the editor keeps out, the draft that applies the rest:
 * onto the pass's own base, or onto `ontoVersion`, the working edit as it is now. Drafts are saved as timelines.
 */
export function buildCutReview(db: MockDb, change: Change, project: Project, restoredCuts?: number[], ontoVersion?: string) {
  const stale = (reason: string) => new ScarletApiError(409, "cut_review_stale", reason, { currentVersion: project.head });
  if (ontoVersion !== undefined && ontoVersion !== project.head) throw stale("The video changed while this cut was open. Open it again.");
  const base = db.timelines[change.fromVersion], proposed = db.timelines[change.toVersion];
  const review = base && proposed ? planCutReview(base, proposed, db.media[change.projectId] ?? [], change.ops, change.firstCut) : null;
  if (!review) return { review: null };
  const save = (tl: Timeline, parent = change.fromVersion) => {
    if (tl === base || tl === proposed) return tl;
    const version = contentHash(tl, ["version", "parent", "createdAt"]).slice(0, 16);
    return db.timelines[version] ??= { ...tl, version, parent };
  };
  if (review.firstCut) review.original = save(review.original);
  if (ontoVersion === undefined) return { review, draft: restoredCuts && save(reviewedTimeline(review, restoredCuts)) };
  const restored = new Set(restoredCuts);
  if (!restoredCuts || restored.size !== restoredCuts.length || restoredCuts.some(i => !Number.isInteger(i) || i < 0 || i >= review.cuts.length))
    throw new ScarletApiError(400, "invalid_cut_selection", "Unknown or duplicate cut in review.");
  if (ontoVersion === change.fromVersion && !change.cutEdits?.length) {
    const removed = review.cuts.flatMap((cut, i) => restored.has(i) ? [] : [cut.removed]);
    return { review, draft: save(reviewedTimeline(review, restoredCuts)), ontoVersion, removed };
  }
  if (review.firstCut) throw stale("The opening assembly changed during review.");
  const head = db.timelines[ontoVersion];
  if (!head) throw notFound("Version");
  const selected: { index: number; range: TimeRange }[] = [];
  const mappers = new Map<string, ReturnType<typeof makeStagedCutMapper>>();
  for (const [i, cut] of review.cuts.entries()) {
    if (restored.has(i)) continue;
    const edit = change.cutEdits?.find(e => e.index === i);
    const from = edit ? db.timelines[edit.version] : base;
    if (!from) throw notFound("Version");
    const range = edit?.range ?? cut.removed;
    if (range.start === range.end) continue;
    let map = mappers.get(from.version);
    if (!map) {
      map = makeStagedCutMapper(from, head, project.settings.fps);
      mappers.set(from.version, map);
    }
    const location = map(range);
    if (location.kind === "conflict") throw stale(location.reason);
    if (location.kind !== "gone") selected.push({ index: i, range: location.range });
  }
  selected.sort((a, b) => a.range.start - b.range.start);
  const removed = selected.map(c => c.range);
  if (removed.some((r, i) => i > 0 && r.start < removed[i - 1]!.end - 1e-6)) throw stale("Two proposed cuts now cover the same footage.");
  const draft = selected.length ? save(applyReviewRemovals(head, removed, review.proposed.version), ontoVersion) : head;
  return { review, draft, ontoVersion, removed };
}

export async function reviewCuts(store: MockStore, changeId: string, restoredCuts?: number[], ontoVersion?: string) {
  store.requireAuth();
  const change = store.changeById(changeId);
  return buildCutReview(store.db, change, store.projectById(change.projectId), restoredCuts, ontoVersion);
}
