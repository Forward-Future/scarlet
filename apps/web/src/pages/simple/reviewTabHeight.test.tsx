// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLowRiskLine } from "./lowRiskFold";
import { useReviewTabHeight, type ReviewTabHeightOptions } from "./reviewTabHeight";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessProps = ReviewTabHeightOptions & {
  lowRiskCount?: number;
  rows: number;
};

function Harness({ lowRiskCount = 0, rows, ...opts }: HarnessProps) {
  const host = useRef<HTMLDivElement>(null);
  const lowLine = useLowRiskLine(host, lowRiskCount, opts.enabled && opts.tab === "you");
  useReviewTabHeight(host, opts);
  return (
    <div>
      <div ref={host} className="simple-pass">
        <div className="simple-review-tabs" />
        {lowLine && <div className="simple-low-risk" data-leaving={lowLine.leaving ? "true" : undefined}>{lowLine.count} low risk edits</div>}
        {rows > 0 ? (
          <ol className="simple-pass-list">
            {Array.from({ length: rows }, (_, i) => <li key={i}><button type="button">Row {i + 1}</button></li>)}
          </ol>
        ) : (
          <p className="simple-review-empty">Nothing here.</p>
        )}
      </div>
      <textarea className="composer-input" aria-label="Message" />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

function stubLayout() {
  const origRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("simple-pass")) return { x: 0, y: 0, left: 0, top: 0, right: 403, bottom: 420, width: 403, height: 420, toJSON: () => ({}) };
    if (this.classList.contains("simple-low-risk")) return { x: 0, y: 0, left: 0, top: 0, right: 403, bottom: 28, width: 403, height: 28, toJSON: () => ({}) };
    if (this.classList.contains("simple-pass-list")) {
      const count = this.querySelectorAll("li").length;
      const h = Math.min(320, count * 30);
      return { x: 0, y: 0, left: 0, top: 0, right: 403, bottom: h, width: 403, height: h, toJSON: () => ({}) };
    }
    if (this.classList.contains("simple-review-empty")) {
      const padded = (this.parentElement as HTMLElement | null)?.dataset.reviewPad !== undefined;
      const h = padded ? parseFloat((this.parentElement as HTMLElement).style.getPropertyValue("--review-body-height")) || 34 : 34;
      return { x: 0, y: 0, left: 0, top: 0, right: 403, bottom: h, width: 403, height: h, toJSON: () => ({}) };
    }
    return origRect.call(this);
  });
  const origStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const base = origStyle(el);
    if (el.classList.contains("simple-low-risk")) return { ...base, marginTop: "0px", marginBottom: "4px" } as CSSStyleDeclaration;
    if (el.classList.contains("simple-pass-list")) return { ...base, marginTop: "0px", marginBottom: "4px" } as CSSStyleDeclaration;
    return { ...base, marginTop: "0px", marginBottom: "0px" } as CSSStyleDeclaration;
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useReviewTabHeight", () => {
  it("holds the height while switching tabs and collapses smoothly when clicking outside", async () => {
    stubLayout();
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation);
    Element.prototype.animate = animate;

    await act(async () => {
      root.render(
        <Harness enabled tab="you" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk lowOpen={false} lowRiskCount={17} rows={12} />,
      );
    });
    const host = container.querySelector<HTMLElement>(".simple-pass")!;
    expect(host.dataset.reviewPad).toBeUndefined();
    expect(host.querySelector(".simple-low-risk")).not.toBeNull();

    // Switch to Working: low-risk switch disappears immediately and height holds at 356px (32 + 320 + 4).
    await act(async () => {
      root.render(
        <Harness enabled tab="working" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk lowOpen={false} lowRiskCount={17} rows={0} />,
      );
    });
    expect(host.querySelector(".simple-low-risk")).toBeNull();
    expect(host.dataset.reviewPad).toBe("");
    expect(host.style.getPropertyValue("--review-body-height")).toBe("356px");

    // Clicking inside the request keeps the height locked.
    await act(async () => {
      host.querySelector(".simple-review-tabs")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(host.dataset.reviewPad).toBe("");
    expect(animate).not.toHaveBeenCalled();

    // Switch to Done: still holds 356px.
    await act(async () => {
      root.render(
        <Harness enabled tab="done" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk lowOpen={false} lowRiskCount={17} rows={0} />,
      );
    });
    expect(host.dataset.reviewPad).toBe("");
    expect(host.style.getPropertyValue("--review-body-height")).toBe("356px");

    // Clicking outside into the composer collapses smoothly back to the empty tab's real height.
    const composer = container.querySelector<HTMLTextAreaElement>(".composer-input")!;
    await act(async () => {
      composer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(host.dataset.reviewPad).toBeUndefined();
    expect(host.style.getPropertyValue("--review-body-height")).toBe("");
    expect(animate).toHaveBeenCalledWith(
      [{ height: "356px", minHeight: "356px" }, { height: "34px", minHeight: "34px" }],
      expect.objectContaining({ duration: 220 }),
    );
  });

  it("collapses when everything in Needs review and Working finishes", async () => {
    stubLayout();
    await act(async () => {
      root.render(
        <Harness enabled tab="you" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk={false} lowOpen={false} rows={12} />,
      );
    });
    const host = container.querySelector<HTMLElement>(".simple-pass")!;
    await act(async () => {
      root.render(
        <Harness enabled tab="working" counts={{ you: 1, working: 0, done: 11 }} youBase={1} hasLowRisk={false} lowOpen={false} rows={0} />,
      );
    });
    expect(host.dataset.reviewPad).toBe("");
    expect(host.style.getPropertyValue("--review-body-height")).toBe("324px");

    // Last item moves to Done (Needs review = 0, Working = 0): collapses automatically.
    await act(async () => {
      root.render(
        <Harness enabled tab="working" counts={{ you: 0, working: 0, done: 12 }} youBase={0} hasLowRisk={false} lowOpen={false} rows={0} />,
      );
    });
    expect(host.dataset.reviewPad).toBeUndefined();
    expect(host.style.getPropertyValue("--review-body-height")).toBe("");
  });

  it("collapses when a newer request starts below it in the chat", async () => {
    stubLayout();
    await act(async () => {
      root.render(
        <Harness enabled tab="you" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk={false} lowOpen={false} rows={12} laterRequests={0} />,
      );
    });
    const host = container.querySelector<HTMLElement>(".simple-pass")!;
    await act(async () => {
      root.render(
        <Harness enabled tab="working" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk={false} lowOpen={false} rows={0} laterRequests={0} />,
      );
    });
    expect(host.dataset.reviewPad).toBe("");

    // A new request is sent below this one: held blank space collapses immediately.
    await act(async () => {
      root.render(
        <Harness enabled tab="working" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk={false} lowOpen={false} rows={0} laterRequests={1} />,
      );
    });
    expect(host.dataset.reviewPad).toBeUndefined();
    expect(host.style.getPropertyValue("--review-body-height")).toBe("");
  });

  it("opens compact on initial mount and skips collapse animation with reduced motion", async () => {
    stubLayout();
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation);
    Element.prototype.animate = animate;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    // Initial mount on a finished request (0 waiting, 15 done): stays compact, no blank box.
    await act(async () => {
      root.render(
        <Harness enabled tab="you" counts={{ you: 0, working: 0, done: 15 }} youBase={0} hasLowRisk={false} lowOpen={false} rows={0} />,
      );
    });
    const host = container.querySelector<HTMLElement>(".simple-pass")!;
    expect(host.dataset.reviewPad).toBeUndefined();

    // Opening Done (15 rows) then switching to Working holds 324px while browsing tabs.
    await act(async () => {
      root.render(
        <Harness enabled tab="done" counts={{ you: 0, working: 0, done: 15 }} youBase={0} hasLowRisk={false} lowOpen={false} rows={15} />,
      );
    });
    await act(async () => {
      root.render(
        <Harness enabled tab="working" counts={{ you: 0, working: 0, done: 15 }} youBase={0} hasLowRisk={false} lowOpen={false} rows={0} />,
      );
    });
    expect(host.dataset.reviewPad).toBe("");
    expect(host.style.getPropertyValue("--review-body-height")).toBe("324px");

    // Clicking outside collapses without animation when prefers-reduced-motion is on.
    const composer = container.querySelector<HTMLTextAreaElement>(".composer-input")!;
    await act(async () => {
      composer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(host.dataset.reviewPad).toBeUndefined();
    expect(animate).not.toHaveBeenCalled();
  });

  it("uses flexBasis collapse keyframes when hosted inside the fixed bottom review dock", async () => {
    stubLayout();
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation);
    Element.prototype.animate = animate;

    const DockHarness = (props: HarnessProps) => <div className="simple-review-dock"><Harness {...props} /></div>;
    await act(async () => {
      root.render(
        <DockHarness enabled tab="you" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk lowOpen={false} lowRiskCount={17} rows={12} />,
      );
    });
    await act(async () => {
      root.render(
        <DockHarness enabled tab="working" counts={{ you: 12, working: 0, done: 0 }} youBase={12} hasLowRisk lowOpen={false} lowRiskCount={17} rows={0} />,
      );
    });
    const host = container.querySelector<HTMLElement>(".simple-pass")!;
    expect(host.dataset.reviewPad).toBe("");
    const composer = container.querySelector<HTMLTextAreaElement>(".composer-input")!;
    await act(async () => {
      composer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(host.dataset.reviewPad).toBeUndefined();
    expect(animate).toHaveBeenCalledWith(
      [{ height: "356px", flexBasis: "356px" }, { height: "34px", flexBasis: "34px" }],
      expect.objectContaining({ duration: 220 }),
    );
  });
});
