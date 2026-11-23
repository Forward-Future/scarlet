import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { isComposing } from "../../lib/hotkeys";
import { Icon } from "../ui/primitives";

interface SkillMatch { start: number; end: number }

function findMatches(text: string, query: string): SkillMatch[] {
  if (!query) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(text.matchAll(new RegExp(literal, "giu")), match => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function substitute(text: string, matches: readonly SkillMatch[], replacement: string) {
  let result = "";
  let offset = 0;
  for (const match of matches) {
    result += text.slice(offset, match.start) + replacement;
    offset = match.end;
  }
  return result + text.slice(offset);
}

export interface SkillFindState {
  matches: readonly SkillMatch[];
  activeIndex: number;
}

export function normalizeSkillLines(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

/** Preserve the existing text runs when a match spans multiple keyword or version-change marks. */
export function markSkillMatches(text: string, from: number, find: SkillFindState | undefined): ReactNode {
  if (!find?.matches.length || !text) return text;
  const { matches, activeIndex } = find;
  let first = 0;
  let last = matches.length;
  while (first < last) {
    const mid = (first + last) >>> 1;
    if (matches[mid]!.end <= from) first = mid + 1;
    else last = mid;
  }
  const parts: ReactNode[] = [];
  let offset = 0;
  for (let index = first; index < matches.length; index++) {
    const { start, end } = matches[index]!;
    if (start >= from + text.length) break;
    const left = Math.max(0, start - from), right = Math.min(text.length, end - from);
    parts.push(text.slice(offset, left), <mark key={left} className="skill-find-match"
      data-active={index === activeIndex || undefined}>{text.slice(left, right)}</mark>);
    offset = right;
  }
  return offset ? [...parts, text.slice(offset)] : text;
}

export function revealSkillMatch(pane: HTMLElement, scroll: HTMLElement = pane) {
  const mark = pane.querySelector<HTMLElement>(".skill-find-match[data-active]");
  const line = mark?.getClientRects()[0];
  const bounds = pane.getBoundingClientRect();
  if (line && (line.top < bounds.top || line.bottom > bounds.bottom)) {
    scroll.scrollTop += line.top - bounds.top - scroll.clientHeight / 2;
    pane.scrollTop = scroll.scrollTop;
  }
}

export function useSkillFind({ text, readOnly, onChange, scope, editor }: {
  text: string;
  readOnly: boolean;
  onChange(value: string): void;
  scope: RefObject<HTMLElement | null>;
  editor: RefObject<HTMLTextAreaElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [index, setIndex] = useState(0);
  const [receipt, setReceipt] = useState<{ before: string; after: string; index: number; count: number }>();
  const field = useRef<HTMLInputElement>(null);
  const replacementField = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const replacementId = useId();
  const displayText = useMemo(() => normalizeSkillLines(text), [text]);
  const matches = useMemo(() => open ? findMatches(displayText, query) : [], [open, displayText, query]);
  const activeIndex = Math.min(index, matches.length - 1);
  const active = matches[activeIndex];
  const last = !readOnly && receipt?.after === text ? receipt : undefined;
  const replacing = replaceOpen && !readOnly;

  function focusFind() {
    field.current?.focus();
    field.current?.select();
  }

  useLayoutEffect(() => { if (open) focusFind(); }, [open]);
  useLayoutEffect(() => { if (replacing) replacementField.current?.focus(); }, [replacing]);
  useEffect(() => {
    if (!readOnly) return;
    setReplaceOpen(false);
    setReceipt(undefined);
  }, [readOnly]);
  useEffect(() => {
    if (receipt && receipt.after !== text) setReceipt(undefined);
  }, [receipt, text]);

  function close() {
    setOpen(false);
    setReplaceOpen(false);
    const area = editor.current;
    if (!area) {
      requestAnimationFrame(() => openButton.current?.focus());
      return;
    }
    if (document.activeElement === area) return;
    area.focus({ preventScroll: true });
    if (active) area.setSelectionRange(active.start, active.end);
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const owner = scope.current;
      if (!owner || event.defaultPrevented || isComposing(event) || event.altKey || event.shiftKey) return;
      const find = event.key.toLowerCase() === "f" && event.metaKey !== event.ctrlKey;
      const escape = open && event.key === "Escape" && !event.metaKey && !event.ctrlKey;
      if (!find && !escape) return;
      if ([...document.querySelectorAll('dialog[open], [role="menu"], [data-shortcut-overlay]')]
        .some(layer => !layer.contains(owner))) return;
      event.preventDefault();
      if (find) {
        if (open) focusFind();
        else setOpen(true);
      } else close();
    }
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [open, active, scope, editor]);

  function step(direction: -1 | 1) {
    if (matches.length) setIndex((activeIndex + direction + matches.length) % matches.length);
  }

  function apply(all: boolean) {
    if (!active || readOnly) return;
    // Selection ranges are measured against the visible LF-normalized text. Splice the original
    // body so replacement preserves the line endings of existing skills.
    const original = findMatches(text, query);
    const selected = all ? original : [original[activeIndex]!];
    const updated = substitute(text, selected, replacement);
    if (updated === text) {
      if (!all) step(1);
      return;
    }
    const remaining = findMatches(normalizeSkillLines(updated), query);
    const following = all ? 0 : remaining.findIndex(match => match.start >= active.start + replacement.length);
    setIndex(Math.max(0, following));
    setReceipt({ before: text, after: updated, index: activeIndex, count: selected.length });
    onChange(updated);
    if (!remaining.length) field.current?.focus();
  }

  function undo() {
    if (!last) return;
    onChange(last.before);
    setIndex(last.index);
    setReceipt(undefined);
    (replacementField.current ?? field.current ?? editor.current ?? openButton.current)?.focus();
  }

  const controls = open ? <div className="skill-find" role="search" aria-label="Skill instructions">
    <div className="skill-find-row">
      {!readOnly && <button type="button" className="btn-icon" aria-label={replacing ? "Hide replace" : "Show replace"}
        title={replacing ? "Hide replace" : "Show replace"} aria-expanded={replacing} aria-controls={replacementId}
        onClick={() => setReplaceOpen(!replaceOpen)}><Icon name={replacing ? "down" : "chevron"} size={14} /></button>}
      <input ref={field} className="field" aria-label="Find in skill" placeholder="Find in skill…" value={query} spellCheck={false}
        onChange={e => { setQuery(e.target.value); setIndex(0); }}
        onKeyDown={e => {
          if (e.key !== "Enter" || isComposing(e)) return;
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }} />
      <span className="skill-find-count" role="status">{query && (matches.length ? `${activeIndex + 1} of ${matches.length}` : "No matches")}</span>
      <button type="button" className="btn-icon" aria-label="Previous match" title="Previous match (Shift+Enter)"
        disabled={matches.length < 2} onClick={() => step(-1)}><span className="rotate-180"><Icon name="down" size={14} /></span></button>
      <button type="button" className="btn-icon" aria-label="Next match" title="Next match (Enter)"
        disabled={matches.length < 2} onClick={() => step(1)}><Icon name="down" size={14} /></button>
      <button type="button" className="btn-icon" aria-label="Close find" title="Close find (Esc)"
        onClick={close}><Icon name="x" size={13} /></button>
    </div>
    {!readOnly && <div className="skill-find-replace" id={replacementId} hidden={!replacing}>
      {replacing &&
      <div className="skill-find-row">
        <input ref={replacementField} className="field" aria-label="Replace with" placeholder="Replace with…" value={replacement}
          spellCheck={false} onChange={e => setReplacement(e.target.value)} onKeyDown={e => {
            if (e.key !== "Enter" || isComposing(e)) return;
            e.preventDefault();
            apply(false);
          }} />
        <button type="button" className="btn-ghost" title="Replace the highlighted match" disabled={!active} onClick={() => apply(false)}>Replace</button>
        <button type="button" className="btn-ghost" disabled={!active} onClick={() => apply(true)}>Replace All</button>
      </div>}
    </div>}
  </div> : <button ref={openButton} type="button" className="btn-quiet skill-find-trigger" aria-label="Find in skill"
    title="Find in skill (⌘F / Ctrl+F)" aria-keyshortcuts="Meta+F Control+F" onClick={() => setOpen(true)}>
    <Icon name="search" size={14} />Find
  </button>;

  const feedback = last && <div className="skill-find-feedback">
    <span role="status">Replaced {last.count} {last.count === 1 ? "match" : "matches"}</span>
    <button type="button" className="simple-link" onClick={undo}>Undo</button>
  </div>;
  return { controls, feedback, matches, activeIndex };
}
