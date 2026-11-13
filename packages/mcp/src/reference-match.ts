/**
 * Where a finished video's speech came from in the recordings it was cut from.
 *
 * Both sides are word-timed transcripts. A stretch of the finished video that plays one continuous piece of a
 * recording has the same words at a constant time offset, so the match is by text and by time together: the same
 * line said twice (a retake) has the same words, and only the take that was used keeps the offset from word to word.
 * Everything here is measurement: which piece plays where, what was left out between two pieces, how long the pause
 * across a join is. What a removal was (a filler, a retake, a tangent) is the model's call.
 */
import { round3 } from "./analysis.js";

export const REFERENCE_MATCH_VERSION = 2;

export interface MatchWord { text: string; start: number; end: number }
export interface MatchSource { mediaId: string; words: readonly MatchWord[] }

/** A continuous piece of one recording as it plays in the finished video. Word numbers are transcript indices. */
export interface Stretch {
  mediaId: string;
  finalStart: number; finalEnd: number;
  sourceStart: number; sourceEnd: number;
  finalWords: [number, number];
  sourceWords: [number, number];
}

/** Speech in the finished video that none of the recordings has: added narration, or words heard differently. */
export interface Unmatched { finalStart: number; finalEnd: number; finalWords: [number, number]; text: string }

export interface Join {
  /** Finished-video seconds: the end of the last word before the join and the start of the first after it. */
  finalOut: number; finalIn: number;
  from: { mediaId: string; time: number; word: number };
  to: { mediaId: string; time: number; word: number };
  /** forward: later in the same recording. back: earlier in it. switch: another recording. */
  kind: "forward" | "back" | "switch";
  /** forward only: recording seconds between the two words, less the pause the finished video has there. */
  removedSeconds?: number;
  /** forward only: the words of the recording left out between the two, and how many. */
  removedWords?: number;
  removedText?: string;
  /** Speech of the finished video between the two pieces that no recording has, when there is any. */
  unmatched?: string;
}

export interface UnusedRange { mediaId: string; sourceStart: number; sourceEnd: number; sourceWords: [number, number]; words: number; text: string }

export interface ReferenceMatch {
  /** Recording seconds per finished second. 1 unless the finished video was retimed. */
  rate: number;
  finalWords: number;
  matchedWords: number;
  stretches: Stretch[];
  joins: Join[];
  unmatched: Unmatched[];
  /** Stretches of each recording's speech that the finished video does not play, in recording order. */
  unused: UnusedRange[];
}

/** Offsets within this many seconds belong to one continuous piece: word times are good to a few hundredths. */
const OFFSET_TOLERANCE = 0.12;
/** This many words in doubt before two in a row keep the offset again, and the audio has moved. */
const OUTLIER_RUN = 3;
/** Words a re-sync may skip on either side when the two transcripts heard a passage differently. */
const RESYNC = 3;
const GRAM = 3;
const MAX_CANDIDATES = 400;
const TEXT_WORDS = 24;

const token = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

interface Side { tokens: string[]; index: number[]; words: readonly MatchWord[] }

/** Words with something to compare. `index` maps a token back to its transcript word. */
function side(words: readonly MatchWord[]): Side {
  const tokens: string[] = [], index: number[] = [];
  words.forEach((w, i) => {
    const t = token(w.text);
    if (t) { tokens.push(t); index.push(i); }
  });
  return { tokens, index, words };
}

interface Run { source: number; pairs: Array<[number, number]>; offset: number }

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function excerpt(words: readonly MatchWord[], from: number, to: number): string {
  const all = words.slice(from, to + 1).map(w => w.text.trim()).filter(Boolean);
  if (all.length <= TEXT_WORDS) return all.join(" ");
  const half = TEXT_WORDS / 2;
  return `${all.slice(0, half).join(" ")} … ${all.slice(-half).join(" ")}`;
}

/**
 * Follow the two transcripts forward from a place where they agree. With `rate`, a word only counts while its time
 * keeps the piece's offset; without, the text alone decides (used once, to measure the rate).
 */
function extend(final: Side, src: Side, source: number, a0: number, b0: number, rate: number | undefined): Run {
  const at = (a: number, b: number) => src.words[src.index[b]!]!.start - (rate ?? 1) * final.words[final.index[a]!]!.start;
  const pairs: Array<[number, number]> = [];
  const offsets: number[] = [];
  let a = a0, b = b0;
  let offset = at(a0, b0);
  // `solid` pairs are proven. A word whose time is off stays in doubt until two in a row keep the offset again.
  let solid = 0, doubts = 0, streak = 0;
  const keeps = (off: number) => {
    offsets.push(off);
    if (rate !== undefined && offsets.length >= 3) offset = median(offsets.slice(-9));
    streak++;
    if (!doubts || streak >= 2) { doubts = 0; solid = pairs.length + 1; }
  };
  for (;;) {
    if (a >= final.tokens.length || b >= src.tokens.length) break;
    if (final.tokens[a] === src.tokens[b]) {
      const off = at(a, b);
      if (rate === undefined || Math.abs(off - offset) <= OFFSET_TOLERANCE) keeps(off);
      else {
        streak = 0;
        // The offset has moved for good: the piece ended at the last proven word.
        if (++doubts >= OUTLIER_RUN) break;
      }
      pairs.push([a, b]);
      a++; b++;
      continue;
    }
    let found: [number, number] | undefined;
    for (let total = 1; total <= RESYNC * 2 && !found; total++) {
      for (let x = Math.max(0, total - RESYNC); x <= Math.min(RESYNC, total); x++) {
        const y = total - x;
        const fa = a + x, sb = b + y;
        if (fa + 1 >= final.tokens.length || sb + 1 >= src.tokens.length) continue;
        if (final.tokens[fa] !== src.tokens[sb] || final.tokens[fa + 1] !== src.tokens[sb + 1]) continue;
        if (rate !== undefined && Math.abs(at(fa, sb) - offset) > OFFSET_TOLERANCE) continue;
        found = [fa, sb];
        break;
      }
    }
    if (!found) break;
    [a, b] = found;
  }
  pairs.length = Math.min(pairs.length, solid);
  return { source, pairs, offset };
}

function align(final: Side, sources: Side[], rate: number | undefined): Run[] {
  const grams = sources.map(src => {
    const map = new Map<string, number[]>();
    for (let b = 0; b + GRAM <= src.tokens.length; b++) {
      const key = src.tokens.slice(b, b + GRAM).join(" ");
      const list = map.get(key);
      if (list) list.push(b); else map.set(key, [b]);
    }
    return map;
  });
  const runs: Run[] = [];
  let a = 0;
  while (a < final.tokens.length) {
    const prev = runs.at(-1);
    const next = prev ? prev.pairs.at(-1)![1] + 1 : 0;
    // Distance from where the last piece stopped: carrying on in the same recording comes first.
    const distance = (source: number, b: number) => prev && source === prev.source ? (b >= next ? b - next : (next - b) + 1e6) : 2e6 + b;
    const candidates: Array<[number, number]> = [];
    if (a + GRAM <= final.tokens.length) {
      const key = final.tokens.slice(a, a + GRAM).join(" ");
      grams.forEach((map, source) => { for (const b of map.get(key) ?? []) candidates.push([source, b]); });
    }
    candidates.sort((p, q) => distance(...p) - distance(...q));
    let best: Run | undefined;
    for (const [source, b] of candidates.slice(0, MAX_CANDIDATES)) {
      const run = extend(final, sources[source]!, source, a, b, rate);
      if (!best || run.pairs.length > best.pairs.length) best = run;
    }
    // Three common words can agree anywhere. A short run counts only as the next thing said in the same recording.
    const near = best && prev && best.source === prev.source && best.pairs[0]![1] >= next && best.pairs[0]![1] - next < 200;
    if (best && (best.pairs.length >= 5 || (near && best.pairs.length >= GRAM))) {
      runs.push(best);
      a = best.pairs.at(-1)![0] + 1;
    } else a++;
  }
  return runs;
}

/** Recording seconds per finished second, from how far apart neighbouring words are on each side. */
function measureRate(final: Side, sources: Side[], runs: Run[]): number {
  const ratios: number[] = [];
  for (const run of runs) {
    const src = sources[run.source]!;
    // In a tightly edited video an eight-word span often crosses a cut even when every word is kept.
    // Measure shorter, consecutive phrases. Skip any span where the text matcher jumped over words.
    const span = 3;
    for (let i = span; i < run.pairs.length; i += span) {
      const [a0, b0] = run.pairs[i - span]!, [a1, b1] = run.pairs[i]!;
      if (a1 - a0 !== span || b1 - b0 !== span) continue;
      const f = final.words[final.index[a1]!]!.start - final.words[final.index[a0]!]!.start;
      const s = src.words[src.index[b1]!]!.start - src.words[src.index[b0]!]!.start;
      // A cut inside the span changes one side only; the median ignores those.
      if (f > 0.5 && s > 0) ratios.push(s / f);
    }
  }
  if (ratios.length < 5) return 1;
  const rate = median(ratios);
  return Math.abs(rate - 1) < 0.02 ? 1 : Math.round(rate * 1000) / 1000;
}

export function matchReference(finalWords: readonly MatchWord[], sourceList: readonly MatchSource[]): ReferenceMatch {
  const final = side(finalWords);
  const sources = sourceList.map(s => side(s.words));
  const rate = measureRate(final, sources, align(final, sources, undefined));
  const runs = align(final, sources, rate);

  // Two runs with the same offset are one piece that the transcripts heard differently in the middle.
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged.at(-1);
    if (prev && prev.source === run.source && run.pairs[0]![1] > prev.pairs.at(-1)![1] && Math.abs(run.offset - prev.offset) <= OFFSET_TOLERANCE) {
      prev.pairs.push(...run.pairs);
    } else merged.push({ ...run, pairs: [...run.pairs] });
  }

  // A retake is usually cut from where the first take starts to where the next one does, so the take that plays starts
  // at the very offset the first one had, and the piece before it ran on into the first take's words for as long as the
  // two deliveries kept time. Each of those words belongs to the piece whose own offset it fits better.
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1]!, next = merged[i]!;
    if (prev.source !== next.source) continue;
    const src = sources[next.source]!;
    const off = (a: number, b: number) => src.words[src.index[b]!]!.start - rate * final.words[final.index[a]!]!.start;
    while (prev.pairs.length > 1) {
      const [a, was] = prev.pairs.at(-1)!, [a0, b0] = next.pairs[0]!;
      const b = b0 - 1;
      if (a !== a0 - 1 || b < 0 || b === was || final.tokens[a] !== src.tokens[b]) break;
      const fit = Math.abs(off(a, b) - next.offset);
      // Fitting both alike, it goes with the words after it: a cut falls before a line, not after its first word.
      if (fit > OFFSET_TOLERANCE || fit > Math.abs(off(a, was) - prev.offset) + 1e-6) break;
      prev.pairs.pop();
      next.pairs.unshift([a, b]);
    }
  }

  const fw = (a: number) => final.index[a]!;
  const stretches: Stretch[] = merged.map(run => {
    const src = sources[run.source]!;
    const [a0, b0] = run.pairs[0]!, [a1, b1] = run.pairs.at(-1)!;
    return {
      mediaId: sourceList[run.source]!.mediaId,
      finalStart: round3(final.words[fw(a0)]!.start), finalEnd: round3(final.words[fw(a1)]!.end),
      sourceStart: round3(src.words[src.index[b0]!]!.start), sourceEnd: round3(src.words[src.index[b1]!]!.end),
      finalWords: [fw(a0), fw(a1)], sourceWords: [src.index[b0]!, src.index[b1]!],
    };
  });

  const unmatched: Unmatched[] = [];
  const gap = (fromWord: number, toWord: number) => {
    // A word or two between pieces is the transcripts disagreeing, not narration.
    const spoken = finalWords.slice(fromWord, toWord + 1).filter(w => token(w.text));
    if (spoken.length < 3) return undefined;
    const item = { finalStart: round3(finalWords[fromWord]!.start), finalEnd: round3(finalWords[toWord]!.end), finalWords: [fromWord, toWord] as [number, number], text: excerpt(finalWords, fromWord, toWord) };
    unmatched.push(item);
    return item;
  };
  const joins: Join[] = [];
  if (stretches.length && stretches[0]!.finalWords[0] > 0) gap(0, stretches[0]!.finalWords[0] - 1);
  for (let i = 1; i < stretches.length; i++) {
    const before = stretches[i - 1]!, after = stretches[i]!;
    const between = after.finalWords[0] - before.finalWords[1] > 1 ? gap(before.finalWords[1] + 1, after.finalWords[0] - 1) : undefined;
    const same = before.mediaId === after.mediaId;
    const kind = !same ? "switch" : after.sourceWords[0] > before.sourceWords[1] ? "forward" : "back";
    const join: Join = {
      finalOut: before.finalEnd, finalIn: after.finalStart,
      from: { mediaId: before.mediaId, time: before.sourceEnd, word: before.sourceWords[1] },
      to: { mediaId: after.mediaId, time: after.sourceStart, word: after.sourceWords[0] },
      kind,
    };
    if (kind === "forward") {
      const words = sourceList.find(s => s.mediaId === before.mediaId)!.words;
      const left = between ? between.finalEnd - between.finalStart : 0;
      join.removedSeconds = round3((after.sourceStart - before.sourceEnd) - rate * (after.finalStart - before.finalEnd - left));
      const [from, to] = [before.sourceWords[1] + 1, after.sourceWords[0] - 1];
      join.removedWords = words.slice(from, to + 1).filter(w => token(w.text)).length;
      if (join.removedWords) join.removedText = excerpt(words, from, to);
    }
    if (between) join.unmatched = between.text;
    joins.push(join);
  }
  const last = stretches.at(-1);
  if (last && last.finalWords[1] < finalWords.length - 1) gap(last.finalWords[1] + 1, finalWords.length - 1);
  if (!stretches.length && finalWords.length) gap(0, finalWords.length - 1);

  const unused: UnusedRange[] = [];
  sourceList.forEach((source, s) => {
    const used = stretches.filter(x => x.mediaId === source.mediaId).map(x => x.sourceWords).sort((p, q) => p[0] - q[0]);
    let from = 0;
    const leave = (to: number) => {
      const spoken = source.words.slice(from, to + 1).filter(w => token(w.text)).length;
      if (to >= from && spoken) unused.push({
        mediaId: source.mediaId, sourceStart: round3(source.words[from]!.start), sourceEnd: round3(source.words[to]!.end),
        sourceWords: [from, to], words: spoken, text: excerpt(source.words, from, to),
      });
    };
    for (const [a, b] of used) {
      leave(a - 1);
      from = Math.max(from, b + 1);
    }
    leave(sources[s]!.words.length - 1);
  });

  return { rate, finalWords: final.tokens.length, matchedWords: merged.reduce((n, r) => n + r.pairs.length, 0), stretches, joins, unmatched, unused };
}

function spread(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => round3(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  return { count: sorted.length, median: at(0.5), p90: at(0.9), max: round3(sorted.at(-1)!) };
}

/** Pauses of at least this long are counted as pauses; shorter gaps are how words run together. */
const PAUSE = 0.3;

/**
 * The figures a reader needs before paging through the joins: how much of each recording plays, how the removals
 * divide by size, and the pauses the finished video keeps against the ones the recordings had.
 */
export function summarizeReference(match: ReferenceMatch, finalWords: readonly MatchWord[], sources: readonly MatchSource[]) {
  const forward = match.joins.filter(j => j.kind === "forward");
  const pauseOnly = forward.filter(j => !j.removedWords && (j.removedSeconds ?? 0) > 0);
  const withWords = forward.filter(j => j.removedWords);
  const sized = (from: number, to: number) => {
    const picked = withWords.filter(j => j.removedWords! >= from && j.removedWords! <= to);
    return { count: picked.length, seconds: spread(picked.map(j => j.removedSeconds!)) };
  };
  const pauses = (words: readonly MatchWord[], from: number, to: number) => {
    const out: number[] = [];
    for (let i = from + 1; i <= to; i++) {
      const gap = words[i]!.start - words[i - 1]!.end;
      if (gap >= PAUSE) out.push(gap);
    }
    return out;
  };
  const keptPauses = match.stretches.flatMap(s => pauses(finalWords, s.finalWords[0], s.finalWords[1]));
  return {
    rate: match.rate,
    finished: {
      words: match.finalWords, matchedWords: match.matchedWords,
      speechSeconds: finalWords.length ? round3(finalWords.at(-1)!.end - finalWords[0]!.start) : 0,
      notInRecordings: { passages: match.unmatched.length, seconds: round3(match.unmatched.reduce((n, u) => n + u.finalEnd - u.finalStart, 0)) },
    },
    recordings: sources.map(source => {
      const used = match.stretches.filter(s => s.mediaId === source.mediaId);
      const unused = match.unused.filter(u => u.mediaId === source.mediaId);
      return {
        mediaId: source.mediaId, words: source.words.length,
        usedPieces: used.length, usedSeconds: round3(used.reduce((n, s) => n + s.sourceEnd - s.sourceStart, 0)),
        unusedPassages: unused.length, unusedSeconds: round3(unused.reduce((n, u) => n + u.sourceEnd - u.sourceStart, 0)),
        firstUsed: used.length ? Math.min(...used.map(s => s.sourceStart)) : null,
        lastUsed: used.length ? Math.max(...used.map(s => s.sourceEnd)) : null,
      };
    }),
    joins: {
      total: match.joins.length,
      forward: forward.length, back: match.joins.filter(j => j.kind === "back").length, switch: match.joins.filter(j => j.kind === "switch").length,
      // A join that only shortens a pause, with what was taken and the pause the finished video leaves there.
      pauseOnly: { count: pauseOnly.length, removedSeconds: spread(pauseOnly.map(j => j.removedSeconds!)), pauseLeft: spread(pauseOnly.map(j => j.finalIn - j.finalOut)) },
      removedWords: { "1-2": sized(1, 2), "3-15": sized(3, 15), "16-100": sized(16, 100), "over100": sized(101, Infinity) },
      pauseAcrossJoin: spread(match.joins.map(j => Math.max(0, j.finalIn - j.finalOut))),
    },
    pauses: {
      // Pauses of 0.3 s or more inside a piece: ones the finished video plays as recorded.
      keptAsRecorded: spread(keptPauses),
      inRecordings: spread(sources.flatMap(s => pauses(s.words, 0, s.words.length - 1))),
    },
  };
}
