import type { TrashedProject } from "@scarlet/shared";
import type { Project } from "@scarlet/timeline";
import { now } from "./util";

/** The sample library's Trash keeps a project 30 days, as the engine's does. */
const purgeDate = (deletedAt: string) => new Date(Date.parse(deletedAt) + 30 * 86400000).toISOString();

/** The demo's deleted projects, newest first. */
export class Trash {
  private entries: Array<{ project: Project; deletedAt: string }> = [];

  has(projectId: string): boolean {
    return this.entries.some(t => t.project.id === projectId);
  }
  add(project: Project) {
    this.entries.unshift({ project, deletedAt: now() });
  }
  /** Takes a project back out of the Trash. */
  take(projectId: string): { project: Project; deletedAt: string } | undefined {
    const t = this.entries.find((x) => x.project.id === projectId);
    if (t) this.entries = this.entries.filter((x) => x.project.id !== projectId);
    return t;
  }
  /** Deletes projects for good. */
  purge(projectIds: Set<string>) {
    this.entries = this.entries.filter(t => !projectIds.has(t.project.id));
  }
  rows(): TrashedProject[] {
    return this.entries.map((t) => ({ id: t.project.id, name: t.project.name, deletedAt: t.deletedAt, purgeAt: purgeDate(t.deletedAt) }));
  }
}
