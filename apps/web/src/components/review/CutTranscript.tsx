import { Fragment, useMemo, useState } from "react";
import { timelineDuration, withHandles, type MediaAsset, type TimeRange, type Timeline } from "@scarlet/timeline";
import { cutWords, type MappedWord } from "../../lib/transcriptMap";
import { useTranscriptWindow } from "../transcript/useTranscriptWindow";
import { Icon } from "../ui/primitives";

/** Kept words shown either side of the removed ones. */
const CONTEXT_WORDS = 4;

function Words({ items, preceding, showSpeakers }: { items: MappedWord[]; preceding?: MappedWord; showSpeakers: boolean }) {
  let previous = preceding?.word.speaker || preceding?.word.audioSource;
  return <>{items.map(({ word, index }, i) => {
    const label = word.speaker || word.audioSource;
    const changed = showSpeakers && !!label && label !== previous;
    if (label) previous = label;
    return <Fragment key={index}>{i > 0 && " "}{changed &&
      <small className="review-voice" title={word.speaker ? "Transcript speaker" : "Separate recording audio track"}>{label}</small>}{word.text}</Fragment>;
  })}</>;
}

/** The words before, inside and after `range` on `timeline`, from the transcript pages the review already reads. */
function useCutPassage(timeline: Timeline, media: MediaAsset[], range: TimeRange, excerpt?: TimeRange, handles = 5, whole = false) {
  const window = useMemo(() => excerpt ?? withHandles(range, handles, timelineDuration(timeline)), [excerpt?.start, excerpt?.end, range.start, range.end, timeline, handles]);
  const { transcripts, loading, error, retry } = useTranscriptWindow(undefined, timeline, media, window, true);
  const parts = useMemo(() => {
    const before: MappedWord[] = [], removed: MappedWord[] = [], after: MappedWord[] = [];
    for (const word of cutWords(timeline, transcripts)) {
      const p = word.placements[0]!;
      const mid = (p.start + p.end) / 2;
      if (mid < window.start || mid >= window.end) continue;
      if (mid < range.start) before.push(word);
      else if (mid < range.end) removed.push(word);
      else after.push(word);
    }
    return whole ? { before, removed, after } : { before: before.slice(-7), removed, after: after.slice(0, 8) };
  }, [timeline, transcripts, range.start, range.end, window, whole]);
  return { ...parts, pending: loading && !transcripts.length, error, retry };
}

function speakersIn(words: MappedWord[]) {
  return new Set(words.map(({ word }) => word.speaker || word.audioSource).filter(Boolean)).size > 1;
}

/** A long removal shows its opening and closing words. */
function RemovedWords({ removed, preceding, showSpeakers }: { removed: MappedWord[]; preceding?: MappedWord; showSpeakers: boolean }) {
  const abbreviate = removed.length > 12;
  return <><Words showSpeakers={showSpeakers} preceding={preceding} items={abbreviate ? removed.slice(0, 6) : removed} />
    {abbreviate && <> … <Words showSpeakers={showSpeakers} preceding={removed.at(-7)} items={removed.slice(-6)} /></>}</>;
}

/** The removed words struck through between a few kept words either side. */
function StruckLine({ before, removed, after }: { before: MappedWord[]; removed: MappedWord[]; after: MappedWord[] }) {
  const showSpeakers = speakersIn([...before, ...removed, ...after]);
  return <p className="review-spoken review-struck">
    {before.length > 0 && <><span className="review-kept">… <Words showSpeakers={showSpeakers} items={before} /></span>{" "}</>}
    <del className="review-removed" aria-label="Removed words"><RemovedWords showSpeakers={showSpeakers} preceding={before.at(-1)} removed={removed} /></del>
    {after.length > 0 && <>{" "}<span className="review-kept"><Words showSpeakers={showSpeakers} preceding={removed.at(-1)} items={after} /> …</span></>}
  </p>;
}

/** What a staged cut takes out, in context: “… and then we <del>um, we</del> started the …”. */
export function StruckExcerpt({ timeline, media, range }: { timeline: Timeline; media: MediaAsset[]; range: TimeRange }) {
  const { before, removed, after, pending, error, retry } = useCutPassage(timeline, media, range);
  if (error) return <button className="btn-quiet" onClick={retry}>Retry transcript</button>;
  if (pending || !removed.length) return null;
  return <div className="review-passage" role="group" aria-label="Words this cut removes">
    <StruckLine before={before.slice(-CONTEXT_WORDS)} removed={removed} after={after.slice(0, CONTEXT_WORDS)} />
  </div>;
}

/** An edit card reads at least this many words either side of its cut, a whole sentence or more, and at most CONTEXT_MOST. */
const CONTEXT_LEAST = 12;
const CONTEXT_MOST = 32;
/** Up to this many removed words show struck in the cut's mark. More fold into it, and the mark gives their length instead. */
const SHOW_REMOVED = 8;
/** Seconds of transcript read either side of the cut, enough for a sentence or two. */
const PASSAGE_HANDLES = 20;

const endsSentence = ({ word }: MappedWord) => /[.?!…]["”’)\]]*$/.test(word.text.trim());

/** The kept words before a cut, back to a sentence start at least CONTEXT_LEAST words away. */
export function sentencesBefore(words: MappedWord[]) {
  let start = Math.max(0, words.length - CONTEXT_MOST);
  for (let i = words.length - 2; i >= start; i--) {
    if (endsSentence(words[i]!) && words.length - (i + 1) >= CONTEXT_LEAST) { start = i + 1; break; }
  }
  const items = words.slice(start);
  // Unless it starts right after a sentence ends, the excerpt starts partway through one.
  return { items, clipped: items.length > 0 && !(start > 0 && endsSentence(words[start - 1]!)) };
}

/** The kept words after a cut, through a sentence end at least CONTEXT_LEAST words in. */
export function sentencesAfter(words: MappedWord[]) {
  let end = Math.min(words.length, CONTEXT_MOST);
  for (let i = 0; i < end; i++) {
    if (endsSentence(words[i]!) && i + 1 >= CONTEXT_LEAST) { end = i + 1; break; }
  }
  const items = words.slice(0, end);
  return { items, clipped: items.length > 0 && !endsSentence(items.at(-1)!) };
}

const midOf = ({ placements: [p] }: MappedWord) => (p!.start + p!.end) / 2;

/** Kept words, with any that another edit removed struck more faintly. */
function KeptRun({ items, others }: { items: MappedWord[]; others: TimeRange[] }) {
  const runs: { other: boolean; items: MappedWord[] }[] = [];
  for (const word of items) {
    const mid = midOf(word);
    const other = others.some(r => mid >= r.start && mid < r.end);
    const last = runs.at(-1);
    if (last && last.other === other) last.items.push(word);
    else runs.push({ other, items: [word] });
  }
  return <>{runs.map((run, i) => {
    const words = <Words showSpeakers={false} items={run.items} />;
    return <Fragment key={run.items[0]!.index}>{i > 0 && " "}{run.other
      ? <del className="review-removed is-other" title="Another edit removes these words">{words}</del>
      : <span className="review-kept">{words}</span>}</Fragment>;
  })}</>;
}

/** Where a cut joins, and how long it ran: "✂ 3:41". Shown on its own while the words around it load. */
export function CutMark({ length }: { length: string }) {
  return <span className="edit-passage-cut"><Icon name="scissors" size={12} />{length}</span>;
}

/**
 * What a cut takes out, read in full sentences: the sentence before it, a mark where it joins, and the sentence after, so
 * the join reads as it will sound. A few removed words show struck in the mark. More fold into it, and it opens them.
 */
export function EditPassage({ timeline, media, range, length, others = [], current = false }: {
  timeline: Timeline; media: MediaAsset[]; range: TimeRange; length: string; others?: TimeRange[]; current?: boolean;
}) {
  const { before, removed, after, pending, error, retry } = useCutPassage(timeline, media, range, undefined, PASSAGE_HANDLES, true);
  const [open, setOpen] = useState(false);
  const lead = sentencesBefore(pending ? [] : before), tail = sentencesAfter(pending ? [] : after);
  const folds = !current && removed.length > SHOW_REMOVED;
  const struck = <del className="review-removed"><Words showSpeakers={false} items={removed} /></del>;
  const mark = current ? <Words showSpeakers={false} items={removed} /> : folds
    ? <button type="button" className="edit-passage-cut" aria-expanded={open} onClick={() => setOpen(o => !o)}
      title={open ? "Hide the cut words" : `Show the ${removed.length} cut words`}><Icon name="scissors" size={12} />{length}</button>
    : removed.length ? <span className="edit-passage-cut is-words" title={length}><Icon name="scissors" size={12} />{struck}</span>
    : <CutMark length={length} />;
  return <div className="edit-passage" role="group" aria-label={current ? "Words in the current passage" : "Words this cut removes"}>
    <p className="review-spoken">
      {lead.items.length > 0 && <>{lead.clipped && "… "}<KeptRun others={others} items={lead.items} />{" "}</>}
      {mark}
      {folds && open && <>{" "}{struck}</>}
      {tail.items.length > 0 && <>{" "}<KeptRun others={others} items={tail.items} />{tail.clipped && " …"}</>}
      {/* Until the words arrive the passage says so: a lone mark reads as a cut with nothing said around it. */}
      {pending && <>{" "}<span className="edit-passage-wait working-text" role="status">Loading the words…</span></>}
      {error && <>{" "}<button type="button" className="btn-quiet" onClick={retry}>Retry transcript</button></>}
    </p>
  </div>;
}
