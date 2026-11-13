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
  // A settled edit drawn as a faint tick has no moment.
  await show(0, [{ time: 20, title: "Edit 1", n: 1, quiet: true, landed: "cut" }]);
  expect(container.querySelector("[data-landed], .simple-timeline-closing")).toBeNull();
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
  expect(onSeek).toHaveBeenLastCalledWith(35);
  expect(await key({ key: "ArrowLeft", shiftKey: true })).toBe(true);
  expect(onSeek).toHaveBeenLastCalledWith(29);
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
