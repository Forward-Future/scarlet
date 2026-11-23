import { useRef } from "react";
import type { Task } from "@scarlet/shared";
import { useWorkingLines } from "../../lib/workingLines";
import { StepMark } from "./RunBundle";

const FLASH_MS = 1200;

/** The chat's row for a request at work: its own line of what it is doing, not one of a request drawn inside it. */
function chatRowOf(taskId: string): { scroll: HTMLElement; flash: HTMLElement } | undefined {
  const run = document.querySelector<HTMLElement>(`#simple-chat [data-run="${CSS.escape(taskId)}"]`);
  if (!run) return;
  const now = [...run.querySelectorAll<HTMLElement>(".req-now")].find(row => row.closest("[data-run]") === run);
  // A request under a cut's or an edit's row is small enough to light whole; a request's block lights its working line.
  return { scroll: now ?? run, flash: run.classList.contains("subunit") ? run : now ?? run };
}

/**
 * Under the timeline, beside the clock, while Scarlet is at work on the video: the chat's turning ring and what Scarlet
 * is doing, in the chat's own words. A press brings that request into the middle of the chat and lights it for a
 * moment; with several at work, each press goes on to the next.
 */
export function TimelineWorking({ tasks }: { tasks: readonly Task[] }) {
  const lines = useWorkingLines();
  const next = useRef(0);
  if (!tasks.length) return null;
  const words = tasks.length > 1 ? `Working on ${tasks.length} at once` : lines[tasks[0]!.id];
  const show = () => {
    const task = tasks[next.current % tasks.length]!;
    next.current += 1;
    const row = chatRowOf(task.id);
    if (!row) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scroll.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    row.flash.removeAttribute("data-flash");
    void row.flash.offsetWidth;
    row.flash.setAttribute("data-flash", "");
    window.setTimeout(() => row.flash.removeAttribute("data-flash"), FLASH_MS);
  };
  return <button type="button" className="timeline-working" title="Show in the chat"
    aria-label={`Scarlet is editing${words ? `: ${words}` : ""}. Show in the chat`} onClick={show}>
    <StepMark state="working" />
    <span className="timeline-working-text">Scarlet is editing{words && <span> · {words}</span>}</span>
  </button>;
}
