import type { TimeRange } from "@scarlet/timeline";
import { otherVoiceTurns } from "./otherVoiceTurns.js";
import { wordSource, type measureSources } from "./transcriptSources.js";

type Measured = ReturnType<typeof measureSources>;
type Word = TimeRange & { text: string };

/** The recording's three synchronized inputs: their mix, the one the dialogue is on, and the other. Zero-based. */
export interface RecordingInputs { mix: number; dialogue: number; other: number }

/** Enough words heard on one input alone to say which input the dialogue is on, and how lopsided they must be. */
const MIN_WORDS = 150, SHARE = .8, PAGE = 60, MAX_PAGES = 16;

/**
 * Which input a recording's dialogue is on, measured: a recording with a mix and two isolated inputs (a microphone
 * and the desktop, or a host and a call) whose words mostly come from one of them. A pass heard a producer's
 * "got you", a system chime and a remark spoken over the presenter as dialogue, because every level it read was the
 * mix (2026-11-13). On that recording 91% of the words heard on one input alone were on the microphone, with whole
 * minutes where the producer on the call said more. Undefined when the layout can't be verified or the two inputs
 * share the words, as two people on two microphones do: then nothing is said about either.
 */
export async function recordingInputs(words: readonly Word[], duration: number, read: (from: number, to: number) => Promise<Measured>): Promise<RecordingInputs | undefined> {
  const pages = new Map<number, Word[]>();
  for (const w of words) {
    const page = Math.floor(w.start / PAGE);
    if (w.end <= Math.min(duration, (page + 1) * PAGE)) (pages.get(page) ?? pages.set(page, []).get(page)!).push(w);
  }
  // Pages spread through the recording, since any one minute can be the other voice's. The mix shows only where
  // each input sounds alone, which a page of unbroken talk may not have, so pages wait until one has shown it.
  const spoken = [...pages].filter(([page]) => Math.min(duration, (page + 1) * PAGE) - page * PAGE >= 5).sort((a, b) => a[0] - b[0]);
  const step = Math.max(1, Math.ceil(spoken.length / MAX_PAGES));
  const waiting: Array<{ from: number; energy: Measured["energy"]; words: Word[] }> = [];
  const counts = [0, 0, 0];
  let mix: number | undefined;
  const decided = (): RecordingInputs | undefined => {
    if (mix === undefined) return;
    const [a, b] = [0, 1, 2].filter(i => i !== mix) as [number, number];
    const heard = counts[a]! + counts[b]!;
    if (heard < MIN_WORDS) return;
    if (counts[a]! >= SHARE * heard) return { mix, dialogue: a, other: b };
    if (counts[b]! >= SHARE * heard) return { mix, dialogue: b, other: a };
  };
  for (let i = Math.floor(step / 2); i < spoken.length; i += step) {
    const [page, said] = spoken[i]!;
    const from = page * PAGE;
    const measured = await read(from, Math.min(duration, from + PAGE));
    if (measured.mix !== undefined) {
      if (mix !== undefined && mix !== measured.mix) return;
      mix = measured.mix;
    }
    waiting.push({ from, energy: measured.energy, words: said });
    if (mix === undefined) continue;
    for (const held of waiting.splice(0)) for (const w of held.words) {
      const input = wordSource(held.energy, held.from, mix, w.start, w.end);
      if (input !== undefined) counts[input]!++;
    }
    const inputs = decided();
    if (inputs) return inputs;
  }
}

/**
 * Sound on the input the dialogue is not on, within one measured window: when, the transcript's words heard there
 * and nowhere else, and whether the dialogue input sounded too. A system sound has no words.
 */
export function otherInputSound(measured: Measured["energy"], inputs: RecordingInputs, from: number, to: number, words: readonly Word[]) {
  return otherVoiceTurns(measured, { me: inputs.dialogue + 1, other: inputs.other + 1 }, from, to).map(turn => ({ ...turn,
    text: words.filter(w => {
      const mid = (w.start + w.end) / 2;
      return mid >= turn.start - .12 && mid < turn.end + .12 && wordSource(measured, from, inputs.mix, w.start, w.end) === inputs.other;
    }).map(w => w.text.trim()).join(" ") }));
}
