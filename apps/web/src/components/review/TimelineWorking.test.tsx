// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@scarlet/shared";
import { useWorkingLines } from "../../lib/workingLines";
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
  useWorkingLines.setState({}, true);
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

const task = (id: string) => ({ id }) as Task;

it("counts several requests at work and goes on to the next one in the chat with each press", async () => {
  const chat = document.createElement("aside");
  chat.id = "simple-chat";
  // A pass at work with a revision under one of its rows, each with its own working line.
  chat.innerHTML = `<div class="unit" data-run="a"><div class="req"><div class="req-now" id="a-now"></div></div>
    <div class="subunit" data-run="b"><div class="req"><div class="req-now" id="b-now"></div></div></div></div>`;
  document.body.append(chat);
  const scrolled: string[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) { scrolled.push(this.id); } });
  useWorkingLines.setState({ a: "Reading the dialogue at 12:34", b: "Listening to Cut 2" });
  try {
    await act(async () => root.render(<TimelineWorking tasks={[task("a")]} />));
    const status = () => container.querySelector<HTMLButtonElement>(".timeline-working")!;
    expect(status().textContent).toBe("Scarlet is editing · Reading the dialogue at 12:34");
    await act(async () => root.render(<TimelineWorking tasks={[task("a"), task("b")]} />));
    expect(status().textContent).toBe("Scarlet is editing · Working on 2 at once");
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
