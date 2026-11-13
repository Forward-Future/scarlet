import type { MappedWord } from "../../lib/transcriptMap";

const voiceOf = (w: MappedWord) => w.word.speaker || w.word.audioSource;
const starts = (w: MappedWord) => w.placements[0]?.start ?? w.word.start;
const ends = (w: MappedWord) => w.placements[0]?.end ?? w.word.end;
const finishesSentence = (w: MappedWord) => /[.!?]["'”’)]?$/.test(w.word.text);

export interface ReadingTurn {
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
    if (newPassage || !last || voice !== last.voice) {
      const tone = sentence.find(w => voiceOf(w) === voice)?.word.detectedSpeaker;
      turns.push({ voice, tone, words: [...sentence], paragraphs: [sentence] });
    } else {
      last.words.push(...sentence);
      const paragraph = last.paragraphs.at(-1)!;
      if (paragraph.length + sentence.length > 55) last.paragraphs.push(sentence);
      else paragraph.push(...sentence);
    }
    sentence = [];
    newPassage = false;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!, prev = words[i - 1];
    if (prev && (w.mediaId !== prev.mediaId || w.word.start < prev.word.start - .5 || starts(w) - ends(prev) >= 3)) {
      flush();
      newPassage = true;
    }
    // An unpunctuated exchange can still contain a clear handoff. A single
    // conflicting word in the middle of a sentence doesn't start another turn.
    const voice = voiceOf(w), next = words[i + 1];
    if (voice && next && next.mediaId === w.mediaId && voiceOf(next) === voice && sentence.length &&
        voiceOf(sentence.at(-1)!) !== voice && sentence.some(prior => voiceOf(prior) && voiceOf(prior) !== voice) &&
        (voiceOf(sentence.at(-1)!) || !sentence.some(prior => voiceOf(prior) === voice))) flush();
    sentence.push(w);
    if (finishesSentence(w) || sentence.length >= 55) flush();
  }
  flush();
  return turns;
}
