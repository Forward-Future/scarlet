import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BatchSummaryItem, ThreadEdit } from "@scarlet/shared";
import { AimRow } from "../../components/review/AimRow";
import { EditVersion, RejectedMark } from "../../components/review/ThreadEdits";
import { ChatRail } from "../../components/shell/ChatRail";
import { Icon } from "../../components/ui/primitives";
import { api } from "../../lib/client";
import { clock as clockLabel } from "../../lib/format";
import { editKey, unkeepEdits } from "../../lib/keptEdits";
import { recordUndo } from "../../lib/undo";
import { useProjectStore } from "../../stores/project";
import type { RailSection, RailStore, UnifiedRailRow } from "./railStore";
import { letGo, type HoveredReviewRow } from "./types";

/**
 * The column of edits between the chat and the video, for the whole video (the editor chose it on 2026-11-24, as
 * T3 Code lists its threads). Every section (Needs review, Low risk, Working, Done) is one unified list sorted by video
 * time — never stacked by chat request — and follow-up requests that modify the same edit combine into one row.
 */
/** The narrowest the edits column can be dragged to while keeping times, words, and amounts legible. */
export const REVIEW_RAIL_MIN = 220;
/**
 * Default width of the chat and of the edits column before the user drags either divider: the two start equal,
 * sharing the room the chat and the column used to take together, never under the chat's 320px.
 */
export const sideRailWidth = (available: number) => Math.round(Math.max(320, Math.min(400, available * 0.27)));
/** What Keep safe edits says it does, on hover and to screen readers. */
const doneLabel = (count: number) => count === 1 ? "Keep the safe edit" : `Keep all ${count} safe edits`;

const ROW_SELECTOR = "button.simple-edit, .simple-pass-list > li > button";
const TIP_DELAY_MS = 180;
const TIP_WARM_MS = 250;

const SECTION_LABELS: Record<RailSection, string> = {
  you: "Edits that need you",
  low: "Safe edits",
  working: "With Scarlet",
  done: "Decided",
};

interface RowTooltip {
  row: HTMLButtonElement;
  text: string;
  meta?: string;
  detail?: string;
  left: number;
  top?: number;
  bottom?: number;
}

function tooltipFor(row: HTMLButtonElement): RowTooltip | null {
  const words = row.querySelector<HTMLElement>(".simple-edit-words, .simple-pass-words");
  const text = (row.dataset.rowTip ?? words?.textContent ?? "").trim();
  if (!text) return null;
  const meta = row.dataset.rowMeta?.trim() || undefined;
  const detail = row.dataset.rowDetail?.trim() || undefined;
  const rowRect = row.getBoundingClientRect();
  const anchorRect = (words ?? row).getBoundingClientRect();
  const left = Math.max(8, Math.round(anchorRect.left));
  const below = rowRect.top < 76;
  return {
    row,
    text,
    meta: meta && meta !== text ? meta : undefined,
    detail: detail && detail !== text && detail !== meta ? detail : undefined,
    left,
    ...(below ? { top: Math.round(rowRect.bottom + 6) } : { bottom: Math.round(window.innerHeight - rowRect.top + 6) }),
  };
}

export function ReviewRail({ projectId, store, open, onOpen, selected, onDoneLow, onHover, flashedThreadId, compact = false, reserve = 0 }: {
  projectId: string;
  store: RailStore;
  open: { working: boolean; done: boolean; low?: boolean };
  onOpen(section: "working" | "done" | "low", open: boolean): void;
  /** What is open on the card, so its row is kept in view. */
  selected?: string;
  /** Keep all confident edits at once. */
  onDoneLow?(): void;
  /** Light the timeline's marker while hovering a row. */
  onHover?(time?: number, target?: HoveredReviewRow): void;
  /** Thread whose rows briefly flash after clicking Show → in chat. */
  flashedThreadId?: string;
  compact?: boolean;
  /** Extra horizontal room to keep free beyond the player's minimum (e.g. an open Transcript column). */
  reserve?: number;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const batchSummaries = useProjectStore(s => s.current?.id === projectId ? s.current.batchSummaries : undefined);
  useEffect(() => {
    store.setBatchSummaries(batchSummaries);
  }, [store, batchSummaries]);
  const host = useRef<HTMLElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [tip, setTip] = useState<RowTooltip | null>(null);
  const [tipLeft, setTipLeft] = useState<number | null>(null);
  const requestedSummaries = useRef<{ projectId: string; keys: Set<string> }>({ projectId, keys: new Set() });
  if (requestedSummaries.current.projectId !== projectId) {
    requestedSummaries.current = { projectId, keys: new Set() };
  }
  const view = store.view();
  const { need, forYouRows, optional, working, done, pastHour, sections } = view;
  const total = need + optional;
  const nothing = need + forYouRows + optional + working + done === 0;
  const showConfident = optional > 0;
  // Safe edits start folded under their heading; a press on it (or opening one of them) unfolds them.
  const lowShown = showConfident && !!open.low;

  // Ask the engine for AI-generated titles for any settled collapsed batches that don't have one cached yet.
  const unsummarized: BatchSummaryItem[] = [];
  const seenKeys = new Set<string>();
  for (const row of [...sections.low, ...sections.done]) {
    const input = row.batchSummaryInput;
    if (!input || seenKeys.has(input.key) || batchSummaries?.[input.key] || requestedSummaries.current.keys.has(input.key)) continue;
    seenKeys.add(input.key);
    unsummarized.push(input);
  }
  const unsummarizedKey = unsummarized.map(b => b.key).join("|");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!unsummarized.length || typeof api.summarizeBatches !== "function") return;
    const batch = unsummarized.slice(0, 20);
    const timer = window.setTimeout(() => {
      for (const item of batch) requestedSummaries.current.keys.add(item.key);
      void api.summarizeBatches(projectId, { batches: batch }).then(res => {
        if (!mounted.current || !res?.summaries) return;
        useProjectStore.getState().mergeBatchSummaries(projectId, res.summaries);
      }).catch(() => {});
    }, 120);
    return () => {
      window.clearTimeout(timer);
    };
  }, [projectId, unsummarizedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The row of the cut or edit that's open stays in view as Keep or ↑ ↓ reveals it.
  useEffect(() => {
    if (selected) host.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, open.working, open.done, open.low]);

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
  }, [nothing, need, optional, working, done, open.working, open.done, open.low]);

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

  const unkeepRow = (row: UnifiedRailRow) => {
    onHover?.();
    if (row.unkeepCall) { row.unkeepCall(); return; }
    const byThread = new Map<string, Omit<ThreadEdit, "at">[]>();
    for (const member of row.members) {
      if (!member.canUnkeep) continue;
      const list = byThread.get(member.threadId);
      if (list) {
        if (!list.some(e => editKey(e) === editKey(member.edit))) list.push(member.edit);
      } else {
        byThread.set(member.threadId, [member.edit]);
      }
    }
    const parts = [...byThread.entries()].map(([threadId, refs]) => ({ threadId, refs }));
    if (!parts.length) return;
    for (const part of parts) unkeepEdits(projectId, part.threadId, part.refs);
    const [first, ...rest] = parts;
    recordUndo({
      kind: "unkeep",
      word: "Unkeep",
      projectId,
      threadId: first!.threadId,
      refs: first!.refs,
      ...(rest.length > 0 && { extraParts: rest }),
      name: row.label,
    });
  };

  const renderSectionList = (key: RailSection) => {
    const rows = sections[key];
    if (!rows.length) return null;
    const listClass = pastHour ? "simple-pass-list simple-edits has-hours" : "simple-pass-list simple-edits";
    return <ol className={listClass} aria-label={SECTION_LABELS[key]}>
      {rows.map(row => {
        const batchCount = row.batch && row.batch.length > 1 ? row.batch.length : 0;
        const activeRow = row.batch?.find(r => r.on) ?? row;
        const canUnkeepRow = key === "done" && !row.rejected && !row.skipped && !row.isMarker
          && (!!row.unkeepCall || row.members.some(m => m.canUnkeep));
        const value = key === "done" ? (row.decision ?? row.value) : row.value;
        const rowTime = clockLabel(row.displayAt);
        const needTime = row.needs || row.asks;
        const lead = <span className={needTime ? "edit-row-time simple-pass-time is-need" : "edit-row-time simple-pass-time"}>{rowTime}</span>;
        const activeLead = <span className={activeRow.needs || activeRow.asks ? "edit-row-time simple-pass-time is-need" : "edit-row-time simple-pass-time"}>{clockLabel(activeRow.displayAt)}</span>;
        const tipText = row.tipText ?? row.label;
        const tipMeta = row.tipMeta && row.tipMeta !== tipText ? row.tipMeta : undefined;
        const tipDetail = row.tipDetail && row.tipDetail !== tipText && row.tipDetail !== tipMeta ? row.tipDetail : undefined;
        const moment = row.moment;
        const unkeepTip = row.unkeepTip ?? "Move back to Needs review";
        const statusWord = row.word;
        const ariaLabel = row.ariaLabel ?? (batchCount > 1
          ? `${rowTime}: ${row.label}${row.decided ? ", kept" : ""}`
          : moment
          ? `${rowTime} ${row.label}, ${moment.more.replace("+ ", "and ")}`
          : row.rejected ? `${rowTime} ${row.label}, rejected`
          : `${rowTime}: ${row.label}${statusWord ? `, ${statusWord.replace(/…$/, "").toLowerCase()}` : row.decided ? (row.isMarker ? ", done" : ", kept") : needTime ? ", needs you" : ""}`);
        const flashed = !!flashedThreadId && row.threadIds.includes(flashedThreadId);
        return <li key={row.key} className={canUnkeepRow ? "has-unkeep" : undefined} data-flash={flashed ? "" : undefined}>
          <button type="button"
            className={["simple-edit", row.on && "is-on", row.rejected && "is-rejected", row.asks && "is-asking", row.isAskingCurrent && "is-asking-current", !row.on && !row.rejected && row.decided && "is-decided"].filter(Boolean).join(" ")}
            aria-current={row.on || undefined}
            data-log-control={row.logControl}
            data-log-label={batchCount > 1 ? "Edit group" : row.logLabel}
            data-batch-count={batchCount > 1 ? batchCount : undefined}
            disabled={!row.open}
            data-row-tip={tipText}
            data-row-meta={tipMeta}
            data-row-detail={tipDetail}
            aria-label={ariaLabel}
            onClick={letGo(() => store.view().findByKey(row.key)?.open?.())}
            onPointerEnter={() => onHover?.(row.mark, row.hover)}
            onPointerLeave={() => onHover?.()}>
            {lead}
            <span className="simple-pass-label">
              {(row.rejected || row.skipped) && <RejectedMark />}
              {row.decided && !row.skipped && !row.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}
              <span className="simple-pass-words simple-edit-words">{row.label}</span>
              {row.version > 0 && <EditVersion n={row.version} hover={row.spent} />}
              {row.fresh && <small className="edit-version is-new">New</small>}
              {moment && <span className="simple-pass-more" aria-expanded={moment.unfolded} title={moment.unfolded ? "Hide its edits" : "Show its edits"}
                onClick={e => { e.stopPropagation(); store.view().findByKey(row.key)?.moment?.toggle(); }}>{moment.more}</span>}
            </span>
            {!statusWord && value && <span className={row.busy ? "simple-edit-value simple-pass-value working-text" : "simple-edit-value simple-pass-value"} title={row.spent}>{value}</span>}
            {statusWord && <span className={`simple-edit-check simple-pass-check${row.revised || row.asks ? "" : " is-kept"}${row.busy ? " working-text" : ""}`} title={row.spent}>{statusWord}</span>}
          </button>
          {canUnkeepRow && <span className="simple-row-unkeep"
            onPointerEnter={() => onHover?.(row.mark, row.hover)} onPointerLeave={() => onHover?.()}>
            <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
              aria-label={`Unkeep ${row.label}`} title={unkeepTip}
              onClick={letGo(() => { const fresh = store.view().findByKey(row.key); if (fresh) unkeepRow(fresh); })}>Unkeep</button>
          </span>}
          <AimRow on={row.on}>{activeLead}<span className="composer-aim-words">{activeRow.label}</span></AimRow>
          {row.nests.map(nest => nest.node)}
          {moment?.unfolded && <ol className="simple-pass-list is-moment" aria-label="Edits in this moment">
            {moment.subRows.map(m => <li key={m.key} className={m.unkeep ? "has-unkeep" : undefined}>
              <button type="button" className={m.on ? "is-on" : m.decided ? "is-decided" : undefined} aria-current={m.on || undefined}
                data-log-control="open-pass-item" data-log-label="Edit in a moment" disabled={!m.open}
                data-row-tip={m.label} data-row-meta={m.tipMeta}
                data-row-detail={m.tipDetail ?? (m.title && m.title !== m.label ? m.title : undefined)}
                onClick={letGo(() => { const fresh = store.view().findByKey(row.key)?.moment?.subRows.find(s => s.key === m.key); fresh?.open?.(); })}
                onPointerEnter={() => onHover?.(m.mark, m.hover)} onPointerLeave={() => onHover?.()}>
                <span className="simple-pass-label">
                  {m.decided && !m.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}
                  <span className="simple-pass-words simple-edit-words">{m.label}</span>
                  {m.version > 0 && <EditVersion n={m.version} hover={m.spent} />}
                </span>
                {m.value && !m.word && <span className={m.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={m.spent}>{m.value}</span>}
                {m.word && <span className={`simple-pass-check${m.revised || m.asks ? "" : " is-kept"}${m.busy ? " working-text" : ""}`} title={m.spent}>{m.word}</span>}
              </button>
              {m.unkeep && <span className="simple-row-unkeep"
                onPointerEnter={() => onHover?.(m.mark, m.hover)} onPointerLeave={() => onHover?.()}>
                <button type="button" className="simple-unkeep" data-log-control="unkeep-edit"
                  aria-label={`Unkeep ${m.label}`} title={m.unkeepTip ?? "Unkeep"}
                  onClick={letGo(() => { const fresh = store.view().findByKey(row.key)?.moment?.subRows.find(s => s.key === m.key); fresh?.unkeep?.(); })}>Unkeep</button>
              </span>}
              {m.nests?.map(nest => nest.node)}
            </li>)}
          </ol>}
        </li>;
      })}
    </ol>;
  };

  const section = (name: "Working" | "Done", key: "working" | "done", count: number) => {
    const shown = open[key] && count > 0;
    return <>
      <button type="button" className={count ? "review-sec" : "review-sec is-none"} aria-expanded={shown} disabled={!count}
        onClick={letGo(() => onOpen(key, !open[key]))}>
        <span>{name}</span><b>{count}</b><Icon name="chevron" size={10} /></button>
      <div className="review-sec-body" role="group" aria-label={name} hidden={!shown}>{renderSectionList(key)}</div>
    </>;
  };

  return <ChatRail compact={compact} railRef={host} id="simple-review-rail" className="review-rail" label="Edit lists"
    side="left" resizes="edits" storageKey="scarlet.simpleReviewWidth" initialWidth={sideRailWidth}
    minWidth={REVIEW_RAIL_MIN} beside="simple-chat" reserve={reserve}>
    <header className="review-rail-head">
      <h2>
        <span>Needs review</span>
        {total > 0 && (need > 0 && optional > 0
          ? <><span className="review-rail-total">{total}</span><span className="review-rail-sep" aria-hidden="true">·</span><span className="review-rail-count" title={`${need} ${need === 1 ? "needs" : "need"} you`}>{need}</span></>
          : need > 0
            ? <span className="review-rail-count" title={`${need} ${need === 1 ? "needs" : "need"} you`}>{need}</span>
            : <span className="review-rail-total">{optional}</span>)}
      </h2>
    </header>
    <div className="review-rail-scroll">
      <div className="review-rail-list" role="group" aria-label="Needs review">
        {renderSectionList("you")}
        {showConfident && <div className={need > 0 || forYouRows > 0 ? "review-tier-sep" : "review-tier-sep is-first"}>
          <button type="button" className="review-tier-label review-tier-toggle" aria-expanded={lowShown} aria-controls={`${tipId}-low`}
            onClick={letGo(() => onOpen("low", !open.low))}><span>Safe edits ({optional})</span><Icon name="chevron" size={10} /></button>
          {onDoneLow && <button type="button" className="review-head-keep" title={doneLabel(optional)} aria-label={doneLabel(optional)}
            onClick={letGo(onDoneLow)}>Keep {optional} safe {optional === 1 ? "edit" : "edits"}</button>}
        </div>}
        <div id={`${tipId}-low`} className="review-low-body" role="group" aria-label="Safe edits" hidden={!lowShown}>{renderSectionList("low")}</div>
        {forYouRows === 0 && !showConfident && <p className="simple-review-empty">{nothing ? "No edits yet." : "Nothing waits on you."}</p>}
      </div>
    </div>
    <div className="review-rail-foot">
      {section("Working", "working", working)}
      {section("Done", "done", done)}
    </div>
    {tip && !nothing && <div ref={tipEl} id={tipId} role="tooltip" className="review-rail-tip"
      style={{ left: tipLeft ?? tip.left, ...(tip.top !== undefined ? { top: tip.top } : { bottom: tip.bottom }) }}>
      <span className="review-rail-tip-title">{tip.text}</span>
      {tip.meta && <span className="review-rail-tip-meta">{tip.meta}</span>}
      {tip.detail && <span className="review-rail-tip-detail">{tip.detail}</span>}
    </div>}
  </ChatRail>;
}
