import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "../../components/ui/primitives";
import { StepMark } from "../../components/review/RunBundle";
import type { Thread } from "../../lib/threads";
import { OptionalLine } from "./PassSummary";
import type { RailStore } from "./railStore";
import { letGo } from "./types";

/** A request about the whole video that Scarlet is on: its words and what it is doing this moment. */
export interface RailWork { id: string; text: string; line?: string }

/**
 * The column of edits on the chat's left, for the whole video (the editor chose it on 2026-11-23). What waits on the
 * editor fills it, as one list with no tabs: every request draws its own rows into its place there. Under those rows
 * one line counts the edits Scarlet didn't flag and opens them. At the column's foot Working counts what Scarlet has,
 * the requests waiting their turn among it, and Done what the editor has decided; each opens on a press. New edit, at
 * its top, lets go of the edit that's open, so the message box is about the whole video again.
 */
export function ReviewRail({ store, threads, optionalOpen, onOptional, open, onOpen, work, queue, queued, fresh, onNewEdit, selected }: {
  store: RailStore;
  /** The requests in the order their rows are listed: the latest first. */
  threads: readonly Thread[];
  optionalOpen: boolean; onOptional(open: boolean): void;
  open: { working: boolean; done: boolean }; onOpen(section: "working" | "done", open: boolean): void;
  work: readonly RailWork[];
  /** The requests waiting their turn, each with its pencil and ×. */
  queue?: ReactNode; queued: number;
  /** Nothing is open: the message box starts a new edit. */
  fresh: boolean; onNewEdit(): void;
  /** What is open on the card, so its row is kept in view. */
  selected?: string;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const host = useRef<HTMLElement>(null);
  const need = store.total("you"), optional = store.total("optional");
  const working = store.total("working") + work.length + queued, done = store.total("done");
  // The row of the cut or edit that's open stays in view as Keep and ↑ ↓ move on.
  useEffect(() => {
    if (selected) host.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const slots = (section: "you" | "optional" | "working" | "done") => threads.map(thread =>
    <div key={thread.id} className="review-slot" data-thread={thread.id} ref={store.ref(section, thread.id)} />);
  const nothing = need + optional + working + done === 0;
  return <aside ref={host} className="review-rail" aria-label="Edits" hidden={nothing}>
    <header className="review-rail-head">
      <h2>For you{need > 0 && <span className="review-rail-count" title={`${need} ${need === 1 ? "needs" : "need"} you`}>{need}</span>}</h2>
      <button type="button" className="review-new" aria-pressed={fresh} title="Start a new edit of the whole video" onClick={letGo(onNewEdit)}>
        <Icon name="plus" size={12} />New edit</button>
    </header>
    <div className="review-rail-list" role="group" aria-label="For you">
      {slots("you")}
      {need === 0 && <p className="simple-review-empty">Nothing waits on you.</p>}
      {optional > 0 && <OptionalLine count={optional} open={optionalOpen} onToggle={() => onOptional(!optionalOpen)} />}
      {optionalOpen && slots("optional")}
    </div>
    <div className="review-rail-foot">
      <button type="button" className="review-sec" aria-expanded={open.working} onClick={letGo(() => onOpen("working", !open.working))}>
        <span>Working</span><b>{working || ""}</b><Icon name="chevron" size={10} /></button>
      {open.working && <div className="review-sec-body" role="group" aria-label="Working">
        {work.map(item => <div key={item.id} className="review-work" data-run={item.id}>
          <StepMark state="working" />
          <div className="review-work-text"><p className="review-work-title" title={item.text}>{item.text}</p>
            {item.line && <p className="review-work-now working-text">{item.line}</p>}</div>
        </div>)}
        {slots("working")}
        {queue}
        {working === 0 && <p className="simple-review-empty">Nothing in the works.</p>}
      </div>}
      <button type="button" className="review-sec" aria-expanded={open.done} onClick={letGo(() => onOpen("done", !open.done))}>
        <span>Done</span><b>{done || ""}</b><Icon name="chevron" size={10} /></button>
      {open.done && <div className="review-sec-body" role="group" aria-label="Done">
        {slots("done")}
        {done === 0 && <p className="simple-review-empty">Nothing decided yet.</p>}
      </div>}
    </div>
  </aside>;
}
