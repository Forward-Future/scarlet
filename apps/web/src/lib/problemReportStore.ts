/**
 * The report form's state, opened from anywhere: a Report beside an error, the Help menu, Settings, a crash. And the
 * errors the window showed lately, so a report says what was on screen even when it was opened from the menu.
 */
import { create } from "zustand";

export const useProblemReport = create<{
  open: boolean;
  /** The error on screen the report is about, in the words shown there. */
  about?: string;
  show(about?: string): void;
  hide(): void;
}>((set) => ({
  open: false,
  about: undefined,
  show: (about) => set({ open: true, about: about?.trim() || undefined }),
  hide: () => set({ open: false, about: undefined }),
}));

/** How many recent errors are kept, and for how long they count as recent. */
const KEPT = 8;
const RECENT_MS = 15 * 60_000;
const shown: { at: number; text: string }[] = [];

/** An error the window put on screen, as its log records it (no field contents, no addresses). */
export function noteOnScreenError(text: string, at = Date.now()) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat || shown.at(-1)?.text === flat) return;
  shown.push({ at, text: flat });
  if (shown.length > KEPT) shown.shift();
}

/** The errors shown in the last quarter hour, oldest first. */
export function recentOnScreenErrors(now = Date.now()) {
  return shown.filter(e => now - e.at <= RECENT_MS).map(e => e.text);
}

export function forgetOnScreenErrors() {
  shown.length = 0;
}
