// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MONITOR_LOAD_EXTENDED_MS,
  MONITOR_LOAD_GRACE_MS,
  MONITOR_LOAD_HINT_MS,
  MONITOR_LOAD_LEAVE_MS,
  MonitorLoadOverlay,
  type LeadInFrames,
} from "./MonitorLoadOverlay";
import { usePictureWait } from "./usePictureWait";

let root: Root;
let container: HTMLDivElement;

interface HarnessProps {
  openingJoin?: boolean;
  disabled?: boolean;
  canWatchBefore?: boolean;
  transitionKey?: string;
  leadIn?: LeadInFrames;
  videoWaiting?: boolean;
  waitStage?: string;
  waitProgress?: string;
  showVideo?: boolean;
}

function Harness({
  openingJoin = false,
  disabled = false,
  canWatchBefore = false,
  transitionKey = "cut-1:after",
  leadIn = { fast: "/frames/fast.jpg", sharp: "/frames/sharp.jpg" },
  videoWaiting = false,
  waitStage,
  waitProgress,
  showVideo = true,
}: HarnessProps) {
  const monitor = useRef<HTMLDivElement>(null);
  const pictureWaiting = usePictureWait(monitor);
  return (
    <div ref={monitor} className="watch-monitor">
      {showVideo && (
        <video
          id="active"
          data-waiting={videoWaiting || undefined}
          data-wait-stage={waitStage}
          data-wait-progress={waitProgress}
        />
      )}
      <MonitorLoadOverlay
        monitor={monitor}
        pictureWaiting={pictureWaiting}
        openingJoin={openingJoin}
        disabled={disabled}
        transitionKey={transitionKey}
        resolveLeadIn={() => leadIn}
        canWatchBefore={canWatchBefore}
      />
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (props: HarnessProps = {}) => act(async () => root.render(<Harness {...props} />));
const after = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const overlay = () => container.querySelector<HTMLElement>(".monitor-load");
const pill = () => container.querySelector<HTMLElement>(".monitor-load-pill");
const hint = () => container.querySelector<HTMLElement>(".monitor-load-hint");
const still = () => container.querySelector<HTMLImageElement>(".monitor-load-still");
const barFill = () => container.querySelector<HTMLElement>(".monitor-load-bar-fill");

it("stays silent inside the 180ms grace period and escalates cleanly through sheen, pill, and Before hint", async () => {
  await render({ openingJoin: true, showVideo: false, canWatchBefore: true });
  await after(MONITOR_LOAD_GRACE_MS - 1);
  expect(overlay()).toBeNull();

  // At 180ms: dimmed lead-in still + sheen + hairline appear, with no pill or extra status role yet.
  await after(1);
  expect(overlay()?.dataset.active).toBe("true");
  expect(overlay()?.dataset.stage).toBe("preparing");
  expect(still()?.getAttribute("src")).toBe("/frames/fast.jpg");
  expect(container.querySelector(".monitor-load-sheen")).not.toBeNull();
  expect(barFill()?.classList.contains("is-indeterminate")).toBe(true);
  expect(pill()).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();

  // At 1.5s total: centered frosted status pill fades in with honest stage copy.
  await after(MONITOR_LOAD_EXTENDED_MS - MONITOR_LOAD_GRACE_MS - 1);
  expect(pill()).toBeNull();
  await after(1);
  expect(pill()?.getAttribute("role")).toBe("status");
  expect(pill()?.textContent).toContain("Preparing cut…");
  expect(hint()).toBeNull();

  // At 2.5s total on After of a review cut: quiet Before shortcut hint appears.
  await after(MONITOR_LOAD_HINT_MS - MONITOR_LOAD_EXTENDED_MS - 1);
  expect(hint()).toBeNull();
  await after(1);
  expect(hint()?.textContent).toContain("Press \\ to watch Before while After renders");

  // When ready: status role clears immediately and the curtain lifts smoothly over 280ms.
  await render({ openingJoin: false, showVideo: true, canWatchBefore: true });
  expect(overlay()?.dataset.leaving).toBe("true");
  expect(container.querySelector('[role="status"]')).toBeNull();
  await after(MONITOR_LOAD_LEAVE_MS);
  expect(overlay()).toBeNull();
});

it("bridges openingJoin into CutStream preroll without resetting timers and shows section progress", async () => {
  await render({ openingJoin: true, showVideo: false, canWatchBefore: false });
  await after(1000);
  expect(overlay()?.dataset.stage).toBe("preparing");
  expect(pill()).toBeNull();

  // Single-cut draft arrives and CutStream mounts with preroll section 0/2 still rendering.
  await render({ openingJoin: false, showVideo: true, videoWaiting: true, waitStage: "rendering", waitProgress: "0/2" });
  expect(overlay()?.dataset.active).toBe("true");
  expect(overlay()?.dataset.stage).toBe("rendering");
  expect(barFill()?.classList.contains("is-indeterminate")).toBe(false);
  expect(barFill()?.style.width).toBe("9%");

  // Remaining 500ms reaches 1.5s total without resetting.
  await after(500);
  expect(pill()?.textContent).toContain("Rendering clip");
  expect(pill()?.textContent).toContain("1 of 2");

  // First section lands -> advances to 2 of 2 and progress bar moves forward.
  await render({ openingJoin: false, showVideo: true, videoWaiting: true, waitStage: "rendering", waitProgress: "1/2" });
  expect(pill()?.textContent).toContain("2 of 2");
  expect(barFill()?.style.width).toBe("59%");

  // Not a review cut After side -> no Before hint even past 2.5s.
  await after(1500);
  expect(hint()).toBeNull();

  // Preroll completes -> lifts cleanly.
  await render({ openingJoin: false, showVideo: true, videoWaiting: false });
  expect(overlay()?.dataset.leaving).toBe("true");
  await after(MONITOR_LOAD_LEAVE_MS);
  expect(overlay()).toBeNull();
});

it("upgrades the lead-in still from fast scrub frame to sharp composite frame and marks ambient source", async () => {
  const preloads: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  vi.stubGlobal("Image", class extends NativeImage {
    constructor() {
      super();
      preloads.push(this);
    }
  });

  await render({ openingJoin: true, showVideo: false });
  await after(MONITOR_LOAD_GRACE_MS);
  expect(still()?.getAttribute("src")).toBe("/frames/fast.jpg");
  expect(still()?.hasAttribute("data-ambient-source")).toBe(false);

  // Fast frame loads -> becomes ambient source immediately.
  await act(async () => { still()!.dispatchEvent(new Event("load")); });
  expect(still()?.dataset.loaded).toBe("true");
  expect(still()?.dataset.ambientSource).toBe("true");

  // Sharp composite frame finishes preloading -> swaps in seamlessly.
  const sharpLoader = preloads.find(img => img.src.includes("/frames/sharp.jpg"));
  expect(sharpLoader).toBeDefined();
  await act(async () => { sharpLoader!.onload?.(new Event("load")); });
  expect(still()?.getAttribute("src")).toBe("/frames/sharp.jpg");
});

it("dismisses immediately on errors or when reduced motion is enabled", async () => {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = false;
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(query, { matches: { get: () => reduced } }));

  // Error (`disabled`) clears immediately without leaving fade.
  await render({ openingJoin: true, showVideo: false });
  await after(MONITOR_LOAD_EXTENDED_MS);
  expect(pill()).not.toBeNull();
  await render({ openingJoin: true, showVideo: false, disabled: true });
  expect(overlay()).toBeNull();

  // Reduced motion clears immediately on ready without 280ms leave fade.
  reduced = true;
  await render({ openingJoin: true, showVideo: false, disabled: false });
  await after(MONITOR_LOAD_GRACE_MS);
  expect(overlay()).not.toBeNull();
  await render({ openingJoin: false, showVideo: true, disabled: false });
  expect(overlay()).toBeNull();
});

it("captures and holds the outgoing video frame across openingJoin until the lead-in still loads", async () => {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);

  await render({ openingJoin: false, showVideo: true, transitionKey: "cut-1:after" });
  const video = container.querySelector<HTMLVideoElement>("#active")!;
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });

  // Pausing before switching cuts captures the outgoing frame.
  await act(async () => { video.dispatchEvent(new Event("pause")); });
  expect(drawImage).toHaveBeenCalledTimes(1);

  // Even inside the first 180ms of `openingJoin`, the outgoing frame holds softly instead of snapping black.
  await render({ openingJoin: true, showVideo: false, transitionKey: "cut-2:after" });
  const heldCanvas = container.querySelector<HTMLCanvasElement>(".monitor-load-held canvas");
  expect(heldCanvas).not.toBeNull();
  expect(heldCanvas?.dataset.ambientSource).toBe("true");
  expect(container.querySelector(".monitor-load-sheen")).toBeNull();

  // Once past 180ms and the lead-in still loads, the lead-in replaces the held frame.
  await after(MONITOR_LOAD_GRACE_MS);
  expect(container.querySelector(".monitor-load-held")?.hasAttribute("data-dimmed")).toBe(true);
  await act(async () => { still()!.dispatchEvent(new Event("load")); });
  expect(container.querySelector(".monitor-load-held")).toBeNull();
});
