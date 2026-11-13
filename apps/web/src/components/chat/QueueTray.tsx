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
 * The requests waiting their turn, as a tray attached to the top of the message box they were sent from. Scarlet runs
 * one request at a time, so the tray reads in running order, which isn't always the order asked: the one marked Next
 * runs first.
 * Closed, it is one line: the next request and how many are queued. It opens upward into every queued request, each
 * with a way to change its words and a way to take it out of the queue. `waits` is what the next request waits for
 * when that is the editor, such as "Waits for your calls": it takes the place of Next on the closed line, since nothing
 * starts until they act. When what it waits for is theirs to waive, the calls of a dialogue pass, that request's row
 * has a small play mark before its pencil, named "Start now" on hover, which starts it without them (`onStart`).
 *
 * A request's pencil, or a click on its words, hands them to the message box to change (`onReword`). While they're
 * there (`rewording`) its row is lit and stays in view, and its pencil, lit too, puts them back as they were.
 */
export function QueueTray({ items, hint, waits, rewording, onRemove, onReword, onStart, opened }: {
  items: readonly QueuedRequest[]; hint?: string; waits?: string; rewording?: string; onRemove(id: string): void; onReword?(id: string): void;
  /** Start the next request without what it waits for. Given only while that is the editor's calls. */
  onStart?(id: string): void;
  /** Whether the tray is open, held by the page: the message box the tray sits on is built again each time it is aimed
   *  somewhere else, and a tray the editor opened must not shut by itself then. */
  opened?: [open: boolean, setOpen: (open: boolean) => void];
}) {
  const own = useState(false);
  const [open, setOpen] = opened ?? own;
  // With one request there's nothing to open: its line carries its own pencil and ×.
  const many = items.length > 1;
  useEffect(() => { if (!many) setOpen(false); }, [many]);
  // A long queue scrolls inside the tray: the row whose words are in the box is brought into view.
  const tray = useRef<HTMLDivElement>(null);
  useEffect(() => { if (rewording) tray.current?.querySelector(".is-rewording")?.scrollIntoView?.({ block: "nearest" }); }, [rewording]);
  if (!items.length) return null;
  // The row whose words are in the box says which request the box is changing, so the list stays open around it.
  const listed = open || (many && !!rewording);
  const next = waits ? <span className="queue-next is-waiting">{waits}</span> : <span className="queue-next">Next</span>;
  // In the open list every row starts at the same place, so the first is Next there and the heading says what it waits for.
  const row = (item: QueuedRequest, first: boolean, removable: boolean, listed = false) => {
    const editing = rewording === item.id;
    const reword = onReword && !item.fixed ? () => onReword(item.id) : undefined;
    return <div key={item.id} className={editing ? "queue-row is-rewording" : "queue-row"} title={item.text}>
      {first && !listed ? next : <span className="queue-next">{first ? "Next" : ""}</span>}
      {item.target && <span className="queue-target">{item.target}</span>}
      <span className={reword && !editing ? "queue-text is-rewordable" : "queue-text"} onClick={editing ? undefined : reword}>{item.text}</span>
      {first && onStart && !editing && <button type="button" className="queue-start" aria-label={`Start now: ${item.text}`}
        title="Start now, before your calls" onClick={() => onStart(item.id)}><Icon name="play" size={10} /></button>}
      {reword && <button type="button" className="queue-reword" aria-pressed={editing} aria-label={`Reword: ${item.text}`}
        title={editing ? "Leave as it was (Esc)" : "Reword"} onClick={reword}><Icon name="pencil" size={11} /></button>}
      {removable && <button type="button" className="queue-remove" aria-label={`Remove from the queue: ${item.text}`} title="Remove from the queue"
        onClick={() => onRemove(item.id)}><Icon name="x" size={11} /></button>}
    </div>;
  };
  const count = <span>{items.length} queued{waits && <span className="queue-waits"> · {waits}</span>}</span>;
  return <div className={listed ? "queue-tray is-open" : "queue-tray"} ref={tray} role="group" aria-label="Queued requests" data-log-private title={!listed ? hint : undefined}>
    {listed ? <>
      {/* While a request's words are in the box its row stays in view, so the heading has nothing to fold: it isn't a control then. */}
      {many && rewording ? <div className="queue-head">{count}</div>
        : <button type="button" className="queue-head" aria-expanded onClick={() => setOpen(false)}>
          {count}<span className="queue-chevron"><Icon name="chevron" size={12} /></span>
        </button>}
      <div className="queue-list">{items.map((item, i) => row(item, i === 0, true, true))}</div>
    </> : many ? <button type="button" className="queue-head" aria-expanded={false} onClick={() => setOpen(true)}>
      {next}
      {items[0]!.target && <span className="queue-target">{items[0]!.target}</span>}
      <span className="queue-text" title={items[0]!.text}>{items[0]!.text}</span>
      <span className="queue-count">{items.length} queued</span><span className="queue-chevron"><Icon name="chevron" size={12} /></span>
    </button> : row(items[0]!, true, true)}
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
