import type { Transcript, TranscriptWord } from "@scarlet/timeline";

export function flattenWords(t: Transcript): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const seg of t.segments) {
    if (seg.words.length) {
      for (const w of seg.words) words.push(seg.speaker && !w.speaker ? { ...w, speaker: seg.speaker } : w);
    } else if (seg.text.trim()) {
      // No word timings: synthesize evenly spaced words so search still works.
      const parts = seg.text.trim().split(/\s+/);
      const step = (seg.end - seg.start) / parts.length;
      parts.forEach((text, i) => {
        words.push({
          text,
          start: Math.round((seg.start + i * step) * 1000) / 1000,
          end: Math.round((seg.start + (i + 1) * step) * 1000) / 1000,
          speaker: seg.speaker,
        });
      });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

export function normalizeTranscriptToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface TranscriptMatch {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** A few words before/after the match for orientation. */
  context: string;
  wordIndex: number;
}

/** Case/punctuation-insensitive phrase search over word timings. */
export function indexTranscriptWords(words: TranscriptWord[]) {
  const normalized = words.map(w => normalizeTranscriptToken(w.text));
  return (query: string, contextWords = 6): TranscriptMatch[] => findPhrase(words, normalized, query, contextWords);
}

export function searchTranscript(words: TranscriptWord[], query: string, contextWords = 6): TranscriptMatch[] {
  return indexTranscriptWords(words)(query, contextWords);
}

function findPhrase(words: TranscriptWord[], norm: string[], query: string, contextWords: number): TranscriptMatch[] {
  const q = query
    .split(/\s+/)
    .map(normalizeTranscriptToken)
    .filter(Boolean);
  if (!q.length) return [];
  const out: TranscriptMatch[] = [];
  for (let i = 0; i + q.length <= norm.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) {
      if (norm[i + j] !== q[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const slice = words.slice(i, i + q.length);
    const before = words.slice(Math.max(0, i - contextWords), i).map((w) => w.text);
    const after = words.slice(i + q.length, i + q.length + contextWords).map((w) => w.text);
    out.push({
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      text: slice.map((w) => w.text).join(" "),
      speaker: slice[0]!.speaker,
      context: [...before, "[", ...slice.map((w) => w.text), "]", ...after].join(" "),
      wordIndex: i,
    });
  }
  return out;
}

export interface TranscriptSearchResult {
  segmentCount: number;
  wordCount: number;
  matches: TranscriptMatch[];
}

export interface FuzzyTranscriptMatch extends TranscriptMatch {
  /** 0..1 token similarity between the query and the matched words. */
  score: number;
}

/** Character similarity of two normalized tokens, 0..1 (Levenshtein ratio). */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

/** Tokens this close count as the same word: plurals, ASR spelling drift and typos in words of five letters or more. */
const SAME_TOKEN = 0.8;

/** tokenSimilarity(a, b) >= SAME_TOKEN. The edit distance is at least the length difference, so
 * tokens whose lengths differ too much can't reach the threshold; skip the distance for them. */
export function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (1 - Math.abs(a.length - b.length) / longest < SAME_TOKEN) return false;
  return tokenSimilarity(a, b) >= SAME_TOKEN;
}

/** Dice-style similarity of two token sequences: 2·LCS / (|a|+|b|), with fuzzy token equality. */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) {
      row[j] = sameToken(a[i - 1]!, b[j - 1]!) ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  return (2 * prev[b.length]!) / (a.length + b.length);
}

/**
 * Token-based fuzzy phrase search: windows of the query's length ±2 words, scored by
 * sequenceSimilarity. Returns the best non-overlapping windows at or above `minScore`,
 * highest first. Use it when the editor paraphrases a line or ASR spelled a word differently.
 */
export function fuzzySearchTranscript(words: TranscriptWord[], query: string,
  opts: { contextWords?: number; minScore?: number; limit?: number } = {}): FuzzyTranscriptMatch[] {
  const { contextWords = 6, minScore = 0.6, limit = 20 } = opts;
  const q = query.split(/\s+/).map(normalizeTranscriptToken).filter(Boolean).slice(0, 40);
  if (!q.length) return [];
  // Compare each distinct word with each query token once; windows then only look up the matrix.
  const rows = new Map<string, boolean[]>();
  const same = words.map(w => {
    const t = normalizeTranscriptToken(w.text);
    let row = rows.get(t);
    if (!row) rows.set(t, row = q.map(x => sameToken(t, x)));
    return row;
  });
  const lcs = (i: number, n: number) => {
    let prev = new Array<number>(n + 1).fill(0);
    for (let a = 1; a <= q.length; a++) {
      const row = [0];
      for (let b = 1; b <= n; b++) row[b] = same[i + b - 1]![a - 1] ? prev[b - 1]! + 1 : Math.max(prev[b]!, row[b - 1]!);
      prev = row;
    }
    return prev[n]!;
  };
  const found: Array<{ i: number; n: number; score: number }> = [];
  for (let i = 0; i < words.length; i++) {
    // A match starts on a word that resembles some query word.
    if (!same[i]!.some(Boolean)) continue;
    let best: { n: number; score: number } | undefined;
    for (let n = Math.max(1, q.length - 2); n <= q.length + 2 && i + n <= words.length; n++) {
      const score = (2 * lcs(i, n)) / (q.length + n);
      if (!best || score > best.score) best = { n, score };
    }
    if (best && best.score >= minScore) found.push({ i, ...best });
  }
  found.sort((a, b) => b.score - a.score || a.i - b.i);
  const taken: boolean[] = [];
  const out: FuzzyTranscriptMatch[] = [];
  for (const f of found) {
    if (out.length >= limit) break;
    let free = true;
    for (let k = f.i; k < f.i + f.n; k++) if (taken[k]) { free = false; break; }
    if (!free) continue;
    for (let k = f.i; k < f.i + f.n; k++) taken[k] = true;
    const slice = words.slice(f.i, f.i + f.n);
    const before = words.slice(Math.max(0, f.i - contextWords), f.i).map(w => w.text);
    const after = words.slice(f.i + f.n, f.i + f.n + contextWords).map(w => w.text);
    out.push({ start: slice[0]!.start, end: slice.at(-1)!.end, text: slice.map(w => w.text).join(" "), speaker: slice[0]!.speaker,
      context: [...before, "[", ...slice.map(w => w.text), "]", ...after].join(" "), wordIndex: f.i, score: Math.round(f.score * 100) / 100 });
  }
  return out;
}
