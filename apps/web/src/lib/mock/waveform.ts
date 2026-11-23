import samples from "./sample-waveform.json";

/** Peaks and loudness of the demo's sample video over [from, to), in `points` windows. */
export function sampleWaveform(mediaId: string, from: number, to: number, points: number) {
  // Measured from the demo MP4 in 20 ms windows, after AAC encoding.
  const peaks: number[] = [];
  const rms: number[] = [];
  for (let i = 0; i < points; i++) {
    const lo = Math.max(0, Math.floor((from + (to - from) * i / points) * samples.pointsPerSecond));
    const hi = Math.min(samples.peaks.length, Math.ceil((from + (to - from) * (i + 1) / points) * samples.pointsPerSecond));
    let peak = 0;
    let energy = 0;
    for (let n = lo; n < hi; n++) {
      peak = Math.max(peak, samples.peaks[n]!);
      energy += samples.rms[n]! ** 2;
    }
    peaks.push(peak);
    rms.push(hi > lo ? Math.sqrt(energy / (hi - lo)) : 0);
  }
  return { mediaId, from, to, peaks, rms };
}
