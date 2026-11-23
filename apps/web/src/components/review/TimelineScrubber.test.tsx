// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelineScrubber, type TimelineGap } from "./TimelineScrubber";

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

it("greys the footage the playing side steps over, tags each gap where its tag fits, and hands a press in one to the caller", async () => {
  const pressed: [string, number][] = [];
  const gap = (start: number, end: number, label: string, shortLabel: string): TimelineGap => ({ start, end, label, shortLabel, title: label, skipped: true });
  // Zoomed to 1:40–1:50, 100 px a second, with three cuts' footage on the version shown and one far off.
  await act(async () => root.render(
    <TimelineScrubber start={0} duration={3000} playhead={100} frameAt={() => undefined} onSeek={t => seeks.push(t)} onScrubStart={() => released}
      highlight={{ view: { start: 100, end: 110 }, band: { start: 102, end: 102.5 } }} onGap={(g, time) => pressed.push([g.label, time])}
      gaps={[gap(101, 101.5, "Cut at 1:41", "1:41"), gap(103, 106, "Cut at 1:43", "1:43"), gap(108, 108.2, "Cut at 1:48", "1:48"), gap(200, 201, "Cut at 3:20", "3:20")]} />));
  await zoomed();
  const gaps = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-gap")];
  expect(gaps().map(g => [g.style.left, g.classList.contains("is-skipped"), g.getAttribute("aria-hidden")])).toEqual([
    ["10%", true, "true"], ["30%", true, "true"], ["80%", true, "true"]]);
  // Whole where it fits, else its time, else nothing: a tag cut off mid-word reads as a mistake.
  expect(gaps().map(g => g.querySelector(".simple-timeline-gap-label")?.textContent ?? "")).toEqual(["1:41", "Cut at 1:43", ""]);
  // A press inside one plays it from there, and doesn't scrub.
  await act(async () => { gaps()[1]!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, isPrimary: true, clientX: 450, bubbles: true })); });
  expect(pressed).toEqual([["Cut at 1:43", 104.5]]);
  expect(seeks).toEqual([]);
  expect(released).not.toHaveBeenCalled();
});

it("opens a dotted cut on click (including a narrow unlabeled sliver) while still letting a drag scrub Before footage", async () => {
  const opened: string[] = [];
  const gap = (start: number, end: number, label: string, shortLabel: string): TimelineGap => ({
    start, end, label, shortLabel, title: label, skipped: false, open: () => opened.push(label),
  });
  // Zoomed to 1:40–1:50 (100 px/s): a wide cut (300–500 px) and a 4 px sliver (800–804 px) with no room for a label.
  await act(async () => root.render(
    <TimelineScrubber start={0} duration={3000} playhead={100} frameAt={() => undefined} onSeek={t => seeks.push(t)} onSelectTime={t => picks.push(t)} onScrubStart={() => released}
      highlight={{ view: { start: 100, end: 110 }, band: { start: 102, end: 102.5 } }}
      gaps={[gap(103, 105, "Cut at 1:43", "1:43"), gap(108, 108.04, "Cut at 1:48", "1:48")]} />));
  await zoomed();
  const gaps = () => [...container.querySelectorAll<HTMLElement>(".simple-timeline-gap")];
  expect(gaps().map(g => g.classList.contains("is-clickable"))).toEqual([true, true]);
  expect(gaps().map(g => g.querySelector(".simple-timeline-gap-label")?.textContent ?? "")).toEqual(["Cut at 1:43", ""]);

  // Hovering near the 4 px sliver (center 802 px, within its 16 px hit zone) highlights it and aims the pointer.
  await pointer("pointermove", 808);
  expect(gaps()[1]!.classList.contains("is-hot")).toBe(true);
  expect(container.querySelector(".timeline-slider")!.classList.contains("is-gap-aimed")).toBe(true);

  // Clicking there opens that cut's edit without seeking or starting a scrub.
  await pointer("pointerdown", 808);
  await pointer("pointerup", 808);
  expect(opened).toEqual(["Cut at 1:48"]);
  expect(seeks).toEqual([]);
  expect(picks).toEqual([]);
  expect(released).not.toHaveBeenCalled();

  // Dragging across the wide dotted cut scrubs Before footage and does not open the cut.
  await pointer("pointerdown", 400);
  await pointer("pointermove", 460);
  await pointer("pointerup", 460);
  expect(opened).toEqual(["Cut at 1:48"]);
  expect(seeks.at(-1)).toBeCloseTo(104.6, 5);
  expect(picks).toEqual([104.6]);
  expect(released).toHaveBeenCalledTimes(1);
});

it("follows a drag across the stretch it began in", async () => {
  await show();
  await pointer("pointerdown", 100);
  await pointer("pointerup", 500);
  expect(seeks).toEqual([300, 1500]);
  expect(picks).toEqual([1500]);
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
