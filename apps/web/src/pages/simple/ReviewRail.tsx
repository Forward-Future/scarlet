import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatRail } from "../../components/shell/ChatRail";
import { Icon } from "../../components/ui/primitives";
import type { Thread } from "../../lib/threads";
import type { RailStore } from "./railStore";
import { letGo } from "./types";

/**
 * The column of edits between the chat and the video, for the whole video (the editor chose it on 2026-11-24, as
 * T3 Code lists its threads). What waits on the editor fills it, as one list with no tabs: every request draws its own
 * rows into its place there. Under them, quieter, "Low Risk Edits (5)" lists every request's edits Scarlet didn't flag,
 * at once and in one list, with no line naming the request (the editor chose this on 2026-11-24, in place of a line
 * under each request's rows that opened them). At the column's foot Working lists the edits Scarlet is revising,
 * open until the editor folds it, and Done counts what the editor has decided and opens on a press. A request about the
 * whole video is not here: it runs in the chat.
 */
/** The narrowest the edits column can be dragged to while keeping times, words, and amounts legible. */
export const REVIEW_RAIL_MIN = 220;
/** Default width of the edits column before the user drags its right divider. */
const reviewRailWidth = (available: number) => available <= 1100 ? 232 : Math.max(260, Math.min(320, available * 0.22));
/** What Keep all says it does, on hover and to screen readers. */
const doneLabel = (count: number) => count === 1 ? "Keep the low-risk edit" : `Keep all ${count} low-risk edits`;

const ROW_SELECTOR = "button.simple-edit, .simple-pass-list > li > button";
const TIP_DELAY_MS = 180;
const TIP_WARM_MS = 250;

interface RowTooltip {
  row: HTMLButtonElement;
  text: string;
  detail?: string;
  left: number;
  top?: number;
  bottom?: number;
}

function tooltipFor(row: HTMLButtonElement): RowTooltip | null {
  const words = row.querySelector<HTMLElement>(".simple-edit-words, .simple-pass-words");
  const text = (row.dataset.rowTip ?? words?.textContent ?? "").trim();
  if (!text) return null;
  const detail = row.dataset.rowDetail?.trim() || undefined;
  const rowRect = row.getBoundingClientRect();
  const anchorRect = (words ?? row).getBoundingClientRect();
  const left = Math.max(8, Math.round(anchorRect.left));
  const below = rowRect.top < 76;
  return {
    row,
    text,
    detail: detail && detail !== text ? detail : undefined,
    left,
    ...(below ? { top: Math.round(rowRect.bottom + 6) } : { bottom: Math.round(window.innerHeight - rowRect.top + 6) }),
  };
}

export function ReviewRail({ store, threads, forYouRows = 0, open, onOpen, selected, onDoneLow, compact = false, reserve = 0 }: {
  store: RailStore;
  /**
   * The rows drawn under For you. They can be more than the store counts as waiting on the editor: a request about a
   * cut or edit that stopped early keeps its row there, uncounted, so For you isn't empty and the column isn't hidden.
   */
  forYouRows?: number;
  /** The requests in the order their rows are listed: the latest first. */
  threads: readonly Thread[];
  open: { working: boolean; done: boolean; low: boolean }; onOpen(section: "working" | "done" | "low", open: boolean): void;
  /** What is open on the card, so its row is kept in view. */
  selected?: string;
  /** Keep all: Keep on every low-risk edit at once. */
  onDoneLow?(): void;
  compact?: boolean;
  /** Extra horizontal room to keep free beyond the player's minimum (e.g. an open Transcript column). */
  reserve?: number;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const host = useRef<HTMLElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [tip, setTip] = useState<RowTooltip | null>(null);
  const [tipLeft, setTipLeft] = useState<number | null>(null);
  const need = store.total("you"), optional = store.total("optional");
  const working = store.total("working"), done = store.total("done");
  const nothing = need + forYouRows + optional + working + done === 0;
  // The row of the cut or edit that's open stays in view as Keep, ↑ ↓, or unfolding reveals it.
  useEffect(() => {
    if (selected) host.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, open.low, open.working, open.done]);

  // Show Scarlet's own dark floating tooltip with the full line on hover or keyboard focus of any edit row.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let showTimer = 0, coolTimer = 0;
    let activeRow: HTMLButtonElement | null = null;
    let warm = false;
    const clearTimers = () => { clearTimeout(showTimer); clearTimeout(coolTimer); showTimer = 0; coolTimer = 0; };
    const hide = (cool = false) => {
      clearTimeout(showTimer); showTimer = 0;
      activeRow = null;
      setTip(null);
      if (cool && warm) {
        clearTimeout(coolTimer);
        coolTimer = window.setTimeout(() => { warm = false; }, TIP_WARM_MS);
      } else if (!cool) {
        clearTimeout(coolTimer); coolTimer = 0;
        warm = false;
      }
    };
    const showRow = (row: HTMLButtonElement, immediate: boolean) => {
      const next = tooltipFor(row);
      if (!next) { hide(true); return; }
      clearTimeout(coolTimer); coolTimer = 0;
      if (activeRow === row && showTimer) return;
      activeRow = row;
      clearTimeout(showTimer); showTimer = 0;
      if (immediate || warm) {
        warm = true;
        setTip(next);
      } else {
        showTimer = window.setTimeout(() => {
          showTimer = 0;
          if (activeRow !== row || !row.isConnected) return;
          warm = true;
          setTip(tooltipFor(row));
        }, TIP_DELAY_MS);
      }
    };
    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target instanceof Element ? e.target : null;
      const row = target?.closest<HTMLButtonElement>(ROW_SELECTOR) ?? null;
      if (!row || !el.contains(row)) { hide(true); return; }
      // Let inner controls with their own hover title (such as version/cost info or "+ N edits") keep their hover.
      const titled = target?.closest<HTMLElement>("[title]");
      if (titled && titled !== row && row.contains(titled) && titled.title) { hide(true); return; }
      showRow(row, false);
    };
    const onPointerLeave = () => hide(true);
    const onDismiss = () => hide(false);
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const row = target?.closest<HTMLButtonElement>(ROW_SELECTOR) ?? null;
      if (row && el.contains(row) && row.matches(":focus-visible")) showRow(row, true);
    };
    const onFocusOut = () => hide(false);
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") hide(false); };
    el.addEventListener("pointerover", onPointerOver);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("pointerdown", onDismiss, true);
    el.addEventListener("scroll", onDismiss, true);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    el.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      clearTimers();
      el.removeEventListener("pointerover", onPointerOver);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("pointerdown", onDismiss, true);
      el.removeEventListener("scroll", onDismiss, true);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, []);

  // Never leave a floating tooltip orphaned if its row unmounts (e.g. via K shortcut or live update).
  useEffect(() => {
    setTip(cur => (cur && (nothing || !cur.row.isConnected) ? null : cur));
  }, [nothing, need, optional, working, done, open.low, open.working, open.done]);

  // Tie aria-describedby to the hovered/focused row while the tooltip is open, and clamp its horizontal edge in view.
  useLayoutEffect(() => {
    if (!tip) { setTipLeft(null); return; }
    const row = tip.row;
    const prev = row.getAttribute("aria-describedby");
    row.setAttribute("aria-describedby", tipId);
    const width = tipEl.current?.getBoundingClientRect().width ?? 0;
    const maxLeft = Math.max(8, window.innerWidth - width - 12);
    setTipLeft(Math.min(tip.left, maxLeft));
    return () => {
      if (prev === null) row.removeAttribute("aria-describedby");
      else row.setAttribute("aria-describedby", prev);
    };
  }, [tip, tipId]);

  const slots = (section: "you" | "working" | "done") => threads.map(thread =>
    <div key={thread.id} className="review-slot" data-thread={thread.id} ref={store.ref(section, thread.id)} />);
  // One list of every request's low-risk rows, with nothing naming the request (the editor's choice, 2026-11-24).
  const lowSlots = threads.map(thread => <div key={thread.id} className="review-slot" data-thread={thread.id} ref={store.ref("low", thread.id)} />);
  const section = (name: "Working" | "Done", key: "working" | "done", count: number) => {
    const shown = open[key] && count > 0;
    return <>
      <button type="button" className={count ? "review-sec" : "review-sec is-none"} aria-expanded={shown} disabled={!count}
        onClick={letGo(() => onOpen(key, !open[key]))}>
        <span>{name}</span><b>{count}</b><Icon name="chevron" size={10} /></button>
      <div className="review-sec-body" role="group" aria-label={name} hidden={!shown}>{slots(key)}</div>
    </>;
  };
  return <ChatRail compact={compact} hidden={nothing} railRef={host} id="simple-review-rail" className="review-rail" label="Edit lists"
    side="left" resizes="edits" storageKey="scarlet.simpleReviewWidth" initialWidth={reviewRailWidth}
    minWidth={REVIEW_RAIL_MIN} beside="simple-chat" reserve={reserve}>
    <header className="review-rail-head">
      <h2>For you{need > 0 && <span className="review-rail-count" title={`${need} ${need === 1 ? "needs" : "need"} you`}>{need}</span>}</h2>
    </header>
    <div className="review-rail-scroll">
      <div className="review-rail-list" role="group" aria-label="For you">
        {slots("you")}
        {need + forYouRows === 0 && <p className="simple-review-empty">Nothing waits on you.</p>}
      </div>
      {/* The edits Scarlet didn't flag, listed at once and quieter, open until the editor folds them. */}
      <div className="review-low" hidden={optional === 0}>
        <div className="review-low-row">
          <button type="button" className="review-low-head" aria-expanded={open.low} onClick={letGo(() => onOpen("low", !open.low))}>
            <span>Low risk</span><b>{optional}</b><Icon name="chevron" size={10} /></button>
          {/* Keep all keeps every low-risk edit at once, as Keep does one. It sits on the heading's line just before its
              chevron, and doesn't fold the list. */}
          {onDoneLow && optional > 0 && <button type="button" className="review-low-done" title={doneLabel(optional)} aria-label={doneLabel(optional)}
            onClick={letGo(onDoneLow)}>Keep all</button>}
        </div>
        <div className="review-low-body" role="group" aria-label="Low risk" hidden={!open.low}>{lowSlots}</div>
      </div>
    </div>
    <div className="review-rail-foot">
      {section("Working", "working", working)}
      {section("Done", "done", done)}
    </div>
    {tip && !nothing && <div ref={tipEl} id={tipId} role="tooltip" className="review-rail-tip"
      style={{ left: tipLeft ?? tip.left, ...(tip.top !== undefined ? { top: tip.top } : { bottom: tip.bottom }) }}>
      <span>{tip.text}</span>
      {tip.detail && <span className="review-rail-tip-detail">{tip.detail}</span>}
    </div>}
  </ChatRail>;
}
