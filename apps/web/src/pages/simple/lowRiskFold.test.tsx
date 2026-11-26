// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLowRiskFold } from "./lowRiskFold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  on: boolean;
  visible: boolean;
  setOn?: (next: boolean) => void;
}

function Harness({ on, visible, setOn = () => {} }: HarnessProps) {
  const host = useRef<HTMLDivElement>(null);
  const low = useLowRiskFold(host, on, setOn, visible);
  return (
    <div ref={host} className="simple-pass" data-low-shown={low.shown ? "true" : "false"} data-low-closing={low.closing ? "true" : "false"}>
      {visible && (
        <>
          <button type="button" className="simple-low-risk-toggle" onClick={low.toggle}>Toggle</button>
          <ol className="simple-edits">
            {low.shown && (
              <>
                <li data-low-risk=""><button type="button">Low risk 1</button></li>
                <li data-low-risk=""><button type="button">Low risk 2</button></li>
              </>
            )}
          </ol>
        </>
      )}
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

function stubAnimate() {
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const resolvers: (() => void)[] = [];
  const animate = vi.fn(() => {
    let resolve!: () => void;
    const finished = new Promise<void>(r => { resolve = r; });
    const cancel = vi.fn();
    cancels.push(cancel);
    resolvers.push(resolve);
    return { finished, cancel } as unknown as Animation;
  });
  Element.prototype.animate = animate;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 28, width: 320, height: 28, toJSON: () => ({}),
  }));
  return { animate, cancels, finishAll: () => { for (const r of resolvers) r(); } };
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

describe("useLowRiskFold", () => {
  it("animates when toggling low risk edits on while Needs review is already visible", async () => {
    const { animate } = stubAnimate();
    await act(async () => { root.render(<Harness on={false} visible />); });
    expect(animate).not.toHaveBeenCalled();

    await act(async () => { root.render(<Harness on visible />); });
    // 2 low-risk rows × (height + opacity/translateY + highlight wash) = 6 animations.
    expect(animate).toHaveBeenCalledTimes(6);
  });

  it("reloads low risk edits instantly with no fade-in when switching away from Needs review and back", async () => {
    const { animate } = stubAnimate();
    await act(async () => { root.render(<Harness on visible />); });
    expect(animate).not.toHaveBeenCalled();

    // Switch away to Working or Done (visible = false, on = false).
    await act(async () => { root.render(<Harness on={false} visible={false} />); });
    expect(animate).not.toHaveBeenCalled();

    // Switch back to Needs review with low risk edits remembered ON (visible = true, on = true).
    await act(async () => { root.render(<Harness on visible />); });
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelectorAll("li[data-low-risk]")).toHaveLength(2);
  });

  it("opens instantly without fading in when jumping to Needs review from another tab", async () => {
    const { animate } = stubAnimate();
    await act(async () => { root.render(<Harness on={false} visible={false} />); });
    expect(animate).not.toHaveBeenCalled();

    await act(async () => { root.render(<Harness on visible />); });
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelectorAll("li[data-low-risk]")).toHaveLength(2);
  });

  it("cancels a close animation immediately when switching away from Needs review", async () => {
    const { animate, cancels } = stubAnimate();
    function ToggleHarness({ visible }: { visible: boolean }) {
      const [on, setOn] = useState(true);
      return <Harness on={on && visible} visible={visible} setOn={setOn} />;
    }
    await act(async () => { root.render(<ToggleHarness visible />); });

    // Toggle low risk off while staying on Needs review: starts closing animation.
    const toggle = container.querySelector<HTMLButtonElement>(".simple-low-risk-toggle")!;
    await act(async () => { toggle.click(); });
    const host = container.querySelector<HTMLElement>(".simple-pass")!;
    expect(host.dataset.lowClosing).toBe("true");
    expect(host.dataset.lowShown).toBe("true");
    expect(animate).toHaveBeenCalled();

    // Switch away to another tab mid-close: cancels closing immediately.
    await act(async () => { root.render(<ToggleHarness visible={false} />); });
    expect(host.dataset.lowClosing).toBe("false");
    expect(host.dataset.lowShown).toBe("false");
    expect(cancels.some(fn => fn.mock.calls.length > 0)).toBe(true);
  });
});
