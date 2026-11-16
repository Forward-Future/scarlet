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
const pointer = (type: string, x: number, y = 0) => act(async () => {
  container.querySelector(".timeline-slider")!.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
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

it("reveals a typed timestamp outside the zoomed window without seeking the player", async () => {
  const render = (times: number[]) => act(async () => root.render(
    <TimelineScrubber duration={3000} playhead={100} frameAt={() => undefined} onSeek={t => seeks.push(t)}
      highlight={{ view: { start: 90, end: 110 } }} typedTimes={times} />));
  await render([]);
  await render([500]);
  await zoomed();
  expect(container.querySelector(".timeline-message-time")?.getAttribute("data-time")).toBe("500");
  expect(container.querySelector(".timeline-slider")?.getAttribute("aria-valuenow")).toBe("100");
  expect(seeks).toEqual([]);
});

it("pulls up from a scrub to jog consecutive frames and commits the release frame once", async () => {
  const range = vi.fn();
  const rate = 24000 / 1001;
  await act(async () => root.render(<TimelineScrubber start={0} duration={20} playhead={0} fps={rate}
    frameAt={time => `/frame/${Math.round(time * rate)}`} onSeek={t => seeks.push(t)} onSelectTime={t => picks.push(t)}
    onRange={range} range={{ start: 12, end: 13 }} onScrubStart={() => released} />));
  const lens = () => container.querySelector<HTMLElement>(".scrub-loupe");
  const frame = Math.round(8 * rate);
  await pointer("pointerdown", 400, 80);
  await pointer("pointermove", 400, 69);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(lens()).toBeNull();
  await pointer("pointermove", 400, 40);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(lens()?.dataset.frame).toBe(String(frame));
  expect(container.querySelector(".timeline-playhead-time")).toBeNull();
  expect(lens()?.querySelector(".scrub-loupe-picture img")?.getAttribute("src")).toBe(`/frame/${frame}`);
  const cell = lens()?.querySelectorAll(".scrub-loupe-cell")[5];
  await pointer("pointermove", 410, 80);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(lens()?.dataset.frame).toBe(String(frame + 1));
  expect(lens()?.querySelectorAll(".scrub-loupe-cell")[4]).toBe(cell);
  expect(seeks.at(-1)).toBeCloseTo((frame + 1) / rate, 8);
  expect(picks).toEqual([]);
  await pointer("pointerup", 420, 40);
  await pointer("lostpointercapture", 420, 40);
  expect(picks).toEqual([(frame + 2) / rate]);
  expect(range).not.toHaveBeenCalled();
  expect(released).toHaveBeenCalledOnce();
  expect(lens()).toBeNull();
  expect(container.querySelector(".timeline-playhead-time")).not.toBeNull();
});

it("keeps the final partial frame inside the clip and drops the loupe if capture is lost", async () => {
  const fps = 25;
  await act(async () => root.render(<TimelineScrubber start={10} duration={1.01} playhead={10} fps={fps}
    previewStrip={{ id: "cached-cut", version: "version", fps }} frameAt={() => undefined}
    onScrubStart={() => released} onSeek={t => seeks.push(t)} onSelectTime={t => picks.push(t)} />));
  await pointer("pointerdown", 1000, 65);
  await pointer("pointermove", 1000, 12);
  await act(async () => { await new Promise(requestAnimationFrame); });
  const lens = container.querySelector<HTMLElement>(".scrub-loupe")!;
  expect(lens.dataset.frame).toBe("275");
  const sheet = new URL(lens.querySelector<HTMLImageElement>(".scrub-loupe-picture img")!.src);
  expect(sheet.searchParams.get("frames")!.split(",").at(-1)).toBe("275");
  await pointer("pointermove", 1100, 12);
  await pointer("lostpointercapture", 1100, 12);
  expect(seeks.at(-1)).toBe(11);
  expect(picks).toEqual([]);
  expect(released).toHaveBeenCalledOnce();
  expect(container.querySelector(".scrub-loupe")).toBeNull();
});
