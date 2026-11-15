import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "react-router-dom";
import type { GraphicTemplateSummary, Skill } from "@scarlet/shared";
import { isComposing } from "../../lib/hotkeys";
import { skillCommands, useSkillsStore } from "../../stores/skills";
import { templatePreview, templateTokens, useTemplatesStore } from "../../stores/templates";
import { useProjectStore } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { interactiveFrameUrl, thumbUrl } from "../review/thumbs";
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

/** What "Make a template" puts in the box, for the editor to say what the template is. */
export const MAKE_TEMPLATE = "Make a template ";

/**
 * The message box's text, with two lists that open over it as the editor types: `/` lists the editing skills and `$`
 * the graphic templates. Both read and behave the same: what follows the sign filters the list, ↑ ↓ light a row, Enter
 * or Tab puts its name in the box and Esc puts the list away. A template's row shows its picture over the frame under
 * the playhead, and while it is lit the player shows it over the picture too.
 */
export function SkillCommandInput({ inputRef, value, skills, id, placeholder, onChange, onSubmit }: Props) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState<number | "create">(0);
  const [, setSearch] = useSearchParams();
  const listId = useId();
  const activeRow = useRef<HTMLButtonElement>(null);
  const status = useSkillsStore(s => s.status);
  const load = useSkillsStore(s => s.load);
  const templates = useTemplatesStore(s => s.templates);
  const templateStatus = useTemplatesStore(s => s.status);
  const loadTemplates = useTemplatesStore(s => s.load);
  const setLit = useTemplatesStore(s => s.setLit);
  const styleGuide = useProjectStore(s => s.current?.project.styleGuide);
  const [caret, setCaret] = useState<number | null>(null);
  const command = caret === null ? undefined : skillCommands(value).find(token => token.start < caret && caret <= token.end);
  const template = caret === null || command ? undefined : templateTokens(value).find(token => token.start < caret && caret <= token.end);
  const token = command ?? template;
  const open = focused && !dismissed && !!token;
  const skillsOpen = open && !!command;
  const templatesOpen = open && !!template;
  const query = token && caret !== null ? value.slice(token.start + 1, caret).toLowerCase() : "";
  const skillMatches = skillsOpen ? skills.filter(s => s.name.includes(query) || s.description.toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query))) : [];
  const templateMatches = templatesOpen ? templates.filter(t => t.name.includes(query) || t.title.toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query))) : [];
  const matches: ReadonlyArray<Skill | GraphicTemplateSummary> = skillsOpen ? skillMatches : templateMatches;
  const activeIndex = index === "create" ? matches.length : Math.min(index, matches.length - 1);
  const active = matches[activeIndex];
  const activeId = index === "create" ? `${listId}-create-action` : active && `${listId}-${skillsOpen ? "skill" : "template"}-${active.name}`;
  const hasCommand = !!command;
  const listStatus = skillsOpen ? status : templateStatus;

  useEffect(() => {
    if (hasCommand && status === "idle") void load();
  }, [hasCommand, status, load]);
  // The library is read each time the list opens, so a template saved meanwhile is in it. What was read before shows
  // until then.
  useEffect(() => {
    if (templatesOpen) void loadTemplates();
  }, [templatesOpen, loadTemplates]);
  useEffect(() => {
    activeRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  // The frame under the playhead as the list opened: each template's row draws its picture over it.
  const frame = useMemo(() => {
    if (!templatesOpen) return undefined;
    const timeline = useProjectStore.getState().current?.timeline ?? null;
    return interactiveFrameUrl(thumbUrl(timeline, usePlayerStore.getState().time, 160));
  }, [templatesOpen]);
  // The lit template is drawn over the player's picture, and goes when the list closes.
  const litTemplate = templatesOpen && index !== "create" && active && "fields" in active ? active : undefined;
  const litUrl = litTemplate && templatePreview(litTemplate);
  useEffect(() => { setLit(litTemplate && litUrl ? { id: litTemplate.id, url: litUrl } : null); }, [litTemplate?.id, litUrl, setLit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setLit(null), [setLit]);

  function syncCaret(input: HTMLTextAreaElement) {
    const next = input.selectionStart === input.selectionEnd ? input.selectionStart : null;
    if (next !== caret) {
      setIndex(0);
      setDismissed(false);
      setCaret(next);
    }
  }

  /** Put `words` in the place of the `/…` or `$…` being typed, with a space after them, and the caret after that. */
  function replaceToken(words: string) {
    const input = inputRef.current;
    if (!input || !token) return;
    const suffix = value.slice(token.end);
    const prefix = value.slice(0, token.start) + words;
    const next = prefix + (suffix || words.endsWith(" ") ? "" : " ") + suffix;
    const position = words.endsWith(" ") ? prefix.length : prefix.length + 1;
    flushSync(() => onChange(next));
    input.focus();
    input.setSelectionRange(position, position);
    setCaret(position);
  }

  const choose = (row: Skill | GraphicTemplateSummary) => replaceToken(("fields" in row ? "$" : "/") + row.name);

  function createSkill() {
    setIndex(0);
    setDismissed(true);
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      next.set("createSkill", "1");
      return next;
    }, { replace: true });
  }

  function makeTemplate() {
    setIndex(0);
    setDismissed(true);
    replaceToken(MAKE_TEMPLATE);
  }

  const create = skillsOpen ? createSkill : makeTemplate;
  const retry = skillsOpen ? load : loadTemplates;

  return <>
    <div className="composer-message">
      <span aria-hidden="true">{value || placeholder}{"​"}</span>
      <textarea id={id} ref={inputRef} rows={1} className="placeholder:text-dim"
        placeholder={placeholder} aria-description="Type / to choose an editing skill, or $ for a graphic template."
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
                if (!e.repeat) create();
              } else if (e.key === "Enter" && active?.name === query && caret === token?.end) onSubmit();
              else if (active) choose(active);
              else if (listStatus === "error") void retry();
              // A command no row matches still sends: the send says when no skill has that name, and a shortcut such
              // as /dialogue-pass goes to the skill it stands for. A $ no template matches is the editor's own words.
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
    </div>
    {skillsOpen && <div className="composer-skills" role="listbox" id={listId} aria-label="Editing skills" data-shortcut-overlay>
      <div className="eyebrow px-2 py-1">Skills</div>
      <div className="composer-skill-list">
        {skillMatches.map(skill => <button key={skill.name} type="button" role="option" tabIndex={-1}
          id={`${listId}-skill-${skill.name}`} aria-selected={skill === active} ref={skill === active ? activeRow : undefined}
          onMouseDown={e => e.preventDefault()} onClick={() => choose(skill)}>
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
          onMouseDown={e => e.preventDefault()} onClick={createSkill}>
          <Icon name="plus" size={14} /> Create a skill
        </button>
      </div>
    </div>}
    {templatesOpen && <div className="composer-skills composer-templates" role="listbox" id={listId} aria-label="Graphic templates" data-shortcut-overlay>
      <div className="eyebrow px-2 py-1">Templates</div>
      <div className="composer-skill-list">
        {templateMatches.map(row => <button key={row.id} type="button" role="option" tabIndex={-1} className="composer-template"
          id={`${listId}-template-${row.name}`} aria-selected={row === active} ref={row === active ? activeRow : undefined} title={`$${row.name}`}
          onMouseDown={e => e.preventDefault()} onMouseEnter={() => setIndex(templateMatches.indexOf(row))} onClick={() => choose(row)}>
          <span className="composer-template-thumb" aria-hidden="true">
            {frame && <img src={frame} alt="" loading="lazy" />}
            <img src={templatePreview(row)} alt="" loading="lazy" />
          </span>
          <span className="composer-template-words">
            <span className="composer-template-title">{row.title}</span>
            {row.fields.length > 0 && <span className="composer-template-fields">{row.fields.join(", ")}</span>}
          </span>
        </button>)}
      </div>
      {!templateMatches.length && <div role="status" className="px-2 py-1 text-muted text-[12px]">
        {templateStatus === "error" ? <>Couldn’t load templates. <button type="button" className="underline" onMouseDown={e => e.preventDefault()} onClick={() => void loadTemplates()} title="Press Enter to retry">Retry</button></>
          : templateStatus !== "ready" ? "Loading templates…" : query && templates.length ? "No matching templates."
          : "No templates yet. Ask Scarlet to make one, or save a graphic from its card."}
      </div>}
      <div className="composer-skill-footer">
        <button type="button" role="option" tabIndex={-1} id={`${listId}-create-action`} aria-selected={index === "create"}
          onMouseDown={e => e.preventDefault()} onClick={makeTemplate}>
          <Icon name="plus" size={14} /> Make a template
        </button>
      </div>
      {styleGuide && <div className="composer-style-guide" title={`Scarlet follows this project’s style guide for every graphic: ${styleGuide.name}`}>
        <span>Style guide</span><span className="composer-style-guide-name">{styleGuide.name}</span>
      </div>}
    </div>}
  </>;
}
