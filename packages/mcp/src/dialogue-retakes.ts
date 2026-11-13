import { normalizeTranscriptToken } from "@scarlet/shared";
import type { TimeRange, TranscriptWord } from "@scarlet/timeline";

interface Attempt extends TimeRange { continuation: string }
export interface RepeatedTake {
  phrase: string;
  first: Attempt;
  next: Attempt;
  immediateRestart: boolean;
}

/** Locate attempts for the editor to compare. A repeat by itself never authorizes a cut. */
export function findRepeatedTakes(words: TranscriptWord[], adjacentOnly = false): RepeatedTake[] {
  const tokens = words.map(w => normalizeTranscriptToken(w.text));
  const found: RepeatedTake[] = [];
  for (let next = 1; next < words.length; next++) {
    let first = -1, length = 0;
    for (let i = next - 1; i >= 0 && words[next]!.start - words[i]!.end <= 25; i--) {
      if (!tokens[i] || tokens[i] !== tokens[next]) continue;
      let count = 0;
      while (i + count < next && tokens[next + count] && tokens[i + count] === tokens[next + count]) {
        if (count && (words[i + count]!.start - words[i + count - 1]!.end > 2 ||
          words[next + count]!.start - words[next + count - 1]!.end > 2)) break;
        count++;
      }
      if (count < 2 || count <= length || new Set(tokens.slice(i, i + count)).size < 2) continue;
      if (adjacentOnly && (i + count !== next || words[next]!.start - words[next - 1]!.end > 1.2)) continue;
      const intervening = tokens.slice(i + count, next);
      if (count < 4 && !intervening.every(t => /^(?:um|uh|ah|erm)$/.test(t))) continue;
      const speakers = new Set([...words.slice(i, i + count), ...words.slice(next, next + count)].map(w => w.speaker).filter(Boolean));
      if (speakers.size > 1 || words[i + count - 1]!.end > words[next]!.start) continue;
      first = i;
      length = count;
    }
    if (first < 0) continue;
    // Skip a suffix of a match we already reported. A third attempt starts a
    // new pair even when the preceding two attempts ended with the same word.
    if (found.some(c => words[first]!.start >= c.first.start && words[first]!.start < c.first.end &&
      words[next]!.start >= c.next.start && words[next]!.start < c.next.end)) continue;
    const attempt = (i: number, limit: number): Attempt => ({
      start: words[i]!.start, end: words[i + length - 1]!.end,
      continuation: words.slice(i + length, Math.min(i + length + 6, limit)).map(w => w.text).join(" "),
    });
    const a = attempt(first, next), b = attempt(next, words.length);
    found.push({ phrase: words.slice(next, next + length).map(w => w.text).join(" "), first: a, next: b,
      immediateRestart: (!adjacentOnly || length >= 3) && next === first + length && b.start - a.end <= 4 });
  }
  return found;
}

/** Acoustic words from two independently measured runs cannot establish a continuous delivery. */
export function acousticRepeatedTakes(wordRuns: TranscriptWord[][], from: number): RepeatedTake[] {
  return wordRuns.flatMap(words => findRepeatedTakes(words, true).filter(take => take.next.end > from));
}
