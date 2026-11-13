import { newId } from "@scarlet/timeline";
import type { InspectionWindow, SheetRequest } from "@scarlet/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod/v3";

export type PictureRequest = z.output<typeof SheetRequest>;
export interface PreparedPictures { result: CallToolResult; windows: InspectionWindow[]; request: PictureRequest }
type Item = { index: number; pictures: PreparedPictures } | { index: number; error: string };
interface Batch {
  key: string; total: number; items: Item[]; delivered: number; touched: number; next: Promise<void>; wake(): void; stop: AbortController;
}

/** Batches kept at once. A model may keep three or four batches in flight while it opens the next. */
export const OPEN_BATCHES = 6;

/** MCP returns images with tool results. One call returns every window that is ready
 * within the wait, so the agent reads them together instead of one per turn. A cursor
 * collects windows that took longer and replays a response after a retry. */
export class PictureBatches {
  private batches = new Map<string, Batch>();
  private lifetime = new AbortController();
  constructor(private read: (request: PictureRequest, signal: AbortSignal) => Promise<PreparedPictures>,
    private opts: { workers?: number; waitMs?: number } = {}) {}

  start(requests: PictureRequest[]) {
    const key = JSON.stringify(requests);
    for (const [id, batch] of this.batches) {
      if (batch.items.length === batch.total && Date.now() - batch.touched > 300_000) this.batches.delete(id);
      else if (batch.key === key && batch.delivered < batch.total) return id;
    }
    // A new batch never waits on an old one. A fully delivered batch goes first, then the one left alone longest:
    // its unread windows stop decoding, and collecting it asks for its windows again.
    while (this.batches.size >= OPEN_BATCHES) {
      const open = [...this.batches];
      const [oldId, old] = open.find(([, b]) => b.delivered === b.total) ?? open.reduce((a, b) => b[1].touched < a[1].touched ? b : a);
      old.stop.abort();
      old.wake();
      this.batches.delete(oldId);
    }
    const id = newId("pictures");
    const batch: Batch = { key, items: [], total: requests.length, delivered: 0, touched: Date.now(), next: Promise.resolve(), wake() {},
      stop: new AbortController() };
    const signal = AbortSignal.any([this.lifetime.signal, batch.stop.signal]);
    const reset = () => { batch.next = new Promise(resolve => { batch.wake = resolve; }); };
    reset();
    this.batches.set(id, batch);
    let index = 0;
    const work = async () => {
      while (!signal.aborted && index < requests.length) {
        const i = index++;
        try { batch.items.push({ index: i, pictures: await this.read(requests[i]!, signal) }); }
        catch (err) { batch.items.push({ index: i, error: err instanceof Error ? err.message : String(err) }); }
        batch.wake();
        reset();
      }
    };
    for (let i = 0; i < Math.min(requests.length, this.opts.workers ?? 3); i++) void work();
    return id;
  }

  async collect(id: string, cursor: number) {
    const batch = this.batches.get(id);
    if (!batch) throw new Error("Picture batch unavailable. Submit its windows again.");
    if (cursor > batch.delivered) throw new Error("Use the returned picture batch cursor.");
    batch.touched = Date.now();
    // Stay under the common 60-second tool deadline while the rest of the batch finishes.
    const deadline = Date.now() + (this.opts.waitMs ?? 25_000);
    while (batch.items.length < batch.total && !this.lifetime.signal.aborted && !batch.stop.signal.aborted && Date.now() < deadline) {
      const timer = new AbortController();
      try { await Promise.race([batch.next, delay(deadline - Date.now(), undefined, { signal: timer.signal, ref: false })]); }
      finally { timer.abort(); }
    }
    const items = batch.items.slice(cursor);
    const end = cursor + items.length;
    batch.delivered = Math.max(end, batch.delivered);
    return { items, total: batch.total, nextCursor: end < batch.total ? end : null };
  }

  close() {
    this.lifetime.abort();
    for (const batch of this.batches.values()) batch.wake();
    this.batches.clear();
  }
}
