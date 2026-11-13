// @vitest-environment happy-dom
// Run from apps/web with pnpm exec vitest bench --run bench/timeline.bench.tsx.
import { bench, describe, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { layoutMarks, PlayerTimeline } from "../src/components/review/TimelineScrubber";
import { usePlayerStore } from "../src/stores/player";
import { renderToString } from "react-dom/server";
import { Change, emptyTimeline, makeMediaClip, makeTrack, type MediaAsset } from "@scarlet/timeline";
import { changeEdits } from "@scarlet/shared";
import { TimelineWaveform } from "../src/components/review/TimelineWaveform";
import { originalClipAt } from "../src/components/review/thumbs";

const media: MediaAsset[] = [{ id: "video", kind: "video", name: "video", path: "video.mp4" }];
const count = 1800;
const track = makeTrack("video", "dialogue");
track.clips = Array.from({ length: count }, (_, i) => makeMediaClip("video", i * 3, i * 3 + 2, i * 2));
const timeline = { ...emptyTimeline("benchmark"), tracks: [track] };
const duration = 2 * count;
const options = { time: 600, iterations: 5 };
describe("reviewing a long dialogue pass", () => {
  const cutReasons = Array.from({ length: 1500 }, (_, i) => ({ start: 4 * i + 2, end: 4 * i + 3, reason: "Shorten pause" }));
  const change = Change.parse({
    id: "pass", projectId: "benchmark", fromVersion: "before", toVersion: "after", state: "approved",
    description: "Tighten dialogue", author: { type: "agent", name: "Scarlet" }, createdAt: "2026-01-01T00:00:00Z",
    cutReasons, ops: cutReasons.map(({ start, end }) => ({ op: "rippleDelete", start, end })).reverse(),
    timelineEdits: cutReasons.map((_, i) => ({ label: "Shorten pause", range: { start: 3 * i + 1.5, end: 3 * i + 2.5 } })),
  });
  bench("build the review list for 1,500 named cuts", () => {
    if (changeEdits(change).length !== cutReasons.length) throw new Error("Missing edit");
  }, options);
});

describe("one hour of dialogue with 1,800 two-second clips", () => {
  bench("initial original-comparison waveform layout, including cold clip lookup", () => {
    const snapshot = { ...timeline };
    renderToString(<TimelineWaveform timeline={snapshot} media={media} original start={0} duration={duration} />);
  }, options);
  bench("128 random original footage seeks on one immutable edit", () => {
    for (let i = 0; i < 128; i++) {
      if (!originalClipAt(timeline, (i * 7919) % duration, media)) throw new Error("Missing clip");
    }
  }, options);
});

describe("timeline input and playback clock, 800px review rail", () => {
  let root: Root;
  const container = document.createElement("div");
  const bounds = new DOMRect(0, 0, 800, 60);
  let seeks = 0;
  let hoverDelay: number | undefined;
  function setup() {
    seeks = 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(bounds.width);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(bounds);
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(<PlayerTimeline duration={duration} waveform={{ timeline, media: [] }} reviewing
      frameAt={() => { hoverDelay ??= Date.now(); return undefined; }} onSeek={() => { seeks++; }} />));
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    Object.defineProperty(slider, "setPointerCapture", { value() {} });
    const point = (type: string, x: number) => slider.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1, clientX: x,
    }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      // Fix the simulated display cadence independently of happy-dom's host load.
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 16 - Date.now() % 16));
      vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
      hoverDelay = undefined;
      point("pointermove", 400);
      vi.advanceTimersByTime(200);
      point("pointerdown", 0);
      for (let i = 1; i <= 240; i++) {
        point("pointermove", i);
        vi.advanceTimersByTime(4);
      }
      point("pointerup", 241);
      console.log(`First hover request at ${hoverDelay} ms. Decoder seeks for down + 240 moves at 250 Hz + release: ${seeks}.`);
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  }
  function teardown() {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  }
  bench("60 playback clock updates through the mounted timeline", () => {
    for (let i = 0; i < 60; i++) flushSync(() => usePlayerStore.getState().setTime(i / 60));
    if (!container.querySelector('[aria-valuenow="0.9833333333333333"]')) throw new Error("Playback did not advance");
  }, { ...options, setup, teardown });
});

describe("a densely edited timeline", () => {
  const dots = Array.from({ length: 1800 }, (_, i) => ({ time: 100 + i / 1000, n: i + 1, title: "" }));
  bench("group 1,800 nearby markers on the hour-long timeline", () => {
    if (layoutMarks(dots, 0, duration, 800)[0]?.label !== "1–1800") throw new Error("Missing grouped markers");
  }, options);
  const gaps = Array.from({ length: 360 }, (_, i) => ({
    start: i * 10, end: i * 10 + 2, title: "Other cut", label: "Cut by Edit 2", shortLabel: "Edit 2", skipped: true,
  }));
  const container = document.createElement("div");
  let root: Root;
  bench("60 playback clock updates with 360 cut gaps visible", () => {
    for (let i = 0; i < 60; i++) flushSync(() => usePlayerStore.getState().setTime(i / 60));
    if (!container.querySelector('[aria-valuenow="0.9833333333333333"]')) throw new Error("Playback did not advance");
  }, {
    ...options,
    setup() {
      root = createRoot(container);
      flushSync(() => root.render(<PlayerTimeline duration={duration} gaps={gaps} frameAt={() => undefined} onSeek={() => {}} onGap={() => {}} />));
      if (container.querySelectorAll(".simple-timeline-gap").length !== gaps.length) throw new Error("Missing cut gaps");
    },
    teardown() { root.unmount(); },
  });
});
