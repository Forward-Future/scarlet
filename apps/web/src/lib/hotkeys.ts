import { useEffect, useRef, type RefObject } from "react";
import { usePlayerStore } from "../stores/player";
import { matchesBinding, matchesShortcut, SHORTCUT_ACTIONS, useShortcutsStore } from "../stores/shortcuts";
import { markedRangeOf, useUiStore } from "../stores/ui";

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
  // A picker's trigger keeps focus after a choice. Closed, it handles its own keys and leaves the rest to the page.
  return t.getAttribute("role") === "combobox" && t.getAttribute("aria-expanded") === "true";
}

/** True when the event target is inside an editable form field or contenteditable surface. */
export function isInEditableElement(t: EventTarget | null): t is HTMLElement {
  return t instanceof HTMLElement && (isEditableTarget(t) || !!t.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"));
}

/** Release focus after a pointer click so Space returns to playback; keyboard activation keeps focus. */
export function blurOnPointerClick(e: { detail: number; currentTarget: HTMLElement }) {
  if (e.detail) e.currentTarget.blur();
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
  // A stretch marked on the timeline goes on Esc before an edit's card or anything else the page closes.
  if (e.key === "Escape" && markedRangeOf(useUiStore.getState().agentContext)) return true;
  // A focused handle of the marked range takes its own Esc, and leaves Space to the player: it has no click of its own.
  const handle = e.target instanceof Element && !!e.target.closest("[data-range-handle]");
  if (e.key === "Escape" && handle) return true;
  if (e.key === " " && !handle && e.target instanceof Element && e.target.closest('button, a, [role="button"]') && !mediaPlaying()) return true;
  // A clip inside version history can handle its own keys while the drawer has focus.
  const dialog = owner?.closest("dialog[open]");
  if (dialog && e.target instanceof Element && e.target.closest("dialog[open]") === dialog) {
    return !!dialog.querySelector('[role="menu"], [data-shortcut-overlay]');
  }
  return !!document.querySelector('dialog[open], [role="dialog"], [role="menu"], [data-shortcut-overlay]');
}

type SeekArrow = "ArrowLeft" | "ArrowRight";

/** ← and → skip 1 second, and 1 frame with Shift. Holding either repeats at the keyboard's own rate. */
export function arrowSeekTime(time: number, key: SeekArrow, shift: boolean, fps = 30): number {
  const dir = key === "ArrowLeft" ? -1 : 1;
  if (shift) {
    const rate = fps > 0 && Number.isFinite(fps) ? fps : 30;
    const slack = Math.min(0.1, 1e-3 * rate);
    return (Math.floor(time * rate + slack) + dir) / rate;
  }
  return (Math.round(time * 1000) + dir * 1000) / 1000;
}

export type KeyHandler = (e: KeyboardEvent) => void;

/**
 * Window-level keydown/keyup hooks that ignore typing in form fields.
 * Handlers always see the latest closure (ref-backed) so callers can pass
 * inline functions without re-subscribing.
 */
function isModifiedWorkspaceShortcut(e: KeyboardEvent, owner?: Element | null): boolean {
  if (e.defaultPrevented || isEditableTarget(e.target) || !(e.metaKey || e.ctrlKey || e.altKey)) return false;
  const dialog = owner?.closest("dialog[open]");
  if (dialog && e.target instanceof Element && e.target.closest("dialog[open]") === dialog) {
    if (dialog.querySelector('[role="menu"], [data-shortcut-overlay]')) return false;
  } else if (document.querySelector('dialog[open], [role="dialog"], [role="menu"], [data-shortcut-overlay]')) {
    return false;
  }
  const { bindings } = useShortcutsStore.getState();
  return SHORTCUT_ACTIONS.some(a => a.scope === "workspace" && a.id !== "clearRange" && !!bindings[a.id] && (bindings[a.id]!.includes("Mod+") || bindings[a.id]!.includes("Alt+")) && matchesBinding(e, bindings[a.id]));
}

export function useHotkeys(onDown: KeyHandler, onUp?: KeyHandler, owner?: RefObject<HTMLElement | null>) {
  const down = useRef(onDown);
  const up = useRef(onUp);
  down.current = onDown;
  up.current = onUp;
  useEffect(() => {
    const d = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e, owner?.current) && !isModifiedWorkspaceShortcut(e, owner?.current)) return;
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

/** Step between cuts once per plain previous/next edit shortcut (↑ / ↓ by default). ← and → are the player's. */
export function handleCutArrow(e: KeyboardEvent, step: (direction: -1 | 1) => void) {
  const direction: -1 | 1 | 0 = matchesShortcut(e, "nextEdit") ? 1 : matchesShortcut(e, "prevEdit") ? -1 : 0;
  if (!direction) return false;
  e.preventDefault();
  if (!e.repeat && !isComposing(e)) step(direction);
  return true;
}

export function useComparisonShortcut(enabled: boolean, toggle: () => void, owner?: RefObject<HTMLElement | null>) {
  useHotkeys(e => {
    if (!enabled || !matchesShortcut(e, "compare") || isComposing(e)) return;
    e.preventDefault();
    if (!e.repeat) toggle();
  }, undefined, owner);
}

/** True for Option+X / Alt+X (standard Clear In/Out). Checks `code` too because macOS reports `≈` for Option+X. */
export function isAltClearRangeKey(e: { key: string; code?: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.code === "KeyX" || e.key.toLowerCase() === "x");
}

/** True when `e` matches the user's configured Clear Marked Range shortcut (Option+X / Alt+X by default). */
export function matchesClearRangeKey(e: { key: string; code?: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return matchesShortcut(e, "clearRange");
}

/** Stands in the list for a shortcut's own key, which is ⌘ on a Mac and Ctrl on Windows. The list shows the one in use. */
export const PLATFORM_KEY = "Mod";
/** Stands in the list for Option on a Mac and Alt on Windows/Linux. */
export const ALT_KEY = "Alt";

export const SHORTCUTS: Array<{ keys: string[]; what: string; where: string }> = [
  { keys: [PLATFORM_KEY, ","], what: "Open Settings", where: "Everywhere" },
  { keys: [PLATFORM_KEY, "A"], what: "Select all projects", where: "Projects" },
  { keys: [PLATFORM_KEY, "F"], what: "Find in skill", where: "Skill Editor" },
  { keys: ["Esc"], what: "Clear the selection", where: "Projects" },
  { keys: ["/"], what: "Choose an editing skill", where: "Start of an edit message" },
  { keys: ["V"], what: "Hold to talk", where: "In a project" },
  { keys: ["A"], what: "Apply the suggestion on screen", where: "Suggestion" },
  { keys: ["R"], what: "Revise what is on screen", where: "Edit, call or suggestion" },
  { keys: ["K"], what: "Keep the edit or call on screen", where: "Edit or call card" },
  { keys: ["X"], what: "Reject the edit or call on screen", where: "Edit or call card" },
  { keys: [COMPARE_KEY], what: "Switch between Before and After", where: "Edit comparison" },
  { keys: ["Space"], what: "Play / pause", where: "Preview" },
  { keys: ["↑", "↓"], what: "Previous / next edit or call", where: "Edit or call card" },
  { keys: ["←", "→"], what: "Back / forward 1 second (1 frame with Shift)", where: "Preview" },
  { keys: ["L"], what: "Speed up playback (again for 1×, Shift for slower)", where: "Preview" },
  { keys: ["−", "+"], what: "Zoom the timeline out / in (0 to fit)", where: "Timeline" },
  { keys: [ALT_KEY, "X"], what: "Clear the marked range (also Esc or Delete)", where: "Timeline" },
  { keys: ["N"], what: "Type a message at the playhead", where: "In a project" },
  { keys: ["Esc"], what: "Close what is on screen", where: "Edit, call or suggestion" },
  { keys: ["Esc"], what: "Close a popover or leave Settings", where: "Everywhere" },
  { keys: ["?"], what: "This list", where: "Everywhere" },
];
