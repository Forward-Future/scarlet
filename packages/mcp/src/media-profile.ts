/**
 * Cheap whole-recording measurements for one media asset: room tone, speech level, pause
 * statistics and repeated clauses that may be retakes. Evidence only; the model decides what a
 * pause or a repeat means.
 */
import type { TranscriptWord } from "@scarlet/timeline";
import { normalizeTranscriptToken, sequenceSimilarity } from "@scarlet/shared";

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]! : undefined;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Room tone and speech level in dBFS (RMS). Buckets away from every transcript word are
 * non-speech; their 25th percentile is the room floor, which skips breaths and handling noise.
 * Without words, the 10th percentile of every bucket stands in for the floor.
 */
export function levelProfile(reading: { from: number; to: number; rms: number[] }, words: TranscriptWord[] | null) {
  const n = reading.rms.length;
  if (!n) return {};
  const step = (reading.to - reading.from) / n;
  const toDb = (r: number) => Math.max(-99, 20 * Math.log10(r + 1e-7));
  const sorted = words ? [...words].sort((a, b) => a.start - b.start) : [];
  const speech: number[] = [], quiet: number[] = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    const s = reading.from + i * step, e = s + step;
    while (w < sorted.length && sorted[w]!.end + .15 < s) w++;
    const spoken = sorted.slice(w, w + 4).some(x => x.start - .15 < e && x.end + .15 > s);
    (spoken ? speech : quiet).push(toDb(reading.rms[i]!));
  }
  speech.sort((a, b) => a - b);
  quiet.sort((a, b) => a - b);
  const all = reading.rms.map(toDb).sort((a, b) => a - b);
  const floor = words && quiet.length >= 10 ? percentile(quiet, .25) : percentile(all, .1);
  const voice = words && speech.length ? percentile(speech, .5) : percentile(all, .9);
  return {
    roomToneDbfs: floor !== undefined ? Math.round(floor) : undefined,
    speechDbfs: voice !== undefined ? Math.round(voice) : undefined,
    resolution: round2(step),
  };
}

/** Pauses between consecutive words, per speaker: median and 90th percentile of gaps from 0.15 to 3 s. */
export function pauseStats(words: TranscriptWord[]) {
  const sorted = [...words].filter(w => w.end > w.start).sort((a, b) => a.start - b.start);
  const by = new Map<string, number[]>();
  const long = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!, b = sorted[i]!;
    const speaker = b.speaker ?? "all";
    if ((a.speaker ?? "all") !== speaker) continue; // a handoff is not a pause in one voice
    const gap = b.start - a.end;
    if (gap > 3) long.set(speaker, (long.get(speaker) ?? 0) + 1);
    else if (gap >= .15) {
      const gaps = by.get(speaker);
      if (gaps) gaps.push(gap);
      else by.set(speaker, [gap]);
    }
  }
  return [...new Set([...by.keys(), ...long.keys()])].map(speaker => {
    const gaps = (by.get(speaker) ?? []).sort((a, b) => a - b);
    return { speaker, pauses: gaps.length, median: round2(percentile(gaps, .5) ?? 0), p90: round2(percentile(gaps, .9) ?? 0),
      over3s: long.get(speaker) ?? 0 };
  });
}

export interface Clause { from: number; to: number; start: number; end: number; text: string; tokens: string[] }

/** Split words into clauses at sentence ends and pauses of 0.5 s or more. `from`/`to` are word indices. */
export function clauses(words: TranscriptWord[]): Clause[] {
  const out: Clause[] = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!, next = words[i + 1];
    if (!next || /[.?!]["”’)]*$/.test(w.text.trim()) || next.start - w.end >= .5 || (next.speaker ?? "") !== (w.speaker ?? "")) {
      const span = words.slice(first, i + 1);
      const tokens = span.map(x => normalizeTranscriptToken(x.text)).filter(Boolean);
      if (tokens.length) out.push({ from: first, to: i, start: span[0]!.start, end: w.end, text: span.map(x => x.text.trim()).join(" "), tokens });
      first = i + 1;
    }
  }
  return out;
}

/**
 * Nearby clauses whose words closely repeat: candidate retakes and false starts. A clause that
 * restarts the next one ("So today we" / "So today we're going to…") scores by containment.
 * Evidence only: deliberate repetition and callbacks look the same.
 */
export function retakeGroups(words: TranscriptWord[], opts: { window?: number; minScore?: number; limit?: number } = {}) {
  const { window = 90, minScore = .6, limit = 30 } = opts;
  const list = clauses(words);
  const pairs: Array<{ a: number; b: number; score: number }> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j]!.start - list[i]!.end <= window; j++) {
      const a = list[i]!, b = list[j]!;
      if (Math.min(a.tokens.length, b.tokens.length) < 3) continue;
      const dice = sequenceSimilarity(a.tokens, b.tokens);
      // A restart: the shorter clause is (almost) a prefix of the longer one.
      const short = a.tokens.length <= b.tokens.length ? a.tokens : b.tokens, long = short === a.tokens ? b.tokens : a.tokens;
      const prefix = sequenceSimilarity(short, long.slice(0, short.length));
      // Three-word restarts ("so if we") match too much by containment alone.
      const score = Math.max(dice, short.length >= 4 ? prefix * .95 : 0);
      if (score >= minScore) pairs.push({ a: i, b: j, score });
    }
  }
  // Join overlapping pairs into groups, so three attempts at one line read as one group.
  const group = list.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
  for (const p of pairs) group[find(p.b)] = find(p.a);
  const groups = new Map<number, { members: Set<number>; score: number }>();
  for (const p of pairs) {
    const root = find(p.a);
    const g = groups.get(root) ?? { members: new Set<number>(), score: 0 };
    g.members.add(p.a).add(p.b);
    g.score = Math.max(g.score, p.score);
    groups.set(root, g);
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map(g => ({ score: round2(g.score), takes: [...g.members].sort((a, b) => a - b).map(i => {
      const c = list[i]!;
      return { words: [c.from, c.to], start: round2(c.start), end: round2(c.end), text: c.text.length > 140 ? c.text.slice(0, 139) + "…" : c.text };
    }) }))
    .sort((a, b) => a.takes[0]!.start - b.takes[0]!.start);
}
