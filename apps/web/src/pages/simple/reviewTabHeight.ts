import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ReviewTab } from "../../lib/reviewTabs";

const COLLAPSE_MS = 220;
const COLLAPSE_EASE = "cubic-bezier(.2, 0, 0, 1)";
const CONTENT_SELECTOR = ":scope > .simple-pass-list, :scope > .simple-edits, :scope > .simple-review-empty";

const canMove = () => typeof window !== "undefined" && typeof Element !== "undefined" && typeof Element.prototype.animate === "function"
  && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export interface ReviewTabHeightOptions {
  /** Only active while the request renders the three tabs (Needs review, Working, Done). */
  enabled: boolean;
  tab: ReviewTab;
  /** Row counts for each tab: `you` is the rows currently drawn in Needs review (excluding low-risk rows when closed). */
  counts: { you: number; working: number; done: number };
  /** Underlying non-optional count in Needs review, used to detect when everything in Needs review and Working is finished. */
  youBase: number;
  /** Whether Needs review shows the "N low risk edits" switch line. */
  hasLowRisk: boolean;
  /** Whether low-risk rows are currently open in Needs review. */
  lowOpen: boolean;
  /** True while low-risk rows are animating shut; avoids locking height mid-collapse. */
  lowClosing?: boolean;
  /** Number of nested requests rendered under rows (changes tab height even when row count is unchanged). */
  nestedCount?: number;
  /** Number of newer requests below this one in the chat; an increase collapses held blank space. */
  laterRequests?: number;
}

function clearFloor(host: HTMLElement) {
  host.style.removeProperty("--review-body-height");
  delete host.dataset.reviewPad;
}

function outerVertical(el: HTMLElement) {
  const style = getComputedStyle(el);
  const top = parseFloat(style.marginTop) || 0;
  const bottom = parseFloat(style.marginBottom) || 0;
  const height = el.getBoundingClientRect().height;
  return { top, bottom, height, outer: top + height + bottom };
}

/**
 * Holds the height below Needs review / Working / Done while the editor switches between tabs so the request heading
 * and tab bar stay still under the pointer, then smoothly collapses back to the active tab's real height when:
 *  - the editor clicks or moves focus outside this request,
 *  - the last waiting/working item finishes (Needs review and Working both reach 0), or
 *  - a new request starts below this one in the chat.
 */
export function useReviewTabHeight(host: RefObject<HTMLElement | null>, opts: ReviewTabHeightOptions) {
  const { enabled, tab, counts, youBase, hasLowRisk, lowOpen, lowClosing = false, nestedCount = 0, laterRequests = 0 } = opts;
  const [holding, setHolding] = useState(false);
  const [resizeTick, setResizeTick] = useState(0);
  const mem = useRef<{
    width: number;
    inPin: boolean;
    prevTab: ReviewTab | undefined;
    prevNatural: number;
    lockedHeight: number;
    prevRemaining: number;
    prevLater: number;
    collapseAnim: Animation | undefined;
  }>({
    width: 0,
    inPin: false,
    prevTab: undefined,
    prevNatural: 0,
    lockedHeight: 0,
    prevRemaining: youBase + counts.working,
    prevLater: laterRequests,
    collapseAnim: undefined,
  });

  const cancelCollapse = useCallback(() => {
    mem.current.collapseAnim?.cancel();
    mem.current.collapseAnim = undefined;
  }, []);

  const collapseNow = useCallback((animate: boolean) => {
    const el = host.current;
    mem.current.lockedHeight = 0;
    setHolding(false);
    if (!el) return;
    cancelCollapse();
    const wasPadded = el.dataset.reviewPad !== undefined;
    const content = el.querySelector<HTMLElement>(CONTENT_SELECTOR);
    if (!wasPadded || !content) {
      clearFloor(el);
      return;
    }
    const fromHeight = content.getBoundingClientRect().height;
    clearFloor(el);
    const toHeight = content.getBoundingClientRect().height;
    if (animate && fromHeight - toHeight > 1 && canMove()) {
      const inPin = !!el.closest(".simple-pin, .simple-review-dock");
      const keyframes = inPin
        ? [{ height: `${fromHeight}px`, flexBasis: `${fromHeight}px` }, { height: `${toHeight}px`, flexBasis: `${toHeight}px` }]
        : [{ height: `${fromHeight}px`, minHeight: `${fromHeight}px` }, { height: `${toHeight}px`, minHeight: `${toHeight}px` }];
      const anim = content.animate(keyframes, { duration: COLLAPSE_MS, easing: COLLAPSE_EASE });
      mem.current.collapseAnim = anim;
      const done = () => { if (mem.current.collapseAnim === anim) mem.current.collapseAnim = undefined; };
      void anim.finished.then(done, done);
    }
  }, [host, cancelCollapse]);

  // Trigger 1: collapse smoothly once the editor clicks or moves focus outside this request's tab area.
  useEffect(() => {
    if (!enabled || !holding) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = host.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      collapseNow(true);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = host.current;
      const target = e.target;
      if (!el || !(target instanceof Element) || target === document.body || target === document.documentElement || el.contains(target)) return;
      collapseNow(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [enabled, holding, host, collapseNow]);

  // Track horizontal rail resizes or window resizes so stale locked heights don't outlive a layout change.
  useEffect(() => {
    if (!enabled) return;
    const el = host.current;
    if (!el) return;
    let lastWidth = Math.round(el.getBoundingClientRect().width);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      const nextWidth = Math.round(el.getBoundingClientRect().width);
      if (nextWidth > 0 && nextWidth !== lastWidth) {
        lastWidth = nextWidth;
        setResizeTick(n => n + 1);
      }
    }) : undefined;
    observer?.observe(el);
    const onResize = () => setResizeTick(n => n + 1);
    window.addEventListener("resize", onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [enabled, host]);

  // Keep prevNatural up to date as the active unpadded list settles (e.g. after low-risk rows finish opening or a moment unfolds).
  useEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const el = host.current;
    const content = el?.querySelector<HTMLElement>(CONTENT_SELECTOR);
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (el.dataset.reviewPad !== undefined || lowClosing || mem.current.collapseAnim) return;
      const lowEl = el.querySelector<HTMLElement>(":scope > .simple-low-risk");
      const lowOuter = lowEl ? outerVertical(lowEl).outer : 0;
      const contentBox = outerVertical(content);
      if (contentBox.height <= 0) return;
      const natural = lowOuter + contentBox.outer;
      mem.current.prevNatural = natural;
      if (mem.current.lockedHeight > 0 && natural > mem.current.lockedHeight) {
        mem.current.lockedHeight = natural;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [enabled, host, tab, lowClosing]);

  useEffect(() => () => cancelCollapse(), [cancelCollapse]);

  useLayoutEffect(() => {
    const el = host.current;
    const remaining = youBase + counts.working;
    if (!el) return;
    if (!enabled || lowClosing) {
      cancelCollapse();
      clearFloor(el);
      if (!enabled) {
        mem.current.lockedHeight = 0;
        mem.current.prevTab = undefined;
        mem.current.prevNatural = 0;
        setHolding(false);
      }
      mem.current.prevRemaining = remaining;
      mem.current.prevLater = laterRequests;
      return;
    }

    const content = el.querySelector<HTMLElement>(CONTENT_SELECTOR);
    if (!content) {
      cancelCollapse();
      clearFloor(el);
      mem.current.lockedHeight = 0;
      setHolding(false);
      mem.current.prevRemaining = remaining;
      mem.current.prevLater = laterRequests;
      return;
    }

    const tabChanged = mem.current.prevTab !== undefined && mem.current.prevTab !== tab;
    const justFinishedAll = mem.current.prevRemaining > 0 && remaining === 0;
    const newerArrived = laterRequests > mem.current.prevLater;
    mem.current.prevRemaining = remaining;
    mem.current.prevLater = laterRequests;

    // Trigger 2 (everything finished) or Trigger 3 (a newer request started below): collapse smoothly instead of holding blank space.
    if (!tabChanged && (justFinishedAll || newerArrived) && mem.current.lockedHeight > 0) {
      collapseNow(true);
      const lowEl = el.querySelector<HTMLElement>(":scope > .simple-low-risk");
      const lowOuter = lowEl ? outerVertical(lowEl).outer : 0;
      const contentBox = outerVertical(content);
      if (contentBox.height > 0) mem.current.prevNatural = lowOuter + contentBox.outer;
      return;
    }

    if (tabChanged) cancelCollapse();

    // Measure natural (unpadded) height synchronously before paint so our own floor never distorts measurement.
    clearFloor(el);

    const hostRect = el.getBoundingClientRect();
    const contentBox = outerVertical(content);
    // Headless DOM without layout (or collapsed request with display: none): leave state intact and do nothing.
    if (hostRect.width === 0 && contentBox.height === 0) return;

    const width = Math.round(hostRect.width);
    const inPin = !!el.closest(".simple-pin, .simple-review-dock");
    if ((mem.current.width > 0 && width > 0 && mem.current.width !== width) || (mem.current.prevTab !== undefined && mem.current.inPin !== inPin)) {
      mem.current.lockedHeight = 0;
      setHolding(false);
    }
    if (width > 0) mem.current.width = width;
    mem.current.inPin = inPin;

    const lowEl = el.querySelector<HTMLElement>(":scope > .simple-low-risk");
    const lowOuter = lowEl ? outerVertical(lowEl).outer : 0;
    const naturalBody = lowOuter + contentBox.outer;

    if (tabChanged) {
      const holdFrom = Math.max(mem.current.lockedHeight, mem.current.prevNatural);
      mem.current.lockedHeight = Math.max(holdFrom, naturalBody);
    } else if (mem.current.lockedHeight > 0 && naturalBody > mem.current.lockedHeight) {
      mem.current.lockedHeight = naturalBody;
    }

    mem.current.prevTab = tab;
    mem.current.prevNatural = naturalBody;

    const target = mem.current.lockedHeight;
    if (target > naturalBody + 0.5) {
      const offset = lowOuter + contentBox.top + contentBox.bottom;
      const needed = Math.max(0, Math.round(target - offset));
      el.style.setProperty("--review-body-height", `${needed}px`);
      el.dataset.reviewPad = "";
      setHolding(true);
    } else {
      setHolding(false);
    }
  }, [enabled, host, tab, counts.you, counts.working, counts.done, youBase, hasLowRisk, lowOpen, lowClosing, nestedCount, laterRequests, resizeTick, cancelCollapse, collapseNow]);
}
