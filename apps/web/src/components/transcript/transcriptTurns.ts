import type { MappedWord } from "../../lib/transcriptMap";

const voiceOf = (w: MappedWord) => w.word.speaker || w.word.audioSource;
const starts = (w: MappedWord) => w.placements[0]?.start ?? w.word.start;
const ends = (w: MappedWord) => w.placements[0]?.end ?? w.word.end;
const finishesSentence = (w: MappedWord) => /[.!?]["'”’)]?$/.test(w.word.text);

/** A pause long enough to mark a new section even after a single stray word. */
export const SECTION_GAP_SECONDS = 60;
/** A pause long enough to break a full passage into a fresh paragraph. */
const PARAGRAPH_GAP_SECONDS = 8;
/** Minimum words in the current turn before a moderate pause starts a new paragraph. */
const MIN_PARAGRAPH_WORDS = 18;
/** Target maximum words per timestamped paragraph block. */
const MAX_PARAGRAPH_WORDS = 55;

interface ReadingTurn {
  voice?: string;
  tone?: number;
  words: MappedWord[];
  paragraphs: MappedWord[][];
}

/** Group text for reading without changing the attribution or timing of an individual word. */
export function transcriptTurns(words: MappedWord[]): ReadingTurn[] {
  const turns: ReadingTurn[] = [];
  let sentence: MappedWord[] = [];
  let newPassage = true;
  const flush = () => {
    if (!sentence.length) return;
    const support = new Map<string, number>();
    for (const w of sentence) {
      const voice = voiceOf(w);
      if (voice) support.set(voice, (support.get(voice) ?? 0) + 1);
    }
    const [best, second] = [...support].sort((a, b) => b[1] - a[1]);
    const voice = best && best[1] >= Math.min(2, sentence.length) && best[1] > 2 * (second?.[1] ?? 0) ? best[0] : undefined;
    const last = turns.at(-1);
    const fitsParagraph = !newPassage && !!last && voice === last.voice && last.words.length + sentence.length <= MAX_PARAGRAPH_WORDS;
    if (!fitsParagraph) {
      const tone = sentence.find(w => voiceOf(w) === voice)?.word.detectedSpeaker;
      turns.push({ voice, tone, words: [...sentence], paragraphs: [sentence] });
    } else {
      last.words.push(...sentence);
      last.paragraphs.at(-1)!.push(...sentence);
    }
    sentence = [];
    newPassage = false;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!, prev = words[i - 1];
    if (prev) {
      const gap = starts(w) - ends(prev);
      const currentWords = (newPassage ? 0 : (turns.at(-1)?.words.length ?? 0)) + sentence.length;
      const majorBreak = w.mediaId !== prev.mediaId || w.word.start < prev.word.start - .5 || gap >= SECTION_GAP_SECONDS;
      const paragraphPause = gap >= PARAGRAPH_GAP_SECONDS && currentWords >= MIN_PARAGRAPH_WORDS && (!sentence.length || finishesSentence(prev));
      if (majorBreak || paragraphPause) {
        flush();
        newPassage = true;
      }
    }
    // An unpunctuated exchange can still contain a clear handoff. A single
    // conflicting word in the middle of a sentence doesn't start another turn.
    const voice = voiceOf(w), next = words[i + 1];
    if (voice && next && next.mediaId === w.mediaId && voiceOf(next) === voice && sentence.length &&
        voiceOf(sentence.at(-1)!) !== voice && sentence.some(prior => voiceOf(prior) && voiceOf(prior) !== voice) &&
        (voiceOf(sentence.at(-1)!) || !sentence.some(prior => voiceOf(prior) === voice))) flush();
    sentence.push(w);
    if (finishesSentence(w) || sentence.length >= MAX_PARAGRAPH_WORDS) flush();
  }
  flush();
  return turns;
}
