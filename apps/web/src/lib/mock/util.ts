import { ScarletApiError } from "@scarlet/shared";
import type { Task } from "@scarlet/shared";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const now = () => new Date().toISOString();
export const notFound = (what: string) => new ScarletApiError(404, "not_found", `${what} not found`);

/** A request that has stopped for good: it takes no more notes, words or retries of its own. */
export const isFinished = (state: Task["state"]) => ["done", "failed", "cancelled"].includes(state);
