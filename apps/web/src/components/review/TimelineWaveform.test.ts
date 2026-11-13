// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { waveformBars, waveformScale } from "./TimelineWaveform";

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
