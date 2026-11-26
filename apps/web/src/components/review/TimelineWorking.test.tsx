// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@scarlet/shared";
import { requestRoots } from "../../lib/requestRuns";
import { TimelineWorking } from "./TimelineWorking";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

const task = (id: string) => ({ id }) as Task;

it("shows Scarlet is editing without trailing text and goes on to the next request in the chat with each press", async () => {
  const chat = document.createElement("aside");
  chat.id = "simple-chat";
  // A pass at work with a revision under one of its rows, each with its own working line.
  chat.innerHTML = `<div class="unit" data-run="a"><div class="req"><div class="req-now" id="a-now"></div></div>
    <div class="subunit" data-run="b"><div class="req"><div class="req-now" id="b-now"></div></div></div></div>`;
  document.body.append(chat);
  const scrolled: string[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) { scrolled.push(this.id); } });
  try {
    await act(async () => root.render(<TimelineWorking tasks={[task("a")]} />));
    const status = () => container.querySelector<HTMLButtonElement>(".timeline-working")!;
    expect(status().textContent).toBe("Scarlet is editing");
    expect(status().getAttribute("aria-label")).toBe("Scarlet is editing. Show in the chat");
    await act(async () => root.render(<TimelineWorking tasks={[task("a"), task("b")]} />));
    expect(status().textContent).toBe("Scarlet is editing");
    // The pass's own line, not the one of the request drawn inside it; then the revision, lit whole; then round again.
    await act(async () => status().click());
    await act(async () => status().click());
    await act(async () => status().click());
    expect(scrolled).toEqual(["a-now", "b-now", "a-now"]);
    expect(chat.querySelector(".subunit")!.hasAttribute("data-flash")).toBe(true);
    // Nothing at work, nothing under the timeline.
    await act(async () => root.render(<TimelineWorking tasks={[]} />));
    expect(container.querySelector(".timeline-working")).toBeNull();
  } finally {
    chat.remove();
  }
});

it("brings a request that was picked up again into view, by the block it began in", async () => {
  const chat = document.createElement("aside");
  chat.id = "simple-chat";
  // The chat keeps a request's one block, named for its first attempt. After a pause or a restart Scarlet works on it
  // under a later attempt, and after Retry under one that only the failed attempt names.
  chat.innerHTML = `<div class="unit" data-run="a"><div class="req"><div class="req-now" id="a-now"></div></div></div>
    <div class="unit" data-run="b"><div class="req"><div class="req-now" id="b-now"></div></div></div>`;
  document.body.append(chat);
  const scrolled: string[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) { scrolled.push(this.id); } });
  const resumed = { id: "a_again", resumeRootId: "a" } as Task;
  const retried = [{ id: "b", retryTaskId: "b_again" }, { id: "b_again" }] as Task[];
  try {
    await act(async () => root.render(<TimelineWorking tasks={[resumed, retried[1]!]} rootOf={requestRoots([resumed, ...retried])} />));
    const status = container.querySelector<HTMLButtonElement>(".timeline-working")!;
    await act(async () => status.click());
    await act(async () => status.click());
    expect(scrolled).toEqual(["a-now", "b-now"]);
    expect(chat.querySelector("#b-now")!.hasAttribute("data-flash")).toBe(true);
    // With nothing to say which request an attempt belongs to, one that was resumed still names it.
    await act(async () => root.render(<TimelineWorking tasks={[resumed]} />));
    await act(async () => container.querySelector<HTMLButtonElement>(".timeline-working")!.click());
    expect(scrolled).toEqual(["a-now", "b-now", "a-now"]);
    // Folded to its band, a request has nothing else in view: its band comes into the middle and lights.
    const folded = chat.querySelector<HTMLElement>('[data-run="a"]')!;
    folded.classList.add("is-collapsed");
    folded.insertAdjacentHTML("afterbegin", '<div class="unit-msg" id="a-band"></div>');
    await act(async () => container.querySelector<HTMLButtonElement>(".timeline-working")!.click());
    expect(scrolled.at(-1)).toBe("a-band");
    expect(chat.querySelector("#a-band")!.hasAttribute("data-flash")).toBe(true);
  } finally {
    chat.remove();
  }
});

it("finds and lights revisions inside the beta edits rail, open or folded, and drops focus on pointer click", async () => {
  const layout = document.createElement("main");
  layout.setAttribute("data-new-layout", "");
  layout.innerHTML = `<aside id="simple-review-rail" class="review-rail">
    <button type="button" class="review-sec" id="working-head">Working</button>
    <div class="review-sec-body" id="working-body">
      <ol class="simple-edits"><li id="rev-row"><div class="subunit" data-run="rev"><div class="req"><div class="req-now" id="rev-now"></div></div></div></li></ol>
    </div>
  </aside>`;
  document.body.append(layout);
  const scrolled: string[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) { scrolled.push(this.id); } });
  try {
    await act(async () => root.render(<TimelineWorking tasks={[task("rev")]} />));
    const status = container.querySelector<HTMLButtonElement>(".timeline-working")!;
    // Open in beta one-row style: scrolls and flashes the visible <li>, not the visually hidden .req-now.
    status.focus();
    await act(async () => status.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(scrolled.at(-1)).toBe("rev-row");
    expect(layout.querySelector("#rev-row")!.hasAttribute("data-flash")).toBe(true);
    expect(document.activeElement).not.toBe(status);
    // Folded Working section: scrolls and flashes the visible Working header.
    layout.querySelector<HTMLElement>("#working-body")!.hidden = true;
    await act(async () => status.click());
    expect(scrolled.at(-1)).toBe("working-head");
    expect(layout.querySelector("#working-head")!.hasAttribute("data-flash")).toBe(true);
  } finally {
    layout.remove();
  }
});

it("renders only the editing status button with no pause control on the timeline", async () => {
  await act(async () => root.render(<TimelineWorking tasks={[task("a")]} />));
  expect(container.querySelector(".timeline-working")?.textContent).toBe("Scarlet is editing");
  expect(container.querySelector(".timeline-working-pause")).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(1);
});
