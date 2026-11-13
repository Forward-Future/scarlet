// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScrubPreview } from "./ScrubPreview";

let root: Root;
let container: HTMLDivElement;
/** Each frame the bubble asked the engine for: where, whether it was called off, and how to answer it. */
let asked: { url: URL; signal: AbortSignal; answer(ok?: boolean): Promise<void> }[];
let made: string[];
let revoked: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // One paint per pointer move, run by the test.
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  asked = [];
  made = [];
  revoked = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    asked.push({ url: new URL(input), signal, answer: (ok = true) => act(async () => resolve(new Response(ok ? "frame" : "", { status: ok ? 200 : 503 }))) });
  })));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => { made.push(`blob:frame-${made.length + 1}`); return made.at(-1)!; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(url => { revoked.push(url); });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const frameAt = (time: number, exact?: boolean) => `http://engine.test/projects/p/frame?t=${time}${exact ? "&exact=1" : ""}`;
const show = async (duration = 100, start = 0, file?: string, aspect?: number, withNote = true) => {
  const hoverVideo = file ? { url: file, lastFrame: 100 - 1 / 30 } : undefined;
  await act(async () => root.render(<ScrubPreview start={start} duration={duration} pictureAspect={aspect} frameAt={frameAt} hoverVideo={hoverVideo}
    note={withNote ? <em>Edit 2</em> : undefined}><div className="track" /></ScrubPreview>));
  const bar = container.firstElementChild as HTMLElement;
  bar.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 40);
  Object.defineProperty(bubble(), "offsetWidth", { configurable: true, value: 320 });
  return bar;
};
const bubble = () => container.querySelector<HTMLElement>('[aria-hidden="true"]')!;
const still = () => container.querySelector("img")!;
const stamp = () => bubble().querySelector("span")!.textContent;
const pointer = (bar: HTMLElement, type: string, clientX: number, init: PointerEventInit = {}) => act(async () => {
  bar.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, ...init }));
  vi.advanceTimersByTime(16);
});

it("shows the time and a frame for where the pointer is, asking for one frame at a time", async () => {
  const bar = await show();
  expect(bubble().hidden).toBe(true);
  await pointer(bar, "pointermove", 250);
  // A quarter of the way along 100 seconds. The bubble carries the note for what the pointer is over.
  expect(bubble().hidden).toBe(false);
  expect(stamp()).toBe("0:25.000");
  expect(bubble().querySelector("em")?.textContent).toBe("Edit 2");
  expect(bubble().style.transform).toBe("translateX(90px)");
  // The frame is asked for at twice the bubble's width, ahead of background work, and stays hidden until it has loaded.
  expect(asked).toHaveLength(1);
  expect([asked[0]!.url.searchParams.get("t"), asked[0]!.url.searchParams.get("w"), asked[0]!.url.searchParams.get("priority")]).toEqual(["25", "640", "interactive"]);
  expect(still().hidden).toBe(true);
  // The pointer moves on twice while that frame is on its way. Neither move queues a request of its own.
  await pointer(bar, "pointermove", 400);
  await pointer(bar, "pointermove", 500);
  expect(stamp()).toBe("0:50.000");
  expect(asked).toHaveLength(1);
  // The first frame arrives for a place the pointer has left: it isn't shown, and the latest place is asked for.
  await asked[0]!.answer();
  expect(still().getAttribute("src")).toBeNull();
  expect(asked.map(a => a.url.searchParams.get("t"))).toEqual(["25", "50"]);
  await asked[1]!.answer();
  expect(still().getAttribute("src")).toBe("blob:frame-1");
  expect(still().hidden).toBe(true);
  await act(async () => { still().dispatchEvent(new Event("load")); });
  expect(still().hidden).toBe(false);
  // Back over a place whose frame is showing asks for nothing.
  await pointer(bar, "pointermove", 500);
  expect(asked).toHaveLength(2);
});

it("sizes the hover frame to the picture while giving edit notes their full width", async () => {
  const bar = await show(100, 0, "/portrait.mp4", 9 / 16, false);
  expect(parseFloat(still().style.aspectRatio)).toBe(9 / 16);
  expect(bubble().style.getPropertyValue("--scrub-picture-width")).toBe("min(180px, 22.5dvh)");
  expect(parseFloat(bar.querySelector("video")!.style.aspectRatio)).toBe(9 / 16);
  expect(bubble().style.width).toBe("");
  Object.defineProperty(bubble(), "offsetWidth", { configurable: true, value: 180 });
  await pointer(bar, "pointerenter", 995);
  expect(bubble().style.transform).toBe("translateX(820px)");
  await show(100, 0, "/portrait.mp4", 9 / 16, true);
  expect(bubble().style.width).toBe("320px");
  expect(bubble().style.getPropertyValue("--scrub-picture-width")).toBe("min(180px, 22.5dvh)");
});

it("calls off the frame on its way when the pointer leaves, and frees the last frame when the timeline goes", async () => {
  const bar = await show();
  await pointer(bar, "pointermove", 100);
  await asked[0]!.answer();
  await act(async () => { still().dispatchEvent(new Event("load")); });
  await pointer(bar, "pointermove", 900);
  expect(asked).toHaveLength(2);
  expect(asked[1]!.signal.aborted).toBe(false);
  await pointer(bar, "pointerleave", 900);
  // The engine's decoder is free at once, and the bubble is gone with its frame.
  expect(asked[1]!.signal.aborted).toBe(true);
  expect([bubble().hidden, still().hidden]).toEqual([true, true]);
  // Over the timeline again, the same place is asked for afresh.
  await pointer(bar, "pointerenter", 900);
  expect(asked.map(a => a.url.searchParams.get("t"))).toEqual(["10", "90", "90"]);
  await asked[2]!.answer();
  // The frame it replaces is freed, and the last one with the timeline.
  expect(revoked).toEqual(["blob:frame-1"]);
  await act(async () => root.render(null));
  expect(revoked).toEqual(["blob:frame-1", "blob:frame-2"]);
});

it("keeps the time and hides the picture when a frame can't be had", async () => {
  const bar = await show();
  await pointer(bar, "pointermove", 300);
  await asked[0]!.answer(false);
  expect(bubble().hidden).toBe(false);
  expect(stamp()).toBe("0:30.000");
  expect(still().hidden).toBe(true);
  expect(made).toEqual([]);
  // A frame whose bytes can't be drawn stays hidden too.
  await pointer(bar, "pointermove", 600);
  await asked[1]!.answer();
  await act(async () => { still().dispatchEvent(new Event("error")); });
  expect(still().hidden).toBe(true);
});

it("follows a drag with exact frames, ignores a button held from elsewhere and touch, and hides when the drag ends", async () => {
  const bar = await show(60, 120);
  // A pointer that arrives with a button already down is a drag from somewhere else, and a finger doesn't hover.
  await pointer(bar, "pointermove", 500, { buttons: 1 });
  await pointer(bar, "pointermove", 500, { pointerType: "touch" });
  expect(bubble().hidden).toBe(true);
  expect(asked).toEqual([]);
  // The timeline starts at 2:00 and runs a minute. A press starts a drag: its frames are the exact ones.
  await pointer(bar, "pointerdown", 500, { buttons: 1 });
  expect(stamp()).toBe("2:30.000");
  expect(asked[0]!.url.searchParams.get("exact")).toBe("1");
  // Another pointer doesn't move it, and only the dragging pointer's release ends it.
  await pointer(bar, "pointermove", 900, { pointerId: 2, buttons: 1 });
  expect(stamp()).toBe("2:30.000");
  await pointer(bar, "pointerup", 500, { pointerId: 2 });
  expect(bubble().hidden).toBe(false);
  // Leaving the track mid-drag keeps the bubble: the drag is still on.
  await pointer(bar, "pointerleave", 500);
  expect(bubble().hidden).toBe(false);
  await pointer(bar, "pointerup", 500);
  expect(bubble().hidden).toBe(true);
  expect(asked[0]!.signal.aborted).toBe(true);
});

it("draws no bubble for a video with no length yet", async () => {
  const bar = await show(0);
  await pointer(bar, "pointermove", 500);
  expect(bubble().hidden).toBe(true);
  expect(asked).toEqual([]);
});

it("ends a drag that is let go off the timeline, so the bubble goes when the pointer leaves", async () => {
  const bar = await show(60, 120);
  // A press in a cut's red band plays its passage and never captures the pointer: the release can land anywhere.
  await pointer(bar, "pointerdown", 500, { buttons: 1 });
  expect(bubble().hidden).toBe(false);
  await act(async () => { window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, isPrimary: true, button: 0 })); });
  expect(bubble().hidden).toBe(true);
  // Back over the track it hovers again, and leaving hides it: the drag isn't still on.
  await pointer(bar, "pointermove", 700);
  expect(bubble().hidden).toBe(false);
  expect(asked.at(-1)!.url.searchParams.get("exact")).toBeNull();
  await pointer(bar, "pointerleave", 700);
  expect(bubble().hidden).toBe(true);
});

it("seeks one muted movie on the timeline clock and only shows the latest completed hover", async () => {
  const bar = await show(40, 60, "/working-cut.mp4");
  const movie = bar.querySelector("video")!;
  let ready = 0, seeking = false, at = 0;
  const seek = vi.fn((t: number) => { at = t; seeking = true; });
  Object.defineProperties(movie, {
    readyState: { get: () => ready }, seeking: { get: () => seeking },
    duration: { value: 100.02 }, videoWidth: { value: 960 }, currentTime: { get: () => at, set: seek },
  });
  expect(movie.muted).toBe(true);
  expect(movie.preload).toBe("metadata");
  expect(movie.getAttribute("src")).toBe("/working-cut.mp4");
  await pointer(bar, "pointerenter", 250);
  ready = 1;
  movie.dispatchEvent(new Event("loadedmetadata"));
  expect(seek.mock.calls).toEqual([[70]]);
  await pointer(bar, "pointermove", 500);
  await pointer(bar, "pointermove", 750);
  expect(seek).toHaveBeenCalledTimes(1);
  ready = 4;
  seeking = false;
  movie.dispatchEvent(new Event("seeked"));
  expect(seek.mock.calls).toEqual([[70], [90]]);
  expect(movie.hidden).toBe(true);
  seeking = false;
  movie.dispatchEvent(new Event("seeked"));
  expect(movie.hidden).toBe(false);
  expect(movie.paused).toBe(true);
  await pointer(bar, "pointerleave", 750);
  expect(movie.hidden).toBe(true);
  await pointer(bar, "pointerenter", 752);
  expect(movie.hidden).toBe(false);
  expect(seek).toHaveBeenCalledTimes(2);
  expect(asked).toHaveLength(0);
  await pointer(bar, "pointermove", 1000);
  expect(seek).toHaveBeenLastCalledWith(99.75);
  await pointer(bar, "pointerdown", 752, { buttons: 1 });
  expect(movie.hidden).toBe(true);
  expect(asked[0]!.url.searchParams.get("exact")).toBe("1");
});

it("keeps the decoder across zooms and releases it when the preview file changes or closes", async () => {
  const bar = await show(100, 0, "/first.mp4");
  const movie = bar.querySelector("video")!;
  const load = vi.spyOn(movie, "load");
  const setFile = vi.spyOn(movie, "src", "set");
  await show(10, 30, "/first.mp4");
  expect(load).not.toHaveBeenCalled();
  expect(setFile).not.toHaveBeenCalled();
  await show(10, 30, "/revised.mp4");
  expect(load).toHaveBeenCalledTimes(1);
  expect(setFile).toHaveBeenCalledWith("/revised.mp4");
  await act(async () => root.render(null));
  expect(movie.hasAttribute("src")).toBe(false);
});

it.each(["error", "timeout"])("uses the engine at the current position when the movie fails (%s)", async failure => {
  const bar = await show(100, 0, "/unavailable.mp4");
  const movie = bar.querySelector("video")!;
  await pointer(bar, "pointermove", 150);
  await pointer(bar, "pointermove", 350);
  if (failure === "error") movie.dispatchEvent(new Event("error"));
  else vi.advanceTimersByTime(500);
  expect(movie.hasAttribute("src")).toBe(false);
  expect(asked.map(a => a.url.searchParams.get("t"))).toEqual(["35"]);
  await asked[0]!.answer();
  still().dispatchEvent(new Event("load"));
  expect(still().hidden).toBe(false);
});

it("releases a slow obsolete decode once the pointer settles, and cancels a pending retarget on leave", async () => {
  const bar = await show();
  await pointer(bar, "pointermove", 100);
  await pointer(bar, "pointermove", 250);
  await pointer(bar, "pointermove", 900);
  vi.advanceTimersByTime(64);
  expect(asked[0]!.signal.aborted).toBe(true);
  expect(asked.map(a => a.url.searchParams.get("t"))).toEqual(["10", "90"]);
  await pointer(bar, "pointermove", 500);
  await pointer(bar, "pointerleave", 500);
  vi.advanceTimersByTime(500);
  expect(asked[1]!.signal.aborted).toBe(true);
  expect(asked).toHaveLength(2);
});

it("keeps a drag's bubble through the page handing it a new way to ask for frames", async () => {
  const bar = await show(60, 120);
  await pointer(bar, "pointerdown", 500, { buttons: 1 });
  expect([bubble().hidden, stamp()]).toEqual([false, "2:30.000"]);
  // The project or its media changed under the drag, as they do while videos cache or Scarlet works: the page builds
  // `frameAt` again. The drag is still on, and its bubble goes on following the pointer with the new one's frames.
  const newer = (time: number, exact?: boolean) => `http://engine.test/projects/p/frame?v=2&t=${time}${exact ? "&exact=1" : ""}`;
  await act(async () => root.render(<ScrubPreview start={120} duration={60} frameAt={newer} note={<em>Edit 2</em>}><div className="track" /></ScrubPreview>));
  expect(bubble().hidden).toBe(false);
  await asked[0]!.answer();
  await pointer(bar, "pointermove", 750, { buttons: 1 });
  expect([bubble().hidden, stamp()]).toEqual([false, "2:45.000"]);
  expect([asked.at(-1)!.url.searchParams.get("v"), asked.at(-1)!.url.searchParams.get("exact")]).toEqual(["2", "1"]);
  await pointer(bar, "pointerup", 750);
  expect(bubble().hidden).toBe(true);
});
