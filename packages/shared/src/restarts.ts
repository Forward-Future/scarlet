/**
 * A phrase that plays, and plays again a moment later: `length` words from `at`, said again from `next`. `again` is
 * the second saying's length when it adds or drops a word ("how mechanical watch, how a mechanical watch").
 */
export interface Restart { at: number; length: number; next: number; again?: number }

/** How long after the first saying ends the second may begin, in seconds and in words said between them. */
export const RESTART_WITHIN_SECONDS = 12, RESTART_WITHIN_WORDS = 12;

/** A contraction compares as the word it starts with: “and then I will … and then I'll copy” is one restart. */
const CONTRACTED: Record<string, string> = {
  ill: "i", im: "i", ive: "i", id: "i", youll: "you", youre: "you", youve: "you", youd: "you", theyre: "they", theyll: "they",
  theyve: "they", itll: "it", its: "it", thats: "that", whats: "what", theres: "there", heres: "here", lets: "let", weve: "we",
  dont: "do", doesnt: "does", didnt: "did", cant: "can", wont: "will", isnt: "is",
};

/**
 * Phrases said twice within a moment, in playback order: a restart ("there's this like white, I don't know what that
 * is, there's this like white stuff"), a retake left beside the take that replaced it, or a deliberate parallel
 * ("we have Muse Wonder … we have Muse Wonderful"). Which it is takes the sentence to tell, so this only locates
 * them. An immediate word-for-word repeat is one of them, with nothing said between.
 *
 * Three words or more, or two with at most one word between: a shorter match is ordinary speech ("you can … you can").
 * A whole first attempt that comes back with one word added or dropped is one too, on three words that match.
 * A shorter phrase said twice inside a longer one's first attempt is found as well, so a match from a sentence
 * before doesn't hide the restart within it. Each saying is the second of at most one phrase, and a third saying
 * pairs with the second.
 *
 * With `cutOffWords`, a first attempt may stop on a word the next one says longer ("so perfect, so perfectly
 * realistic", "we want, we wanted"): a word of three letters or more that the second saying's word starts with,
 * when it is the last word before the second saying.
 */
export function findRestarts(tokens: readonly string[], starts: readonly number[], ends: readonly number[],
  options: { cutOffWords?: boolean } = {}): Restart[] {
  const key = tokens.map(t => { const k = t.replace(/['’]/g, ""); return CONTRACTED[k] ?? k; });
  const found: Restart[] = [];
  const paired = new Set<number>();
  const n = key.length;
  const same = (a: number, b: number) => !!key[a] && key[a] === key[b];
  for (let i = 0; i < n - 1;) {
    let best: Restart | undefined;
    if (key[i]) {
      for (let j = i + 2; j < n && j <= i + 2 * RESTART_WITHIN_WORDS + 2; j++) {
        if (!same(i, j) || paired.has(j)) continue;
        let length = 0;
        while (i + length < j && j + length < n && same(i + length, j + length)) length++;
        if (options.cutOffWords && length && i + length + 1 === j && j + length < n && key[i + length]!.length >= 3 &&
          key[j + length]!.length > key[i + length]!.length && key[j + length]!.startsWith(key[i + length]!)) length++;
        const between = j - (i + length);
        const distinct = new Set(key.slice(i, i + length)).size;
        if (between <= RESTART_WITHIN_WORDS && starts[j]! - ends[i + length - 1]! <= RESTART_WITHIN_SECONDS &&
          ((length >= 3 && distinct >= 2) || (length === 2 && distinct === 2 && between <= 1))) {
          if (!best || length > best.length) best = { at: i, length, next: j };
          continue;
        }
        // The whole first attempt again, with one word slipped in or left out after its first word.
        for (const [skipA, skipB] of [[0, 1], [1, 0]] as const) {
          let a = i + length + skipA, b = j + length + skipB, more = 0;
          while (a < j && b < n && same(a, b)) a++, b++, more++;
          if (a !== j || length + more < 3 || more < 1 || new Set(key.slice(i, j)).size < 2 ||
            starts[j]! - ends[j - 1]! > RESTART_WITHIN_SECONDS) continue;
          if (!best || j - i > best.length) best = { at: i, length: j - i, next: j, again: b - j };
          break;
        }
      }
    }
    if (best) { found.push(best); paired.add(best.next); i = best.at + best.length; }
    else i++;
  }
  return found;
}
