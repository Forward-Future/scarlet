import { setTimeout as delay } from "node:timers/promises";
import { json, text, unmeasured, type ToolResult } from "./tool-result.js";

type JoinReading = Record<string, unknown>;
type Run = (publish: (index: number, reading: JoinReading, inspected?: () => void) => void) => Promise<ToolResult | void>;

interface JoinJob {
  done: Promise<ToolResult | void>;
  inspections: Map<number, () => void>;
  readings: (JoinReading | undefined)[];
  missed: Map<string, string>;
  finished?: number;
}

/**
 * The longest list of checked joins dialogue_check_join returns whole, in characters. Claude Code withholds a tool
 * result over 25,000 tokens, and a run has no tool to read it back with: lists of 24 to 35 cuts, 57,000 characters
 * and more, came back to real passes as "exceeds maximum allowed tokens", and each was checked again a few at a time
 * or saved unchecked.
 */
const JOIN_LIST_CHARS = 40_000;

/** Compact the response that is being delivered. Keep the original measurements for later collection. */
function joinList(job: JoinJob, version: string, pending: boolean) {
  const joins: JoinReading[] = job.readings.map(reading => reading ? { ...reading } : { status: "pending" });
  const header = pending ? { version, status: "measuring",
    pendingCuts: job.readings.flatMap((reading, i) => reading ? [] : [i]), retryAfterSeconds: 5,
    next: "Repeat the same arguments on the returned version after 5 seconds to collect the remaining readings." } : { version };
  const acknowledge = () => {
    for (const [i, inspected] of job.inspections) {
      if (joins[i]?.audio) { inspected(); job.inspections.delete(i); }
    }
  };
  const whole = JSON.stringify({ ...header, joins });
  if (whole.length <= JOIN_LIST_CHARS) { acknowledge(); return text(whole); }
  // A longer list would not reach the model at all, so it gives up its bulk: the words around each join, then
  // the readings at its edges. Joins with both edges on quiet give theirs up first, since nothing about them is
  // left to judge, then the others from the end of the list. Every join keeps its status and its range, and the
  // result names each one that came back without some of it, for the agent to check again in a shorter list.
  const short = new Set<number>();
  // Counted as if every join were named, so what goes back is never longer than this.
  let size = JSON.stringify({ ...header, joins, evidenceLeftOut: joins.map((_, i) => i) }).length;
  for (const [field, quiet] of [["nearbyWords", true], ["audio", true], ["alternativeWordRanges", true], ["nearbyWords", false], ["audio", false], ["alternativeWordRanges", false], ["acousticRetakeContinuity", true], ["acousticRetakeContinuity", false], ["partialWordRepeat", true], ["partialWordRepeat", false]] as const) {
    for (let i = joins.length - 1; i >= 0 && size > JOIN_LIST_CHARS; i--) {
      const join = joins[i]!;
      if (!(field in join) || (join.status === "unchanged") !== quiet) continue;
      // The value, its name in quotes, the colon and the comma.
      size -= JSON.stringify(join[field]).length + field.length + 4;
      delete join[field];
      short.add(i);
    }
  }
  acknowledge();
  return json({ ...header, joins, evidenceLeftOut: [...short].sort((a, b) => a - b) });
}

/** A slow join check survives individual MCP calls in this session. Deliver its final reading once so a
 * later independent check gets fresh transcript, scan and audio evidence, even on the same timeline. */
export class JoinChecks {
  private readonly jobs = new Map<string, JoinJob>();

  async collect(key: string, version: string, count: number, run: Run, waitMs: number): Promise<ToolResult> {
    for (const [id, job] of this.jobs) {
      if (job.finished !== undefined && Date.now() - job.finished > 10 * 60_000) this.jobs.delete(id);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 16) {
        const oldest = [...this.jobs].filter(([, j]) => j.finished !== undefined).sort((a, b) => a[1].finished! - b[1].finished!)[0];
        if (oldest) this.jobs.delete(oldest[0]);
        else return json({ status: "busy", version, next: "Other join checks are still running. Collect one of those checks, then retry this one." });
      }
      const readings = Array<JoinReading | undefined>(count).fill(undefined);
      const missed = new Map<string, string>();
      const inspections = new Map<number, () => void>();
      const done = unmeasured.run(missed, () => run((index, reading, inspected) => {
        readings[index] = reading;
        if (inspected) inspections.set(index, inspected);
      }));
      const entry: JoinJob = { done, readings, missed, inspections };
      this.jobs.set(key, entry);
      job = entry;
      // Keep errors for the polling caller too. Removing a failed job here would silently start it again.
      const finish = () => { entry.finished = Date.now(); };
      void done.then(finish, finish);
    }
    const timer = new AbortController();
    const pending = Symbol("still measuring");
    try {
      const result = await Promise.race([job.done, delay(waitMs, pending, { signal: timer.signal, ref: false })]);
      for (const [what, why] of job.missed) unmeasured.getStore()?.set(what, why);
      if (typeof result === "symbol") return joinList(job, version, true);
      if (this.jobs.get(key) === job) this.jobs.delete(key);
      if (!result) return joinList(job, version, false);
      // The single-cut response includes all of its audio evidence.
      job.inspections.get(0)?.();
      job.inspections.delete(0);
      return result;
    } catch (err) {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
      throw err;
    } finally { timer.abort(); }
  }
}
