import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Skill, StyleGuideRecord } from "@scarlet/shared";
import type { MessageTimestamp } from "../../lib/messageTimestamps";
import { isComposing } from "../../lib/hotkeys";
import { skillCommands, useSkillsStore } from "../../stores/skills";
import { styleGuideCommands, useStyleGuidesStore } from "../../stores/styleGuides";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";
import { useTokenList } from "./useTokenList";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  skills: Skill[];
  id: string;
  placeholder: string;
  timestamps?: MessageTimestamp[];
  onTimestamp?(time: number): void;
  onChange(value: string): void;
  onSubmit(): void;
  /** No list opens: a skill's own page has no skills to pick. */
  plain?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * The message box's text, with the list that opens over it as the editor types: `/` lists the editing skills. What
 * follows the sign filters the list, ↑ ↓ light a row, Enter or Tab puts its name in the box and Esc puts the list away.
 */
export function SkillCommandInput({ inputRef, value, skills, id, placeholder, timestamps, onTimestamp, onChange, onSubmit, plain, disabled, ariaLabel }: Props) {
  const list = useTokenList(inputRef, value, onChange);
  const { caret, index } = list;
  const [, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const listId = useId();
  const activeRow = useRef<HTMLButtonElement>(null);
  const status = useSkillsStore(s => s.status);
  const load = useSkillsStore(s => s.load);
  const styleGuidesBeta = useUiStore(s => s.styleGuidesBeta);
  const styleGuides = useStyleGuidesStore(s => s.styleGuides);
  const styleStatus = useStyleGuidesStore(s => s.status);
  const loadStyleGuides = useStyleGuidesStore(s => s.load);

  const skillToken = caret === null || plain ? undefined : skillCommands(value).find(t => t.start < caret && caret <= t.end);
  const styleToken = caret === null || plain || skillToken || !styleGuidesBeta ? undefined : styleGuideCommands(value).find(t => t.start < caret && caret <= t.end);
  const mode: "skill" | "style" | null = skillToken ? "skill" : styleToken ? "style" : null;
  const token = skillToken ?? styleToken;
  const open = list.focused && !list.dismissed && !!token;
  const query = token && caret !== null ? value.slice(token.start + 1, caret).toLowerCase() : "";

  const skillMatches = open && mode === "skill"
    ? skills.filter(s => s.name.includes(query) || s.description.toLowerCase().includes(query))
      .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)))
    : [];
  const styleMatches = open && mode === "style"
    ? styleGuides.filter(g => g.name.includes(query) || g.description.toLowerCase().includes(query))
      .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)) || Number(b.isDefault) - Number(a.isDefault))
    : [];
  const matchCount = mode === "style" ? styleMatches.length : skillMatches.length;
  const activeIndex = list.activeIndex(matchCount);
  const activeSkill: Skill | undefined = mode === "skill" ? skillMatches[activeIndex] : undefined;
  const activeStyle: StyleGuideRecord | undefined = mode === "style" ? styleMatches[activeIndex] : undefined;
  const activeName = activeStyle?.name ?? activeSkill?.name;
  const activeId = index === "create"
    ? `${listId}-create-action`
    : activeName ? `${listId}-${mode}-${activeName}` : undefined;

  useEffect(() => {
    if (mode === "skill" && status === "idle") void load();
    if (mode === "style" && styleStatus === "idle") void loadStyleGuides();
  }, [mode, status, load, styleStatus, loadStyleGuides]);
  useEffect(() => {
    activeRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const chooseSkill = (row: Skill) => list.replaceToken(token, "/" + row.name);
  const chooseStyle = (row: StyleGuideRecord) => list.replaceToken(token, "@" + row.name);

  function createAction() {
    list.close();
    if (mode === "style") {
      navigate("/settings/style-guides/new");
      return;
    }
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      next.set("createSkill", "1");
      return next;
    }, { replace: true });
  }

  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (overlay.current && inputRef.current) overlay.current.scrollTop = inputRef.current.scrollTop;
  }, [value, timestamps, inputRef]);
  const markedText: ReactNode[] = [];
  let end = 0;
  for (const stamp of timestamps ?? []) {
    markedText.push(<span key={`before-${stamp.start}`} aria-hidden="true">{value.slice(end, stamp.start)}</span>, <button key={stamp.start} type="button" className="composer-timestamp"
      aria-label={`Jump to ${stamp.text}`} title={`Jump to ${stamp.text}`}
      onMouseDown={e => e.preventDefault()} onClick={() => onTimestamp?.(stamp.time)}>{stamp.text}</button>);
    end = stamp.start + stamp.text.length;
  }

  return <>
    <div className="composer-message">
      <span aria-hidden="true">{value || placeholder}{"​"}</span>
      <textarea id={id} ref={inputRef} rows={1} className="placeholder:text-dim" disabled={disabled} aria-label={ariaLabel}
        placeholder={placeholder} aria-description={plain ? undefined : "Type / to choose an editing skill."}
        aria-autocomplete="list" aria-haspopup="listbox" aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId} value={value}
        onScroll={e => { if (overlay.current) overlay.current.scrollTop = e.currentTarget.scrollTop; }}
        onSelect={e => { list.syncCaret(e.currentTarget); }}
        onFocus={e => list.focus(e.currentTarget)}
        onBlur={() => list.setFocused(false)}
        onChange={e => {
          // WebKit can return the caret from a native dialog before the textarea receives another focus event.
          list.setFocused(document.activeElement === e.currentTarget);
          list.typed(e.currentTarget);
          onChange(e.target.value);
        }}
        onKeyDown={e => {
          if (isComposing(e)) return;
          if (open && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (list.navigate(e, matchCount)) return;
            if (e.key === "Enter" || (e.key === "Tab" && (activeSkill || activeStyle))) {
              e.preventDefault();
              if (index === "create") {
                if (!e.repeat) createAction();
              } else if (e.key === "Enter" && activeName === query && caret === token?.end) onSubmit();
              else if (activeSkill) chooseSkill(activeSkill);
              else if (activeStyle) chooseStyle(activeStyle);
              else if (mode === "skill" && status === "error") void load();
              else if (mode === "style" && styleStatus === "error") void loadStyleGuides();
              // A command no row matches still sends: the send says when no skill has that name, and a shortcut such
              // as /dialogue-pass goes to the skill it stands for.
              else if (e.key === "Enter" && caret === token?.end && !e.repeat) onSubmit();
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Held down, Enter is one press: its repeats don't send whatever the box shows next.
            if (!e.repeat) onSubmit();
          }
          if (e.key === "Escape") e.currentTarget.blur();
        }} />
      {markedText.length > 0 && <div ref={overlay} className="composer-timestamp-overlay">
        {markedText}<span aria-hidden="true">{value.slice(end)}{"​"}</span>
      </div>}
    </div>
    {open && mode === "skill" && <div className="composer-skills" role="listbox" id={listId} aria-label="Editing skills" data-shortcut-overlay>
      <div className="eyebrow px-2 py-1">Skills</div>
      <div className="composer-skill-list">
        {skillMatches.map(skill => <button key={skill.name} type="button" role="option" tabIndex={-1}
          id={`${listId}-skill-${skill.name}`} aria-selected={skill === activeSkill} ref={skill === activeSkill ? activeRow : undefined}
          onMouseDown={e => e.preventDefault()} onClick={() => chooseSkill(skill)}>
          <span className="font-mono text-[12px]">/{skill.name}</span>
          {skill.description && <span className="block truncate text-muted text-[12px]" title={skill.description}>{skill.description}</span>}
        </button>)}
      </div>
      {!skillMatches.length && <div role="status" className="px-2 py-1 text-muted text-[12px]">
        {status === "error" ? <>Couldn’t load skills. <button type="button" className="underline" onMouseDown={e => e.preventDefault()} onClick={() => void load()} title="Press Enter to retry">Retry</button></>
          : status !== "ready" ? "Loading skills…" : query ? "No matching skills." : "No enabled skills in this project."}
      </div>}
      <div className="composer-skill-footer">
        <button type="button" role="option" tabIndex={-1} id={`${listId}-create-action`} aria-selected={index === "create"}
          onMouseDown={e => e.preventDefault()} onClick={createAction}>
          <Icon name="plus" size={14} /> Create a skill
        </button>
      </div>
    </div>}
    {open && mode === "style" && <div className="composer-skills" role="listbox" id={listId} aria-label="Style guides" data-shortcut-overlay>
      <div className="eyebrow px-2 py-1">Style guides</div>
      <div className="composer-skill-list">
        {styleMatches.map(guide => <button key={guide.id} type="button" role="option" tabIndex={-1}
          id={`${listId}-style-${guide.name}`} aria-selected={guide === activeStyle} ref={guide === activeStyle ? activeRow : undefined}
          onMouseDown={e => e.preventDefault()} onClick={() => chooseStyle(guide)}>
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12px]">@{guide.name}</span>
            {guide.isDefault && <span className="text-[10.5px] text-dim">Default</span>}
          </span>
          {guide.description && <span className="block truncate text-muted text-[12px]" title={guide.description}>{guide.description}</span>}
        </button>)}
      </div>
      {!styleMatches.length && <div role="status" className="px-2 py-1 text-muted text-[12px]">
        {styleStatus === "error" ? <>Couldn’t load style guides. <button type="button" className="underline" onMouseDown={e => e.preventDefault()} onClick={() => void loadStyleGuides()} title="Press Enter to retry">Retry</button></>
          : styleStatus !== "ready" ? "Loading style guides…" : query ? "No matching style guides." : "No style guides yet."}
      </div>}
      <div className="composer-skill-footer">
        <button type="button" role="option" tabIndex={-1} id={`${listId}-create-action`} aria-selected={index === "create"}
          onMouseDown={e => e.preventDefault()} onClick={createAction}>
          <Icon name="plus" size={14} /> Create a style guide
        </button>
      </div>
    </div>}
  </>;
}
