import type { Change } from "@scarlet/timeline";
import type { DialogueInspection } from "./dialogue-review.js";

/** Bounded work shared by everything that decodes pictures. A freed slot goes to the most
 * urgent waiter, judged when the slot frees, so work can be promoted while it waits. */
export class Lanes {
  private active = 0;
  private waiting: { priority: () => number; go(): void }[] = [];
  constructor(private size: number) {}

  async run<T>(priority: () => number, work: () => Promise<T>): Promise<T> {
    if (this.active < this.size) this.active++;
    else await new Promise<void>(go => this.waiting.push({ priority, go }));
    try { return await work(); }
    finally {
      let best = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        if (best < 0 || this.waiting[i]!.priority() > this.waiting[best]!.priority()) best = i;
      }
      // The finished slot passes straight to the chosen waiter.
      if (best >= 0) this.waiting.splice(best, 1)[0]!.go();
      else this.active--;
    }
  }
}

/** The agent is waiting, the agent reads it next, or the agent may ask for it. */
export type Urgency = "now" | "next" | "later";
export const urgencyRank = (u: Urgency) => u === "now" ? 2 : u === "next" ? 1 : 0;

export interface InspectionRequest { index: number; audio: boolean; wholePicture: boolean }
type Compute = (change: Change, request: InspectionRequest, priority: () => number) => Promise<DialogueInspection>;
interface Queue { change: Change; total: number; next: number; reached: number; workers: number }

/**
 * Second-pass inspections of a pending dialogue pass, prepared a few cuts ahead of the agent.
 * Each prepared result is delivered once. Asking for the same cut again inspects it afresh.
 */
export class ReviewInspections {
  private prepared = new Map<string, { job: Promise<DialogueInspection>; urgency: Urgency }>();
  private queues = new Map<string, Queue>();
  private closed = false;

  constructor(private compute: Compute, private opts: { lookahead?: number; workers?: number; kept?: number } = {}) {}

  private key(change: Change, r: InspectionRequest) {
    return JSON.stringify([change.id, change.fromVersion, change.toVersion, r.index, r.audio, r.wholePicture]);
  }

  /** Start or join one inspection. Joining can only make it more urgent. */
  prepare(change: Change, request: InspectionRequest, urgency: Urgency = "next") {
    const key = this.key(change, request);
    const entry = this.prepared.get(key);
    if (entry) {
      if (urgencyRank(urgency) > urgencyRank(entry.urgency)) entry.urgency = urgency;
      return entry.job;
    }
    const own: { job: Promise<DialogueInspection>; urgency: Urgency } = { job: undefined!, urgency };
    own.job = this.compute(change, request, () => urgencyRank(own.urgency));
    this.prepared.set(key, own);
    own.job.catch(() => { if (this.prepared.get(key) === own) this.prepared.delete(key); });
    // Results carry images. Drop the oldest one the agent never asked for.
    const kept = this.opts.kept ?? 24;
    for (const old of this.prepared.keys()) {
      if (this.prepared.size <= kept) break;
      if (old !== key) this.prepared.delete(old);
    }
    return own.job;
  }

  /** The inspection for the agent, prepared already or now. */
  async take(change: Change, request: InspectionRequest) {
    const key = this.key(change, request);
    const job = this.prepare(change, request, "now");
    try { return await job; }
    finally { if (this.prepared.get(key)?.job === job) this.prepared.delete(key); }
  }

  /** Keep the cuts from `reached` on prepared, a few at a time. */
  ahead(change: Change, reached: number, total: number) {
    if (this.closed) return;
    const id = JSON.stringify([change.id, change.fromVersion, change.toVersion]);
    let q = this.queues.get(id);
    if (!q) this.queues.set(id, q = { change, total, next: reached, reached, workers: 0 });
    q.reached = Math.max(q.reached, reached);
    q.next = Math.max(q.next, q.reached);
    // A worker with nothing to do returns at once, so start only as many as there are cuts to prepare.
    const room = Math.min(q.total, q.reached + (this.opts.lookahead ?? 8)) - q.next;
    const start = Math.min(room, (this.opts.workers ?? 2) - q.workers);
    for (let i = 0; i < start; i++) {
      q.workers++;
      void this.work(q);
    }
  }

  private async work(q: Queue) {
    try {
      while (!this.closed && q.next < q.total && q.next < q.reached + (this.opts.lookahead ?? 8)) {
        const index = q.next++;
        await this.prepare(q.change, { index, audio: false, wholePicture: false }, "next").catch(() => undefined);
      }
    } finally { q.workers--; }
  }

  close() {
    this.closed = true;
    this.prepared.clear();
    this.queues.clear();
  }
}
