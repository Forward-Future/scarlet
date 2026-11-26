import { useRef } from "react";
import type { Task } from "@scarlet/shared";
import { blurOnPointerClick } from "../../lib/hotkeys";
import { Icon } from "../ui/primitives";
import { StepMark } from "./RunBundle";

const FLASH_MS = 1200;
const flashTimers = new WeakMap<HTMLElement, number>();

/** The chat or edits-rail row for a request at work: its own line of what it is doing, not one of a request drawn inside it. */
function chatRowOf(taskId: string): { scroll: HTMLElement; flash: HTMLElement } | undefined {
  const escaped = CSS.escape(taskId);
  const run = document.querySelector<HTMLElement>(`#simple-chat [data-run="${escaped}"], .review-rail [data-run="${escaped}"]`);
  if (!run) return;
  // A request folded to its band, or one under a row of it, has nothing else in view: the band is what is shown and lit.
  const band = run.closest(".unit.is-collapsed")?.querySelector<HTMLElement>(":scope > .unit-msg");
  if (band) return { scroll: band, flash: band };
  // In the beta edits rail, a revision inside a folded Working section lights that section's header instead.
  const foldedSection = run.closest<HTMLElement>(".review-sec-body[hidden]");
  if (foldedSection?.previousElementSibling instanceof HTMLElement) {
    return { scroll: foldedSection.previousElementSibling, flash: foldedSection.previousElementSibling };
  }
  // In the beta one-row revision style, `.subunit > .req` is visually hidden while the parent `<li>` holds the row.
  if (run.classList.contains("subunit") && run.closest("[data-new-layout]") && run.parentElement?.tagName === "LI") {
    return { scroll: run.parentElement, flash: run.parentElement };
  }
  const now = [...run.querySelectorAll<HTMLElement>(".req-now")].find(row => row.closest("[data-run]") === run);
  // A request under a cut's or an edit's row is small enough to light whole; a request's block lights its working line.
  return { scroll: now ?? run, flash: run.classList.contains("subunit") ? run : now ?? run };
}

/**
 * Under the timeline, beside the clock, while Scarlet is at work on the video: the chat's turning ring and
 * "Scarlet is editing". A press brings that request into the middle of the chat and lights it for a moment;
 * with several at work, each press goes on to the next.
 */
export function TimelineWorking({ tasks, rootOf = task => task.resumeRootId ?? task.id, pause }: { tasks: readonly Task[];
  /** The request an attempt belongs to, by its first attempt (`requestRoots`): the chat names a request's block for it. */
  rootOf?(task: Task): string;
  /** Project-wide Pause / Resume button beside the status (beta layout). */
  pause?: { paused: boolean; onToggle(): void };
}) {
  const next = useRef(0);
  if (!tasks.length && !pause?.paused) return null;
  if (!tasks.length && pause?.paused) {
    return <span className="timeline-working-group is-paused">
      <span className="timeline-working-paused">Editing paused</span>
      <button type="button" className="timeline-working-pause is-resume" aria-label="Resume editing"
        title="Resume editing. Paused work picks up first, where it left off."
        onClick={e => { blurOnPointerClick(e); pause.onToggle(); }}>
        <Icon name="play" size={11} /><span>Resume</span>
      </button>
    </span>;
  }
  const show = () => {
    const task = tasks[next.current % tasks.length]!;
    next.current += 1;
    // After a pause, a restart or a retry Scarlet works under a later attempt, and the block keeps its first one's name.
    const row = chatRowOf(rootOf(task));
    if (!row) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scroll.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    const prev = flashTimers.get(row.flash);
    if (prev !== undefined) window.clearTimeout(prev);
    row.flash.removeAttribute("data-flash");
    void row.flash.offsetWidth;
    row.flash.setAttribute("data-flash", "");
    flashTimers.set(row.flash, window.setTimeout(() => {
      row.flash.removeAttribute("data-flash");
      flashTimers.delete(row.flash);
    }, FLASH_MS));
  };
  const status = <button type="button" className="timeline-working" title="Show in the chat"
    aria-label="Scarlet is editing. Show in the chat" onClick={e => { blurOnPointerClick(e); show(); }}>
    <StepMark state="working" />
    <span className="timeline-working-text">Scarlet is editing</span>
  </button>;
  if (!pause) return status;
  return <span className="timeline-working-group">
    {status}
    <button type="button" className="timeline-working-pause" aria-label="Pause editing"
      title="Pause all editing in this project. Nothing new starts, and edits already made stay."
      onClick={e => { blurOnPointerClick(e); pause.onToggle(); }}>
      <Icon name="pause" size={11} /><span>Pause</span>
    </button>
  </span>;
}
