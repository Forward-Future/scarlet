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

it("lands on the video's first or last moment when a drag goes past the end of a zoomed-in timeline, and shows it there (#681)", async () => {
  // Zoomed to 1:40–1:50: before, the far left of the timeline was as far back as a drag could go.
  await show({ start: 100, end: 110 });
  await zoomed();
  await pointer("pointerdown", 500);
  await pointer("pointermove", -20);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(seeks).toEqual([105, 0]);
  await pointer("pointerup", -20);
  expect(picks).toEqual([0]);
  // The view turned to the start at the same scale: the same press now reads 0:05, not 1:45.
  await pointer("pointerdown", 500);
  await pointer("pointerup", 500);
  expect(picks).toEqual([0, 5]);
  // And past the right end, the last moment, with the view at the end.
  await pointer("pointerdown", 500);
  await pointer("pointerup", 1040);
  expect(picks).toEqual([0, 5, 3000]);
  await pointer("pointerdown", 500);
  await pointer("pointerup", 500);
  expect(picks.at(-1)).toBe(2995);
});

it("carries frame-by-frame scrubbing on from the first frame once it is pulled past the start (#681)", async () => {
  const fps = 25;
  await act(async () => root.render(<TimelineScrubber start={0} duration={20} playhead={8} fps={fps} frameAt={() => undefined}
    onScrubStart={() => released} onSeek={t => seeks.push(t)} onSelectTime={t => picks.push(t)} />));
  await pointer("pointerdown", 400, 80);
  await pointer("pointermove", 400, 40);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(container.querySelector<HTMLElement>(".scrub-loupe")?.dataset.frame).toBe("200");
  await pointer("pointermove", -5, 40);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(seeks.at(-1)).toBe(0);
  // Back inside, it steps on a frame each 10 px from the first frame, not from where the jog began.
  await pointer("pointermove", 15, 40);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(seeks.at(-1)).toBe(2 / fps);
  await pointer("pointerup", 15, 40);
  expect(picks).toEqual([2 / fps]);
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

it("lets hover-only edge handles drag an open cut's start or end edge, shows live word readout, cancels on Esc, and nudges with arrow keys", async () => {
  const onCommit = vi.fn();
  const onBand = vi.fn();
  await act(async () => root.render(
    <TimelineScrubber start={0} duration={20} playhead={5} fps={30} frameAt={() => undefined}
      onSeek={t => seeks.push(t)} onScrubStart={() => released} onBand={onBand}
      highlight={{ key: "cut-1", view: { start: 0, end: 10 }, band: { start: 2, end: 4 }, bandLabel: "Cut · 2.0 s" }}
      cutAdjust={{
        bounds: { minStart: 1, maxStart: 4, minEnd: 2, maxEnd: 6 },
        tone: "cut",
        bandPrefix: "Cut",
        describeEdge: (edge, oldTime, newTime) => ({
          text: edge === "start" && newTime > oldTime ? "Put back “really”" : "Cut “and”",
          tone: newTime > oldTime ? "put-back" : "take-out",
          delta: `${newTime > oldTime ? "+" : "−"}${Math.abs(newTime - oldTime).toFixed(2)} s`,
        }),
        onCommit,
      }} />));
  await zoomed();

  const startHandle = container.querySelector<HTMLButtonElement>('[data-cut-handle="start"]');
  const endHandle = container.querySelector<HTMLButtonElement>('[data-cut-handle="end"]');
  expect(startHandle).not.toBeNull();
  expect(endHandle).not.toBeNull();
  expect(startHandle!.style.left).toBe("20%");
  expect(endHandle!.style.left).toBe("40%");

  // Clicking the middle of the band still plays Before footage via onBand, without touching cutAdjust.
  await act(async () => {
    container.querySelector(".simple-timeline-band")!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, isPrimary: true, clientX: 300, bubbles: true }));
  });
  expect(onBand).toHaveBeenCalledWith(3);
  expect(onCommit).not.toHaveBeenCalled();

  // Drag the start handle right from 2.0 s (200 px) to 2.5 s (250 px).
  await act(async () => {
    startHandle!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, isPrimary: true, clientX: 200, bubbles: true }));
  });
  await act(async () => {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 250, bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  const readout = container.querySelector(".timeline-cut-readout");
  expect(readout?.textContent).toContain("Put back “really”");
  expect(readout?.textContent).toContain("+0.50 s");
  expect(container.querySelector(".timeline-cut-origin")).not.toBeNull();
  expect(seeks.at(-1)).toBeCloseTo(2.5, 5);

  await act(async () => {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientX: 250, bubbles: true }));
  });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit.mock.calls[0]![0]).toEqual({ start: 2.5, end: 4 });
  expect(container.querySelector(".timeline-cut-readout")).toBeNull();

  // Pressing Esc during a drag cancels cleanly without committing.
  await act(async () => {
    endHandle!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, button: 0, isPrimary: true, clientX: 400, bubbles: true }));
  });
  await act(async () => {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 460, bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(container.querySelector(".timeline-cut-readout")).not.toBeNull();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".timeline-cut-readout")).toBeNull();

  // Keyboard arrow keys nudge one frame (or 10 frames with Shift).
  await act(async () => {
    startHandle!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(onCommit).toHaveBeenCalledTimes(2);
  expect(onCommit.mock.calls[1]![0].start).toBeCloseTo(2 + 1 / 30, 5);
  expect(onCommit.mock.calls[1]![0].end).toBe(4);
});

it("renders edit-toned edge handles with custom removeLabel when pulling a timed edit closed", async () => {
  const onCommit = vi.fn();
  await act(async () => root.render(
    <TimelineScrubber start={0} duration={20} playhead={1} fps={30} frameAt={() => undefined}
      onSeek={t => seeks.push(t)} onScrubStart={() => released}
      highlight={{ key: "edit-1", view: { start: 0, end: 10 }, band: { start: 1, end: 3 }, bandLabel: "Text · 2.0 s", tone: "kept" }}
      cutAdjust={{
        bounds: { minStart: 0, maxStart: 3, minEnd: 1, maxEnd: 8 },
        tone: "edit",
        bandPrefix: "Text",
        removeLabel: "Remove",
        describeEdge: (_edge, oldTime, newTime, next) => ({
          text: next.end <= next.start ? "Remove text" : newTime > oldTime ? "Ends later" : "Ends earlier",
          tone: next.end <= next.start ? "take-out" : "neutral",
          delta: `${newTime > oldTime ? "+" : "−"}${Math.abs(newTime - oldTime).toFixed(2)} s`,
        }),
        onCommit,
      }} />));
  await zoomed();

  const startHandle = container.querySelector<HTMLButtonElement>('[data-cut-handle="start"]');
  const endHandle = container.querySelector<HTMLButtonElement>('[data-cut-handle="end"]');
  expect(startHandle?.classList.contains("is-edit")).toBe(true);
  expect(endHandle?.classList.contains("is-edit")).toBe(true);
  expect(startHandle?.getAttribute("aria-label")).toContain("Adjust start of edit");
  expect(endHandle?.getAttribute("aria-label")).toContain("Adjust end of edit");

  // Dragging the end edge shorter updates the band label, and pulling it all the way back to start collapses to the cut line with removeLabel.
  await act(async () => {
    endHandle!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, button: 0, isPrimary: true, clientX: 300, bubbles: true }));
  });
  await act(async () => {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 200, bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(container.querySelector(".simple-timeline-band")?.textContent).toBe("Text · 1.0 s");
  await act(async () => {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 100, bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
  expect(container.querySelector(".simple-timeline-cut")?.textContent).toBe("Remove");
  expect(container.querySelector(".timeline-cut-readout")?.textContent).toContain("Remove text");

  await act(async () => {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: 100, bubbles: true }));
  });
  expect(onCommit).toHaveBeenCalledWith({ start: 1, end: 1 });
});

/** An open cut's band, at `start` for a second, zoomed to as `focusAround` does: five seconds either side. */
const openCut = (start: number, duration = 3000, playhead = start - 2) => act(async () => root.render(
  <TimelineScrubber start={0} duration={duration} playhead={playhead} frameAt={() => undefined} onSeek={t => seeks.push(t)} onScrubStart={() => released}
    highlight={{ key: "cut-1", view: { start: start - 5, end: start + 6 }, band: { start, end: start + 1 }, bandLabel: "Cut · 1.0 s" }} />));
const band = () => container.querySelector<HTMLElement>(".simple-timeline-band");
const bandLeft = () => Math.round(parseFloat(band()!.style.left) * 100) / 100;

it("zooms to an open cut's band again when the timeline is built again for a version where the cut sits elsewhere (#686)", async () => {
  // The cut opens at 1:40 on the version before it, zoomed to 1:35–1:46.
  await openCut(100);
  await zoomed();
  expect(bandLeft()).toBeCloseTo(45.45, 1);
  // The version it is shown on changes under it (a pass saves its next batch, a call goes onto the version that still
  // has the footage round it): the timeline is built again, and the same cut now sits at 5:00. The zoom it carried
  // over showed 1:35–1:46, where the band isn't, and the cut on the card had nothing on the timeline.
  await openCut(300, 3100);
  await zoomed();
  expect(band()).not.toBeNull();
  expect(bandLeft()).toBeCloseTo(45.45, 1);
});

it("zooms to an open cut's band again when it moves out of view on the same timeline (#686)", async () => {
  await openCut(100);
  await zoomed();
  // The same cut, placed again on the same version (its one-cut preview arrived, or its revision landed elsewhere),
  // before its listen has moved the playhead there.
  await openCut(300, 3000, 98);
  await zoomed();
  expect(band()).not.toBeNull();
  expect(bandLeft()).toBeCloseTo(45.45, 1);
});

it("keeps the zoom it had when the timeline is built again and the open cut's band is still in view", async () => {
  await openCut(100);
  await zoomed();
  // A new version under the same cut, which moved a little: the zoom stays as the editor had it, and the band moves in it.
  await openCut(101, 3100);
  await zoomed();
  expect(bandLeft()).toBeCloseTo(54.55, 1);
});
