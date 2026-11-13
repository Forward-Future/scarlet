import { useSyncExternalStore } from "react";
import { desktop, type UpdateBuild, type UpdateStatus } from "./desktop";

const NONE: UpdateStatus = { ready: null, building: null };
const POLL_MS = 5000;

let enabled = false;
let status = NONE;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

// One round of asking at a time: a read overtaken by a newer one (shown again, or asked to look now) ends there.
let round = 0;

async function poll() {
  const mine = ++round;
  const next = await desktop.updateStatus().catch(() => NONE);
  if (mine !== round || !listeners.size) return;
  // The same answer keeps the same object, so nothing draws again until the updater has something new to say.
  if (JSON.stringify(next) !== JSON.stringify(status)) {
    status = next;
    listeners.forEach(listener => listener());
  }
  timer = setTimeout(poll, POLL_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (enabled && listeners.size === 1) void poll();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearTimeout(timer); timer = undefined; }
  };
}

/** Only the installed app that the local updater looks after has updates to show. */
export function enableUpdateStatus() { enabled = true; }

/** What the updater has for this app: a build under way, and a verified one that installs on restart. */
export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(subscribe, () => status);
}

/** Ask again now, after a restart was refused: the build it offered may be gone. */
export function refreshUpdateStatus() {
  if (!enabled || !listeners.size) return;
  clearTimeout(timer);
  void poll();
}

/**
 * How far along a build is, in whole percent. The updater says where its current part starts, how much of the build it
 * is and how long it took last time; the figure moves through that part at that pace. A part that runs longer than
 * last time waits at its end, and the figure never reads 100 before the updater says the build is verified.
 */
export function buildPercent(build: UpdateBuild, nowMs: number): number {
  const within = build.stepSeconds > 0 ? Math.min(1, Math.max(0, (nowMs / 1000 - build.stepStarted) / build.stepSeconds)) : 1;
  return Math.max(0, Math.min(99, Math.floor((build.done + build.step * within) * 100)));
}
