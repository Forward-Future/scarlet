import { EventEmitter } from "node:events";
import type { Db } from "./db.js";
import type { WsEvent } from "@scarlet/shared";

/**
 * Internal event bus. Everything that changes state publishes a WsEvent here;
 * the WebSocket layer fans them out to subscribed clients. A few internal
 * (non-WS) events coordinate services (render completion, task queueing).
 */
export interface BusEvents {
  ws: [WsEvent];
  "render.finished": [{ renderId: string; projectId: string; state: "done" | "failed" | "cancelled" }];
  "task.queued": [{ taskId: string; projectId: string }];
}

export class Bus extends EventEmitter<BusEvents> {
  constructor(private readonly db: Db) {
    super();
  }

  /** The changes announced inside `asSaved`, each as it was last saved there. */
  private settling?: Map<string, { event: WsEvent }>;

  publish(event: WsEvent) {
    if (this.settling && event.type === "change.updated") {
      const held = this.settling.get(event.change.id);
      if (held) { held.event = event; return; }
      const first = { event };
      this.settling.set(event.change.id, first);
      this.db.afterCommit(() => this.emit("ws", first.event));
      return;
    }
    this.db.afterCommit(() => this.emit("ws", event));
  }

  /**
   * Runs one step that saves a change more than once, and announces that change once: as the step left it, in the
   * place of its first save. A window following the project is never told of a change half made, such as a revised
   * pass before its notes are carried onto it, which it would draw for the moment until the rest arrived.
   */
  asSaved<T>(step: () => T): T {
    if (this.settling) return step();
    this.settling = new Map();
    try {
      return step();
    } finally {
      this.settling = undefined;
    }
  }

  taskQueued(event: BusEvents["task.queued"][0]) {
    this.db.afterCommit(() => this.emit("task.queued", event));
  }

  renderFinished(event: BusEvents["render.finished"][0]) {
    this.db.afterCommit(() => this.emit("render.finished", event));
  }
}

/** Resolve true for a matching event, false on timeout or abort. */
export function waitFor<K extends keyof BusEvents>(
  bus: Bus,
  event: K,
  ms: number,
  filter: (...args: BusEvents[K]) => boolean = () => true,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const handler = (...args: BusEvents[K]) => {
      if (!filter(...args)) return;
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      bus.off(event, handler as never);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); resolve(false); };
    signal?.addEventListener("abort", abort, { once: true });
    bus.on(event, handler as never);
  });
}
