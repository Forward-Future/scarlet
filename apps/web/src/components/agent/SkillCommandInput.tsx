import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "react-router-dom";
import type { Skill } from "@scarlet/shared";
import { isComposing } from "../../lib/hotkeys";
import { skillCommands, useSkillsStore } from "../../stores/skills";
import { Icon } from "../ui/primitives";

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  skills: Skill[];
  id: string;
  placeholder: string;
  onChange(value: string): void;
  onSubmit(): void;
}

export function SkillCommandInput({ inputRef, value, skills, id, placeholder, onChange, onSubmit }: Props) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState<number | "create">(0);
  const [, setSearch] = useSearchParams();
  const listId = useId();
  const activeRow = useRef<HTMLButtonElement>(null);
  const status = useSkillsStore(s => s.status);
  const load = useSkillsStore(s => s.load);
  const [caret, setCaret] = useState<number | null>(null);
  const command = caret === null ? undefined : skillCommands(value).find(token => token.start < caret && caret <= token.end);
  const open = focused && !dismissed && !!command;
  const query = command && caret !== null ? value.slice(command.start + 1, caret).toLowerCase() : "";
  const matches = open ? skills.filter(s => s.name.includes(query) || s.description.toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query))) : [];
  const activeIndex = index === "create" ? matches.length : Math.min(index, matches.length - 1);
  const active = matches[activeIndex];
  const activeId = index === "create" ? `${listId}-create-action` : active && `${listId}-skill-${active.name}`;
  const hasCommand = !!command;

  useEffect(() => {
    if (hasCommand && status === "idle") void load();
  }, [hasCommand, status, load]);
  useEffect(() => {
    activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function syncCaret(input: HTMLTextAreaElement) {
    const next = input.selectionStart === input.selectionEnd ? input.selectionStart : null;
    if (next !== caret) {
      setIndex(0);
      setDismissed(false);
      setCaret(next);
    }
  }

  function choose(skill: Skill) {
    const input = inputRef.current;
    if (!input || !command) return;
    const suffix = value.slice(command.end);
    const prefix = value.slice(0, command.start) + "/" + skill.name;
    const next = prefix + (suffix ? "" : " ") + suffix;
    const position = prefix.length + 1;
    flushSync(() => onChange(next));
    input.focus();
    input.setSelectionRange(position, position);
    setCaret(position);
  }

  function createSkill() {
    setIndex(0);
    setDismissed(true);
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      next.set("createSkill", "1");
      return next;
    }, { replace: true });
  }

  return <>
    <div className="composer-message">
      <span aria-hidden="true">{value || placeholder}{"\u200b"}</span>
      <textarea id={id} ref={inputRef} rows={1} className="placeholder:text-dim"
        placeholder={placeholder} aria-description="Type / to choose an editing skill."
        aria-autocomplete="list" aria-haspopup="listbox" aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId} value={value}
        onSelect={e => { syncCaret(e.currentTarget); }}
        onFocus={e => { syncCaret(e.currentTarget); setFocused(true); setDismissed(false); }}
        onBlur={() => setFocused(false)}
        onChange={e => {
          // WebKit can return the caret from a native dialog before the textarea receives another focus event.
          setFocused(document.activeElement === e.currentTarget);
          syncCaret(e.currentTarget);
          setIndex(0);
          setDismissed(false);
          onChange(e.target.value);
        }}
        onKeyDown={e => {
          if (isComposing(e)) return;
          if (open && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const direction = e.key === "ArrowDown" ? 1 : -1;
              const count = matches.length + 1;
              const next = (activeIndex + direction + count) % count;
              setIndex(next === matches.length ? "create" : next);
              return;
            }
            if (e.key === "Enter" || (e.key === "Tab" && active)) {
              e.preventDefault();
              if (index === "create") {
                if (!e.repeat) createSkill();
              } else if (e.key === "Enter" && active?.name === query && caret === command?.end) onSubmit();
              else if (active) choose(active);
              else if (status === "error") void load();
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
    </div>
    {open && <div className="composer-skills" role="listbox" id={listId} aria-label="Editing skills" data-shortcut-overlay>
      <div className="eyebrow px-2 py-1">Skills</div>
      <div className="composer-skill-list">
        {matches.map(skill => <button key={skill.name} type="button" role="option" tabIndex={-1}
          id={`${listId}-skill-${skill.name}`} aria-selected={skill === active} ref={skill === active ? activeRow : undefined}
          onMouseDown={e => e.preventDefault()} onClick={() => choose(skill)}>
          <span className="font-mono text-[12px]">/{skill.name}</span>
          {skill.description && <span className="block truncate text-muted text-[12px]" title={skill.description}>{skill.description}</span>}
        </button>)}
      </div>
      {!matches.length && <div role="status" className="px-2 py-1 text-muted text-[12px]">
        {status === "error" ? <>Couldn’t load skills. <button type="button" className="underline" onMouseDown={e => e.preventDefault()} onClick={() => void load()} title="Press Enter to retry">Retry</button></>
          : status !== "ready" ? "Loading skills…" : query ? "No matching skills." : "No enabled skills in this project."}
      </div>}
      <div className="composer-skill-footer">
        <button type="button" role="option" tabIndex={-1} id={`${listId}-create-action`} aria-selected={index === "create"}
          onMouseDown={e => e.preventDefault()} onClick={createSkill}>
          <Icon name="plus" size={14} /> Create a skill
        </button>
      </div>
    </div>}
  </>;
}
