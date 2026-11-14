import { expect, it } from "vitest";
import { otherInputSound, recordingInputs } from "./otherInput.js";
import { measureSources } from "./transcriptSources.js";

const RATE = 8000, PAGE = 60;
type Span = [from: number, to: number];
/** One page of a three-input recording: input 0 is the mix of a microphone (1) and a second input (2). */
function page(mic: Span[], second: Span[]) {
  const pcm = Buffer.alloc(PAGE * RATE * 6);
  const on = (spans: Span[], t: number) => spans.some(([from, to]) => t >= from && t < to);
  for (let i = 0; i < PAGE * RATE; i++) {
    const t = i / RATE, sign = i % 2 ? 1 : -1;
    const b = on(mic, t) ? 2000 * sign : 0, c = on(second, t) ? 1500 * sign : 0;
    pcm.writeInt16LE(b + c, i * 6); pcm.writeInt16LE(b, i * 6 + 2); pcm.writeInt16LE(c, i * 6 + 4);
  }
  return measureSources(pcm);
}
const words = (spans: Span[], offset = 0) => spans.flatMap(([from, to]) =>
  Array.from({ length: Math.floor((to - from) / .5) }, (_, i) => ({ start: offset + from + i * .5, end: offset + from + i * .5 + .4, text: "word" })));

it("finds the input the dialogue is on, and what sounded on the other one", async () => {
  // Three minutes of a presenter on the microphone. In the first, a producer on the call says a word and a chime plays.
  const talk: Span[] = [[1, 50]], remark: Span = [55, 56], chime: Span = [57.2, 57.7];
  const first = page(talk, [remark, chime]), rest = page(talk, []);
  const said = [...words(talk), { start: 55.2, end: 55.7, text: "okay" }, ...words(talk, 60), ...words(talk, 120)];
  const reads: number[] = [];
  const inputs = await recordingInputs(said, 180, async from => { reads.push(from); return from === 0 ? first : rest; });
  expect(inputs).toEqual({ mix: 0, dialogue: 1, other: 2 });
  expect(reads).toEqual([0, 60]);
  const sound = otherInputSound(first.energy, inputs!, 0, 60, said.filter(w => w.end <= 60));
  expect(sound.map(s => [Math.round(s.start * 10) / 10, Math.round(s.end * 10) / 10, s.meAlsoActive, s.text])).toEqual([
    [55, 56, false, "okay"], [57.2, 57.7, false, ""],
  ]);
});

it("says nothing when two people on two microphones share the words", async () => {
  const host: Span[] = [[1, 28]], guest: Span[] = [[31, 58]];
  const both = page(host, guest);
  const said = [0, 60, 120, 180].flatMap(offset => [...words(host, offset), ...words(guest, offset)]);
  expect(await recordingInputs(said, 240, async () => both)).toBeUndefined();
});

it("says nothing when no page shows each input sounding alone, so the mix can't be told from them", async () => {
  const only = page([[1, 50]], []);
  const said = [0, 60, 120].flatMap(offset => words([[1, 50]], offset));
  expect(await recordingInputs(said, 180, async () => only)).toBeUndefined();
});
