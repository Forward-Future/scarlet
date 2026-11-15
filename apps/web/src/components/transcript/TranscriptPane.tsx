import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TranscriptionAction, useTranscriptionAvailability } from "../media/TranscriptionAction";
import { clock, clockRange, plural } from "../../lib/format";
import { mediaPlaying } from "../../lib/hotkeys";
import { player } from "../../lib/player";
import type { MediaAsset, Timeline } from "@scarlet/timeline";
import { noteThread } from "@scarlet/shared";
import { cutWords, mapWords, sourceWords, selectionRange, indexWordTimes, type MappedWord } from "../../lib/transcriptMap";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import { useUiStore, type AgentContext } from "../../stores/ui";
import { EmptyState, Icon, Spinner } from "../ui/primitives";

import { transcriptTurns } from "./transcriptTurns";
import { useTranscriptWindow } from "./useTranscriptWindow";
import { useNotePositions } from "../../lib/useNotePositions";

const emptyMedia: MediaAsset[] = [];
const WHOLE = { start: 0, end: Infinity };
/** A word as search compares it: lower case, without punctuation. */
const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
/** Where the searched words start, each a run of `length` words: every word but the last matched whole, the last from its start. */
export function findWords(words: { word: { text: string } }[], query: string) {
  const terms = query.split(/\s+/).map(bare).filter(Boolean);
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
      title={w.cut ? `Play from here · Unused in edit (source ${clock(w.word.start)})` : `Play from here · ${clock(w.placements[0]!.start)}${w.word.speaker ? ` · ${w.word.speaker}` : ""}`}>
      {w.word.text}
    </span></Fragment>;
  })}</p>;
});

/**
 * `simple` is the simple view's column beside the player, which heads the transcript itself: the pane is then the words
 * alone, set as the chat is, with no toolbar, figures, key box or notes (the chat already holds those).
 */
export function TranscriptPane({ source, draft, onAsk, simple }: { draft?: Timeline; source?: MediaAsset; onAsk(words: AgentContext): void; simple?: boolean }) {
  const project = useProjectStore(s => s.current?.project);
  const projectMedia = useProjectStore(s => s.current?.media ?? emptyMedia);
  const projectNotes = useProjectStore(s => source || simple ? undefined : s.current?.notes);
  const projectTimeline = useProjectStore(s => s.current?.timeline);
  const transcriptionAvailable = useTranscriptionAvailability();
  const openNotePopover = useUiStore((s) => s.openNotePopover);
  const setAgentContext = useUiStore((s) => s.setAgentContext);
  const focusComposer = useUiStore((s) => s.focusComposer);
  const [selected, setSelected] = useState<{ from: string; to: string } | null>(null);
  const [showKeys, setShowKeys] = useState(false);
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
  // The simple view reads the whole transcript at once, so it can be searched and scrolled end to end.
  const page = useTranscriptWindow(source, timeline, projectMedia, simple ? WHOLE : undefined);
  const { assets, transcripts, from, to } = page;
  const fps = source?.fps || project?.settings.fps || 30;
  const notePositions = useNotePositions(timeline, projectNotes, fps);
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
  // The simple view names voices only where there is more than one to tell apart.
  const hasVoices = simple ? new Set(groups.map(g => g.voice ?? "")).size > 1 : groups.some(g => g.voice);
  const indices = useMemo(() => new Map(words.map(w => [wordKey(w), w.index])), [words]);
  const selFrom = selected && indices.get(selected.from), selTo = selected && indices.get(selected.to);
  const sel = selFrom != null && selTo != null ? { from: selFrom, to: selTo } : null;
  const setSel = (span: { from: number; to: number } | null) => setSelected(span
    ? { from: wordKey(words[span.from]!), to: wordKey(words[span.to]!) } : null);
  const scrollAnchor = useRef<{ word: string; top: number } | null>(null);
  const extend = (direction: -1 | 1) => {
    if (page.loading || (direction < 0 ? !page.earlier : !page.later)) return;
    const list = listRef.current;
    const nodes = wordNodes.current;
    if (list && nodes) {
      const top = list.getBoundingClientRect().top;
      let lo = 0, hi = nodes.length;
      // Words are laid out in reading order. Avoid measuring every line above the viewport.
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (nodes[mid]!.getBoundingClientRect().bottom < top) lo = mid + 1;
        else hi = mid;
      }
      const el = nodes[lo];
      if (el) scrollAnchor.current = { word: el.dataset.wordKey!, top: el.getBoundingClientRect().top };
    }
    page.extend(direction, !!sel || dragging.current);
  };
  useLayoutEffect(() => {
    const saved = scrollAnchor.current, list = listRef.current;
    wordNodes.current = list?.querySelectorAll<HTMLElement>("[data-w]");
    keyboardStops.current = undefined;
    if (!saved || !list || page.loading) return;
    const index = indices.get(saved.word);
    const el = index !== undefined && wordNodes.current?.[index];
    if (el) list.scrollTop += el.getBoundingClientRect().top - saved.top;
    scrollAnchor.current = null;
  }, [indices, page.loading, projectNotes, notePositions.times, page.earlier, page.later]);
  useLayoutEffect(() => {
    const nodes = wordNodes.current;
    if (!nodes?.length) return;
    const at = indexWordTimes(words);
    let previous: HTMLElement | undefined;
    let near: HTMLElement[] = [];
    // The simple view lights the sentence around the word the playhead is on, and the word itself more.
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
      if (simple) {
        for (const node of near) node.removeAttribute("data-near");
        near = next ? sentence(index) : [];
        for (const node of near) node.setAttribute("data-near", "");
      }
      if (!next || Date.now() - userScrolledAt.current < 2500) return;
      if (playing) next.scrollIntoView({ block: "center", behavior: "smooth" });
      else if (simple && listRef.current) {
        // Moved by a pick on the timeline or a skip: brought into view if it went out of it.
        const box = listRef.current.getBoundingClientRect(), word = next.getBoundingClientRect();
        if (word.top < box.top || word.bottom > box.bottom) next.scrollIntoView({ block: "center" });
      }
    };
    update(usePlayerStore.getState());
    const unsubscribe = usePlayerStore.subscribe(update);
    return () => { unsubscribe(); previous?.removeAttribute("data-current"); for (const node of near) node.removeAttribute("data-near"); };
  }, [words]);

  const terms = query.trim().split(/\s+/).filter(Boolean).length;
  const hits = useMemo(() => simple ? findWords(words, query) : [], [simple, words, query]);
  const shownHit = hits.length ? Math.min(hit, hits.length - 1) : -1;
  // Matches are marked on the words themselves, so the paragraphs aren't drawn again on each key.
  useLayoutEffect(() => {
    const nodes = wordNodes.current;
    if (!nodes || !hits.length) return;
    const marked: HTMLElement[] = [];
    hits.forEach((start, n) => {
      for (let k = 0; k < terms; k++) {
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
  const status = assets.filter(asset => !asset.transcriptId).map(asset => (
    <div key={asset.id} className={simple ? "transcript-missing" : "flex flex-wrap items-center gap-2 px-4 py-2 text-[12px]"}>
      <span className="text-muted">{asset.name}</span>
      <TranscriptionAction asset={asset} available={transcriptionAvailable} />
    </div>
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
  const notes = (projectNotes ?? []).flatMap(n => {
    const time = notePositions.times.get(n.id);
    return n.state !== "dismissed" && time != null && time >= from && time <= to ? [{ ...n, time }] : [];
  }).sort((a, b) => a.time - b.time);

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
  const retryNotes = notePositions.failed && <button className="btn-quiet" onClick={notePositions.retry}>Retry earlier notes</button>;
  const figures = <span className="reading-window">{clock(from)}–{clock(to)} · {plural(words.length, "word")}</span>;
  const markUnused = source && timeline && <button className="btn-quiet" onClick={() => setShowCut(v => !v)} aria-pressed={showCut}>Mark unused words</button>;
  const help = <button className="btn-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" aria-expanded={showKeys} onClick={() => setShowKeys(v => !v)}>
    <Icon name="help" size={15} />
  </button>;

  return (
    <div className="flex flex-col h-full" onMouseUp={() => (dragging.current = false)} onMouseLeave={() => (dragging.current = false)}>
      {!simple ? <div className="reading-toolbar">
        {retryNotes}
        <div className="reading-title"><h2>Transcript</h2><span>{source?.name ?? "Current edit · playback order"}</span></div>
        <div className="reading-tools">{figures}{markUnused}{help}</div>
      </div> : <div className="transcript-search">
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
      </div>}
      {showKeys && <div className="reading-keys"><span><kbd>← →</kbd> Move</span><span><kbd>Shift + ← →</kbd> Select</span><span><kbd>Enter</kbd> Play from word</span></div>}
      {/* In the simple view a file with no transcript yet is said after the words, not over them. */}
      {!simple && status}
      {page.loading && <p role="status" className="px-4"><Spinner /> Loading transcript…</p>}
      {page.error && <p role="alert" className="px-4">{page.error} <button className="btn-ghost" onClick={page.retry}>Retry transcript</button></p>}
      {!page.loading && !page.error && !words.length && !status.length && <p className="p-4 text-muted">No spoken words here.</p>}
      {range && sel && simple && <div className="transcript-chosen">
        <span>{clockRange(range.start, range.end)}</span>
        <button type="button" className="simple-link" onClick={() => askAboutSelection()}>Ask about this</button>
        <button type="button" className="simple-link simple-link-quiet" onClick={() => setSel(null)}>Clear</button>
      </div>}
      {range && sel && !simple && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-hi-dim border-b border-line text-[12px]">
          <span className="font-mono tnum text-fg">
            {clockRange(range.start, range.end)}
          </span>
          <div className="flex-1" />
          {!source && !draft && <button
            className="btn-ghost py-1"
            onClick={() => {
              openNotePopover(range.start, range.end);
              setSel(null);
            }}
          >
            <Icon name="note" size={12} /> Note
          </button>}
          <button
            className="btn-primary py-1"
            onClick={() => askAboutSelection()}
          >
            Ask about this
          </button>
          <button className="btn-icon" aria-label="Clear selection" title="Clear selection" onClick={() => setSel(null)}>
            <Icon name="x" size={11} />
          </button>
        </div>
      )}
      <div ref={listRef} tabIndex={0} role="group" aria-label="Transcript words and notes"
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
          // In the simple view a click places the playhead on the word; Space plays from there.
          if (w && !moved.current && !e.shiftKey) { setSel(null); if (simple) { if (w.placements[0]) seek(w.placements[0].start); } else playWord(w); }
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
        className={simple ? "reading-scroll transcript-words" : "reading-scroll"}
        title={simple ? "Click a word to play from it · Double-click or drag to choose words · Shift + ← → to select" : undefined} onScroll={e => {
          userScrolledAt.current = Date.now();
          const el = e.currentTarget;
          if (el.scrollHeight <= el.clientHeight) return;
          if (el.scrollTop <= 1) extend(-1);
          else if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) extend(1);
        }}>
        {page.earlier && <button className="btn-quiet" onClick={() => extend(-1)}>Load earlier words</button>}
        {groups.map((g, gi) => {
          const start = g.words[0]?.placements[0]?.start ?? -1;
          const nextStart = groups[gi + 1]?.words[0]?.placements[0]?.start ?? Infinity;
          const here = start < 0 ? [] : notes.filter((n) => n.time >= (gi === 0 ? -Infinity : start) && n.time < nextStart);
          const first = g.words[0];
          if (!first) return null;
          return (
            <div className="reading-turn" key={wordKey(first)}>
            {!source && (simple ? new Set(words.map(w => w.mediaId)).size : assets.length) > 1 && first?.mediaId !== groups[gi - 1]?.words[0]?.mediaId && (
              <p className="mt-2 mb-1 text-xs text-muted">{assets.find(asset => asset.id === first?.mediaId)?.name}</p>
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
            {here.map((n) => (
              <button
                key={n.id}
                tabIndex={-1}
                onClick={() => seek(n.time)}
                className={`mb-3 block w-full text-left rounded-r-lg border-l-2 px-3 py-2 text-[12px] leading-snug ${n.state === "resolved" ? "border-dim bg-raised/40 text-dim" : "border-warn bg-warn/5 text-muted"}`}
              >
                <span className="font-medium text-fg">{n.author.name} · {clock(n.time)}</span> {noteThread(n).text}
                {n.state === "in_progress" && <span className="block mt-1 text-fg">With Scarlet</span>}
                {n.state === "resolved" && <span className="block mt-1">Done</span>}
              </button>
            ))}
            </div>
          );
        })}
        {page.later && <button className="btn-quiet" onClick={() => extend(1)}>Load later words</button>}
      </div>
    </div>
  );
}
