// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TimeRange } from "@scarlet/timeline";
import { TimelineScrubber } from "./TimelineScrubber";
import { HOLD_MS, orderedRange, rangeEdges, snapTime } from "./TimelineRange";

/** The timeline by itself, a thousand pixels wide over 3000 seconds: three seconds a pixel. */
let root: Root;
let container: HTMLDivElement;
const seeks: number[] = [], picks: number[] = [];
const marked = vi.fn<(range: TimeRange | undefined) => void>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  seeks.length = picks.length = 0;
  marked.mockClear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 40, width: 1000, height: 40, x: 0, y: 0, toJSON() {} });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value() {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const gap = { start: 600, end: 660, label: "Cut at 10:00", title: "Cut at 10:00", skipped: false };
const show = (range?: TimeRange) => act(async () => root.render(
  <TimelineScrubber start={0} duration={3000} playhead={100} frameAt={() => undefined} onSeek={t => seeks.push(t)} onSelectTime={t => picks.push(t)}
    range={range} onRange={marked} fps={30} gaps={[gap]} marks={[]} />));
const event = (type: string, x: number) => new PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, clientX: x, bubbles: true });
const press = (selector: string, x: number) => act(async () => { container.querySelector(selector)!.dispatchEvent(event("pointerdown", x)); });
const move = (x: number) => act(async () => { document.dispatchEvent(event("pointermove", x)); });
const release = (x: number) => act(async () => { document.dispatchEvent(event("pointerup", x)); });

it("finds the edge a dragged end lands on, and keeps a range's ends in order and a frame apart", () => {
  expect(rangeEdges({ start: 5, end: 9 }, [{ start: 20, end: 22 }], [{ time: 9 }, { time: 30 }])).toEqual([5, 9, 20, 22, 30]);
  expect(snapTime(8.8, [5, 9, 20], .5)).toBe(9);
  expect(snapTime(8.4, [5, 9, 20], .5)).toBeUndefined();
  expect(orderedRange(12, 4, 0, 60, 30)).toEqual({ start: 4, end: 12 });
  // Both ends on one frame still mark a frame, inside the video.
  const frame = orderedRange(60, 60, 0, 60, 30);
  expect(frame.end).toBe(60);
  expect(frame.end - frame.start).toBeCloseTo(1 / 30);
});

it("marks a stretch with a drag along the ruler, and lands its end on a cut it comes near", async () => {
  await show();
  await press(".timeline-range-zone", 100);
  // 585 s is five pixels short of the footage a cut took out at 600 s.
  await move(195);
  await release(195);
  expect(marked).toHaveBeenCalledExactlyOnceWith({ start: 300, end: 600 });
  // The video followed the end that moved, and no moment was picked for the message.
  expect(seeks.at(-1)).toBe(600);
  expect(picks).toEqual([]);
  // Further from the cut than it reaches, the end stays where it was let go.
  await press(".timeline-range-zone", 100);
  await move(150);
  await release(150);
  expect(marked).toHaveBeenLastCalledWith({ start: 300, end: 450 });
});

it("still moves the playhead on a press on the ruler that doesn't drag", async () => {
  await show();
  await press(".timeline-range-zone", 100);
  await release(101);
  expect(marked).not.toHaveBeenCalled();
  expect(seeks).toEqual([300]);
  expect(picks).toEqual([300]);
  // Below the ruler the timeline scrubs as it always did.
  await press(".timeline-slider", 200);
  expect(seeks).toEqual([300, 600]);
});

it("takes the range off on a click on the ruler, which still moves the playhead there", async () => {
  await show({ start: 300, end: 450 });
  await press(".timeline-range-zone", 700);
  await release(700);
  expect(marked).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(picks).toEqual([2100]);
});

it("opens the close-up on a press held still on the ruler, to draw a range by frames from there", async () => {
  await show();
  await press(".timeline-range-zone", 100);
  await act(async () => { await new Promise(done => setTimeout(done, HOLD_MS + 50)); });
  expect(container.querySelector(".timeline-range-loupe b")?.textContent).toBe("5:00.000");
  // Twenty pixels is 60 s on this timeline, and 6 s in the close-up.
  await move(120);
  await release(120);
  expect(marked).toHaveBeenCalledExactlyOnceWith({ start: 300, end: 306 });
  expect(picks).toEqual([]);
  // Held and let go without moving, it draws nothing.
  marked.mockClear();
  await press(".timeline-range-zone", 100);
  await act(async () => { await new Promise(done => setTimeout(done, HOLD_MS + 50)); });
  await release(100);
  expect(marked).not.toHaveBeenCalled();
});

it("moves an end a frame at a time from the keyboard, and Esc takes the range off", async () => {
  await show({ start: 300, end: 450 });
  const end = container.querySelector<HTMLButtonElement>(".timeline-range-handle.is-end")!;
  const key = (init: KeyboardEventInit) => act(async () => { end.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })); });
  await key({ key: "ArrowRight" });
  expect(marked.mock.lastCall![0]!.end).toBeCloseTo(450 + 1 / 30);
  await key({ key: "ArrowLeft", shiftKey: true });
  expect(marked.mock.lastCall![0]!.end).toBeCloseTo(450 - 10 / 30);
  // The arrows were the handle's: the playhead went to the end that moved, and nowhere by the timeline's own skip.
  expect(picks).toEqual([]);
  await key({ key: "Escape" });
  expect(marked).toHaveBeenLastCalledWith(undefined);
});

it("opens a close-up on a handle held still, where the end moves ten times slower and by frames", async () => {
  await show({ start: 300, end: 450 });
  await press(".timeline-range-handle.is-end", 150);
  expect(container.querySelector(".timeline-range-loupe")).toBeNull();
  await act(async () => { await new Promise(done => setTimeout(done, HOLD_MS + 50)); });
  expect(container.querySelector(".timeline-range-loupe b")?.textContent).toBe("7:30.000");
  // Thirty pixels is 90 s on this timeline, and 9 s in the close-up.
  await move(180);
  await release(180);
  expect(marked).toHaveBeenCalledExactlyOnceWith({ start: 300, end: 459 });
  expect(container.querySelector(".timeline-range-loupe")).toBeNull();
});

it("adjusts an end by dragging its handle, landing on a cut's edge", async () => {
  await show({ start: 300, end: 450 });
  await press(".timeline-range-handle.is-end", 150);
  await move(222);
  await release(222);
  // 666 s is two pixels past the end of the cut footage at 660 s.
  expect(marked).toHaveBeenCalledExactlyOnceWith({ start: 300, end: 660 });
});
