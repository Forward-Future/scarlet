import { planRevert, newId, timelineDuration, type Change } from "@scarlet/timeline";
import type { MockStore } from "./store";
import { notFound, now } from "./util";

export function historyEdit(store: MockStore, projectId: string, target: string, action: "revert" | "restore", expectedHead: string, branch: string) {
  const project = store.projectById(projectId);
  const head = project.head;
  if (!head || head !== expectedHead || branch !== (project.branch ?? "main")) throw new Error("The video changed. Try again.");
  const versions = store.db.versions[projectId] ?? [];
  const selected = versions.find(v => v.version === target);
  if (!selected) throw notFound("Version");
  const lookup = (id: string) => store.db.changes.find(c => c.id === id) ?? null;
  const links = versions.map(v => ({ ...v, revertsVersion: v.changeId ? lookup(v.changeId)?.revertsVersion : undefined }));
  const result = action === "restore" ? store.db.timelines[target]! : planRevert(links, head, target, project.settings.fps,
    id => store.db.timelines[id]!, lookup);
  const version = newId("ver");
  const timeline = { ...result, version, parent: head, createdAt: now() };
  const description = `${action === "restore" ? "Restore" : "Undo"} · ${selected.description ?? target}`;
  const change: Change = { id: newId("chg"), projectId, fromVersion: head, toVersion: version, appliedOnto: head,
    appliedVersion: version, revertsVersion: action === "revert" ? target : undefined, description, author: store.human(),
    state: "approved", noteIds: [], renders: [], ranges: [], createdAt: now(), updatedAt: now() };
  store.db.timelines[version] = timeline;
  versions.unshift({ version, parent: head, revertsVersion: change.revertsVersion, name: timeline.name, author: change.author, changeId: change.id,
    description, duration: timelineDuration(timeline), isHead: true, createdAt: now() });
  store.db.changes.unshift(change);
  project.head = version;
  store.summary(projectId).head = version;
  store.emit({ type: "change.updated", projectId, change });
  store.emitProject(projectId);
  store.log(projectId, action === "restore" ? "version.restored" : "change.undone", description, { changeId: change.id, target });
  return { project, change };
}

export function checkout(store: MockStore, projectId: string, version: string) {
  const project = store.projectById(projectId);
  if (!store.db.timelines[version]) throw notFound("Version");
  const from = project.head ?? version;
  project.head = version;
  project.updatedAt = now();
  store.summary(projectId).head = version;
  const change: Change = { id: newId("chg"), projectId, fromVersion: from, toVersion: version, description: `Checked out ${store.db.versions[projectId]?.find((v) => v.version === version)?.description ?? version}`, author: store.human(), noteIds: [], ranges: [], state: "approved", renders: [], createdAt: now(), updatedAt: now() };
  store.db.changes.unshift(change);
  store.emit({ type: "change.updated", projectId, change });
  store.emitProject(projectId);
  return { project };
}
