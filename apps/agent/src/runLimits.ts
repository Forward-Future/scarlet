/** A run's optional time cap and stall limit, in the words the prompt and the task error use for them. */

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/**
 * A run's time cap as the prompt request takes it: whole minutes, rounded up as the stop reason rounds them.
 * The engine takes a limit of up to a day and refuses the request over that, so a longer one is left out: the host
 * still stops the run at it, and the prompt names no limit rather than a shorter one nothing enforces. Matches the desktop host.
 */
export function promptTimeLimit(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  const limit = Math.max(1, Math.ceil(timeoutMs / 60_000));
  return limit <= 24 * 60 ? limit : undefined;
}

/** The task error for a run stopped at the optional time cap. The app reads the minutes from it. Matches the desktop host. */
export function timedOutReason(limitMs: number): string {
  return `timed out after ${minutes(limitMs)}, the limit for one agent run`;
}

/** The task error for a run stopped because its agent went silent. The app reads the minutes from it. Matches the desktop host. */
export function stalledReason(stallMs: number): string {
  return `stalled: the agent wrote nothing for ${minutes(stallMs)}`;
}
