import type { Task } from "@scarlet/shared";
import type { Project, Timeline } from "@scarlet/timeline";

/**
 * A task as a request answered it, unless the socket already has it further on. The engine tells the socket first, so
 * an answer that says "queued" can arrive after the task was claimed, and would put a running request back in line.
 */
export function upsertAnswered(tasks: Task[], task: Task): Task[] {
  const held = tasks.find(t => t.id === task.id);
  return held && task.state === "queued" && held.state !== "queued" && held.state !== "waiting_for_user" ? tasks : upsert(tasks, task);
}

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function upsertEditingTasks(before: Task[], live: Task[], changed: Task[]): Task[] {
  const original = new Map(before.map(task => [task.id, task]));
  return changed.reduce((tasks, task) => {
    const current = tasks.find(item => item.id === task.id);
    // The socket can already have a later state, but the stop response can carry a new retry link.
    if (current && current !== original.get(task.id)) {
      return task.retryTaskId && !current.retryTaskId ? upsert(tasks, { ...current, retryTaskId: task.retryTaskId }) : tasks;
    }
    return upsert(tasks, task);
  }, live);
}

export function mergeSinceLoad<T extends { id: string }>(snapshot: T[], base: T[], live: T[]): T[] {
  if (base === live) return snapshot;
  const before = new Map(base.map(item => [item.id, item]));
  const newer = new Map(live.filter(item => item !== before.get(item.id)).map(item => [item.id, item]));
  const result = snapshot.map(item => {
    const update = newer.get(item.id);
    newer.delete(item.id);
    return update ?? item;
  });
  return [...result, ...newer.values()];
}

/** Project revisions order complete engine snapshots across the HTTP and realtime transports. */
function olderProject(incoming: Project, held: Project): boolean {
  return incoming.rowRevision !== undefined && held.rowRevision !== undefined && incoming.rowRevision < held.rowRevision;
}

/**
 * A version's content never changes, so a second read of the one on screen keeps the object the player was given.
 * A new object would reopen the playback stream and stop the video on a still.
 */
export function sameVersion(had: Timeline | null | undefined, read: Timeline | null): Timeline | null {
  return had && read && had.version === read.version && read.version !== "draft" ? had : read;
}

/** The waits before the store tries again to read the open project. After the last it stops trying. */
export const READ_AGAIN_AFTER_MS = [1000, 2000, 4000, 8000];

interface HeldProject {
  projectId: string;
  saved: Project;
  shown: Project;
  read: number;
  changed: number;
  rename?: { name: string };
  filings: Map<string, { value?: string; at: number }>;
}

/**
 * Tracks the open project as the engine last described it (`saved`) alongside optimistic local changes (a rename still
 * being saved, and filings an older engine confirmed without sending the project).
 */
export function createHeldProjectController() {
  let held: HeldProject | undefined;
  let clock = 0;

  const heldFor = (d: { id: string; project: Project }) => {
    // A project set from outside the store's actions starts again from what it shows.
    if (held?.projectId !== d.id || held.shown !== d.project) {
      held = { projectId: d.id, saved: d.project, shown: d.project, read: 0, changed: 0, filings: new Map() };
    }
    return held;
  };

  const showHeld = (h: HeldProject) => {
    let project = h.saved;
    // A filing the snapshot's read began after isn't in it.
    const filings = [...h.filings].filter(([, filing]) => filing.at > h.read);
    if (filings.length) {
      const completedThreads = { ...project.completedThreads };
      for (const [id, { value }] of filings) {
        if (value === undefined) delete completedThreads[id];
        else completedThreads[id] = value;
      }
      project = { ...project, completedThreads };
    }
    if (h.rename) project = { ...project, name: h.rename.name };
    return h.shown = project;
  };

  /**
   * Take a snapshot of the open project from the engine and return what to show, or nothing to keep what is shown.
   * An older one is left: by its revision, or, from an older engine that gives none, when it was read before the
   * snapshot held changed and is on the same head. `readAt`: when its read began, for a read that may have crossed
   * other changes. An event or an answer is current as it arrives.
   */
  const takeProject = (d: { id: string; project: Project }, incoming: Project, readAt = ++clock): Project | undefined => {
    const h = heldFor(d);
    if (olderProject(incoming, h.saved)) return undefined;
    const unordered = incoming.rowRevision === undefined || h.saved.rowRevision === undefined;
    if (unordered && h.changed > readAt && incoming.head === h.saved.head) return undefined;
    h.saved = incoming;
    h.read = readAt;
    h.changed = ++clock;
    for (const [id, filing] of h.filings) if (filing.at <= readAt) h.filings.delete(id);
    return showHeld(h);
  };

  /** Replace the held snapshot on a fresh project load while keeping in-flight rename and newer filings. */
  const resetOnLoad = (id: string, project: Project, readAt: number, hasPrev: boolean): Project => {
    const kept = hasPrev && held?.projectId === id ? held : undefined;
    held = {
      projectId: id, saved: project, shown: project, read: readAt, changed: ++clock,
      rename: kept?.rename, filings: new Map([...kept?.filings ?? []].filter(([, filing]) => filing.at > readAt)),
    };
    return showHeld(held);
  };

  return {
    tick: () => ++clock,
    heldFor,
    showHeld,
    takeProject,
    resetOnLoad,
  };
}
