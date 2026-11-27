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
 * The same request asked in a row about different spots (Add pressed on several to-dos) is one bubble, tagged by its
 * first spots and how many more ("Edit at 8:53, 9:26 +11"); a press on the tag shows each, with Show as one under them,
 * and its × takes them all out of the queue (the editor asked for it on 2026-11-26).
 */
export function QueueInChat({ items, hint, waits, rewording, onRemove, onReword, onStart, paused: isPaused, onContinue }: {
  items: readonly QueuedRequest[]; hint?: string; waits?: string; rewording?: string; onRemove(id: string): void; onReword?(id: string): void;
  onStart?(id: string): void; paused?: boolean; onContinue?(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  // The runs of the same request the editor has opened back into their own bubbles, by their first request.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (rewording) list.current?.querySelector(".is-rewording")?.scrollIntoView?.({ block: "nearest" }); }, [rewording]);
  if (!items.length && !onContinue) return null;
  const toggle = (id: string) => setOpened(was => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; });
  // The first request keeps a bubble of its own while it waits on the editor or can start before their calls.
  const runs = queueRuns(items, { keepFirst: !isPaused && (!!waits || !!onStart), apart: rewording });
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
  const batch = (run: readonly QueuedRequest[], first: boolean) => {
    const head = run[0]!;
    const names = run.map(item => item.target!);
    return <div key={head.id} className="queue-row queue-batch">
      <p className="queue-bubble">
        <button type="button" className="queue-target queue-batch-open" aria-expanded={false}
          aria-label={`${run.length} requests: ${names.join(", ")}. Show each`} title="Show each" onClick={() => toggle(head.id)}>{runTag(names)}</button>
        <span className="queue-text">{head.text}</span></p>
      <div className="queue-foot">
        <button type="button" className="queue-remove" aria-label={`Remove all ${run.length} from the queue: ${head.text}`}
          title={`Remove all ${run.length} from the queue`} onClick={() => run.forEach(item => onRemove(item.id))}><Icon name="x" size={11} /></button>
        {!isPaused && <span className="queue-next">{first ? "Up next" : "Queued"}</span>}
      </div>
    </div>;
  };
  return <div className="queue-chat" ref={list} role="group" aria-label={items.length ? "Queued requests" : "Project editing"} data-log-private title={hint}>
    {runs.map(({ run, index }) => run.length < 2 ? row(run[0]!, index === 0)
      : opened.has(run[0]!.id) ? [
        ...run.map((item, i) => row(item, index + i === 0)),
        <button key={`${run[0]!.id}:less`} type="button" className="queue-batch-close" aria-expanded onClick={() => toggle(run[0]!.id)}>
          Show as one</button>,
      ] : batch(run, index === 0))}
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

/**
 * The queue in running order, with the same request asked in a row about different spots, such as Add pressed on
 * several to-dos, gathered into one run: the chat shows a run as one bubble instead of a bubble for each spot. A run
 * needs the same words, each request aimed at a spot, and two or more requests. `keepFirst` leaves the first request
 * on its own, and `apart` names one that stays on its own (its words are in the message box to change).
 */
export function queueRuns(items: readonly QueuedRequest[], { keepFirst, apart }: { keepFirst?: boolean; apart?: string } = {}) {
  const runs: { run: QueuedRequest[]; index: number }[] = [];
  const joins = (item: QueuedRequest, i: number) => !!item.target && item.id !== apart && !(keepFirst && i === 0);
  items.forEach((item, i) => {
    const last = runs.at(-1);
    const prev = last?.run.at(-1);
    if (last && prev && joins(item, i) && joins(prev, last.index + last.run.length - 1)
      && prev.text.trim().toLowerCase() === item.text.trim().toLowerCase() && !!prev.fixed === !!item.fixed) last.run.push(item);
    else runs.push({ run: [item], index: i });
  });
  return runs;
}

/**
 * A run's tag, led by its times as each request's tag is: "Edit at 8:53, 9:26 +11". The first two spots are named, and
 * the rest counted; when the spots aren't all named the same way, the first is named and the rest counted.
 */
export function runTag(names: readonly string[]) {
  const parts = names.map(name => /^(.*?\bat )(.+)$/.exec(name));
  const prefix = parts[0]?.[1];
  const shown = 2;
  if (!prefix || parts.some(part => part?.[1] !== prefix)) return `${names[0]} +${names.length - 1}`;
  const times = parts.map(part => part![2]);
  return `${prefix}${times.slice(0, shown).join(", ")}${times.length > shown ? ` +${times.length - shown}` : ""}`;
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
