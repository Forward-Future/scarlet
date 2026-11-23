// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelineScrubber, type TimelineDot } from "./TimelineScrubber";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = (playhead: number, marks?: TimelineDot[]) =>
  act(async () => root.render(<TimelineScrubber duration={120} playhead={playhead} marks={marks} frameAt={() => undefined} onSeek={() => {}} />));

it("lands a just-applied edit with a moment: a cut's red closes up first, any other edit only pops in", async () => {
  await show(0, [
    { time: 20, title: "Edit 1 of 3 · 0:20", n: 1, landed: "cut" },
    { time: 60, title: "Edit 2 of 3 · 1:00", n: 2, landed: "edit" },
    { time: 100, title: "Edit 3 of 3 · 1:40", n: 3 },
  ]);
  const marks = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  expect(marks.map(m => [m.textContent, m.dataset.landed])).toEqual([["1", "cut"], ["2", "edit"], ["3", undefined]]);
  const closing = container.querySelectorAll<HTMLElement>(".simple-timeline-closing");
  expect(closing).toHaveLength(1);
  expect(closing[0]!.style.left).toBe(marks[0]!.style.left);
});

it("plays an edit's arrival once: a marker drawn again picks it up where it is, and one drawn after is simply there", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const cut = (time: number): TimelineDot => ({ time, title: "Edit 1", n: 1, landed: "cut", landedAt: 1_000_000 });
  await show(0, [cut(20)]);
  const mark = () => container.querySelector<HTMLElement>(".simple-timeline-mark")!;
  expect(mark().dataset.landed).toBe("cut");
  expect(mark().style.animationDelay).toBe("");
  // The cut's timeline settles 400 ms later and moves the marker: drawn anew, it carries on from 400 ms in.
  now += 400;
  await show(0, [cut(18)]);
  expect(mark().dataset.landed).toBe("cut");
  expect(mark().style.animationDelay).toBe("-140ms");
  expect(container.querySelector<HTMLElement>(".simple-timeline-closing")!.style.animationDelay).toBe("-400ms");
  // Once the moment has played, a marker drawn again doesn't play it a second time.
  now += 1000;
  await show(0, [cut(17)]);
  expect(mark().dataset.landed).toBeUndefined();
  expect(container.querySelector(".simple-timeline-closing")).toBeNull();
  vi.restoreAllMocks();
});

it("takes a newer cut into a pill already there quietly: only that cut's red closes up, where it is", async () => {
  const now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await show(0, [
    { time: 21, title: "Edit 1", n: 1 },
    { time: 21, title: "Edit 2", n: 2 },
    { time: 21, title: "Edit 3", n: 3, landed: "cut", landedAt: now, edit: "c3/0" },
  ]);
  const marks = [...container.querySelectorAll<HTMLElement>(".simple-timeline-mark")];
  expect(marks.map(m => [m.textContent, m.dataset.landed])).toEqual([["1–3", undefined]]);
  const closing = [...container.querySelectorAll<HTMLElement>(".simple-timeline-closing")];
  expect(closing.map(c => c.style.left)).toEqual([`${21 / 120 * 100}%`]);
  vi.restoreAllMocks();
});

it("glides the playhead through a jump, and follows playback and small steps as before", async () => {
  vi.useFakeTimers();
  const playhead = () => container.querySelector(".timeline-playhead")!;
  await show(10);
  expect(playhead().classList.contains("is-gliding")).toBe(false);
  // A press on a marker or a skip moves it seconds at once: it glides there.
  await show(70);
  expect(playhead().classList.contains("is-gliding")).toBe(true);
  expect(container.querySelector(".timeline-playhead-time")!.classList.contains("is-gliding")).toBe(true);
  // Once there, playback moves it a little at a time, with no glide.
  vi.advanceTimersByTime(300);
  await show(70.25);
  expect(playhead().classList.contains("is-gliding")).toBe(false);
});

const slider = () => container.querySelector<HTMLElement>('[role="slider"]')!;

it("cancels a navigation glide at a short cut and snaps across cuts in either direction", async () => {
  vi.useFakeTimers();
  const skippedRanges = [{ start: 20, end: 20.2 }, { start: 24, end: 30 }];
  const draw = (time: number) => act(async () => root.render(<TimelineScrubber duration={120} playhead={time}
    skippedRanges={skippedRanges} frameAt={() => undefined} onSeek={() => {}} />));
  const gliding = () => [".timeline-playhead", ".timeline-playhead-time"].map(selector =>
    container.querySelector(selector)!.classList.contains("is-gliding"));
  await draw(10);
  await draw(19.98);
  expect(gliding()).toEqual([true, true]);
  await draw(20.21);
  expect(gliding()).toEqual([false, false]);
  await draw(30);
  expect(gliding()).toEqual([false, false]);
  await draw(24);
  expect(gliding()).toEqual([false, false]);
});

it("leaves ← and → alone on the focused timeline while ⌘, Ctrl or Alt is held, as the page does", async () => {
  const onSeek = vi.fn();
  await act(async () => root.render(<TimelineScrubber duration={120} playhead={30} frameAt={() => undefined} onSeek={onSeek} />));
  const key = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => { slider().dispatchEvent(event); });
    return event.defaultPrevented;
  };
  expect([await key({ key: "ArrowLeft", metaKey: true }), await key({ key: "ArrowRight", ctrlKey: true }), await key({ key: "ArrowRight", altKey: true })]).toEqual([false, false, false]);
  expect(onSeek).not.toHaveBeenCalled();
  expect(await key({ key: "ArrowRight" })).toBe(true);
  expect(onSeek).toHaveBeenLastCalledWith(31);
  expect(await key({ key: "ArrowLeft", shiftKey: true })).toBe(true);
  expect(onSeek).toHaveBeenLastCalledWith(899 / 30);
});

it("ends a drag that is held when a new working cut builds the timeline again, so the video it paused carries on", async () => {
  const release = vi.fn();
  const gestures: AbortSignal[] = [];
  const draw = (duration: number) => act(async () => root.render(<TimelineScrubber duration={duration} playhead={30} frameAt={() => undefined} onSeek={() => {}}
    onScrubStart={gesture => { gestures.push(gesture); return release; }} />));
  await draw(120);
  vi.spyOn(slider(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 120, 80));
  Object.defineProperty(slider(), "setPointerCapture", { value() {} });
  await act(async () => { slider().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: 40 })); });
  expect([gestures.length, release.mock.calls.length]).toEqual([1, 0]);
  // Scarlet applies a cut while the pointer is still down: the video is shorter, and its timeline is built anew.
  await draw(110);
  expect(gestures[0]!.aborted).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
});

it("stays where the editor zoomed while the video plays on elsewhere, instead of going back to the playhead", async () => {
  const { usePlayerStore } = await import("../../stores/player");
  const before = usePlayerStore.getState();
  const draw = (playhead: number) => act(async () => root.render(<TimelineScrubber duration={600} playhead={playhead} frameAt={() => undefined} onSeek={() => {}} />));
  // The playhead is drawn only while it is inside the stretch the timeline shows.
  const inView = () => !!container.querySelector(".timeline-playhead");
  try {
    usePlayerStore.setState({ time: 60, playing: true });
    await draw(60);
    expect(inView()).toBe(true);
    const track = container.querySelector<HTMLElement>(".timeline-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 80));
    // A pinch near the end of the video, to look ahead while it plays near the start.
    for (let i = 0; i < 3; i++) await act(async () => { track.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 950 })); });
    expect(inView()).toBe(false);
    // The video plays on. The view stays on the stretch the editor chose, with the playhead still out of it.
    usePlayerStore.setState({ time: 60.25 });
    await draw(60.25);
    expect(inView()).toBe(false);
    // Paused, the next move of the playhead turns the view to it, as before.
    usePlayerStore.setState({ time: 61, playing: false });
    await draw(61);
    expect(inView()).toBe(true);
  } finally {
    usePlayerStore.setState(before, true);
  }
});

it("keeps two-finger horizontal scrolling and pinch zoom separate instead of zooming while scrolling", async () => {
  vi.useFakeTimers();
  let now = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  try {
    await act(async () => root.render(<TimelineScrubber duration={100} playhead={50} frameAt={() => undefined} onSeek={() => {}} />));
    const track = container.querySelector<HTMLElement>(".timeline-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 80));
    const zoomLevel = () => container.querySelector<HTMLElement>(".timeline-zoom-level")!.textContent;
    const playheadLeft = () => parseFloat(container.querySelector<HTMLElement>(".timeline-playhead")!.style.left);

    const wheel = (deltaX: number, deltaY: number, opts?: { ctrlKey?: boolean; shiftKey?: boolean; clientX?: number }) => act(async () => {
      const event = new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        ctrlKey: { value: opts?.ctrlKey ?? false },
        shiftKey: { value: opts?.shiftKey ?? false },
        clientX: { value: opts?.clientX ?? 200 },
      });
      track.dispatchEvent(event);
    });
    const pinch = (type: "gesturestart" | "gesturechange" | "gestureend", scale: number, clientX = 200) => act(async () => {
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX });
      track.dispatchEvent(event);
    });

    // Pinch in to 200%, with minor pre-pinch touch jitter and post-pinch finger-lift drift.
    await wheel(2, 1);
    now += 8;
    await pinch("gesturestart", 1);
    now += 8;
    await wheel(12, -4);
    now += 8;
    await pinch("gesturechange", 2);
    now += 8;
    await pinch("gestureend", 2);
    expect(zoomLevel()).toBe("200%");
    const afterPinchLeft = playheadLeft();
    expect(afterPinchLeft).toBeCloseTo(50);

    // Trailing finger-lift wheel events right after gestureend must not pan or zoom.
    now += 30;
    await wheel(24, -15);
    expect(zoomLevel()).toBe("200%");
    expect(playheadLeft()).toBeCloseTo(afterPinchLeft);

    // After the pinch cooldown, a realistic two-finger horizontal swipe with vertical touch-down jitter,
    // a direction reversal (deltaX = 0, deltaY != 0), slight pinch drift, and momentum tail pans without zooming.
    now += 200;
    await wheel(0, 2);
    now += 16;
    await wheel(2, 3);
    now += 16;
    await wheel(18, 4);
    now += 16;
    await wheel(22, -3);
    now += 16;
    await wheel(0, -4);
    now += 16;
    await wheel(-8, 5);
    now += 16;
    await pinch("gesturestart", 1);
    now += 16;
    await pinch("gesturechange", 1.03);
    now += 16;
    await wheel(16, 2);
    now += 16;
    await pinch("gesturechange", 1.06);
    now += 16;
    await pinch("gestureend", 1.06);
    now += 16;
    await wheel(1, 3);
    now += 32;
    await wheel(0, 2);
    expect(zoomLevel()).toBe("200%");
    expect(playheadLeft()).toBeLessThan(afterPinchLeft);

    // After the pan settles, pinch zoom (both WKWebView gesture and ctrl+wheel) works cleanly again,
    // and interleaved plain wheel events during a ctrl+wheel pinch do not pan.
    now += 250;
    await wheel(0, -50, { ctrlKey: true });
    const afterCtrlZoom = zoomLevel();
    expect(parseInt(afterCtrlZoom!, 10)).toBeGreaterThan(200);
    const anchoredLeft = playheadLeft();
    now += 16;
    await wheel(30, 0);
    expect(zoomLevel()).toBe(afterCtrlZoom);
    expect(playheadLeft()).toBeCloseTo(anchoredLeft);

    // Intentional straight vertical scrolling still zooms, and ignores minor horizontal wobble while zooming.
    now += 250;
    await wheel(0, -40, { clientX: 200 });
    const afterVerticalZoom = zoomLevel();
    expect(parseInt(afterVerticalZoom!, 10)).toBeGreaterThan(parseInt(afterCtrlZoom!, 10));
    const zoomedLeft = playheadLeft();
    now += 16;
    await wheel(25, 0);
    expect(zoomLevel()).toBe(afterVerticalZoom);
    expect(playheadLeft()).toBeCloseTo(zoomedLeft);
  } finally {
    vi.restoreAllMocks();
  }
});
