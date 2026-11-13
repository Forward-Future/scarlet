import { useEffect, useRef, type RefObject } from "react";
import { usePlayerStore } from "../stores/player";

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
  // A picker's trigger keeps focus after a choice. Closed, it handles its own keys and leaves the rest to the page.
  return t.getAttribute("role") === "combobox" && t.getAttribute("aria-expanded") === "true";
}

/**
 * True while an input method (Japanese, Chinese, Korean…) is composing. Safari
 * reports the Enter that commits a composition with isComposing false but
 * keyCode 229, so check both before treating Enter as "send".
 */
export function isComposing(e: { nativeEvent?: KeyboardEvent; keyCode?: number; isComposing?: boolean }): boolean {
  return !!(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;
}

/** True while any video or audio on the page is playing. */
export function mediaPlaying(): boolean {
  return usePlayerStore.getState().playing
    || Array.from(document.querySelectorAll("video, audio")).some(m => !(m as HTMLMediaElement).paused);
}

/**
 * Page-wide shortcuts yield to the active overlay and to focused controls,
 * except that Space always pauses while something plays: a clicked button
 * (Fit, a cut marker…) keeps focus, and Space would otherwise press it again.
 */
export function ignorePageShortcut(e: KeyboardEvent, owner?: Element | null): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return true;
  // A small popover that is open closes on Esc before anything behind it does, wherever its own listener sits.
  if (e.key === "Escape" && document.querySelector("[data-escape-owner]")) return true;
  if (e.key === " " && e.target instanceof Element && e.target.closest('button, a, [role="button"]') && !mediaPlaying()) return true;
  // A clip inside version history can handle its own keys while the drawer has focus.
  const dialog = owner?.closest("dialog[open]");
  if (dialog && e.target instanceof Element && e.target.closest("dialog[open]") === dialog) {
    return !!dialog.querySelector('[role="menu"], [data-shortcut-overlay]');
  }
  return !!document.querySelector('dialog[open], [role="dialog"], [role="menu"], [data-shortcut-overlay]');
}

type SeekArrow = "ArrowLeft" | "ArrowRight";

/** ← and → skip 5 seconds, and 1 second with Shift. Holding either repeats at the keyboard's own rate. */
export function arrowSeekTime(time: number, key: SeekArrow, shift: boolean): number {
  const stepMs = shift ? 1000 : 5000;
  return (Math.round(time * 1000) + (key === "ArrowLeft" ? -stepMs : stepMs)) / 1000;
}

export type KeyHandler = (e: KeyboardEvent) => void;

/**
 * Window-level keydown/keyup hooks that ignore typing in form fields.
 * Handlers always see the latest closure (ref-backed) so callers can pass
 * inline functions without re-subscribing.
 */
export function useHotkeys(onDown: KeyHandler, onUp?: KeyHandler, owner?: RefObject<HTMLElement | null>) {
  const down = useRef(onDown);
  const up = useRef(onUp);
  down.current = onDown;
  up.current = onUp;
  useEffect(() => {
    const d = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e, owner?.current)) return;
      down.current(e);
    };
    const u = (e: KeyboardEvent) => {
      up.current?.(e);
    };
    window.addEventListener("keydown", d);
    window.addEventListener("keyup", u);
    return () => {
      window.removeEventListener("keydown", d);
      window.removeEventListener("keyup", u);
    };
  }, [owner]);
}

export const COMPARE_KEY = "\\";

/** Step between cuts once per plain ↑ or ↓ press. ← and → are the player's. */
export function handleCutArrow(e: KeyboardEvent, step: (direction: -1 | 1) => void) {
  if (e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return false;
  e.preventDefault();
  if (!e.repeat && !isComposing(e)) step(e.key === "ArrowDown" ? 1 : -1);
  return true;
}

export function useComparisonShortcut(enabled: boolean, toggle: () => void, owner?: RefObject<HTMLElement | null>) {
  useHotkeys(e => {
    if (!enabled || e.key !== COMPARE_KEY || e.shiftKey || isComposing(e)) return;
    e.preventDefault();
    if (!e.repeat) toggle();
  }, undefined, owner);
}

/** Stands in the list for a shortcut's own key, which is ⌘ on a Mac and Ctrl on Windows. The list shows the one in use. */
export const PLATFORM_KEY = "Mod";

export const SHORTCUTS: Array<{ keys: string[]; what: string; where: string }> = [
  { keys: [PLATFORM_KEY, ","], what: "Open Settings", where: "Everywhere" },
  { keys: [PLATFORM_KEY, "A"], what: "Select all projects", where: "Projects" },
  { keys: ["Esc"], what: "Clear the selection", where: "Projects" },
  { keys: ["/"], what: "Choose an editing skill", where: "Start of an edit message" },
  { keys: ["V"], what: "Hold to talk", where: "In a project" },
  { keys: ["A"], what: "Apply the suggestion on screen", where: "Suggestion" },
  { keys: ["R"], what: "Revise what is on screen", where: "Edit, call or suggestion" },
  { keys: ["K"], what: "Keep the applied edit", where: "Edit card" },
  { keys: ["U"], what: "Undo the applied edit", where: "Edit card" },
  { keys: ["A"], what: "Approve the call on screen", where: "Call card" },
  { keys: ["S"], what: "Skip the call on screen", where: "Call card" },
  { keys: [COMPARE_KEY], what: "Switch between Before and After", where: "Edit comparison" },
  { keys: ["Space"], what: "Play / pause", where: "Preview" },
  { keys: ["↑", "↓"], what: "Previous / next edit or call", where: "Edit or call card" },
  { keys: ["←", "→"], what: "Back / forward 5 seconds (1 second with Shift)", where: "Preview" },
  { keys: ["+", "−"], what: "Zoom in / out (0 to fit)", where: "Timeline" },
  { keys: ["N"], what: "Type a message at the playhead", where: "In a project" },
  { keys: ["Esc"], what: "Close what is on screen", where: "Edit, call or suggestion" },
  { keys: ["Esc"], what: "Close a popover or leave Settings", where: "Everywhere" },
  { keys: ["?"], what: "This list", where: "Everywhere" },
];
