// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelineScrubber } from "./TimelineScrubber";

/** The timeline by itself, a thousand pixels wide, with no pictures or sound to draw. */
let root: Root;
let container: HTMLDivElement;
const seeks: number[] = [], picks: number[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  seeks.length = picks.length = 0;
  released.mockClear();
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

const released = vi.fn();
const show = (zoom?: { start: number; end: number }) => act(async () => root.render(
  <TimelineScrubber start={0} duration={3000} playhead={100} frameAt={() => undefined} onSeek={t => seeks.push(t)} onSelectTime={t => picks.push(t)}
    onScrubStart={() => released} highlight={zoom && { view: zoom, band: zoom }} />));
const pointer = (type: string, x: number) => act(async () => {
  container.querySelector(".timeline-slider")!.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, clientX: x, bubbles: true }));
});
/** The zoom to or from a highlighted change has run its course. */
const zoomed = () => act(async () => { await new Promise(done => setTimeout(done, 400)); });

it("reads a press against the stretch the timeline showed when it began, though the press itself changes what it shows", async () => {
  // Zoomed to an open edit at 1:40 to 1:50.
  await show({ start: 100, end: 110 });
  await zoomed();
  await pointer("pointerdown", 760);
  expect(seeks).toEqual([107.6]);
  // An edit closes while the pointer is down, returning the timeline to the whole video.
  await show();
  await zoomed();
  // Let go where it was pressed: the playhead stays where the press put it. Read against the whole video, the same
  // spot was 38 minutes on, and the playhead and the message box's tag went there.
  await pointer("pointerup", 760);
  expect(seeks).toEqual([107.6]);
  expect(picks).toEqual([107.6]);
});

it("follows a drag across the stretch it began in", async () => {
  await show();
  await pointer("pointerdown", 100);
  await pointer("pointerup", 500);
  expect(seeks).toEqual([300, 1500]);
  expect(picks).toEqual([1500]);
});

it("points its controls' button at the controls only while they are open", async () => {
  await show();
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Timeline controls"]')!;
  expect(button.getAttribute("aria-controls")).toBeNull();
  await act(async () => button.click());
  expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
});
