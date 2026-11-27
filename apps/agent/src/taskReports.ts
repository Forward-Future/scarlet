/**
 * How a run's events and live token counts reach the engine: in stream order, without letting a stuck engine hold up
 * the run's completion, and without a slow usage report overwriting a later one.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { AgentUsage, ScarletClient, Task, TaskEvent } from "@scarlet/shared";
import { humanDuration } from "./logText.js";
import { errMsg } from "./runners/spawn.js";
import { addUsage } from "./runners/usage.js";

/** Forward events in stream order and bound how long completion waits for a stuck engine. */
export function createEventForwarder(client: ScarletClient, task: Task, signal: AbortSignal, log: (msg: string) => void, flushLimitMs: number) {
  let posting: Promise<void> = Promise.resolve();
  const post = (ev: TaskEvent): Promise<void> => {
    const at = new Date().toISOString();
    return (posting = posting.then(async () => {
      if (signal.aborted) return;
      try {
        await client.postTaskEvent(task.id, { ...ev, taskId: task.id, at }, task.startedAt);
      } catch (err) {
        log(`task ${task.id}: post event failed: ${errMsg(err)}`);
      }
    }));
  };
  const flush = async () => {
    const timer = new AbortController();
    const late = await Promise.race([posting.then(() => false), delay(flushLimitMs, true, { signal: timer.signal }).catch(() => false)]);
    timer.abort();
    if (!late) return;
    log(`task ${task.id}: events still posting after ${humanDuration(flushLimitMs)}; finishing without waiting for them`);
    posting = Promise.resolve(); // What follows is not queued behind a request that hangs.
  };
  return { post, flush };
}

/**
 * The engine replaces repeated usage reports for the same claim. Serialize live writes (throttled every 2s)
 * and wait for any in-flight report before persisting the final total so slower requests cannot overwrite it.
 */
export function createLiveUsageReporter(client: ScarletClient, task: Task, signal: AbortSignal, log: (msg: string) => void) {
  const startedAt = task.startedAt;
  let closed = false;
  let pending: AgentUsage | undefined;
  let inFlight: Promise<unknown> | undefined;
  let nextAt = 0;
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    clearTimeout(timer);
    if (closed || signal.aborted || !pending || inFlight) return;
    const wait = nextAt - Date.now();
    if (wait > 0) {
      timer = setTimeout(flush, wait).unref();
      return;
    }
    const body = { ...pending, startedAt };
    pending = undefined;
    inFlight = client.recordTaskUsage(task.id, body, AbortSignal.timeout(5000))
      .catch(err => log(`task ${task.id}: live usage report failed: ${errMsg(err)}`)).finally(() => {
      inFlight = undefined;
      nextAt = Date.now() + 2000;
      flush();
    });
  };
  return {
    update: (snapshot: AgentUsage, priorUsage?: AgentUsage) => {
      if (!startedAt || closed) return;
      pending = addUsage(priorUsage, snapshot);
      flush();
    },
    recordFinal: async (usage: AgentUsage | undefined) => {
      closed = true;
      clearTimeout(timer);
      await inFlight;
      if (usage) await client.recordTaskUsage(task.id, { ...usage, startedAt: task.startedAt }).catch(err => log(`usage report failed: ${errMsg(err)}`));
    },
  };
}
