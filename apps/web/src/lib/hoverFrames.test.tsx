// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, connectDesktopEngine } from "./client";
import { hoverTimes, useHoverFrames } from "./hoverFrames";

let root: Root;
let hook!: ReturnType<typeof useHoverFrames>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Each frame loads a moment after it is asked for.
  vi.stubGlobal("Image", class { onload?: () => void; set src(_: string) { setTimeout(() => this.onload?.(), 10); } });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ id, hasVideo = true }: { id: string; hasVideo?: boolean }) {
  hook = useHoverFrames(id, { mediaId: "med_b", time: 2 }, hasVideo);
  return null;
}

it("spreads a card's frames through its video, a little in from each end", () => {
  expect(hoverTimes(100)).toEqual([8, 24.8, 41.6, 58.4, 75.2, 92].map(t => expect.closeTo(t, 6)));
  expect(hoverTimes(0)).toEqual([]);
});

it("flips through the poster's video while the pointer rests on the card, and goes back to the poster when it leaves", async () => {
  const media = vi.spyOn(api, "media").mockResolvedValue({ media: [
    { id: "med_a", kind: "video", duration: 50 }, { id: "med_b", kind: "video", duration: 100 },
  ] } as never);
  vi.spyOn(api, "frameUrl").mockImplementation((id: string, time: number) => `/frame/${id}/${time.toFixed(1)}`);
  await act(async () => root.render(<Probe id="prj_1" />));
  expect(hook.frame).toBeUndefined();
  // Passing over the card asks for nothing.
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(100); });
  await act(async () => { hook.onPointerLeave(); });
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(media).not.toHaveBeenCalled();
  // Resting on it, the frames come from the video the poster is from, in order.
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(300); });
  await act(async () => { vi.advanceTimersByTime(550); });
  expect(hook.frame).toBe("/frame/med_b/8.0");
  await act(async () => { vi.advanceTimersByTime(550); });
  expect(hook.frame).toBe("/frame/med_b/24.8");
  await act(async () => { hook.onPointerLeave(); });
  expect(hook.frame).toBeUndefined();
});

it("flips through a video that was still importing at the first rest once its length is known", async () => {
  const media = vi.spyOn(api, "media").mockResolvedValue({ media: [{ id: "med_b", kind: "video" }] } as never);
  vi.spyOn(api, "frameUrl").mockImplementation((id: string, time: number) => `/frame/${id}/${time.toFixed(1)}`);
  await act(async () => root.render(<Probe id="prj_importing" />));
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(hook.frame).toBeUndefined();
  await act(async () => { hook.onPointerLeave(); });
  // The import finished: the next rest reads the video again and flips through it.
  media.mockResolvedValue({ media: [{ id: "med_b", kind: "video", duration: 100 }] } as never);
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(300); });
  await act(async () => { vi.advanceTimersByTime(550); });
  expect(hook.frame).toBe("/frame/med_b/8.0");
});

it("reads a card's frames from the engine that is running now, after it came back at another address", async () => {
  vi.spyOn(api, "media").mockResolvedValue({ media: [{ id: "med_b", kind: "video", duration: 100 }] } as never);
  vi.spyOn(api, "frameUrl").mockImplementation((id: string, time: number) => `http://old/frame/${id}/${time.toFixed(1)}`);
  await act(async () => root.render(<Probe id="prj_moved" />));
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(300); });
  await act(async () => { vi.advanceTimersByTime(550); });
  expect(hook.frame).toBe("http://old/frame/med_b/8.0");
  await act(async () => { hook.onPointerLeave(); });
  connectDesktopEngine("http://127.0.0.1:5999", "token");
  vi.spyOn(api, "media").mockResolvedValue({ media: [{ id: "med_b", kind: "video", duration: 100 }] } as never);
  vi.spyOn(api, "frameUrl").mockImplementation((id: string, time: number) => `http://new/frame/${id}/${time.toFixed(1)}`);
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(300); });
  await act(async () => { vi.advanceTimersByTime(550); });
  expect(hook.frame).toBe("http://new/frame/med_b/8.0");
});

it("keeps the poster for a card with no video", async () => {
  const media = vi.spyOn(api, "media");
  await act(async () => root.render(<Probe id="prj_2" hasVideo={false} />));
  await act(async () => { hook.onPointerEnter(); });
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(media).not.toHaveBeenCalled();
  expect(hook.frame).toBeUndefined();
});
