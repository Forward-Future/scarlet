import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { appLog } from "./appLog";
import { IS_DESKTOP } from "./client";
import { dropTargets, fileDropZone } from "./dropTargets";
import { isComposing, isInEditableElement } from "./hotkeys";
import { useUiStore } from "../stores/ui";

/** Measures whether clamped text overflows its box and manages click-to-expand state. */
export function useClippedExpand<T extends HTMLElement = HTMLParagraphElement>(text: string, tolerance = 1) {
  const ref = useRef<T>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + tolerance);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open, tolerance]);
  return { ref, clipped, open, opens: clipped || open, toggle: () => setOpen(v => !v) };
}

/** True when `target` is inside `container` or a portaled popup owned by an expanded control inside it. */
function withinPopover(container: HTMLElement | null, target: Node | null): boolean {
  if (!container || !target) return false;
  if (container.contains(target)) return true;
  for (const opener of container.querySelectorAll<HTMLElement>('[aria-expanded="true"][aria-controls]')) {
    const popupId = opener.getAttribute("aria-controls");
    if (popupId && document.getElementById(popupId)?.contains(target)) return true;
  }
  return false;
}

/** Dismisses a popover on outside pointer/focus or Escape (returning focus to its trigger on Escape). */
export function usePopoverDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      if (!withinPopover(containerRef.current, event.target as Node | null)) dismissRef.current();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isComposing(event)) return;
      // An expanded child picker (such as PreferenceSelect) consumes this Escape to close its own list first.
      if (containerRef.current?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissEscape, true);
    };
  }, [open, containerRef, triggerRef]);
}

/** Positions a portal floating note above (or below) its anchor, clamped to 8px viewport margins via rAF. */
export function useFloatingPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  opts: { rightOffset?: number; clampTop?: boolean } = {},
) {
  const { rightOffset = 0, clampTop = false } = opts;
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      const anchor = anchorRef.current, panel = panelRef.current;
      if (!anchor || !panel) return;
      const box = anchor.getBoundingClientRect();
      const { offsetHeight: height, offsetWidth: width } = panel;
      const above = box.top - 6 - height;
      const rawTop = above >= 8 ? above : Math.min(box.bottom + 6, window.innerHeight - height - 8);
      panel.style.top = `${clampTop ? Math.max(8, rawTop) : rawTop}px`;
      panel.style.left = `${Math.max(8, Math.min(box.right + rightOffset - width, window.innerWidth - width - 8))}px`;
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [open, anchorRef, panelRef, rightOffset, clampTop]);
}

/** Prevents window unload / update restart while `active` is true. */
export function useBeforeUnloadGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => { appLog("window", "unload-blocked"); e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

/**
 * Esc leaves the page unless a dialog, menu, or text field is using it. Inside an editable field, Esc blurs it first.
 */
export function useEscapeToLeave(onLeave: () => void, overlaySelector = 'dialog[open], [role="menu"]') {
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(() => {
    const leave = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (useUiStore.getState().shortcutsOpen || document.querySelector(overlaySelector)) return;
      if (isInEditableElement(e.target)) {
        e.target.blur();
        return;
      }
      e.preventDefault();
      leaveRef.current();
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [overlaySelector]);
}

/** Registers a native desktop file-drop target and provides matching browser drag/drop handlers. */
export function useFileDropTarget(
  onPaths: (paths: string[]) => void,
  onFiles: (files: FileList) => void,
  opts: { ignoreChildLeave?: boolean } = {},
) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathsRef = useRef(onPaths);
  pathsRef.current = onPaths;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    dropTargets.set(el, { highlight: setOver, drop: paths => pathsRef.current(paths) });
    return () => { dropTargets.delete(el); };
  }, []);
  const dropProps = {
    ref,
    "data-file-drop": "",
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!IS_DESKTOP && e.dataTransfer.types.includes("Files") && fileDropZone(e.target) === e.currentTarget) {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!opts.ignoreChildLeave || !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      setOver(false);
      if (!IS_DESKTOP && e.dataTransfer.files.length && fileDropZone(e.target) === e.currentTarget) {
        e.preventDefault();
        e.stopPropagation();
        onFiles(e.dataTransfer.files);
      } else if (!opts.ignoreChildLeave) {
        e.preventDefault();
      }
    },
  };
  return { over, dropProps };
}

const CHAT_SCROLL_CONTAINERS = ".simple-pass-list:not(.is-moment), .simple-edits, .simple-pin, .simple-chat";

/** Whether `el` is clipped above or below any scrollable ancestor inside the chat rail. */
export function isClippedInScrollAncestors(el: Element): boolean {
  const box = el.getBoundingClientRect();
  if (box.height === 0) return false;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (parent.matches(CHAT_SCROLL_CONTAINERS)) {
      const view = parent.getBoundingClientRect();
      if (view.height > 0 && (box.top < view.top || box.bottom > view.bottom)) return true;
    }
    if (parent.matches(".simple-chat, .simple-pin")) break;
  }
  return false;
}

/**
 * Keeps the currently selected row inside `container` visible within its scroll container(s) whenever `selectedKey`
 * changes (selection, list filter, or rows above it) and whenever the container resizes and clips the selected row.
 */
export function useKeepSelectedInView(
  container: RefObject<HTMLElement | null>,
  selectedKey: string | undefined,
  selector = '[aria-current="true"]',
) {
  useLayoutEffect(() => {
    if (!selectedKey) return;
    container.current?.querySelector(selector)?.scrollIntoView?.({ block: "nearest" });
  }, [container, selectedKey, selector]);

  useEffect(() => {
    const el = container.current;
    if (!selectedKey || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const row = el.querySelector(selector);
      if (row && isClippedInScrollAncestors(row)) row.scrollIntoView?.({ block: "nearest" });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [container, selectedKey, selector]);
}
