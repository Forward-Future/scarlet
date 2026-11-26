import { useEffect, useRef, useState } from "react";
import { ScarletApiError } from "@scarlet/shared";
import { Icon } from "../ui/primitives";

export interface QueuedRequest {
  id: string;
  /** What the editor asked, as they said it. */
  text: string;
  /** What it revises, when it's about one edit or cut: "Revising the cut at 2:05". */
  target?: string;
  /** Scarlet made this request itself, so its words aren't the editor's to change. */
  fixed?: boolean;
}

/**
 * The requests waiting their turn, in the chat as the editor's other messages are: each a bubble at the chat's right,
 * in running order, after the request Scarlet is on and just above the message box (the editor chose this on
 * 2026-11-24, in place of the tray on the box). Under each bubble one small line says where it stands: "Up next" for
 * the first, in amber what it waits for when that is the editor ("Waits for your calls"), "Queued" for the rest. Its
 * pencil, or a click on its words, hands them to the message box to change, and × takes it out of the queue; both show
 * while the pointer is on it. The request the calls hold back has a play mark before them, "Start now, before your
 * calls". While editing is paused with nothing under way, the last line says "Editing paused" with Resume.
 */
export function QueueInChat({ items, hint, waits, rewording, onRemove, onReword, onStart, paused: isPaused, onContinue }: {
  items: readonly QueuedRequest[]; hint?: string; waits?: string; rewording?: string; onRemove(id: string): void; onReword?(id: string): void;
  onStart?(id: string): void; paused?: boolean; onContinue?(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (rewording) list.current?.querySelector(".is-rewording")?.scrollIntoView?.({ block: "nearest" }); }, [rewording]);
  if (!items.length && !onContinue) return null;
  const row = (item: QueuedRequest, first: boolean) => {
    const editing = rewording === item.id;
    const reword = onReword && !item.fixed ? () => onReword(item.id) : undefined;
    const marker = isPaused ? null
      : first && waits ? <span className="queue-next is-waiting">{waits}</span>
      : <span className="queue-next">{first ? "Up next" : "Queued"}</span>;
    return <div key={item.id} className={editing ? "queue-row is-rewording" : "queue-row"}>
      <p className="queue-bubble">
        {item.target && <span className="queue-target">{item.target}</span>}
        <span className={reword && !editing ? "queue-text is-rewordable" : "queue-text"} onClick={editing ? undefined : reword}>{item.text}</span></p>
      <div className="queue-foot">
        {first && onStart && !editing && <button type="button" className="queue-start" aria-label={`Start now: ${item.text}`}
          title="Start now, before your calls" onClick={() => onStart(item.id)}><Icon name="play" size={10} /></button>}
        {reword && <button type="button" className="queue-reword" aria-pressed={editing} aria-label={`Reword: ${item.text}`}
          title={editing ? "Leave as it was (Esc)" : "Reword"} onClick={reword}><Icon name="pencil" size={11} /></button>}
        <button type="button" className="queue-remove" aria-label={`Remove from the queue: ${item.text}`} title="Remove from the queue"
          onClick={() => onRemove(item.id)}><Icon name="x" size={11} /></button>
        {marker}
      </div>
    </div>;
  };
  return <div className="queue-chat" ref={list} role="group" aria-label={items.length ? "Queued requests" : "Project editing"} data-log-private title={hint}>
    {items.map((item, i) => row(item, i === 0))}
    {(isPaused || onContinue) && <div className="queue-footer">
      <span className="queue-paused">Editing paused</span>
      {onContinue && <button type="button" className="queue-editing-action" aria-disabled={pending || undefined}
        title="Resume editing. Paused work picks up first, where it left off."
        onClick={async () => {
          if (pending) return;
          setPending(true);
          try { await onContinue(); } finally { setPending(false); }
        }}><Icon name="play" />Resume</button>}
    </div>}
  </div>;
}

/** How often the hold on a request being reworded is renewed. The engine lets it go after 90 s without one. */
const RENEW_HOLD_MS = 30_000;
/** How soon a hold that failed for another reason, such as the engine restarting, is asked for again. */
const RETRY_HOLD_MS = 3_000;

/**
 * Keep the queued request `id` from starting while its words are being changed, so it can't run with the words being
 * replaced, and let it go once `id` is unset. `onLost` runs when it can't be held: Scarlet began it first. Any other
 * failure keeps the words where they are and asks again shortly, since the hold outlasts a missed renewal.
 */
export function useRewordingHold(id: string | undefined, hold: (id: string, on: boolean) => Promise<void>, onLost: () => void) {
  const latest = useRef({ hold, onLost });
  latest.current = { hold, onLost };
  // The request being held now, and those the engine has confirmed it holds. A hold that lands after its words closed
  // is let go at once.
  const live = useRef<string | undefined>(undefined);
  const held = useRef(new Set<string>());
  useEffect(() => {
    if (!id) return;
    live.current = id;
    const release = (of: string) => {
      if (!held.current.delete(of)) return;
      void latest.current.hold(of, false).catch(() => {});
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    const take = (): Promise<void> => latest.current.hold(id, true).then(() => {
      held.current.add(id);
      if (live.current !== id) release(id);
    }, (error: unknown) => {
      if (live.current !== id) return;
      if (error instanceof ScarletApiError && error.code === "already_started") latest.current.onLost();
      else {
        clearTimeout(retry);
        retry = setTimeout(() => void take(), RETRY_HOLD_MS);
      }
    });
    void take();
    const renew = setInterval(() => void take(), RENEW_HOLD_MS);
    return () => {
      if (live.current === id) live.current = undefined;
      clearInterval(renew);
      clearTimeout(retry);
      release(id);
    };
  }, [id]);
}
