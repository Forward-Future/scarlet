import { cachedShare, Task, type ProjectActivity, type ProjectSummary } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { sourceCacheStatuses } from "./sourcePreviews.js";

/** The project's own requests. A skill's edit only borrows a project to run in. */
const REQUESTS = "('edit','note','revise')";

/**
 * What Scarlet is doing in each listed project, for the project list: a request it is working on, then files it
 * is importing, transcribing or caching. Saved state answers all but caching, so a project with nothing under way costs
 * nothing; only one with videos waiting to cache reads its cache files.
 */
export async function withActivity(ctx: Ctx, summaries: ProjectSummary[]): Promise<ProjectSummary[]> {
  if (!summaries.length) return summaries;
  const found = new Map<string, ProjectActivity[]>();
  const add = (projectId: string, activity: ProjectActivity) => {
    let list = found.get(projectId);
    if (!list) found.set(projectId, list = []);
    list.push(activity);
  };
  const paused = new Set((ctx.db.prepare("SELECT id FROM projects WHERE media_paused = 1").all() as { id: string }[]).map(row => row.id));

  // A request asking the editor something is counted with what needs them, not as work under way.
  const editing = new Map((ctx.db.prepare(`SELECT project_id, count(*) AS n FROM tasks
    WHERE state IN ('claimed','running') AND kind IN ${REQUESTS} GROUP BY project_id`)
    .all() as { project_id: string; n: number }[]).map(row => [row.project_id, row.n]));

  const importing = new Map((ctx.db.prepare("SELECT project_id, count(*) AS n FROM media WHERE status = 'ingesting' GROUP BY project_id")
    .all() as { project_id: string; n: number }[]).map(row => [row.project_id, row.n]));

  // A transcription waiting its turn counts as none of it done, so the figure doesn't jump when another file joins.
  const transcribing = new Map<string, { fractions: number[]; known: boolean; running: boolean }>();
  for (const row of ctx.db.prepare("SELECT project_id, state, json FROM tasks WHERE kind = 'transcribe' AND state IN ('queued','running')")
    .all() as { project_id: string; state: string; json: string }[]) {
    const progress = Task.shape.progress.safeParse(JSON.parse(row.json).progress);
    const fraction = progress.success ? progress.data?.fraction : undefined;
    let entry = transcribing.get(row.project_id);
    if (!entry) transcribing.set(row.project_id, entry = { fractions: [], known: false, running: false });
    entry.fractions.push(fraction ?? 0);
    entry.known ||= fraction !== undefined;
    entry.running ||= row.state === "running";
  }

  const caching = new Set((ctx.db.prepare(`SELECT DISTINCT m.project_id FROM source_cache_requests r JOIN media m ON m.id = r.media_id`)
    .all() as { project_id: string }[]).map(row => row.project_id));

  await Promise.all(summaries.map(async ({ id }) => {
    const edits = editing.get(id);
    if (edits) add(id, { kind: "editing", count: edits });
    const imports = importing.get(id);
    if (imports) add(id, { kind: "importing", count: imports });
    const words = transcribing.get(id);
    if (words) {
      const fraction = words.known ? words.fractions.reduce((a, b) => a + b, 0) / words.fractions.length : undefined;
      add(id, { kind: "transcribing", count: words.fractions.length, ...(fraction !== undefined && { fraction }),
        ...(!words.running && paused.has(id) && { paused: true }) });
    }
    if (caching.has(id)) {
      const cache = await cachingActivity(ctx, id, paused.has(id)).catch(() => undefined);
      if (cache) add(id, cache);
    }
  }));
  return summaries.map(s => {
    const activity = found.get(s.id);
    return activity ? { ...s, activity } : s;
  });
}

/**
 * The project's caching as one figure: how much of the footage it is caching is cached, by length. Videos cached
 * earlier count as done, so the figure is of the project's footage, and a video that isn't to be cached isn't in it.
 */
async function cachingActivity(ctx: Ctx, projectId: string, paused: boolean): Promise<ProjectActivity | undefined> {
  const caches = await sourceCacheStatuses(ctx, projectId);
  const left = caches.filter(c => c.state === "caching" || c.queued);
  if (!left.length) return undefined;
  const lengths = new Map(ctx.repos.projects.listMedia(projectId).map(m => [m.id, m.duration ?? 0]));
  const fraction = cachedShare(caches.map(cache => ({ cache, seconds: lengths.get(cache.mediaId) ?? 0 })));
  const running = caches.some(c => c.state === "caching");
  return { kind: "caching", count: left.length, ...(fraction !== undefined && { fraction }),
    ...(!running && paused && { paused: true }) };
}
