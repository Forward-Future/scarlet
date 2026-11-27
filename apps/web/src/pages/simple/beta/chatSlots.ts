import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Chronological slots inside `.simple-chat` for single-edit revisions in the beta layout.
 * A revision belongs to the thread that created the edit, which may be far above in the chat;
 * portaling its unit into a chronological slot keeps it right where the editor sent it.
 */
export class ChatSlotStore {
  private hosts = new Map<string, HTMLElement>();
  private refs = new Map<string, (el: HTMLElement | null) => void>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  host(runId: string): HTMLElement | null {
    return this.hosts.get(runId) ?? null;
  }

  ref(runId: string) {
    let ref = this.refs.get(runId);
    if (!ref) {
      ref = el => {
        if (el ? this.hosts.get(runId) === el : !this.hosts.has(runId)) return;
        if (el) this.hosts.set(runId, el); else this.hosts.delete(runId);
        this.changed();
      };
      this.refs.set(runId, ref);
    }
    return ref;
  }
}

export const ChatSlotContext = createContext<ChatSlotStore | undefined>(undefined);

const never = () => () => {};
const zero = () => 0;

export function useChatSlots() {
  const store = useContext(ChatSlotContext);
  useSyncExternalStore(store?.subscribe ?? never, store?.snapshot ?? zero, store?.snapshot ?? zero);
  return store;
}
