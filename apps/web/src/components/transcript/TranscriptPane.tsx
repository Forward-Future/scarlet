import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TranscriptionStatus } from "../media/TranscriptionAction";
import { clock, clockRange } from "../../lib/format";
import { mediaPlaying } from "../../lib/hotkeys";
import { player } from "../../lib/player";
import type { MediaAsset, Timeline } from "@scarlet/timeline";
import { cutWords, mapWords, sourceWords, selectionRange, indexWordTimes, type MappedWord } from "../../lib/transcriptMap";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import { useUiStore, type AgentContext } from "../../stores/ui";
import { EmptyState, Icon, Spinner } from "../ui/primitives";

import { transcriptTurns } from "./transcriptTurns";
import { useTranscriptWindow } from "./useTranscriptWindow";

const emptyMedia: MediaAsset[] = [];
const WHOLE = { start: 0, end: Infinity };
/** A word as search compares it: lower case, without punctuation. */
const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
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

const wordKey = (w: MappedWord) => JSON.stringify([w.mediaId, w.segmentId, w.indexInSegment]);

// Word text and timing stay fixed across playback, project updates and selections in other paragraphs.
const WordParagraph = memo(function WordParagraph({ words, from, to }: {
  words: MappedWord[]; from: number; to: number;
}) {
  return <p className="reading-passage">{words.map((w, i) => {
    const key = wordKey(w);
    return <Fragment key={key}>{i > 0 && " "}<span data-w={w.index} data-word-key={key} role="button" tabIndex={-1}
      aria-label={w.cut ? `${w.word.text} (unused in edit)` : w.word.text}
      className={`rounded px-[2px] py-0.5 -mx-px cursor-pointer hover:bg-raised data-[current]:bg-hi data-[current]:text-bg data-[current]:hover:bg-hi ${w.cut ? "line-through text-dim decoration-dim/70" : "text-fg"} ${w.index >= from && w.index <= to ? "bg-hi-dim" : ""}`}
      title={w.cut ? `Unused in edit · source ${clock(w.word.start)}` : `${clock(w.placements[0]!.start)}${w.word.speaker ? ` · ${w.word.speaker}` : ""}`}>
      {w.word.text}
    </span></Fragment>;
  })}</p>;
});

/**
 * The simple view's Transcript column beside the player, which heads it: a search field, then the words alone, set as
 * the chat is, with no toolbar, figures, key box or notes (the chat already holds those).
 */
export function TranscriptPane({ source, draft, onAsk }: { draft?: Timeline; source?: MediaAsset; onAsk(words: AgentContext): void }) {
  const project = useProjectStore(s => s.current?.project);
  const projectMedia = useProjectStore(s => s.current?.media ?? emptyMedia);
  const projectTimeline = useProjectStore(s => s.current?.timeline);
  const setAgentContext = useUiStore((s) => s.setAgentContext);
  const focusComposer = useUiStore((s) => s.focusComposer);
  const [selected, setSelected] = useState<{ from: string; to: string } | null>(null);
  const [showCut, setShowCut] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const dragging = useRef(false);
  const anchor = useRef<string | null>(null);
  const moved = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const wordNodes = useRef<NodeListOf<HTMLElement> | undefined>(undefined);
  const keyboardStops = useRef<HTMLElement[] | undefined>(undefined);
  const userScrolledAt = useRef(0);

  const timeline = draft ?? projectTimeline ?? null;
  // The whole transcript is read at once, so it can be searched and scrolled end to end.
  const page = useTranscriptWindow(source, timeline, projectMedia, WHOLE);
  const { assets, transcripts, from, to } = page;
  const words = useMemo(() => {
    let mapped: MappedWord[] = [];
    if (source && transcripts[0]) {
      mapped = sourceWords(transcripts[0]);
      if (showCut && timeline) {
        const cut = mapWords(transcripts[0], timeline, source.id);
        mapped = mapped.map((word, i) => ({ ...word, cut: cut[i]!.cut }));
      }
    } else if (timeline) mapped = cutWords(timeline, transcripts);
    return mapped.filter(w => {
      const p = w.placements[0]!;
      return p.start < to && (p.end > from || p.start >= from);
    }).map((w, index) => ({ ...w, index }));
  }, [transcripts, source, showCut, timeline, from, to]);
  const groups = useMemo(() => transcriptTurns(words), [words]);
  // Voices are named only where there is more than one to tell apart.
  const hasVoices = useMemo(() => new Set(groups.map(g => g.voice ?? "")).size > 1, [groups]);
  // Recordings are named only where the words come from more than one.
  const severalRecordings = useMemo(() => !source && new Set(words.map(w => w.mediaId)).size > 1, [source, words]);
  const indices = useMemo(() => new Map(words.map(w => [wordKey(w), w.index])), [words]);
  const selFrom = selected && indices.get(selected.from), selTo = selected && indices.get(selected.to);
  const sel = selFrom != null && selTo != null ? { from: selFrom, to: selTo } : null;
  const setSel = (span: { from: number; to: number } | null) => setSelected(span
    ? { from: wordKey(words[span.from]!), to: wordKey(words[span.to]!) } : null);
  useLayoutEffect(() => {
    wordNodes.current = listRef.current?.querySelectorAll<HTMLElement>("[data-w]");
    keyboardStops.current = undefined;
  }, [indices, page.loading]);
  useLayoutEffect(() => {
    const nodes = wordNodes.current;
    if (!nodes?.length) return;
    const at = indexWordTimes(words);
    let previous: HTMLElement | undefined;
    let near: HTMLElement[] = [];
    // The sentence around the word the playhead is on is lit, and the word itself more.
    const sentence = (i: number) => {
      const ends = (k: number) => /[.?!…]["”’)]*$/.test(words[k]?.word.text ?? "");
      let a = i, b = i;
      while (a > 0 && i - a < 30 && !ends(a - 1)) a--;
      while (b < words.length - 1 && b - i < 30 && !ends(b)) b++;
      return Array.from({ length: b - a + 1 }, (_, k) => nodes[a + k]!).filter(Boolean);
    };
    const update = ({ time, playing }: ReturnType<typeof usePlayerStore.getState>) => {
      const index = at(time);
      const next = nodes[index];
      if (next === previous) return;
      previous?.removeAttribute("data-current");
      next?.setAttribute("data-current", "");
      previous = next;
      for (const node of near) node.removeAttribute("data-near");
      near = next ? sentence(index) : [];
      for (const node of near) node.setAttribute("data-near", "");
      if (!next || Date.now() - userScrolledAt.current < 2500) return;
      if (playing) next.scrollIntoView({ block: "center", behavior: "smooth" });
      else if (listRef.current) {
        // Moved by a pick on the timeline or a skip: brought into view if it went out of it.
        const box = listRef.current.getBoundingClientRect(), word = next.getBoundingClientRect();
        if (word.top < box.top || word.bottom > box.bottom) next.scrollIntoView({ block: "center" });
      }
    };
    update(usePlayerStore.getState());
    const unsubscribe = usePlayerStore.subscribe(update);
    return () => { unsubscribe(); previous?.removeAttribute("data-current"); for (const node of near) node.removeAttribute("data-near"); };
  }, [words]);

  // One list of terms both finds the matches and says how many words each one underlines.
  const terms = useMemo(() => searchTerms(query), [query]);
  const hits = useMemo(() => findWords(words, terms), [words, terms]);
  const shownHit = hits.length ? Math.min(hit, hits.length - 1) : -1;
  // Matches are marked on the words themselves, so the paragraphs aren't drawn again on each key.
  useLayoutEffect(() => {
    const nodes = wordNodes.current;
    if (!nodes || !hits.length) return;
    const marked: HTMLElement[] = [];
    hits.forEach((start, n) => {
      for (let k = 0; k < terms.length; k++) {
        const node = nodes[start + k];
        if (!node) continue;
        node.setAttribute("data-match", n === shownHit ? "current" : "");
        marked.push(node);
      }
    });
    // The match in hand is kept in view as the search is typed and stepped through.
    if (shownHit >= 0) { userScrolledAt.current = Date.now(); nodes[hits[shownHit]!]?.scrollIntoView({ block: "center" }); }
    return () => { for (const node of marked) node.removeAttribute("data-match"); };
  }, [hits, shownHit, terms, words]);
  // Enter places the playhead on the match in view, then steps on to the next; Space plays from the words found.
  const placed = useRef(false);
  const goToHit = (step: 1 | -1) => {
    if (!hits.length) return;
    const next = placed.current ? (shownHit + step + hits.length) % hits.length : shownHit;
    placed.current = true;
    setHit(next);
    const word = words[hits[next]!];
    if (word?.placements[0]) player.seek(word.placements[0].start);
  };

  if (!project) return null;
  if (!assets.length) return <EmptyState icon="diff" title="No speech media in this edit" body="The transcript follows audio and video clips with audible sound." />;
  // A file with no transcript yet is said after the words, plainly: Media is where a transcription is started.
  const status = assets.filter(asset => !asset.transcriptId).map(asset => (
    <p key={asset.id} className="transcript-missing">
      <span className="text-muted">{asset.name}</span>
      <TranscriptionStatus asset={asset} />
    </p>
  ));

  const range = sel ? selectionRange(words, sel.from, sel.to) : null;
  const selectedFrom = sel ? Math.min(sel.from, sel.to) : -1;
  const selectedTo = sel ? Math.max(sel.from, sel.to) : -1;
  const wordAt = (target: EventTarget) => {
    const index = target instanceof HTMLElement ? target.dataset.w : undefined;
    return index === undefined ? undefined : words[Number(index)];
  };

  const seek = (at: number) => player.seek(at);

  const playWord = (word: MappedWord) => {
    const placement = word.placements[0];
    if (!placement) return;
    player.seek(placement.start);
    player.play();
  };

  const onWordDown = (i: number, shift: boolean) => {
    dragging.current = true;
    const start = anchor.current && indices.get(anchor.current);
    if (shift && typeof start === "number") {
      setSel({ from: start, to: i });
    } else {
      anchor.current = wordKey(words[i]!);
      setSel(null);
    }
    moved.current = false;
  };
  const onWordEnter = (i: number) => {
    const start = anchor.current && indices.get(anchor.current);
    if (dragging.current && typeof start === "number" && i !== start) {
      moved.current = true;
      setSel({ from: start, to: i });
    }
  };

  const askAboutSelection = () => {
    if (!range) return;
    const selection = words.slice(selectedFrom, selectedTo + 1);
    const selText = selection.map(w => w.word.text).join(" ");
    const clipIds = [...new Set(selection.flatMap(w => w.placements.flatMap(p => p.clipId ? [p.clipId] : [])))];
    const asked: AgentContext = { version: draft?.version ?? project.head ?? undefined, time: range.start, end: range.end, clipIds: source ? [] : clipIds, ...(source && { mediaId: source.id }), label: `“${selText.length > 40 ? `${selText.slice(0, 37)}…` : selText}”` };
    setAgentContext(asked);
    // The page can aim the box further: words inside a call that's open are about that call.
    onAsk(asked);
    focusComposer();
    setSel(null);
  };
  const markUnused = source && timeline && <button className="btn-quiet" onClick={() => setShowCut(v => !v)} aria-pressed={showCut}>Mark unused words</button>;

  return (
    <div className="flex flex-col h-full" onMouseUp={() => (dragging.current = false)} onMouseLeave={() => (dragging.current = false)}>
      <div className="transcript-search">
        <Icon name="search" size={13} />
        <input type="search" value={query} placeholder="Search the transcript" aria-label="Search the transcript"
          onChange={e => { setQuery(e.target.value); setHit(0); placed.current = false; }}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); goToHit(e.shiftKey ? -1 : 1); }
            else if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
          }} />
        {query.trim() && <span className="transcript-search-count" title="Enter for the next, Shift + Enter for the one before">
          {hits.length ? `${shownHit + 1} of ${hits.length}` : "No matches"}</span>}
        {markUnused}
      </div>
      {page.loading && <p role="status" className="px-4"><Spinner /> Loading transcript…</p>}
      {page.error && <p role="alert" className="px-4">{page.error} <button className="btn-ghost" onClick={page.retry}>Retry transcript</button></p>}
      {!page.loading && !page.error && !words.length && !status.length && <p className="p-4 text-muted">No spoken words here.</p>}
      {range && sel && <div className="transcript-chosen">
        <span>{clockRange(range.start, range.end)}</span>
        <button type="button" className="simple-link" onClick={() => askAboutSelection()}>Ask about this</button>
        <button type="button" className="simple-link simple-link-quiet" onClick={() => setSel(null)}>Clear</button>
      </div>}
      <div ref={listRef} tabIndex={0} role="group" aria-label="Transcript words"
        onMouseDown={e => {
          const word = wordAt(e.target);
          if (!word) return;
          e.preventDefault();
          onWordDown(word.index, e.shiftKey);
        }}
        onMouseOver={e => { const w = wordAt(e.target); if (w && dragging.current) onWordEnter(w.index); }}
        onDoubleClick={e => { const w = wordAt(e.target); if (w) setSel({ from: w.index, to: w.index }); }}
        onClick={e => {
          const w = wordAt(e.target);
          // A click places the playhead on the word; it doesn't play. Space plays from there.
          if (w && !moved.current && !e.shiftKey) { setSel(null); if (w.placements[0]) seek(w.placements[0].start); }
        }}
        onFocus={(e) => {
          if (e.target === e.currentTarget) {
            // Shift+Tab out of the words stops on the list itself on its way out. Sent back to a word from here, as
            // a Tab in from outside is, the keyboard never got out of the transcript that way.
            if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget) && e.currentTarget.matches(":focus-visible")) return;
            const target = e.currentTarget.querySelector<HTMLElement>("[data-current]") ?? e.currentTarget.querySelector<HTMLElement>("[data-w]");
            target?.focus();
          }
        }}
        onKeyDown={(e) => {
          const w = wordAt(e.target);
          // Space on a word pauses while playing, like everywhere else.
          if (w && (e.key === "Enter" || (e.key === " " && !mediaPlaying()))) {
            e.preventDefault();
            e.stopPropagation();
            playWord(w);
            return;
          }
          // A key the page has already taken is the page's: ↑ and ↓ step edits while a card is open.
          if (e.defaultPrevented || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
          const target = e.target as HTMLElement;
          let stops: NodeListOf<HTMLElement> | HTMLElement[] | undefined;
          let i: number;
          if (e.shiftKey) {
            if (!w) return;
            stops = wordNodes.current;
            i = w.index;
          } else {
            stops = keyboardStops.current ??= Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button, [data-w]"));
            i = stops.indexOf(target);
          }
          if (!stops?.length || i < 0) return;
          e.preventDefault();
          e.stopPropagation();
          const direction = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
          const next = e.key === "Home" ? stops[0] : e.key === "End" ? stops[stops.length - 1] : stops[Math.max(0, Math.min(stops.length - 1, i + direction))];
          if (!next) return;
          const from = stops[i]?.dataset.w;
          const to = next.dataset.w;
          if (e.shiftKey && from !== undefined && to !== undefined) {
            setSel({ from: sel?.from ?? Number(from), to: Number(to) });
          } else if (!e.shiftKey) {
            setSel(null);
          }
          next.focus();
        }}
        className="reading-scroll transcript-words"
        title="Click a word to place the playhead there · Double-click or drag to choose words · Shift + ← → to select"
        onScroll={() => { userScrolledAt.current = Date.now(); }}>
        {groups.map((g, gi) => {
          const first = g.words[0];
          if (!first) return null;
          return (
            <div className="reading-turn" key={wordKey(first)}>
            {severalRecordings && first.mediaId !== groups[gi - 1]?.words[0]?.mediaId && (
              <p className="mt-2 mb-1 text-xs text-muted">{assets.find(asset => asset.id === first.mediaId)?.name}</p>
            )}
            <div className="reading-turn-head">
              {hasVoices && <span className="reading-speaker" data-known={!!g.voice}>
                <i aria-hidden="true" data-tone={g.voice === "me" ? "host" : g.voice ? String((g.tone ?? 0) % 4) : "unknown"} />
                {g.voice || "Voice unclear"}
              </span>}
              {first.placements[0] && (
                <button tabIndex={-1} className="reading-time" onClick={() => seek(first.placements[0]!.start)} aria-label={`Seek to ${clock(first.placements[0].start)}`}>
                  {clock(first.placements[0].start)}
                </button>
              )}
            </div>
            {g.paragraphs.map(paragraph => {
              const first = paragraph[0]!, last = paragraph.at(-1)!;
              const overlaps = selectedFrom <= last.index && selectedTo >= first.index;
              return <WordParagraph key={wordKey(first)} words={paragraph}
                from={overlaps ? Math.max(selectedFrom, first.index) : -1} to={overlaps ? Math.min(selectedTo, last.index) : -1} />;
            })}
            </div>
          );
        })}
        {status}
      </div>
    </div>
  );
}
