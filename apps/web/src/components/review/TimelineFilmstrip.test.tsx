// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MediaLanes, type PreviewStrip } from "./TimelineFilmstrip";

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps its stills when resized while hidden in full screen and re-measures on a visible resize", () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let width = 480;
  let onResize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: () => void) {}
    observe() { onResize = this.cb; }
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(54);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const preview: PreviewStrip = { id: "rnd_fs", version: "v1", fps: 30 };
  act(() => {
    root.render(<MediaLanes start={0} duration={60} pictureAspect={16 / 9} frameAt={() => undefined} preview={preview}
      visibleStart={0} visibleSpan={60} />);
  });
  act(() => {
    for (const img of container.querySelectorAll("img[src]")) img.dispatchEvent(new Event("load"));
  });

  const strip = () => container.querySelector<HTMLElement>(".timeline-filmstrip")!;
  const stillUrls = () => [...container.querySelectorAll<HTMLImageElement>(".timeline-filmstrip img")].map(img => img.getAttribute("src"));
  const resize = (next: number) => {
    width = next;
    act(() => { onResize(); vi.advanceTimersByTime(150); });
  };

  const initialUrls = stillUrls();
  expect(initialUrls).toHaveLength(5);
  expect(initialUrls.every(Boolean)).toBe(true);
  expect(strip().classList.contains("is-loading")).toBe(false);

  // Entering full screen hides the lane and widens it to the full window.
  container.style.visibility = "hidden";
  resize(1440);
  expect(stillUrls()).toEqual(initialUrls);
  expect(strip().classList.contains("is-loading")).toBe(false);

  // Leaving full screen restores visibility at the original width with no reload.
  container.style.visibility = "";
  resize(480);
  expect(stillUrls()).toEqual(initialUrls);
  expect(strip().classList.contains("is-loading")).toBe(false);

  // A visible width change still re-measures and requests stills for the new width.
  resize(960);
  expect(stillUrls()).toHaveLength(10);
  expect(strip().classList.contains("is-loading")).toBe(true);
});
