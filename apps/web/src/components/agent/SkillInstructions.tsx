import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Skill } from "@scarlet/shared";
import { useSkillsStore } from "../../stores/skills";
import { markSkillMatches, normalizeSkillLines, revealSkillMatch, type SkillFindState } from "./SkillFind";

/** A `/skill` the library has, where it is in the text. Words the library has no skill for stay plain. */
function keywordSpans(text: string, skills: readonly Pick<Skill, "name">[]) {
  const names = new Set(skills.map(s => s.name));
  return Array.from(text.matchAll(/(^|[^\w/])\/([a-z0-9][a-z0-9-]*)/gi), m => {
    const name = m[2]!;
    const start = m.index + m[1]!.length;
    return names.has(name) ? { start, end: start + 1 + name.length, name } : undefined;
  }).filter(k => !!k);
}

/** The text with each keyword in a faint fill, so the editor can tell a skill of theirs from plain words. */
export function MarkedKeywords({ text, skills }: { text: string; skills?: readonly Skill[] }) {
  const librarySkills = useSkillsStore(s => s.skills);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const k of keywordSpans(text, skills ?? librarySkills)) {
    parts.push(text.slice(at, k.start), <span key={k.start} className="skill-keyword">{text.slice(k.start, k.end)}</span>);
    at = k.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

interface Props {
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
  placeholder?: string;
  describedBy?: string;
  className: string;
  box?: RefObject<HTMLTextAreaElement | null>;
  find?: SkillFindState;
}

/**
 * A skill's instructions, as the editor writes them. A `/skill` of theirs has a faint fill and says what it is on hover.
 */
export function SkillInstructions({ value: body, onChange, readOnly, placeholder, describedBy, className, box: editor, find }: Props) {
  const localBox = useRef<HTMLTextAreaElement>(null);
  const box = editor ?? localBox;
  const value = useMemo(() => normalizeSkillLines(body), [body]);
  const backdrop = useRef<HTMLDivElement>(null);
  const skills = useSkillsStore(s => s.skills);
  const skillStatus = useSkillsStore(s => s.status);
  const loadSkills = useSkillsStore(s => s.load);
  // The keyword under the pointer: `at` tells two of the same name apart, so the note follows the one pointed at.
  const [hover, setHover] = useState<{ name: string; at: number; left: number; top: number } | null>(null);

  // Keywords are known by the library's skills, so they are read as the page opens.
  useEffect(() => { if (skillStatus === "idle") void loadSkills(); }, [skillStatus, loadSkills]);

  useLayoutEffect(() => {
    const pane = backdrop.current, field = box.current;
    if (!pane || !field || !find || find.activeIndex < 0) return;
    const reveal = () => {
      // A classic scrollbar consumes part of the field's width. Match it before measuring the highlighted text.
      pane.style.width = `${field.clientWidth + pane.offsetWidth - pane.clientWidth}px`;
      pane.scrollTop = field.scrollTop;
      revealSkillMatch(pane, field);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(field);
    return () => {
      observer.disconnect();
      pane.style.width = "";
    };
  }, [box, find?.activeIndex, find?.matches]);

  // The text drawn under the field: the same words, with each keyword's fill.
  const marked: ReactNode[] = [];
  let at = 0;
  for (const k of keywordSpans(value, skills)) {
    if (at < k.start) marked.push(<Fragment key={at}>{markSkillMatches(value.slice(at, k.start), at, find)}</Fragment>);
    marked.push(<span key={k.start} className={`skill-keyword${hover?.at === k.start ? " is-hover" : ""}`} data-keyword={k.name} data-at={k.start}>
      {markSkillMatches(value.slice(k.start, k.end), k.start, find)}
    </span>);
    at = k.end;
  }
  if (at < value.length) marked.push(<Fragment key={at}>{markSkillMatches(value.slice(at), at, find)}</Fragment>);

  /** The keyword under the pointer, from the text drawn under the field. */
  function pointAt(x: number, y: number) {
    for (const el of backdrop.current?.querySelectorAll<HTMLElement>("[data-keyword]") ?? []) {
      for (const r of el.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const outer = backdrop.current!.parentElement!.getBoundingClientRect();
          return { name: el.dataset.keyword!, at: Number(el.dataset.at), left: r.left - outer.left, top: r.top - outer.top };
        }
      }
    }
    return null;
  }

  const hoverDescription = hover && skills.find(s => s.name === hover.name)?.description;

  return <div className="skill-instructions">
    <div ref={backdrop} className={`${className} skill-instructions-text`} aria-hidden="true">{marked}{"​"}</div>
    <textarea ref={box} className={`${className} skill-instructions-field`} value={value} readOnly={readOnly} placeholder={placeholder}
      aria-label="Skill markdown" aria-describedby={describedBy} spellCheck={false}
      onScroll={e => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; setHover(null); }}
      onMouseMove={e => {
        // Another keyword, or the same one in another place or on another line of it, moves the note there.
        const next = pointAt(e.clientX, e.clientY);
        if (next?.at !== hover?.at || next?.name !== hover?.name || next?.left !== hover?.left || next?.top !== hover?.top) setHover(next);
      }}
      onMouseLeave={() => setHover(null)}
      onChange={e => onChange(e.target.value)} />
    {hover && <div className="skill-keyword-note" role="tooltip" style={{ left: hover.left - 6, top: hover.top - 6 }}>
      <span className="skill-keyword-words"><span>/{hover.name}</span>
        <small>Skill{hoverDescription ? ` · ${hoverDescription}` : ""}</small></span>
    </div>}
  </div>;
}
