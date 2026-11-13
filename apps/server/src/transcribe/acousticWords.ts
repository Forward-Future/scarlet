import type { TimeRange } from "@scarlet/timeline";
import { EmissionFile } from "./emissions.js";
import { CLASSES, FRAME_SECONDS, CTC_LETTERS, SEPARATOR } from "./ctcAlign.js";

type Word = TimeRange & { text: string };

/** Decode just the frames that play. A cut through a word can leave a different sound from its source transcript. */
export function acousticWordReader(startsAtWordBoundary = true) {
  const words: Word[] = [];
  let previous = -1, word: Word | undefined;
  let complete = startsAtWordBoundary;
  return {
    read(rows: Float32Array, firstFrame: number) {
      for (let offset = 0; offset < rows.length; offset += CLASSES) {
        let top = 0;
        for (let i = 1; i < CLASSES; i++) if (rows[offset + i]! > rows[offset + top]!) top = i;
        const at = (firstFrame + offset / CLASSES) * FRAME_SECONDS;
        if (top >= 5) {
          word ??= { text: "", start: at, end: at };
          if (top !== previous) word.text += CTC_LETTERS[top - 5]!.toLowerCase();
          word.end = at + FRAME_SECONDS;
        } else if (top === SEPARATOR) {
          if (word && complete) words.push(word);
          word = undefined;
          complete = true;
        }
        previous = top;
      }
    },
    finish: (endsAtWordBoundary = true) => word && complete && endsAtWordBoundary ? [...words, word] : words,
  };
}

/** Read whole words for a scan page. A missing measurement breaks the run even if words on either side match. */
export async function readCachedAcousticWords(path: string, from: number, to: number): Promise<Word[][]> {
  const store = await EmissionFile.open(path);
  if (!store) return [];
  try {
    const [first, last] = store.frameRange(from, to);
    const gaps = store.missing(first, last).map(i => store.chunks[i]!.keep);
    const runs: Word[][] = [];
    let next = first;
    for (const [gapStart, gapEnd] of [...gaps, [last, last] as const]) {
      const end = Math.min(gapStart, last);
      if (next < end) {
        const reader = acousticWordReader(next === 0);
        reader.read(await store.read(next, end), next);
        runs.push(reader.finish(end === store.frames).filter(w => w.start >= from && w.end <= to));
      }
      next = Math.max(next, gapEnd);
    }
    return runs;
  } finally { await store.close(); }
}

/** A short reading in source seconds. Undefined when its local speech measurements have not been prepared. */
export async function readAcousticWindow(path: string, from: number, to: number) {
  const store = await EmissionFile.open(path);
  if (!store) return;
  try {
    const [first, last] = store.frameRange(from, to);
    if (first >= last || store.missing(first, last).length) return;
    const reader = acousticWordReader();
    reader.read(await store.read(first, last), first);
    return reader.finish().map(w => ({ ...w, start: Math.max(from, w.start), end: Math.min(to, w.end) }));
  } finally { await store.close(); }
}
