/**
 * What a dialogue_apply_cuts receipt says about the edits it saved, without echoing what the model just sent. Every
 * receipt stays in the model's context for the rest of the pass and is read again on each later step, so a sentence it
 * already wrote, or the same explanation on every save, costs it again each time.
 */
import type { Change } from "@scarlet/timeline";

type SavedEdit = NonNullable<Change["timelineEdits"]>[number];
type SavedChange = Pick<Change, "id" | "state" | "fromVersion" | "toVersion" | "description" | "intent" | "timelineEdits">;

/** Timeline seconds to the millisecond: a frame is 17 ms or more, so this still names each saved edge's frame. */
const ms = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Each saved edit by its summary and range, in the order saved. `reason` is the sentence the model wrote for the card,
 * and `label` is the summary again when the model gave one, so both go. An edit with no summary keeps its label, which
 * then names it. `check` and `replaces` stay: they say what the editor is asked and which earlier edit this one replaces.
 */
export function receiptEdit({ label, reason: _reason, summary, range, ...rest }: SavedEdit) {
  return { ...(summary ? { summary } : { label }), range: { start: ms(range.start), end: ms(range.end) }, ...rest };
}

export function receiptChanges(changes: readonly SavedChange[]) {
  return changes.map(({ timelineEdits, ...change }) => ({ ...change, ...(timelineEdits && { timelineEdits: timelineEdits.map(receiptEdit) }) }));
}

/** Words a removal named by transcript indices takes out, by its first and last words when there are many. */
const WORDS_SHOWN = 6;
export function shortWords(words: string) {
  const all = words.split(/\s+/).filter(Boolean);
  if (all.length <= WORDS_SHOWN * 2 + 2) return words;
  return `${all.slice(0, WORDS_SHOWN).join(" ")} … ${all.slice(-WORDS_SHOWN).join(" ")}`;
}

/**
 * The gate as the model reads it. `words` is the transcript text of the indices the model named: its first and last
 * words say where those indices begin and end, and the words between are the ones the model read when it chose them.
 * `removes`, read by Scarlet for a range given in seconds, stays whole: the model hasn't seen what it holds.
 */
export function receiptGate<G extends { decisions: Array<Record<string, unknown>> }>(gate: G): G {
  return { ...gate, decisions: gate.decisions.map(d => typeof d.words === "string" ? { ...d, words: shortWords(d.words) } : d) };
}

/** `onFrames.why` is the same sentence on every save: said on the first one of the session, and after that only the figures. */
export function receiptOnFrames<F extends { why?: string }>(onFrames: F | undefined, explained: boolean): F | Omit<F, "why"> | undefined {
  if (!onFrames || !explained) return onFrames;
  const { why: _why, ...figures } = onFrames;
  return figures;
}

/** A number to the millisecond, or its thousandth for anything else: seconds read to 17 digits cost as many tokens. */
const thousandths = (n: number) => Number.isInteger(n) ? n : Math.round(n * 1000) / 1000;

/** A JSON text part with every fraction to three decimals; any other text as it was. */
export function thousandthsText(text: string) {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return text;
  try {
    return JSON.stringify(JSON.parse(text, (_key, value: unknown) => typeof value === "number" ? thousandths(value) : value));
  } catch {
    return text;
  }
}

/** The lists dialogue_check_repeats pages together with one offset; silences and short pieces are listed from the first each time. */
const PAGED_TOGETHER = ["repeats", "fragments", "pictures"] as const;

/**
 * A dialogue_check_repeats page that fits one result: when the 25 the engine pages at once don't, fewer of each paged
 * list, with nextOffset where the next page starts. The model reads the rest from there; a longer result is cut in its
 * middle by a harness with a size limit.
 */
export function fitRepeatPage<R extends { nextOffset?: number } & Partial<Record<(typeof PAGED_TOGETHER)[number], unknown[]>>>(result: R, offset: number, maxChars: number): R {
  if (JSON.stringify(result).length <= maxChars) return result;
  const longest = Math.max(0, ...PAGED_TOGETHER.map(name => result[name]?.length ?? 0));
  let page = result;
  for (let shown = longest - 1; shown >= 1; shown--) {
    page = { ...result, nextOffset: offset + shown };
    for (const name of PAGED_TOGETHER) if (result[name]) page[name] = result[name]!.slice(0, shown) as R[typeof name];
    if (JSON.stringify(page).length <= maxChars) break;
  }
  return page;
}
