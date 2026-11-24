import { useEffect, useRef, useSyncExternalStore } from "react";
import { Icon } from "../../components/ui/primitives";
import type { Thread } from "../../lib/threads";
import type { RailStore } from "./railStore";
import { letGo } from "./types";

/**
 * The column of edits between the chat and the video, for the whole video (the editor chose it on 2026-11-24, as
 * T3 Code lists its threads). What waits on the editor fills it, as one list with no tabs: every request draws its own
 * rows into its place there. Under them, quieter, Low risk lists every request's edits Scarlet didn't flag, at once and
 * under a dim line naming the request when more than one has some (the editor chose this on 2026-11-24, in place of a
 * line under each request's rows that opened them). At the column's foot Working lists the edits Scarlet is revising,
 * open until the editor folds it, and Done counts what the editor has decided and opens on a press. A request about the
 * whole video is not here: it runs in the chat.
 */
/** A request's name over its low-risk rows: its words, or for edits that came with no request, plainly that. */
const nameOf = (thread: Thread) => thread.tasks.length ? thread.title : "Earlier edits";

export function ReviewRail({ store, threads, open, onOpen, selected }: {
  store: RailStore;
  /** The requests in the order their rows are listed: the latest first. */
  threads: readonly Thread[];
  open: { working: boolean; done: boolean; low: boolean }; onOpen(section: "working" | "done" | "low", open: boolean): void;
  /** What is open on the card, so its row is kept in view. */
  selected?: string;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const host = useRef<HTMLElement>(null);
  const need = store.total("you"), optional = store.total("optional");
  const working = store.total("working"), done = store.total("done");
  // The row of the cut or edit that's open stays in view as Keep and ↑ ↓ move on.
  useEffect(() => {
    if (selected) host.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const slots = (section: "you" | "working" | "done") => threads.map(thread =>
    <div key={thread.id} className="review-slot" data-thread={thread.id} ref={store.ref(section, thread.id)} />);
  // Low risk numbers each request's edits on their own (1, 2, 3, then 1, 2): with more than one request there, each
  // request's rows sit under a dim line with its words, so the numbers read. An edit with no request is an earlier one.
  const lowFrom = threads.filter(thread => (store.info(thread.id)?.optional ?? 0) > 0);
  const lowSlots = threads.map(thread => <div key={thread.id} className="review-low-group">
    {lowFrom.length > 1 && lowFrom.includes(thread) && <p className="review-low-name" title={nameOf(thread)}>{nameOf(thread)}</p>}
    <div className="review-slot" data-thread={thread.id} ref={store.ref("low", thread.id)} />
  </div>);
  const nothing = need + optional + working + done === 0;
  const section = (name: "Working" | "Done", key: "working" | "done", count: number) => {
    const shown = open[key] && count > 0;
    return <>
      <button type="button" className={count ? "review-sec" : "review-sec is-none"} aria-expanded={shown} disabled={!count}
        onClick={letGo(() => onOpen(key, !open[key]))}>
        <span>{name}</span><b>{count}</b><Icon name="chevron" size={10} /></button>
      <div className="review-sec-body" role="group" aria-label={name} hidden={!shown}>{slots(key)}</div>
    </>;
  };
  return <aside ref={host} className="review-rail" aria-label="Edit lists" hidden={nothing}>
    <header className="review-rail-head">
      <h2>For you{need > 0 && <span className="review-rail-count" title={`${need} ${need === 1 ? "needs" : "need"} you`}>{need}</span>}</h2>
    </header>
    <div className="review-rail-scroll">
      <div className="review-rail-list" role="group" aria-label="For you">
        {slots("you")}
        {need === 0 && <p className="simple-review-empty">Nothing waits on you.</p>}
      </div>
      {/* The edits Scarlet didn't flag, listed at once and quieter, open until the editor folds them. */}
      <div className="review-low" hidden={optional === 0}>
        <button type="button" className="review-low-head" aria-expanded={open.low} onClick={letGo(() => onOpen("low", !open.low))}>
          <span>Low risk</span><b>{optional}</b><Icon name="chevron" size={10} /></button>
        <div className="review-low-body" role="group" aria-label="Low risk" hidden={!open.low}>{lowSlots}</div>
      </div>
    </div>
    <div className="review-rail-foot">
      {section("Working", "working", working)}
      {section("Done", "done", done)}
    </div>
  </aside>;
}
