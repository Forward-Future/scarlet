import { useEffect, useRef, useState } from "react";
import { ScarletApiError } from "@scarlet/shared";
import { blurOnPointerClick } from "../../lib/hotkeys";
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
 * one request at a time, except those that are each about their own cut or edit, which start at once and never wait
 * here for one another. The tray reads in running order, which isn't always the order asked: the one marked Next
 * runs first.
 * Closed, it is one line: the next request and how many are queued. It opens upward into every queued request, each
 * with a way to take it out of the queue. New requests can have their words changed. `waits` is what the next waits for
 * when that is the editor, such as "Waits for your calls": it takes the place of Next on the closed line, since nothing
 * starts until they act. When what it waits for is theirs to waive, the calls of a dialogue pass, that request's row
 * has a small play mark before its pencil, named "Start now" on hover, which starts it without them (`onStart`).
 *
 * A request's pencil, or a click on its words, hands them to the message box to change (`onReword`). While they're
 * there (`rewording`) its row is lit and stays in view, and its pencil, lit too, puts them back as they were.
 *
 * Pause, Resume and Stop are at the right of the band of the request Scarlet has. While editing is `paused` the tray
 * says so ("Editing paused · 2 queued"), and holds Resume itself (`onContinue`) only when no band does: editing paused
 * with nothing under way, only requests waiting their turn.
 */
export function QueueTray({ items, hint, waits, rewording, onRemove, onReword, onStart, paused: isPaused, onContinue, opened }: {
  items: readonly QueuedRequest[]; hint?: string; waits?: string; rewording?: string; onRemove(id: string): void; onReword?(id: string): void;
  /** Start the next request without what it waits for. Given only while that is the editor's calls. */
  onStart?(id: string): void;
  /** Editing is paused in the project. */
  paused?: boolean;
  /** Resume editing the paused project, when nothing in the chat offers it. */
  onContinue?(): Promise<void>;
  /** Whether the tray is open, held by the page: the message box the tray sits on is built again each time it is aimed
   *  somewhere else, and a tray the editor opened must not shut by itself then. */
  opened?: [open: boolean, setOpen: (open: boolean) => void];
}) {
  const own = useState(false);
  const [open, setOpen] = opened ?? own;
  const [pending, setPending] = useState(false);
  const action = onContinue;
  // With one request there's nothing to open: its line is already shown.
  const many = items.length > 1;
  useEffect(() => { if (!many) setOpen(false); }, [many]);
  // A long queue scrolls inside the tray: the row whose words are in the box is brought into view.
  const tray = useRef<HTMLDivElement>(null);
  useEffect(() => { if (rewording) tray.current?.querySelector(".is-rewording")?.scrollIntoView?.({ block: "nearest" }); }, [rewording]);
  if (!items.length && !action) return null;
  // The row whose words are in the box says which request the box is changing, so the list stays open around it.
  const listed = many && (open || !!rewording);
  const marker = (first: boolean, expanded: boolean) => {
    if (first && !expanded && waits) return <span className="queue-next is-waiting">{waits}</span>;
    return <span className="queue-next">{first ? "Next" : ""}</span>;
  };
  // Every row in the open list starts in the same place, and the heading says what the next request waits for.
  const row = (item: QueuedRequest, first: boolean, expanded = false) => {
    const editing = rewording === item.id;
    const reword = onReword && !item.fixed ? () => onReword(item.id) : undefined;
    return <div key={item.id} className={editing ? "queue-row is-rewording" : "queue-row"} title={item.text}>
      {marker(first, expanded)}
      {item.target && <span className="queue-target">{item.target}</span>}
      <span className={reword && !editing ? "queue-text is-rewordable" : "queue-text"} onClick={editing ? undefined : reword}>{item.text}</span>
      {first && onStart && !editing && <button type="button" className="queue-start" aria-label={`Start now: ${item.text}`}
        title="Start now, before your calls" onClick={() => onStart(item.id)}><Icon name="play" size={10} /></button>}
      {reword && <button type="button" className="queue-reword" aria-pressed={editing} aria-label={`Reword: ${item.text}`}
        title={editing ? "Leave as it was (Esc)" : "Reword"} onClick={reword}><Icon name="pencil" size={11} /></button>}
      <button type="button" className="queue-remove" aria-label={`Remove from the queue: ${item.text}`} title="Remove from the queue"
        onClick={() => onRemove(item.id)}><Icon name="x" size={11} /></button>
    </div>;
  };
  const paused = <span className="queue-paused">Editing paused</span>;
  const count = isPaused ? <span>{paused}{items.length ? ` · ${items.length} queued` : ""}</span>
    : <span>{items.length} queued{waits && <span className="queue-waits"> · {waits}</span>}</span>;
  const first = items[0];
  const heading = !first ? <div className="queue-editing-status">{paused}</div>
    : (listed && rewording) || (isPaused && !many) ? <div className="queue-head">{count}</div>
    : many ? <button type="button" className="queue-head" aria-expanded={listed} onClick={e => { blurOnPointerClick(e); setOpen(!listed); }}>
      {listed || isPaused ? count : <>
        {marker(true, false)}
        {first.target && <span className="queue-target">{first.target}</span>}
        <span className="queue-text" title={first.text}>{first.text}</span>
        <span className="queue-count">{items.length} queued</span>
      </>}
      <span className="queue-chevron"><Icon name="chevron" size={12} /></span>
    </button> : row(first, true);
  return <div className={listed ? "queue-tray is-open" : "queue-tray"} ref={tray} role="group" aria-label={items.length ? "Queued requests" : "Project editing"} data-log-private title={!listed ? hint : undefined}>
    {(listed || (isPaused && first && !many)) && <div className="queue-list">{items.map((item, i) => row(item, i === 0, true))}</div>}
    {action ? <div className="queue-footer">
      {heading}<button type="button" className="queue-editing-action" aria-disabled={pending || undefined}
        title="Resume editing. Paused work picks up first, where it left off."
        onClick={async () => {
          if (pending) return;
          setPending(true);
          try { await action(); } finally { setPending(false); }
        }}><Icon name="play" />Resume</button>
    </div> : heading}
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
