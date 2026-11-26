// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTab } from "../../lib/reviewTabs";
import { useReviewTabHeight, type ReviewTabHeightOptions } from "./reviewTabHeight";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The request's width, as the rail lays it out. */
let width = 400;

/** A ResizeObserver the test fires by hand. */
class FakeObserver {
  static all: FakeObserver[] = [];
  targets: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) { FakeObserver.all.push(this); }
  observe(el: Element) { this.targets.push(el); }
  unobserve() {}
  disconnect() { this.targets = []; }
  static fire(el: Element) { for (const o of FakeObserver.all) if (o.targets.includes(el)) o.callback([], o as unknown as ResizeObserver); }
}

type Props = Partial<ReviewTabHeightOptions> & { tab: ReviewTab; height?: number; content?: "list" | "empty" | "none"; low?: boolean; pin?: boolean };

function Request({ height = 100, content = "list", low = false, pin = false, ...opts }: Props) {
  const host = useRef<HTMLDivElement>(null);
  useReviewTabHeight(host, { enabled: true, counts: { you: 3, working: 1, done: 0 }, youBase: 3, hasLowRisk: low, lowOpen: false, ...opts });
  return (
    <div>
      <div className={pin ? "simple-pin" : "simple-thread"}>
        <div ref={host} className="simple-pass">
          <button type="button" className="tab">Working</button>
          {low && <div className="simple-low-risk">2 low risk edits</div>}
          {content === "list" && <ol className="simple-edits" data-height={height} />}
          {content === "empty" && <p className="simple-review-empty" data-height={height}>Nothing here.</p>}
        </div>
      </div>
      <textarea className="composer-input" aria-label="Message" />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;
const realAnimate = Element.prototype.animate;
/** Each render re-measures, as a real one does when a row or a nested request changes. */
let renders = 0;
const render = async (props: Props) => { await act(async () => { root.render(<Request nestedCount={++renders} {...props} />); }); };
const host = () => container.querySelector<HTMLElement>(".simple-pass")!;
const body = () => host().style.getPropertyValue("--review-body-height");
const padded = () => host().dataset.reviewPad !== undefined;
const content = () => host().querySelector<HTMLElement>(".simple-edits, .simple-review-empty")!;

function stubAnimate() {
  const made: { keyframes: Keyframe[]; cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
  const animate = vi.fn((keyframes: Keyframe[]) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const cancel = vi.fn();
    made.push({ keyframes, cancel, finish });
    return { finished, cancel } as unknown as Animation;
  });
  Element.prototype.animate = animate as unknown as Element["animate"];
  return { animate, made };
}

/** Hold Needs review's 300 px while the editor looks at Working's 34 px. */
async function holdAfterSwitch(extra: Partial<Props> = {}) {
  await render({ tab: "you", height: 300, ...extra });
  await render({ tab: "working", height: 34, ...extra });
  // The floor is the list's own height: a low risk line above it is counted apart.
  expect(body()).toBe("300px");
}

beforeEach(() => {
  width = 400;
  FakeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeObserver);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const box = (w: number, h: number) => ({ x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) }) as DOMRect;
    if (el.classList.contains("simple-pass")) return box(width, 400);
    if (el.classList.contains("simple-low-risk")) return box(width, 24);
    if (el.dataset.height !== undefined) {
      const parent = el.parentElement!;
      const floor = parent.dataset.reviewPad !== undefined ? parseFloat(parent.style.getPropertyValue("--review-body-height")) || 0 : 0;
      return box(width, Math.max(Number(el.dataset.height), floor));
    }
    return box(0, 0);
  });
  const style = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(el => {
    const margins = el.classList.contains("simple-low-risk") ? { marginTop: "0px", marginBottom: "4px" } : { marginTop: "", marginBottom: "0px" };
    return { ...style(el), ...margins } as CSSStyleDeclaration;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Element.prototype.animate = realAnimate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useReviewTabHeight", () => {
  it("collapses when focus moves out of the request, but not when it moves within it or back to the page", async () => {
    const { animate } = stubAnimate();
    await holdAfterSwitch();
    await act(async () => { document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    await act(async () => { host().querySelector<HTMLElement>(".tab")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(padded()).toBe(true);
    expect(animate).not.toHaveBeenCalled();

    await act(async () => { container.querySelector(".composer-input")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(padded()).toBe(false);
    expect(body()).toBe("");
    expect(animate).toHaveBeenCalledWith([{ height: "300px", minHeight: "300px" }, { height: "34px", minHeight: "34px" }], expect.objectContaining({ duration: 220 }));
  });

  it("lets go of the held height when the tabs go away, and starts afresh when they come back", async () => {
    await holdAfterSwitch();
    await render({ tab: "working", height: 34, enabled: false });
    expect(padded()).toBe(false);
    // Back on, it hasn't seen a tab yet, so nothing is held from before.
    await render({ tab: "working", height: 34 });
    expect(padded()).toBe(false);
    await render({ tab: "done", height: 20 });
    expect(body()).toBe("34px");
  });

  it("drops the floor while low risk rows close, and holds again once they have", async () => {
    await holdAfterSwitch();
    await render({ tab: "working", height: 34, lowClosing: true });
    expect(padded()).toBe(false);
    await render({ tab: "working", height: 34, lowClosing: false });
    expect(body()).toBe("300px");
  });

  it("forgets the held height when the tab draws nothing to measure", async () => {
    await holdAfterSwitch();
    await render({ tab: "working", content: "none" });
    expect(padded()).toBe(false);
    await render({ tab: "working", height: 34 });
    expect(padded()).toBe(false);
  });

  it("leaves its memory alone while the request has no layout, and holds once it is laid out again", async () => {
    await render({ tab: "you", height: 300 });
    width = 0;
    await render({ tab: "working", height: 0 });
    expect(padded()).toBe(false);
    width = 400;
    await render({ tab: "working", height: 34 });
    expect(body()).toBe("300px");
  });

  it("lets go of the hold when the window or the rail changes the request's width", async () => {
    await holdAfterSwitch();
    // The same width again changes nothing.
    await act(async () => { FakeObserver.fire(host()); });
    expect(body()).toBe("300px");
    width = 360;
    await act(async () => { FakeObserver.fire(host()); });
    expect(padded()).toBe(false);

    await render({ tab: "you", height: 300 });
    await render({ tab: "working", height: 34 });
    expect(body()).toBe("300px");
    width = 520;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(padded()).toBe(false);
  });

  it("lets go of the hold when the request moves into the pinned dock", async () => {
    await holdAfterSwitch();
    await render({ tab: "working", height: 34, pin: true });
    expect(padded()).toBe(false);
  });

  it("raises the hold when the tab shown grows past it, and holds that once it shrinks", async () => {
    await holdAfterSwitch();
    await render({ tab: "working", height: 420 });
    expect(padded()).toBe(false);
    await render({ tab: "working", height: 80 });
    expect(body()).toBe("420px");
  });

  it("follows the tab's own height as it settles, holding what it grew to", async () => {
    await render({ tab: "you", height: 100, low: true });
    content().dataset.height = "250";
    await act(async () => { FakeObserver.fire(content()); });
    await render({ tab: "working", height: 34, low: true });
    // The 250 px list it had grown to, under the 24 px line and its 4 px margin.
    expect(body()).toBe("250px");
  });

  it("passes over sizes reported while padded, while rows close, or with nothing drawn", async () => {
    await holdAfterSwitch();
    content().dataset.height = "500";
    await act(async () => { FakeObserver.fire(content()); });
    await render({ tab: "done", height: 35 });
    expect(body()).toBe("300px");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ tab: "you", height: 100, lowClosing: true });
    content().dataset.height = "600";
    await act(async () => { FakeObserver.fire(content()); });
    content().dataset.height = "100";
    await render({ tab: "you", height: 100 });
    content().dataset.height = "0";
    width = 0;
    await act(async () => { FakeObserver.fire(content()); });
    width = 400;
    await render({ tab: "working", height: 34 });
    expect(body()).toBe("100px");
  });

  it("raises a hold it isn't padding for when the tab grows under it", async () => {
    await holdAfterSwitch();
    await render({ tab: "working", height: 420 });
    content().dataset.height = "450";
    await act(async () => { FakeObserver.fire(content()); });
    await render({ tab: "working", height: 60 });
    expect(body()).toBe("450px");
  });

  it("collapses with the low risk line still measured once everything is finished", async () => {
    await render({ tab: "you", height: 300, low: true });
    await render({ tab: "working", height: 34, low: true });
    expect(body()).toBe("300px");
    await render({ tab: "working", height: 34, low: true, counts: { you: 0, working: 0, done: 4 }, youBase: 0 });
    expect(padded()).toBe(false);
    // What it measured then (28 px line and 34 px list) is what a switch holds next.
    await render({ tab: "done", height: 10, low: true, counts: { you: 0, working: 0, done: 4 }, youBase: 0 });
    expect(body()).toBe("34px");
  });

  it("clears a hold it isn't padding for once everything is finished", async () => {
    stubAnimate();
    await holdAfterSwitch();
    await render({ tab: "working", height: 420 });
    expect(padded()).toBe(false);
    await render({ tab: "working", height: 420, counts: { you: 0, working: 0, done: 4 }, youBase: 0 });
    await render({ tab: "working", height: 60, counts: { you: 0, working: 0, done: 4 }, youBase: 0 });
    expect(padded()).toBe(false);
  });

  it("stops a collapse when the editor switches tab again, and when the request goes away", async () => {
    const { made } = stubAnimate();
    await holdAfterSwitch();
    await act(async () => { container.querySelector(".composer-input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(made).toHaveLength(1);
    // Sizes reported while it collapses are its own animation's, and are passed over.
    content().dataset.height = "900";
    await act(async () => { FakeObserver.fire(content()); });
    await render({ tab: "done", height: 34 });
    expect(made[0]!.cancel).toHaveBeenCalledOnce();
    expect(body()).toBe("");

    await render({ tab: "you", height: 300 });
    await render({ tab: "working", height: 34 });
    await act(async () => { container.querySelector(".composer-input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(made).toHaveLength(2);
    made[1]!.finish();
    await act(async () => { await Promise.resolve(); });
    await render({ tab: "you", height: 300 });
    expect(made[1]!.cancel).not.toHaveBeenCalled();

    await render({ tab: "working", height: 34 });
    await act(async () => { container.querySelector(".composer-input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await act(async () => root.unmount());
    expect(made[2]!.cancel).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it("collapses at once, without a shrink to show, when the held tab is as tall as the hold", async () => {
    const { animate } = stubAnimate();
    await holdAfterSwitch();
    content().dataset.height = "300";
    await act(async () => { container.querySelector(".composer-input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(padded()).toBe(false);
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing without ResizeObserver beyond holding across tabs", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    await holdAfterSwitch();
    expect(FakeObserver.all).toHaveLength(0);
  });
});
