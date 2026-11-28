// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pauseForScrub, player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { HOLD_MS } from "./TimelineRange";
import { TimelineScrubber } from "./TimelineScrubber";

const FPS = 30;
let root: Root;
let container: HTMLDivElement;
let video: HTMLVideoElement;
let endAudition: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  usePlayerStore.setState({ time: 0, duration: 20, playing: false, rate: 1, speedUpRate: 1.5, scrubGesture: undefined });
  video = document.createElement("video");
  document.body.append(video);
  player.attach(video);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 1000, bottom: 40, width: 1000, height: 40, x: 0, y: 0, toJSON() {},
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  endAudition?.();
  endAudition = undefined;
  player.detach();
  video.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const reach = (time: number) => {
  video.currentTime = time;
  video.dispatchEvent(new Event("timeupdate"));
};

/** Play an open cut's audition through its join until it stops at its end. */
function finishAudition() {
  endAudition?.();
  endAudition = player.audition({ start: 1, end: 5, skips: [{ start: 2, end: 4, removed: true }] }, FPS);
  reach(1.9);
  reach(1.99);
  reach(4.9);
  reach(5.02);
  expect(video.paused).toBe(true);
  expect(usePlayerStore.getState().playing).toBe(false);
}

async function mountCut(onCommit: () => void = () => {}) {
  await act(async () => root.render(
    <TimelineScrubber
      start={0}
      duration={20}
      playhead={5}
      fps={FPS}
      frameAt={() => undefined}
      onSeek={t => player.seek(t, true)}
      onScrubStart={pauseForScrub}
      highlight={{ key: "cut-1", view: { start: 0, end: 10 }, band: { start: 2, end: 4 }, bandLabel: "Cut · 2.0 s" }}
      cutAdjust={{ bounds: { minStart: 1, maxStart: 4, minEnd: 2, maxEnd: 6 }, tone: "cut", bandPrefix: "Cut", onCommit }}
    />,
  ));
  return container.querySelector<HTMLButtonElement>('[data-cut-handle="start"]')!;
}

const down = (el: Element, id: number, x: number) => act(async () => {
  el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: id, button: 0, isPrimary: true, clientX: x, bubbles: true }));
});
const move = (id: number, x: number) => act(async () => {
  document.dispatchEvent(new PointerEvent("pointermove", { pointerId: id, clientX: x, bubbles: true }));
  await new Promise(requestAnimationFrame);
});
const up = (id: number, x: number) => act(async () => {
  document.dispatchEvent(new PointerEvent("pointerup", { pointerId: id, clientX: x, bubbles: true }));
});
const esc = () => act(async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});

it.each<{
  name: string;
  gesture: (start: HTMLButtonElement) => Promise<void>;
  committed: boolean;
}>([
  {
    name: "clicking a handle without moving",
    gesture: async start => { await down(start, 1, 200); await up(1, 200); },
    committed: false,
  },
  {
    name: "cancelling an edge drag with Esc",
    gesture: async start => { await down(start, 1, 200); await move(1, 260); await esc(); },
    committed: false,
  },
  {
    name: "holding still for the frame close-up then releasing without moving",
    gesture: async start => {
      await down(start, 1, 200);
      await act(async () => { await new Promise(done => setTimeout(done, HOLD_MS + 100)); });
      expect(container.querySelector(".timeline-range-loupe")).not.toBeNull();
      await up(1, 200);
    },
    committed: false,
  },
  {
    name: "dragging and releasing to commit",
    gesture: async start => { await down(start, 1, 200); await move(1, 250); await up(1, 250); },
    committed: true,
  },
])("keeps the video paused after $name once its audition stops", async ({ gesture, committed }) => {
  let pausedAtCommit: boolean | undefined;
  const onCommit = vi.fn(() => { pausedAtCommit = video.paused; });
  const start = await mountCut(onCommit);
  finishAudition();

  await gesture(start);

  if (committed) {
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(pausedAtCommit).toBe(true);
  } else {
    expect(onCommit).not.toHaveBeenCalled();
  }
  expect(video.paused).toBe(true);
});

it("still plays on after cancelling an edge drag started while the video was playing", async () => {
  const start = await mountCut();
  finishAudition();
  player.play();
  expect(video.paused).toBe(false);

  await down(start, 1, 200);
  await move(1, 260);
  expect(video.paused).toBe(true);
  await esc();
  expect(video.paused).toBe(false);
});
