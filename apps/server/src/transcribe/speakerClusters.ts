import type { SpeakerTurn } from "./speakerLabels.js";

type Sample = SpeakerTurn & { voice?: Float32Array };
type Core = { center: Float32Array; sum: Float32Array; count: number; seconds: number };

function dot(a: Float32Array, b: Float32Array) {
  let value = 0;
  for (let i = 0; i < a.length; i++) value += a[i]! * b[i]!;
  return value;
}
function unit(v: Float32Array) {
  const length = Math.sqrt(dot(v, v)) || 1;
  return v.map(x => x / length);
}

/** Compare clean excerpts across the entire recording. Local diarization alone
 * often splits a returning speaker as their volume or microphone angle changes. */
export function clusterExcerpts(samples: Sample[]): SpeakerTurn[] {
  const turns = samples.map(t => ({ ...t, voice: t.voice && unit(t.voice) })).sort((a, b) => a.start - b.start);
  const anchors = [];
  const blocked: SpeakerTurn[] = [];
  let first = 0;
  for (const t of turns) {
    // A turn with no length ends where it starts, so the scan can pass it and every turn after.
    while (first < turns.length && turns[first]!.end <= t.start) first++;
    let overlap = 0, until = t.start;
    for (let i = first; i < turns.length && turns[i]!.start < t.end; i++) {
      const u = turns[i]!;
      if (u === t) continue;
      const start = Math.max(until, u.start), end = Math.min(t.end, u.end);
      if (end > start) {
        overlap += end - start;
        if (u.start >= t.start) blocked.push({ start, end, speaker: -1 });
      }
      until = Math.max(until, end);
    }
    const duration = t.end - t.start;
    if (t.voice && duration >= 1 && overlap < .25 * duration) anchors.push({ voice: t.voice, duration });
  }
  anchors.sort((a, b) => Math.min(5, b.duration) - Math.min(5, a.duration));
  const cores: Core[] = [];
  for (const a of anchors) {
    let target: Core | undefined, best = .34;
    for (const c of cores) {
      const score = dot(a.voice, c.center);
      if (score > best) { best = score; target = c; }
    }
    if (!target) {
      cores.push({ center: a.voice, sum: a.voice.slice(), count: 1, seconds: a.duration });
    } else {
      for (let i = 0; i < a.voice.length; i++) target.sum[i] = target.sum[i]! + a.voice[i]!;
      target.center = unit(target.sum);
      target.count++;
      target.seconds += a.duration;
    }
  }
  const duration = turns.at(-1)?.end ?? 0;
  const established = cores.filter(c => duration > 120
    ? c.count >= 2 && c.seconds >= Math.min(20, Math.max(4, duration * .004))
    : c.count >= 2 || c.seconds >= 3.5 || cores.length === 1);
  const labeled = turns.map(t => {
    let speaker = -1, best = -Infinity, runnerUp = -Infinity;
    if (t.voice) for (const [i, core] of established.entries()) {
      const score = dot(t.voice, core.center);
      if (score > best) { runnerUp = best; best = score; speaker = i; }
      else runnerUp = Math.max(runnerUp, score);
    }
    return { start: t.start, end: t.end, speaker: best >= .29 && best - runnerUp >= .065 ? speaker : -1 };
  });
  return [...labeled, ...blocked].sort((a, b) => a.start - b.start);
}
