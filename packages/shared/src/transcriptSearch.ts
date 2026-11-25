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
  // Marks stay: a Hindi vowel sign or a Thai tone mark makes another word (काम is not कम).
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
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

function buildTranscriptMatch(words: TranscriptWord[], startIndex: number, length: number, contextWords: number): TranscriptMatch {
  const slice = words.slice(startIndex, startIndex + length);
  const before = words.slice(Math.max(0, startIndex - contextWords), startIndex).map((w) => w.text);
  const after = words.slice(startIndex + length, startIndex + length + contextWords).map((w) => w.text);
  return {
    start: slice[0]!.start,
    end: slice.at(-1)!.end,
    text: slice.map((w) => w.text).join(" "),
    speaker: slice[0]!.speaker,
    context: [...before, "[", ...slice.map((w) => w.text), "]", ...after].join(" "),
    wordIndex: startIndex,
  };
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
    out.push(buildTranscriptMatch(words, i, q.length, contextWords));
  }
  return out;
}

export interface TranscriptSearchResult {
  segmentCount: number;
  wordCount: number;
  matches: TranscriptMatch[];
  /** The exact word order searched. When the caller knows this id, its copy supplies the texts. */
  wordSnapshot?: { id: string; texts?: string[] };
}

export interface FuzzyTranscriptMatch extends TranscriptMatch {
  /** 0..1 token similarity between the query and the matched words. */
  score: number;
}

/** Character similarity of two normalized tokens, 0..1 (Levenshtein ratio). */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // Shared affixes do not change edit distance. Keep the original lengths for the ratio.
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (start < endA && start < endB && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const width = endB - start;
  const row = Array.from({ length: width + 1 }, (_, j) => j);
  for (let i = start; i < endA; i++) {
    let diagonal = row[0]!;
    row[0] = i - start + 1;
    for (let j = 1; j <= width; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i] === b[start + j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - row[width]! / Math.max(a.length, b.length);
}

/** Tokens this close count as the same word: plurals, ASR spelling drift and typos in words of five letters or more. */
const SAME_TOKEN = 0.8;

/** tokenSimilarity(a, b) >= SAME_TOKEN. The edit distance is at least the length difference, so
 * tokens whose lengths differ too much can't reach the threshold; skip the distance for them. */
export function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest < 5 || 1 - Math.abs(a.length - b.length) / longest < SAME_TOKEN) return false;
  return tokenSimilarity(a, b) >= SAME_TOKEN;
}

/** For one query, compare each distinct transcript token at most once while its rows fit in memory. */
function tokenMatches(query: string[], maxCells = Infinity) {
  const cache = new Map<string, Uint8Array>();
  return (token: string) => {
    const cached = cache.get(token);
    if (cached) return cached;
    const matches = Uint8Array.from(query, q => Number(sameToken(q, token)));
    if ((cache.size + 1) * query.length <= maxCells) cache.set(token, matches);
    return matches;
  };
}

/** Advance one column of the longest-common-subsequence table for an incoming word. */
function advanceLcs(lengths: Uint32Array, matches: Uint8Array) {
  let diagonal = 0;
  for (let i = 1; i < lengths.length; i++) {
    const previous = lengths[i]!;
    lengths[i] = matches[i - 1] ? diagonal + 1 : Math.max(previous, lengths[i - 1]!);
    diagonal = previous;
  }
}

/** Compare a clause with nearby takes. The same LCS table also scores their equal-length prefixes. */
export function transcriptSequenceMatcher(query: string[]) {
  const matches = tokenMatches(query, 256 * 1024);
  const lengths = new Uint32Array(query.length + 1);
  return (other: string[]) => {
    if (!query.length || !other.length) return { score: 0, prefix: 0 };
    lengths.fill(0);
    let prefix = 0;
    const shorter = Math.min(query.length, other.length);
    for (let j = 0; j < other.length; j++) {
      advanceLcs(lengths, matches(other[j]!));
      if (j + 1 === shorter) prefix = lengths[shorter]! / shorter;
    }
    return { score: (2 * lengths[query.length]!) / (query.length + other.length), prefix };
  };
}

/** Dice-style similarity of two token sequences: 2·LCS / (|a|+|b|), with fuzzy token equality. */
export function sequenceSimilarity(a: string[], b: string[]): number {
  return transcriptSequenceMatcher(a)(b).score;
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
  const matchToken = tokenMatches(q);
  const same = words.map(w => matchToken(normalizeTranscriptToken(w.text)));
  const lengths = new Uint32Array(q.length + 1);
  const shortest = Math.max(1, q.length - 2);
  const found: Array<{ i: number; n: number; score: number }> = [];
  for (let i = 0; i < words.length; i++) {
    // A match starts on a word that resembles some query word.
    if (!same[i]!.some(Boolean)) continue;
    let best: { n: number; score: number } | undefined;
    lengths.fill(0);
    const longest = Math.min(q.length + 2, words.length - i);
    for (let n = 1; n <= longest; n++) {
      advanceLcs(lengths, same[i + n - 1]!);
      if (n < shortest) continue;
      const score = (2 * lengths[q.length]!) / (q.length + n);
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
    out.push({ ...buildTranscriptMatch(words, f.i, f.n, contextWords), score: Math.round(f.score * 100) / 100 });
  }
  return out;
}
