/**
 * A restart cut whose edge runs a word or two past the restart: it takes the end of the phrase the edit keeps, or the
 * start of the take it resumes with, and nothing either side of the join says those words again.
 *
 * A pass asked to remove the restart in “absolutely beautiful. The detail, the, the detail, the spatial awareness” and
 * named one word too many: the cut took “beautiful” with it, and the edit played “this is absolutely ‖ detail, the
 * spatial awareness”. Another took “including its” with “including 3D,”, leaving “capabilities, ‖ ability to generate”.
 * Each word played whole and each join measured clean, so nothing reported them; the editor heard them (2026-11-16).
 * On that 58-minute pass this shape named 14 of the 96 speech joins its cuts made, and in about half a sentence had
 * lost a word (“Everything looks really ‖ now”, “it's ‖ now there are”); the rest took out a correction or an aside.
 *
 * This only locates the shape, from the words: whether the words should go is the model's call.
 */
import { closesSentence, normalizeTranscriptToken } from "@scarlet/shared";

/** Words either side of a join that count as said there again. */
const EDGE_CONTEXT_WORDS = 6;
/** The most words an overshoot takes at the edge that leaves the kept phrase, and at the edge it resumes on. Longer
 *  runs are a passage taken out on purpose, as an aside is. */
const MOST_TAKEN = { out: 2, in: 3 } as const;
/** Of the words played after the join, the ones a restart resumes on. */
const RESUMES_WITHIN = 3;

/** A hesitation sound is no word a sentence needs: one at the edge of a removal is not an overshoot. */
const HESITATION = /^(u+h+m*|u+m+|e+r+m*|a+h+|h+m+|m+h*m*|e+h+)$/u;

export interface EdgeOvershoot {
  /** `out`: the cut takes the end of what plays before it. `in`: it takes the start of what plays after it. */
  side: "out" | "in";
  /** The words taken at that edge that the join doesn't say again, as the transcript spells them. */
  words: string;
}

/**
 * `before` and `after` are the words the edit plays up to the join and from it on, in playback order; `removed` the
 * words the join takes out, in the order they were said.
 */
export function edgeOvershoots(before: readonly string[], removed: readonly string[], after: readonly string[]): EdgeOvershoot[] {
  const token = (text: string) => normalizeTranscriptToken(text);
  const near = new Set([...before.slice(-EDGE_CONTEXT_WORDS), ...after.slice(0, EDGE_CONTEXT_WORDS)].map(token).filter(Boolean));
  const taken = removed.filter(text => { const t = token(text); return !!t && !HESITATION.test(t); });
  const tokens = taken.map(token);
  if (!tokens.length) return [];
  const found: EdgeOvershoot[] = [];
  // Leaving the kept phrase: the first words taken aren't said either side, and what the cut takes after them is a
  // restart, a word said twice in it or one the edit resumes on. A phrase that closes its sentence before the join
  // isn't cut short.
  let k = 0;
  while (k < tokens.length && !near.has(tokens[k]!)) k++;
  // A restart is said again within a few words: one word twice in a long aside is no restart.
  const rest = tokens.slice(k, k + EDGE_CONTEXT_WORDS), resumes = new Set(after.slice(0, RESUMES_WITHIN).map(token));
  if (k > 0 && k <= MOST_TAKEN.out && rest.length && before.length && !closesSentence(before.at(-1)!)
    && (new Set(rest).size < rest.length || rest.some(t => resumes.has(t))))
    found.push({ side: "out", words: taken.slice(0, k).join(" ") });
  // Resuming: the last words taken aren't said either side, and the first of them was said earlier in the cut, so the
  // cut took the start of the take that says it again.
  let j = tokens.length;
  while (j > 0 && !near.has(tokens[j - 1]!)) j--;
  const tail = tokens.length - j;
  if (tail > 0 && tail <= MOST_TAKEN.in && j > 0 && tokens.slice(Math.max(0, j - EDGE_CONTEXT_WORDS), j).includes(tokens[j]!))
    found.push({ side: "in", words: taken.slice(j).join(" ") });
  return found;
}
