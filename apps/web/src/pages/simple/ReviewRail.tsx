import { useEffect, useRef, useSyncExternalStore } from "react";
import { Icon } from "../../components/ui/primitives";
import type { Thread } from "../../lib/threads";
import type { RailStore } from "./railStore";
import { letGo } from "./types";

/**
 * The column of edits between the chat and the video, for the whole video (the editor chose it on 2026-11-24, as
 * T3 Code lists its threads). What waits on the editor fills it, as one list with no tabs: every request draws its own
 * rows into its place there, and under them its one line that counts the edits Scarlet didn't flag and opens them. At
 * the column's foot Working lists the edits Scarlet is revising, open until the editor folds it, and Done counts what
 * the editor has decided and opens on a press. A request about the whole video is not here: it runs in the chat.
 */
export function ReviewRail({ store, threads, open, onOpen, selected }: {
  store: RailStore;
  /** The requests in the order their rows are listed: the latest first. */
  threads: readonly Thread[];
  open: { working: boolean; done: boolean }; onOpen(section: "working" | "done", open: boolean): void;
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
    <div className="review-rail-list" role="group" aria-label="For you">
      {slots("you")}
      {need === 0 && optional === 0 && <p className="simple-review-empty">Nothing waits on you.</p>}
    </div>
    <div className="review-rail-foot">
      {section("Working", "working", working)}
      {section("Done", "done", done)}
    </div>
  </aside>;
}
