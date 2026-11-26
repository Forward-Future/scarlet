// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyTimeline } from "@scarlet/timeline";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { useCaughtUpStore, type CaughtUp } from "../../stores/shownCut";
import { CaughtUpOnMonitor } from "./CaughtUp";

let root: Root;
let container: HTMLDivElement;
/** The element the player says it has attached now. */
let attached: HTMLVideoElement | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  attached = null;
  vi.spyOn(player, "element").mockImplementation(() => attached);
  usePlayerStore.setState({ time: 12, playing: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCaughtUpStore.setState({ caughtUp: undefined, waiting: undefined });
  usePlayerStore.setState(usePlayerStore.getInitialState());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A video element as the held frame and the player see it. */
function video({ readyState = 4, seeking = false }: { readyState?: number; seeking?: boolean } = {}) {
  const el = document.createElement("video");
  Object.defineProperty(el, "readyState", { configurable: true, get: () => readyState });
  Object.defineProperty(el, "seeking", { configurable: true, get: () => seeking });
  return el;
}

function held(id = 1, frameVideo = video({ readyState: 0 })): CaughtUp {
  const timeline = emptyTimeline("prj_1");
  const canvas = document.createElement("canvas");
  canvas.className = "held-picture";
  return { id, from: timeline, to: timeline, time: 12, frame: { canvas, video: frameVideo } };
}

const show = () => act(async () => root.render(<CaughtUpOnMonitor />));
const frame = () => container.querySelector<HTMLElement>(".caught-up-frame");
const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

it("shows nothing with no edits waiting and no held picture", async () => {
  await show();
  expect(container.innerHTML).toBe("");
});

it("says new edits are ready while they wait for a pause", async () => {
  useCaughtUpStore.setState({ waiting: true });
  await show();
  const status = container.querySelector('[role="status"]')!;
  expect(status.textContent).toBe("New edits ready · pause to see them");
  await act(async () => useCaughtUpStore.setState({ waiting: false }));
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("holds the stopped picture until the new player has its own frame, then fades it and lets it go", async () => {
  const caughtUp = held();
  useCaughtUpStore.setState({ caughtUp });
  await show();
  expect(frame()?.getAttribute("aria-hidden")).toBe("true");
  expect(frame()?.querySelector("canvas.held-picture")).toBe(caughtUp.frame!.canvas);
  // No player, then one still loading or seeking: the picture stays.
  await tick(200);
  attached = video({ readyState: 1 });
  await tick(200);
  attached = video({ seeking: true });
  await tick(200);
  expect(frame()?.dataset.leaving).toBeUndefined();
  // The new player has a frame where it stands.
  attached = video();
  await tick(50);
  expect(frame()?.dataset.leaving).toBe("true");
  expect(useCaughtUpStore.getState().caughtUp?.frame).toBeDefined();
  await tick(250);
  expect(useCaughtUpStore.getState().caughtUp?.frame).toBeUndefined();
  expect(useCaughtUpStore.getState().caughtUp?.id).toBe(1);
  expect(frame()).toBeNull();
  expect(caughtUp.frame!.canvas.isConnected).toBe(false);
});

it("keeps the held picture a moment when the player that played stays attached", async () => {
  const same = video();
  useCaughtUpStore.setState({ caughtUp: held(2, same) });
  attached = same;
  await show();
  await tick(100);
  expect(frame()?.dataset.leaving).toBeUndefined();
  await tick(100);
  expect(frame()?.dataset.leaving).toBe("true");
});

it("lets the held picture go when the editor scrubs away from it", async () => {
  useCaughtUpStore.setState({ caughtUp: held(3) });
  await show();
  await tick(100);
  expect(frame()?.dataset.leaving).toBeUndefined();
  usePlayerStore.setState({ time: 20 });
  await tick(50);
  expect(frame()?.dataset.leaving).toBe("true");
});

it("waits up to four seconds of playing for a player that loads nothing until Play", async () => {
  useCaughtUpStore.setState({ caughtUp: held(4) });
  await show();
  // A moved playhead while playing isn't a scrub away.
  usePlayerStore.setState({ playing: true, time: 13 });
  await tick(3_900);
  expect(frame()?.dataset.leaving).toBeUndefined();
  await tick(200);
  expect(frame()?.dataset.leaving).toBe("true");
});

it("doesn't drop a newer held picture when an older one finishes fading", async () => {
  useCaughtUpStore.setState({ caughtUp: held(5) });
  await show();
  usePlayerStore.setState({ time: 30 });
  await tick(50);
  expect(frame()?.dataset.leaving).toBe("true");
  // A newer catch-up arrives before the fade ends: it gets its own held picture.
  const newer = held(6);
  await act(async () => useCaughtUpStore.setState({ caughtUp: newer }));
  usePlayerStore.setState({ time: 12 });
  await tick(250);
  expect(useCaughtUpStore.getState().caughtUp?.frame).toBe(newer.frame);
  expect(frame()?.querySelector("canvas")).toBe(newer.frame!.canvas);
});
