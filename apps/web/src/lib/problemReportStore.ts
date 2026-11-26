/**
 * The report form's state, opened from the Help menu or Settings, or to add details to a report a Report beside an
 * error already sent in one click. And the errors the window showed lately, so a report says what was on screen.
 */
import { create } from "zustand";
import { logPath } from "./appLog";
import type { ProblemReportWords } from "./desktop";

/** A report already sent, that the editor can add what happened to. */
export interface SentReport { id: string; reference: string; about?: string }

export const useProblemReport = create<{
  open: boolean;
  /** Set when the form adds details to a report already sent. */
  follows?: SentReport;
  /** Reports the editor added details to, by id. */
  detailed: string[];
  show(): void;
  addDetails(report: SentReport): void;
  markDetailed(id: string): void;
  hide(): void;
}>((set) => ({
  open: false,
  follows: undefined,
  detailed: [],
  show: () => set({ open: true, follows: undefined }),
  addDetails: (follows) => set({ open: true, follows }),
  markDetailed: (id) => set(s => ({ detailed: [...s.detailed, id] })),
  hide: () => set({ open: false, follows: undefined }),
}));

/** What a report says beside the logs Scarlet adds: the editor's words, the error on screen, the page, what was shown. */
export function reportWords(description: string, about?: string): ProblemReportWords {
  return { description, about: about?.trim() || undefined, page: logPath(location.href), onScreen: recentOnScreenErrors() };
}

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
