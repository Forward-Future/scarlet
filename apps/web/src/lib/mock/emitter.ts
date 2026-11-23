import type { WsEvent } from "@scarlet/shared";

/** Plays the role of the WebSocket for the demo. */
export class Emitter {
  private fns = new Set<(ev: WsEvent) => void>();
  on(fn: (ev: WsEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(ev: WsEvent) {
    // Deliver asynchronously, like a socket would.
    setTimeout(() => this.fns.forEach((fn) => fn(ev)), 0);
  }
}
