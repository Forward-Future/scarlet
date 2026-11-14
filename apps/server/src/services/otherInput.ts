import { stat } from "node:fs/promises";
import { fileInDirectory } from "@scarlet/render";
import type { MediaAsset, TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { AnalysisCache } from "./analysisCache.js";
import { otherVoiceTurns } from "./otherVoiceTurns.js";
import { readSourceEnergy, sourceLabels, wordSource, type measureSources } from "./transcriptSources.js";

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

/** Sound on an input counts from this mean square (int16), as otherVoiceTurns counts a turn: about -49 dBFS. */
const SOUNDING = 14000;
/** A run of the other input sounding alone this short is a click, not a voice or a sound to hear. */
const MIN_RUN = .1;

/** Where each requested word and gap sat on a recording's inputs. */
export interface InputReading {
  /** Whether the recording has a mix and two inputs with the dialogue on one of them. Without it nothing below is said. */
  available: boolean;
  /** For each word asked about, whether it was heard only on the input the dialogue isn't on. */
  words: boolean[];
  /** For each gap asked about, the stretches of sound on that input alone, in source seconds. */
  gaps: TimeRange[][];
}

const readers = new WeakMap<Ctx, ReturnType<typeof makeReader>>();
/** One reader per engine: which input the dialogue is on is measured once per file, and pages of levels are shared. */
export function otherInputReader(ctx: Ctx) {
  let reader = readers.get(ctx);
  if (!reader) readers.set(ctx, reader = makeReader(ctx));
  return reader;
}

function makeReader(ctx: Ctx) {
  const inputsOf = new Map<string, Promise<RecordingInputs | undefined>>();
  const windows = new AnalysisCache<Measured>(r => r.energy.length * 64, 24 * 1024 * 1024);
  /** The recording's inputs and a reader of its levels, or undefined when its layout isn't one this can read. */
  async function open(projectId: string, media: MediaAsset) {
    if (media.voiceRoles || !media.transcriptId || !media.duration || (media.kind !== "audio" && !media.hasAudio)) return;
    const file = fileInDirectory(ctx.paths.media(projectId), media.path);
    if (!file) return;
    const signal = ctx.projectSignal(projectId);
    const info = await stat(file);
    const stamp = JSON.stringify([file, info.size, info.mtimeMs, info.ctimeMs]);
    const read = (from: number, to: number) => windows.get(JSON.stringify([stamp, from, to]), () => readSourceEnergy(file, from, to, signal));
    let inputs = inputsOf.get(stamp);
    if (!inputs) {
      inputs = (async () => {
        if (!(await sourceLabels(file, signal)).length) return;
        const transcript = ctx.repos.transcripts.get(media.transcriptId!);
        return transcript ? recordingInputs(transcript.segments.flatMap(s => s.words), media.duration!, read) : undefined;
      })();
      if (inputsOf.size >= 32) inputsOf.delete(inputsOf.keys().next().value!);
      inputsOf.set(stamp, inputs);
      inputs.catch(() => inputsOf.delete(stamp));
    }
    const known = await inputs;
    return known && { inputs: known, read, duration: media.duration };
  }

  /** Sound on the other input within one scan page, or undefined when the recording's layout can't say. */
  async function pageSound(projectId: string, media: MediaAsset, from: number, to: number, words: readonly Word[]) {
    const opened = await open(projectId, media);
    if (!opened) return;
    const { energy } = await opened.read(from, to);
    return otherInputSound(energy, opened.inputs, from, to, words);
  }

  /**
   * Which of these words were heard only on the input the dialogue isn't on, and what sounded there alone in these gaps.
   * Levels are read a page of a minute at a time and kept, so a transcript read in pages reads each minute once.
   */
  async function classify(projectId: string, media: MediaAsset, words: readonly TimeRange[], gaps: readonly TimeRange[]): Promise<InputReading> {
    const none: InputReading = { available: false, words: words.map(() => false), gaps: gaps.map(() => []) };
    const opened = await open(projectId, media);
    if (!opened) return none;
    const { inputs, read, duration } = opened;
    // Pages start on whole minutes and run two seconds past them, so a word that starts in one is read whole.
    const page = (t: number) => Math.max(0, Math.floor(t / PAGE) * PAGE);
    const levels = async (start: number) => ({ start, ...(await read(start, Math.min(duration, start + PAGE + 2))) });
    const needed = new Set([...words.map(w => page(w.start)), ...gaps.flatMap(g => {
      const out: number[] = [];
      for (let p = page(g.start); p < g.end && p < duration; p += PAGE) out.push(p);
      return out;
    })]);
    const pages = new Map<number, Awaited<ReturnType<typeof levels>>>();
    for (const start of [...needed].sort((a, b) => a - b)) pages.set(start, await levels(start));
    const heardOther = words.map(w => {
      const at = pages.get(page(w.start));
      return !!at && wordSource(at.energy, at.start, inputs.mix, w.start, Math.min(w.end, at.start + at.energy.length * .02)) === inputs.other;
    });
    const sounding = gaps.map(g => {
      const runs: TimeRange[] = [];
      let open: number | undefined, last = g.start;
      const close = (t: number) => {
        if (open !== undefined && t - open >= MIN_RUN - 1e-6) runs.push({ start: Math.round(open * 100) / 100, end: Math.round(t * 100) / 100 });
        open = undefined;
      };
      for (let p = page(g.start); p < g.end && p < duration; p += PAGE) {
        const at = pages.get(p)!;
        for (let i = Math.max(0, Math.floor((g.start - at.start) / .02)); i < at.energy.length; i++) {
          const t = at.start + i * .02;
          if (t >= Math.min(g.end, p + PAGE)) break;
          const frame = at.energy[i]!, other = frame[inputs.other]!, dialogue = frame[inputs.dialogue]!;
          if (other >= SOUNDING && other > 16 * dialogue) open ??= Math.max(t, g.start);
          else close(t);
          last = t + .02;
        }
      }
      close(Math.min(g.end, last));
      return runs;
    });
    return { available: true, words: heardOther, gaps: sounding };
  }
  return { pageSound, classify };
}
