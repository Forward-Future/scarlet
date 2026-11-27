/** A word as search compares it: lower case, without punctuation, an apostrophe inside it (between cased letters, as in "don’t") read the same curly or straight. */
const bare = (text: string) => text.normalize("NFC").toLowerCase().replace(/([\p{LC}\p{N}])’(?=\p{LC})/gu, "$1'").replace(/[^\p{L}\p{M}\p{N}']+/gu, "");
/** The words searched for, as `findWords` compares them: a run of punctuation alone is no word. */
export const searchTerms = (query: string) => query.split(/\s+/).map(bare).filter(Boolean);
/** Where the searched words start, each a run of `terms.length` words: every word but the last matched whole, the last from its start. */
export function findWords(words: { word: { text: string } }[], query: string | string[]) {
  const terms = typeof query === "string" ? searchTerms(query) : query;
  if (!terms.length) return [];
  const texts = words.map(w => bare(w.word.text));
  const found: number[] = [];
  for (let i = 0; i + terms.length <= texts.length; i++) {
    if (terms.every((term, j) => j === terms.length - 1 ? texts[i + j]!.startsWith(term) : texts[i + j] === term)
      || (terms.length === 1 && texts[i]!.includes(terms[0]!))) found.push(i);
  }
  return found;
}
