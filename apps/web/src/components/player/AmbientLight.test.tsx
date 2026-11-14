// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AmbientLight, pictureRect, shownVideo } from "./AmbientLight";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const rounded = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1000) / 1000 + 0]));

it("finds the picture inside a letterboxed video", () => {
  // A 16:9 picture in a square box sits in a band across its middle.
  expect(rounded(pictureRect({ width: 1000, height: 1000 }, { videoWidth: 1920, videoHeight: 1080 }))).toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 });
  // A 9:16 picture in a wide box sits in a column at its centre.
  expect(rounded(pictureRect({ width: 1600, height: 900 }, { videoWidth: 1080, videoHeight: 1920 }))).toEqual({ x: 546.875, y: 0, width: 506.25, height: 900 });
  // Before the video knows its size, the picture is the whole box.
  expect(pictureRect({ width: 400, height: 300 }, { videoWidth: 0, videoHeight: 0 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
});

/** A video element that reports a frame ready to draw. */
function readyVideo(ready = true) {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: ready ? 4 : 0 });
  Object.defineProperty(video, "videoWidth", { value: ready ? 1920 : 0 });
  Object.defineProperty(video, "videoHeight", { value: ready ? 1080 : 0 });
  video.getClientRects = () => [{}] as unknown as DOMRectList;
  video.getBoundingClientRect = () => ({ left: 20, top: 16, width: 960, height: 540, right: 980, bottom: 556, x: 20, y: 16, toJSON() {} });
  return video;
}

it("lights from the picture on top: a clip over the video, not the video under it", () => {
  const monitor = document.createElement("div");
  const under = readyVideo(), over = readyVideo(), loading = readyVideo(false);
  monitor.append(under, over, loading);
  expect(shownVideo(monitor)).toBe(over);
  over.getClientRects = () => [] as unknown as DOMRectList;
  expect(shownVideo(monitor)).toBe(under);
  expect(shownVideo(document.createElement("div"))).toBeUndefined();
});

it("copies the frame on screen into the glow, eases toward later frames, and goes dark with no picture", async () => {
  const draws: { alpha: number; args: unknown[] }[] = [];
  let copies = 0;
  const fades: number[] = [];
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    clearRect: vi.fn(),
    fillRect() { if (this.globalCompositeOperation === "destination-out") fades.push(this.globalAlpha); },
    // Every canvas shares this stand-in. Frames are drawn from the video; the glow is moved toward the latest one, then
    // blurred onto the canvas on screen.
    drawImage(...args: unknown[]) { if (args[0] instanceof HTMLVideoElement) draws.push({ alpha: this.globalAlpha, args }); else copies++; },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const stage = document.createElement("section"), monitor = document.createElement("div");
  Object.defineProperty(stage, "clientWidth", { value: 1000 });
  Object.defineProperty(stage, "clientHeight", { value: 800 });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON() {} });
  const video = readyVideo();
  monitor.append(video);
  document.body.append(stage);
  stage.append(monitor);
  const stageRef = createRef<HTMLElement>(), monitorRef = createRef<HTMLDivElement>();
  (stageRef as { current: HTMLElement | null }).current = stage;
  (monitorRef as { current: HTMLDivElement | null }).current = monitor;

  const host = document.createElement("div");
  stage.prepend(host);
  const root = createRoot(host);
  await act(async () => root.render(<AmbientLight stage={stageRef} monitor={monitorRef} />));
  const canvas = host.querySelector("canvas")!;
  expect(canvas.getAttribute("aria-hidden")).toBe("true");
  // A coarse canvas, an eighth of the stage.
  expect([canvas.width, canvas.height]).toEqual([125, 100]);
  // The first look fills the glow at once, a little past the picture on each side.
  expect(canvas.dataset.lit).toBe("true");
  expect(draws).toHaveLength(1);
  expect(draws[0]!.alpha).toBe(1);
  // The glow is blurred in three passes of nine copies, the last onto the canvas on screen, which is painted whole.
  expect(copies).toBe(27);
  const [, ...place] = draws[0]!.args as number[];
  expect(place.map(n => Math.round(n * 8))).toEqual([-95, -49, 1190, 670]);

  // Later looks move the whole glow a step toward the frame, then stop once it has settled while the picture holds still.
  await act(async () => { vi.advanceTimersByTime(120 * 30); });
  expect(fades).toHaveLength(draws.length - 1);
  for (const alpha of fades) expect(alpha).toBeCloseTo(0.3);
  expect(context.globalCompositeOperation).toBe("source-over");
  const settled = draws.length;
  expect(settled).toBeLessThan(20);
  await act(async () => { vi.advanceTimersByTime(120 * 10); });
  expect(draws).toHaveLength(settled);

  // Playing on, it follows the picture again.
  video.currentTime = 3;
  await act(async () => { vi.advanceTimersByTime(120); });
  expect(draws).toHaveLength(settled + 1);

  // With no picture, the glow goes dark.
  video.remove();
  await act(async () => { vi.advanceTimersByTime(120); });
  expect(canvas.dataset.lit).toBe("false");
  expect(context.clearRect).toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("holds the glow still while the picture plays with motion reduced, and sets it at once when it rests", async () => {
  let reduce = true;
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.create(query, { matches: { get: () => reduce } }));
  // Frames drawn from the video, and steps of the glow toward one.
  let draws = 0, fades = 0;
  const context = {
    globalCompositeOperation: "source-over",
    clearRect() {},
    fillRect() { if (this.globalCompositeOperation === "destination-out") fades++; },
    drawImage(source: unknown) { if (source instanceof HTMLVideoElement) draws++; },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  let width = 1000, paused = false;
  const stage = document.createElement("section"), monitor = document.createElement("div");
  Object.defineProperty(stage, "clientWidth", { get: () => width });
  Object.defineProperty(stage, "clientHeight", { value: 800 });
  const playing =() => { const video = readyVideo(); Object.defineProperty(video, "paused", { get: () => paused }); return video; };
  const video = playing();
  monitor.append(video);
  document.body.append(stage);
  stage.append(monitor);
  const stageRef = createRef<HTMLElement>(), monitorRef = createRef<HTMLDivElement>();
  (stageRef as { current: HTMLElement | null }).current = stage;
  (monitorRef as { current: HTMLDivElement | null }).current = monitor;
  const host = document.createElement("div");
  stage.prepend(host);
  const root = createRoot(host);
  const tick = (n = 1) => act(async () => { vi.advanceTimersByTime(120 * n); });

  // The first look fills the glow at once, though the picture plays.
  await act(async () => root.render(<AmbientLight stage={stageRef} monitor={monitorRef} />));
  expect(host.querySelector("canvas")!.dataset.lit).toBe("true");
  expect(draws).toBe(1);

  // Playing on, through new frames and a clip that comes on top, the glow holds as it is.
  for (let t = 1; t <= 20; t++) { video.currentTime = t; await tick(); }
  const clip = playing();
  monitor.append(clip);
  await tick(20);
  expect(draws).toBe(1);
  expect(fades).toBe(0);

  // At rest, the picture on top sets the glow at once, and so does a seek: no step toward it.
  paused = true;
  await tick();
  expect(draws).toBeGreaterThan(1);
  clip.currentTime = 50;
  await tick(20);
  expect(fades).toBe(0);
  const settled = draws;
  await tick(10);
  expect(draws).toBe(settled);

  // A glow cleared by a resize is filled once, though the picture plays, and then holds again.
  paused = false;
  width = 1200;
  await tick();
  expect(draws).toBe(settled + 1);
  for (let t = 51; t <= 60; t++) { clip.currentTime = t; await tick(); }
  expect(draws).toBe(settled + 1);

  // With motion no longer reduced, it follows the playing picture again.
  reduce = false;
  clip.currentTime = 61;
  await tick();
  expect(fades).toBeGreaterThan(0);
  await act(async () => root.unmount());
});
