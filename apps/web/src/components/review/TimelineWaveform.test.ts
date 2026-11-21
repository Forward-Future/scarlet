// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { api } from "../../lib/client";
import { sourcePeaks, waveformBars, waveformScale } from "./TimelineWaveform";

it("projects clipped, retimed source peaks into the selected window with gain, fades and gaps", () => {
  const wave = { mediaId: "take", from: 3, to: 7, peaks: [1, .5, .25, .75], rms: [.5, .25, 0, .5] };
  const clip = { id: "take", start: 10, end: 12, sourceIn: 3, speed: 2, gain: .5, fadeIn: .5, fadeOut: .5 };
  const { peaks, rms } = waveformBars([clip], new Map([["take", wave]]), 9.5, 3, 6);
  expect([...peaks]).toEqual([0, .25, .25, .125, .1875, 0]);
  expect([...rms]).toEqual([0, .125, .125, 0, .125, 0]);
});

it("keeps a cut inside one pixel from creating an artificial spike", () => {
  const wave = { mediaId: "take", from: 0, to: 1, peaks: [.5], rms: [.25] };
  const span = { id: "take", start: 0, end: .5, sourceIn: 0, speed: 1, gain: 1, fadeIn: 0, fadeOut: 0 };
  const waves = new Map([["take", wave]]);
  const { peaks, rms } = waveformBars([span, { ...span, start: .5, end: 1 }], waves, 0, 1, 1);
  expect([...peaks]).toEqual([.5]);
  expect([...rms]).toEqual([.25]);
  expect([...waveformBars([span, { ...span, start: .25, end: 1 }], waves, 0, 1, 1).peaks]).toEqual([1]);
});

it("draws Before and After on one scale, so a level change shows as a change in height", () => {
  const wave = { mediaId: "take", from: 0, to: 2, peaks: [.6, .6], rms: [.3, .3] };
  const span = { id: "take", start: 0, end: 2, sourceIn: 0, speed: 1, gain: 1, fadeIn: 0, fadeOut: 0 };
  const waves = new Map([["take", wave]]);
  const after = waveformBars([span], waves, 0, 2, 2).peaks;
  const before = waveformBars([{ ...span, gain: .5 }], waves, 0, 2, 2).peaks;
  // On its own, each side fills the lane and the 6 dB difference disappears.
  expect(before[0]! * waveformScale(before)).toBeCloseTo(after[0]! * waveformScale(after));
  // Sharing the louder side's scale, Before draws at half the height.
  expect(before[0]! * waveformScale(before, after)).toBeCloseTo(after[0]! * waveformScale(after, before) / 2);
  expect(waveformScale(new Float32Array([.01]))).toBe(46 / .25);
});

it("answers a window from one read already that holds it as finely, and reads again only when it can't", async () => {
  // The engine's answer: one bucket per hundredth of a second, each the time it starts at.
  const read = vi.spyOn(api, "waveform").mockImplementation(async (mediaId, from, to, points = 1000) => ({
    mediaId, from, to, peaks: Array.from({ length: points }, (_, i) => from + i * (to - from) / points),
    rms: Array.from({ length: points }, () => .5) }));
  try {
    const whole = await sourcePeaks("wave_take", 10, 40);
    expect(whole.peaks).toHaveLength(3000);
    // Zoomed in: the same buckets, from the read that holds them.
    const part = await sourcePeaks("wave_take", 12.5, 20.25);
    expect(read).toHaveBeenCalledOnce();
    expect(part).toMatchObject({ from: 12.5, to: 20.25 });
    expect(part.peaks).toHaveLength(775);
    expect(part.peaks[0]).toBeCloseTo(12.5);
    expect(part.rms).toHaveLength(775);
    // Outside it, or finer than it was read, is read anew.
    await sourcePeaks("wave_take", 35, 45);
    await sourcePeaks("wave_other", 12.5, 20.25);
    expect(read).toHaveBeenCalledTimes(3);
    const wide = await sourcePeaks("wave_take", 0, 600);
    expect(wide.peaks).toHaveLength(8192);
    await sourcePeaks("wave_take", 100, 110);
    expect(read).toHaveBeenCalledTimes(5);
    // A new working cut's window, a little shorter than the whole read, asks for nothing either.
    const cut = await sourcePeaks("wave_take", 2, 560);
    expect(read).toHaveBeenCalledTimes(5);
    expect(cut).toMatchObject({ mediaId: "wave_take" });
    expect(cut.from).toBeLessThanOrEqual(2);
    expect(cut.to).toBeGreaterThanOrEqual(560);
    // Back out to a window seen before reads nothing. The windows used last are the ones kept.
    for (let i = 0; i < 20; i++) await sourcePeaks("wave_take", 200 + i, 201 + i);
    read.mockClear();
    await sourcePeaks("wave_take", 0, 600);
    for (let i = 0; i < 20; i++) await sourcePeaks("wave_take", 300 + i, 301 + i);
    await sourcePeaks("wave_take", 0, 600);
    expect(read).toHaveBeenCalledTimes(20);
    expect(read.mock.calls.some(([, from, to]) => from === 0 && to === 600)).toBe(false);
  } finally {
    read.mockRestore();
  }
});
