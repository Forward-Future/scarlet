import { describe, expect, it } from "vitest";
import { analyzeMusic, SAMPLE_RATE } from "./musicBeats.js";

/**
 * Clicks at a known tempo: a low kick on the first beat of each bar and a short high tick on the others, over a little
 * noise. `gain(t)` scales the whole mix, for sections that step or rise.
 */
function clicks({ bpm, beatsPerBar, seconds, first = 0.25, gain = () => 1, seed = 1 }:
  { bpm: number; beatsPerBar: number; seconds: number; first?: number; gain?: (t: number) => number; seed?: number }) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const random = noiseSource(seed);
  const noise = () => (random() - 0.5) * 0.01;
  for (let i = 0; i < samples.length; i++) samples[i] = noise();
  const beats: number[] = [];
  for (let k = 0, t = first; t < seconds - 0.2; k++, t = first + k * 60 / bpm) {
    beats.push(t);
    const down = k % beatsPerBar === 0;
    const start = Math.round(t * SAMPLE_RATE);
    for (let j = 0; j < 0.25 * SAMPLE_RATE && start + j < samples.length; j++) {
      const s = j / SAMPLE_RATE;
      const sound = down ? 0.8 * Math.sin(2 * Math.PI * 60 * s) * Math.exp(-s / 0.08) + 0.3 * Math.sin(2 * Math.PI * 2000 * s) * Math.exp(-s / 0.01)
        : 0.4 * Math.sin(2 * Math.PI * 2000 * s) * Math.exp(-s / 0.01);
      samples[start + j]! += sound * gain(t + s);
    }
  }
  return { samples, beats };
}

/** Uniform noise in 0..1 (xorshift32): no period a beat reader could take for a tempo. */
function noiseSource(seed: number) {
  let x = seed | 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 2 ** 32; };
}

/** The reading's beat nearest each true beat, and how far off it is. */
function errors(found: number[], truth: number[]) {
  return truth.map(t => Math.min(...found.map(f => Math.abs(f - t))));
}

describe("analyzeMusic", () => {
  it("reads 120 BPM clicks in four: tempo, every beat to about a hundredth of a second, and the bars", () => {
    const { samples, beats } = clicks({ bpm: 120, beatsPerBar: 4, seconds: 30 });
    const reading = analyzeMusic(samples);
    expect(reading.tempo).toMatchObject({ bpm: expect.closeTo(120, 0) });
    expect((reading.tempo as { confidence: number }).confidence).toBeGreaterThan(0.3);
    expect(reading.beatSeconds).toBeCloseTo(0.5, 2);
    expect(reading.beats.length).toBeGreaterThanOrEqual(beats.length - 1);
    expect(Math.max(...errors(reading.beats, beats))).toBeLessThan(0.015);
    expect(reading.meter).toMatchObject({ beatsPerBar: 4 });
    const bars = beats.filter((_, k) => k % 4 === 0);
    expect(Math.max(...errors(reading.downbeats!, bars))).toBeLessThan(0.015);
    expect(reading.downbeats!.length).toBeGreaterThanOrEqual(bars.length - 1);
  });

  it("reads a waltz in three at 90 BPM, starting later in the file", () => {
    const { samples, beats } = clicks({ bpm: 90, beatsPerBar: 3, seconds: 30, first: 0.6, seed: 7 });
    const reading = analyzeMusic(samples, 100);
    expect((reading.tempo as { bpm: number }).bpm).toBeCloseTo(90, 0);
    expect(reading.from).toBe(100);
    expect(Math.max(...errors(reading.beats, beats.map(t => t + 100)))).toBeLessThan(0.015);
    expect(reading.meter).toMatchObject({ beatsPerBar: 3 });
    expect(Math.max(...errors(reading.downbeats!, beats.filter((_, k) => k % 3 === 0).map(t => t + 100)))).toBeLessThan(0.015);
  });

  it("finds where the level steps up on the bar, and a build that rises", () => {
    // Quiet for eight bars, a rise over the next four, then full: a build and a drop.
    const gain = (t: number) => t < 16.25 ? 0.1 : t < 24.25 ? 0.1 + 0.4 * (t - 16.25) / 8 : 1;
    const { samples } = clicks({ bpm: 120, beatsPerBar: 4, seconds: 40, gain });
    const { sections } = analyzeMusic(samples);
    const step = sections.find(s => (s.jumpDb ?? 0) > 3 && s.start > 20)!;
    expect(step.start).toBeCloseTo(24.25, 1);
    const before = sections.filter(s => s.end <= step.start);
    expect(before.at(-1)!.changeDb).toBeGreaterThan(3);
    expect(step.levelDb).toBeGreaterThan(sections[0]!.levelDb + 10);
  });

  it("says there is no beat in steady noise, and still gives its level", () => {
    const random = noiseSource(3);
    const samples = Float32Array.from({ length: 20 * SAMPLE_RATE }, () => (random() - 0.5) * 0.2);
    const reading = analyzeMusic(samples);
    expect(reading.tempo).toHaveProperty("unclear");
    expect(reading.beats).toEqual([]);
    expect(reading.sections).toHaveLength(1);
    expect(reading.levels.db.length).toBe(40);
  });
});
