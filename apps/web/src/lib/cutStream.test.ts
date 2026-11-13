// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../stores/player";
import { joinClock } from "./joinClock";
import { openCutStream } from "./cutStream";
import { pauseForScrub, player } from "./player";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mediaFixture() {
  vi.useFakeTimers();
  const offsets: number[] = [];
  const remove = vi.fn((_start: number, _end: number) => queueMicrotask(() => buffer.dispatchEvent(new Event("updateend"))));
  const buffer = Object.assign(new EventTarget(), {
    timestampOffset: 0, appendWindowEnd: Infinity, updating: false, remove,
    appendBuffer() {
      offsets.push(buffer.timestampOffset);
      queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
    },
  });
  let media!: MockSource;
  class MockSource extends EventTarget {
    static isTypeSupported = () => true;
    addSourceBuffer = () => buffer;
    readyState = "open";
    endOfStream = vi.fn(() => { this.readyState = "ended"; });
    constructor() { super(); media = this; }
  }
  vi.stubGlobal("MediaSource", MockSource);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const video = document.createElement("video");
  video.muted = true;
  vi.spyOn(video, "paused", "get").mockReturnValue(false);
  vi.spyOn(video, "readyState", "get").mockReturnValue(1);
  return { video, buffer, offsets, remove, revoke, get media() { return media; } };
}

it("requests an unbuffered keyboard selection immediately and coalesces a moving pointer", async () => {
  const fixture = mediaFixture();
  vi.spyOn(fixture.video, "paused", "get").mockReturnValue(true);
  const ranges = Array.from({length: 10}, (_, i) => ({start: i * 10, end: (i + 1) * 10}));
  const load = vi.fn(async (_range: {start: number}) => new ArrayBuffer(1));
  const stream = openCutStream(fixture.video, ranges, 0, load, vi.fn());
  player.attach(fixture.video, { duration: 100, prepare() {}, seek: stream.seek, finishSeek: stream.finishSeek });
  try {
    fixture.media.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(0);
    load.mockClear();
    player.seek(32, true);
    expect(load.mock.calls.map(([r]) => r.start)).toEqual([30]);
    const gesture = new AbortController();
    const finish = pauseForScrub(gesture.signal);
    player.seek(12, true);
    player.seek(71, true);
    expect(load).toHaveBeenCalledTimes(1);
    gesture.abort();
    finish();
    expect(load.mock.calls.map(([r]) => r.start)).toEqual([30, 70]);
  } finally { player.detach(); stream.dispose(); }
});

it("prepares sections concurrently, appends in order, and discards stale work after a seek", async () => {
  const fixture = mediaFixture();
  const { video, offsets, remove, revoke } = fixture;
  const ranges = Array.from({ length: 180 }, (_, i) => ({ start: i * 10, end: i * 10 + 10 }));
  const bytes = new ArrayBuffer(1);
  let release!: (data: ArrayBuffer) => void;
  const load = vi.fn(async (range: { start: number }, _signal: AbortSignal) =>
    range.start === 1090 ? new Promise<ArrayBuffer>(resolve => { release = resolve; }) : bytes);
  const fail = vi.fn();
  const stream = openCutStream(video, ranges, 1078, load, fail);
  const { media } = fixture;
  media.dispatchEvent(new Event("sourceopen"));
  expect(load.mock.calls.map(([range]) => range.start)).toEqual([1070, 1080]);
  await vi.advanceTimersByTimeAsync(0);
  expect(video.currentTime).toBe(1078);
  expect(offsets).toEqual([1070, 1080]);
  expect(load.mock.calls.map(([range]) => range.start)).toEqual([1070, 1080, 1090, 1100, 1110]);
  const stale = load.mock.calls.find(([range]) => range.start === 1090)![1];

  video.currentTime = 1081;
  video.dispatchEvent(new Event("timeupdate"));
  expect(load.mock.lastCall?.[0].start).toBe(1120);
  stream.seek(1796);
  video.currentTime = 1796;
  expect(load.mock.lastCall?.[0].start).toBe(1120);
  stream.finishSeek();
  expect(load.mock.lastCall?.[0].start).toBe(1790);
  await vi.advanceTimersByTimeAsync(0);
  expect(stale.aborted).toBe(true);
  release(bytes);
  await vi.advanceTimersByTimeAsync(0);
  expect(offsets).toEqual([1070, 1080, 1790]);
  expect(remove.mock.calls.some(([start, end]) => start === 1070 && end > 1079.99 && end < 1080)).toBe(true);
  expect(media.endOfStream).toHaveBeenCalledOnce();
  expect(fail).not.toHaveBeenCalled();
  stream.dispose();
  expect(revoke).toHaveBeenCalledWith("blob:preview");
});

it.each([
  { previous: 32.5, next: 92.5, arrivesFirst: "old seek", stillSeeking: false },
  { previous: 92.5, next: 32.5, arrivesFirst: "new section", stillSeeking: false },
  { previous: 32.5, next: 92.5, arrivesFirst: "old seek", stillSeeking: true },
])("autoplays the next cut when the $arrivesFirst arrives first (still seeking: $stillSeeking)", async ({ previous, next, arrivesFirst, stillSeeking }) => {
  const fixture = mediaFixture();
  const { video, offsets } = fixture;
  vi.spyOn(video, "paused", "get").mockRestore(); // Let the real transport pause and start the element.
  const readiness = vi.spyOn(video, "readyState", "get").mockReturnValue(1);
  const seeking = vi.spyOn(video, "seeking", "get").mockReturnValue(false);
  const ranges = Array.from({ length: 30 }, (_, i) => ({ start: i * 4, end: (i + 1) * 4 }));
  const section = Math.floor(next / 4) * 4;
  const bytes = new ArrayBuffer(1);
  let supply!: (bytes: ArrayBuffer) => void;
  const destination = new Promise<ArrayBuffer>(resolve => { supply = resolve; });
  const load = vi.fn(async (range: { start: number }) => range.start === section ? destination : bytes);
  const stream = openCutStream(video, ranges, previous - 0.5, load, vi.fn());
  player.attach(video, { duration: 120, prepare() {}, seek: stream.seek, finishSeek: stream.finishSeek, sourceTime: stream.sourceTime });
  let endListen: (() => void) | undefined;
  try {
    fixture.media.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(0);
    readiness.mockReturnValue(3);
    // The outgoing cut sought its last frame. Its seeked event hasn't arrived when the editor approves it.
    player.seek(previous, true);
    seeking.mockReturnValue(true);
    video.dispatchEvent(new Event("seeking"));
    readiness.mockReturnValue(1);
    endListen = player.audition({ start: next, end: next + 7, skips: [] }, 30);
    expect(video.currentTime).toBe(next);
    expect(load).toHaveBeenCalledWith(ranges[section / 4], expect.anything());

    if (arrivesFirst === "new section") {
      supply(bytes);
      await vi.advanceTimersByTimeAsync(0);
      expect(offsets).toContain(section);
    }
    // WebKit briefly reported the new position, then reports the previous seek's buffered frame.
    video.currentTime = previous;
    seeking.mockReturnValue(stillSeeking);
    video.dispatchEvent(new Event(stillSeeking ? "seeking" : "seeked"));
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("waiting"));
    expect(usePlayerStore.getState().time).toBe(next);
    if (arrivesFirst === "old seek") supply(bytes);
    await vi.advanceTimersByTimeAsync(0);

    expect(offsets).toEqual(expect.arrayContaining([section, section + 4]));
    expect(video.currentTime).toBe(next);
    expect(video.paused).toBe(false);
    readiness.mockReturnValue(3);
    seeking.mockReturnValue(false);
    video.currentTime = next + 1 / 30;
    video.dispatchEvent(new Event("seeked"));
    expect(video.currentTime).toBe(next + 1 / 30);
    video.dispatchEvent(new Event("playing"));
    video.currentTime = next + 1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(usePlayerStore.getState().time).toBe(next + 1);
  } finally {
    endListen?.();
    player.detach();
    stream.dispose();
  }
});

it("keeps buffered sections until a seek across a cut lands, even when the next section arrives late", async () => {
  const fixture = mediaFixture();
  const { video, offsets, remove } = fixture;
  const ranges = Array.from({ length: 10 }, (_, i) => ({ start: i * 4, end: (i + 1) * 4 }));
  const bytes = new ArrayBuffer(1);
  let supplyTail!: (bytes: ArrayBuffer) => void;
  const tail = new Promise<ArrayBuffer>(resolve => { supplyTail = resolve; });
  const stream = openCutStream(video, ranges, 2, async range => range.start === 16 ? tail : bytes, vi.fn());
  try {
    fixture.media.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(0);
    expect(offsets).toEqual([0, 4, 8, 12]);

    // The join rounds to the end of a buffered section. The decoder still needs the next section to land there.
    const join = 16 - 1e-12;
    stream.seek(join);
    video.currentTime = join;
    const seeking = vi.spyOn(video, "seeking", "get").mockReturnValue(true);
    stream.finishSeek();
    video.dispatchEvent(new Event("waiting"));
    supplyTail(bytes);
    await vi.advanceTimersByTimeAsync(0);
    expect(offsets).toContain(16);
    expect(remove).not.toHaveBeenCalled();

    seeking.mockReturnValue(false);
    video.dispatchEvent(new Event("seeked"));
    await vi.advanceTimersByTimeAsync(0);
    // WebKit can timestamp the retained section's opening keyframe just before the declared seam.
    // Remove the preceding frame without touching that keyframe or its dependent frames.
    expect(remove.mock.calls.map(([start]) => start)).toEqual([0, 4]);
    for (const [start, end] of remove.mock.calls) {
      expect(end).toBeGreaterThan(start + 4 - 1 / 30);
      expect(end).toBeLessThan(start + 4 - 0.0001);
    }
  } finally { stream.dispose(); }
});

it("keeps the preceding fragment's tail when scrubbing back and evicting an upcoming fragment", async () => {
  const fixture = mediaFixture();
  const { video, remove, offsets } = fixture;
  const ranges = Array.from({ length: 12 }, (_, i) => ({ start: i * 4, end: (i + 1) * 4 }));
  const load = vi.fn(async () => new ArrayBuffer(1));
  const stream = openCutStream(video, ranges, 6, load, vi.fn());
  try {
    fixture.media.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(0);
    expect(offsets).toEqual([4, 8, 12, 16, 20]);

    // Moving back one section evicts the last lookahead fragment. At the exact seam WebKit
    // also discarded 216 ms from the preceding fragment, even after we reappended its neighbor.
    stream.seek(2);
    video.currentTime = 2;
    stream.finishSeek();
    await vi.advanceTimersByTimeAsync(0);
    expect(remove.mock.calls).toHaveLength(1);
    const [from, to] = remove.mock.calls[0]!;
    expect(from).toBeGreaterThan(20);
    expect(from).toBeLessThan(20 + 1 / 30);
    expect(to).toBeLessThan(24);

    video.currentTime = 6;
    video.dispatchEvent(new Event("timeupdate"));
    await vi.advanceTimersByTimeAsync(0);
    expect(offsets).toEqual([4, 8, 12, 16, 20, 0, 20]);
    expect(load).toHaveBeenCalledTimes(6);
  } finally { stream.dispose(); }
});

it.each([false, true])("retries the section needed to land a fractional seek, then reports a persistent failure (%s)", async persistent => {
  const fixture = mediaFixture();
  const { video, offsets } = fixture;
  const ranges = Array.from({ length: 8 }, (_, i) => ({ start: i * 4, end: (i + 1) * 4 }));
  let attempts = 0;
  let reject!: (error: Error) => void;
  const error = new Error("Section unavailable");
  const fail = vi.fn();
  const stream = openCutStream(video, ranges, 2, async range => {
    if (range.start === 16) {
      if (++attempts === 1) return new Promise<ArrayBuffer>((_, no) => { reject = no; });
      if (persistent) throw error;
    }
    return new ArrayBuffer(1);
  }, fail);
  try {
    fixture.media.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(0);
    const join = 16 - 1e-10;
    stream.seek(join);
    video.currentTime = join;
    vi.spyOn(video, "seeking", "get").mockReturnValue(true);
    stream.finishSeek();
    reject(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);
    if (persistent) {
      expect(fail.mock.calls).toEqual([[error]]);
    } else {
      expect(offsets).toContain(16);
      expect(fail).not.toHaveBeenCalled();
    }
  } finally { stream.dispose(); }
});

it("streams only the canonical sections intersecting the review and keeps its loop start buffered", async () => {
  const fixture = mediaFixture();
  const { video, buffer, offsets } = fixture;
  const ranges = Array.from({ length: 12 }, (_, i) => ({ start: i * 10, end: i * 10 + 10 }));
  const loop = { start: 32.5, end: 74.25 };
  const load = vi.fn(async () => new ArrayBuffer(1));
  const fail = vi.fn();
  const stream = openCutStream(video, ranges, loop.start, load, fail, loop);
  fixture.media.dispatchEvent(new Event("sourceopen"));
  await vi.advanceTimersByTimeAsync(0);
  expect(video.currentTime).toBe(loop.start);
  expect(buffer.appendWindowEnd).toBe(loop.end);
  expect(offsets).toEqual([30, 40, 50]);
  for (const time of [41, 51, 61, 71]) {
    video.currentTime = time;
    video.dispatchEvent(new Event("timeupdate"));
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(offsets).toEqual([30, 40, 50, 60, 70]);
  expect(buffer.remove.mock.calls.map(([start]) => start)).not.toContain(30);
  expect(fixture.media.endOfStream).toHaveBeenCalledOnce();
  expect(fail).not.toHaveBeenCalled();
  stream.dispose();
});

it("buffers the entire joined audition before starting and lets the editor cancel a cold replay", async () => {
  const fixture = mediaFixture();
  const { video } = fixture;
  vi.spyOn(video, "paused", "get").mockRestore();
  const ranges = Array.from({ length: 5 }, (_, i) => ({ start: i * 4, end: (i + 1) * 4 }));
  let supply!: (data: ArrayBuffer) => void;
  const late = new Promise<ArrayBuffer>(resolve => { supply = resolve; });
  const stream = openCutStream(video, ranges, 2, async range => range.start === 4 ? late : new ArrayBuffer(1), vi.fn());
  player.attach(video, { duration: 20, prepare() {}, seek: stream.seek, finishSeek: stream.finishSeek, bufferThrough: stream.bufferThrough });
  player.setJoins(video, joinClock([{ start: 4, end: 7 }], 23));
  const play = vi.spyOn(video, "play");
  const release = player.audition({ start: 2, end: 10, skips: [{ start: 4, end: 7, removed: true }] }, 30);
  try {
    fixture.media.dispatchEvent(new Event("sourceopen"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.offsets).toEqual([0]);
    // A pause event from the previous listen can arrive after this replay asked for its media.
    video.dispatchEvent(new Event("pause"));
    expect(play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playing).toBe(true);
    player.toggle();
    supply(new ArrayBuffer(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playing).toBe(false);
    player.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.offsets.slice(0, 2)).toEqual([0, 4]);
    expect(play).toHaveBeenCalledOnce();
  } finally {
    release();
    player.detach();
    stream.dispose();
  }
});

it("warms one adjacent section after settling and reuses recently visited sections", async () => {
  const fixture = mediaFixture();
  const { video, offsets } = fixture;
  vi.spyOn(video, "paused", "get").mockReturnValue(true);
  const ranges = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, end: (i + 1) * 10 }));
  const load = vi.fn(async (_range: { start: number }) => new ArrayBuffer(1));
  const stream = openCutStream(video, ranges, 2, load, vi.fn());
  fixture.media.dispatchEvent(new Event("sourceopen"));
  await vi.advanceTimersByTimeAsync(400);
  expect(offsets).toEqual([0]);
  const jump = async (time: number, wait: number) => {
    stream.seek(time);
    video.currentTime = time;
    await vi.advanceTimersByTimeAsync(wait);
  };
  await jump(72, 75);
  await vi.advanceTimersByTimeAsync(1000);
  expect(offsets).toEqual([0, 70, 80]);
  await jump(2, 0);
  await jump(82, 0);
  expect(offsets).toEqual([0, 70, 80, 0, 80]);
  expect(load.mock.calls.map(([range]) => range.start)).toEqual([0, 70, 80]);
  stream.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(3);
});

it("evicts old fragments by total bytes and retries failed idle work on demand", async () => {
  const fixture = mediaFixture();
  const { video } = fixture;
  vi.spyOn(video, "paused", "get").mockReturnValue(true);
  const ranges = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, end: (i + 1) * 10 }));
  const bytes = new ArrayBuffer(12 * 1024 * 1024);
  const load = vi.fn(async (range: { start: number }) => {
    if (range.start === 10 && load.mock.calls.length === 2) throw new Error("Unavailable");
    return bytes;
  });
  const fail = vi.fn();
  const stream = openCutStream(video, ranges, 0, load, fail);
  fixture.media.dispatchEvent(new Event("sourceopen"));
  await vi.advanceTimersByTimeAsync(1000);
  for (const time of [12, 52, 2]) {
    stream.seek(time);
    video.currentTime = time;
    await vi.advanceTimersByTimeAsync(75);
  }
  expect(load.mock.calls.map(([range]) => range.start)).toEqual([0, 10, 10, 50, 0]);
  expect(fail).not.toHaveBeenCalled();
  stream.dispose();
});

it("says the video is empty when there is nothing to play", () => {
  expect(() => openCutStream(document.createElement("video"), [], 0, async () => new ArrayBuffer(0), () => {})).toThrow("This video is empty.");
});
