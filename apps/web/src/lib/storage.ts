import type { StorageProject } from "@scarlet/shared";
import { api, IS_DESKTOP } from "./client";
import { desktop, type StorageSize } from "./desktop";
import { fmtBytes } from "./format";

export type MeasuredProject = Omit<StorageProject, "segments"> & StorageSize;
export interface StorageScan { projects: MeasuredProject[]; at: number }
let current: StorageScan | undefined;
let pending: Promise<StorageScan> | undefined;
let owner: typeof api | undefined;

/** What a permanent delete gives back, for its confirmation. Empty when nothing was measured. */
export function freedSpace(sizes: Pick<StorageSize, "bytes" | "estimated">[]): string {
  const bytes = sizes.reduce((sum, s) => sum + s.bytes, 0);
  return bytes ? (sizes.some(s => s.estimated) ? "about " : "") + fmtBytes(bytes) : "";
}

export function lastStorageScan() { return owner === api ? current : undefined; }

export function invalidateStorageScan() {
  pending = undefined;
  current = undefined;
}

export function scanStorage(catalog?: StorageProject[]): Promise<StorageScan> {
  if (owner !== api) {
    owner = api;
    invalidateStorageScan();
  }
  if (pending) return pending;
  const client = api;
  const job = (async () => {
    const projects = catalog ?? (await client.storage()).projects;
    const sizes = await desktop.measureProjectStorage(projects);
    const rows = projects.map(({ id, name, deletedAt, purgeAt, busy, missingSource }) => {
      const size = sizes[id];
      if (!size) throw new Error("Project storage changed. Rescan to refresh.");
      return { id, name, deletedAt, purgeAt, busy, missingSource, ...size };
    });
    return { at: Date.now(), projects: rows };
  })();
  pending = job;
  // Settled here before any caller waiting on the job carries on, so a scan asked for right after one is a new one.
  void job.then(scan => {
    if (pending !== job) return;
    pending = undefined;
    if (client === api) current = scan;
  }, () => {
    if (pending === job) pending = undefined;
  });
  return job;
}

/** Warm the inventory when the desktop has idle time. All automatic work is read-only. */
export function scheduleStorageScan() {
  if (!IS_DESKTOP) return;
  let idle: number | undefined;
  const schedule = () => {
    if (document.hidden) return;
    const scan = () => {
      const client = api;
      if (pending || document.hidden) return;
      void client.storage().then(({ projects }) => {
        if (client === api && !projects.some(p => p.busy)) return scanStorage(projects);
      }).catch(() => {});
    };
    if (window.requestIdleCallback) idle = window.requestIdleCallback(scan);
    else scan();
  };
  const first = window.setTimeout(schedule, 15_000);
  const interval = window.setInterval(schedule, 6 * 60 * 60 * 1000);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(interval);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
