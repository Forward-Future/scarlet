import { useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import type { GraphicTemplateSummary, Skill } from "@scarlet/shared";
import type { MessageTimestamp } from "../../lib/messageTimestamps";
import { isComposing } from "../../lib/hotkeys";
import { skillCommands, useSkillsStore } from "../../stores/skills";
import { templatePreview, templateTokens, useTemplatesStore } from "../../stores/templates";
import { joinFrames, templateMatches as matchTemplates, TemplateMenu } from "./TemplateMenu";
import { useProjectStore } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { interactiveFrameUrl, thumbUrl } from "../review/thumbs";
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
  /** Only `$` opens a list: a skill's own page has no skills to pick. */
  templatesOnly?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

/** What "Make a template" puts in the box, for the editor to say what the template is. */
export const MAKE_TEMPLATE = "Make a template ";

/**
 * The message box's text, with two lists that open over it as the editor types: `/` lists the editing skills and `$`
 * the templates, graphics and transitions. Both read and behave the same: what follows the sign filters the list, ↑ ↓ light a row, Enter
 * or Tab puts its name in the box and Esc puts the list away. A template's row shows its picture over the frame under
 * the playhead, and while it is lit the player shows it over the picture too.
 */
export function SkillCommandInput({ inputRef, value, skills, id, placeholder, timestamps, onTimestamp, onChange, onSubmit, templatesOnly, disabled, ariaLabel }: Props) {
  const list = useTokenList(inputRef, value, onChange);
  const { caret, index } = list;
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
  const command = caret === null || templatesOnly ? undefined : skillCommands(value).find(token => token.start < caret && caret <= token.end);
  const template = caret === null || command ? undefined : templateTokens(value).find(token => token.start < caret && caret <= token.end);
  const token = command ?? template;
  const open = list.focused && !list.dismissed && !!token;
  const skillsOpen = open && !!command;
  const templatesOpen = open && !!template;
  const query = token && caret !== null ? value.slice(token.start + 1, caret).toLowerCase() : "";
  const skillMatches = skillsOpen ? skills.filter(s => s.name.includes(query) || s.description.toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query))) : [];
  const templateMatches = templatesOpen ? matchTemplates(templates, query) : [];
  const matches: ReadonlyArray<Skill | GraphicTemplateSummary> = skillsOpen ? skillMatches : templateMatches;
  const activeIndex = list.activeIndex(matches.length);
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
  // The frame under the playhead as the list opened: each graphic's row draws its picture over it. A transition's row
  // moves between the pictures either side of the next cut, which is where the player plays it while it is lit.
  const { frame, joins, large } = useMemo(() => {
    if (!templatesOpen) return {};
    const timeline = useProjectStore.getState().current?.timeline ?? null;
    const time = usePlayerStore.getState().time;
    return { frame: interactiveFrameUrl(thumbUrl(timeline, time, 160)), joins: joinFrames(timeline, time, 160), large: joinFrames(timeline, time, 960) };
  }, [templatesOpen]);
  const fps = useProjectStore(s => s.current?.project.settings.fps);
  // The lit template is drawn over the player's picture, and goes when the list closes.
  const litTemplate = templatesOpen && index !== "create" && active && "fields" in active ? active : undefined;
  const litUrl = litTemplate && litTemplate.kind !== "transition" ? templatePreview(litTemplate) : undefined;
  useEffect(() => {
    if (litTemplate?.kind === "transition" && litTemplate.transition) setLit({ id: litTemplate.id, transition: litTemplate.transition, from: large?.from, to: large?.to });
    else setLit(litTemplate && litUrl ? { id: litTemplate.id, url: litUrl } : null);
  }, [litTemplate?.id, litUrl, large, setLit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setLit(null), [setLit]);

  const choose = (row: Skill | GraphicTemplateSummary) => list.replaceToken(token, ("fields" in row ? "$" : "/") + row.name);

  function createSkill() {
    list.close();
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      next.set("createSkill", "1");
      return next;
    }, { replace: true });
  }

  function makeTemplate() {
    list.close();
    list.replaceToken(token, MAKE_TEMPLATE);
  }

  const create = skillsOpen ? createSkill : makeTemplate;
  const retry = skillsOpen ? load : loadTemplates;

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
        placeholder={placeholder} aria-description="Type / to choose an editing skill, or $ for a graphic or transition template."
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
            if (list.navigate(e, matches.length)) return;
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
      {markedText.length > 0 && <div ref={overlay} className="composer-timestamp-overlay">
        {markedText}<span aria-hidden="true">{value.slice(end)}{"​"}</span>
      </div>}
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
    {templatesOpen && <TemplateMenu listId={listId} rows={templateMatches} active={index === "create" ? undefined : active as GraphicTemplateSummary | undefined}
      makeActive={index === "create"} activeRow={activeRow} frame={frame} joins={joins} fps={fps} status={templateStatus} query={query} empty={!templates.length}
      onHover={row => list.setIndex(templateMatches.indexOf(row))} onChoose={choose} onMake={makeTemplate} onRetry={() => void loadTemplates()}
      footer={styleGuide && <div className="composer-style-guide" title={`Scarlet follows this project’s style guide for every graphic: ${styleGuide.name}`}>
        <span>Style guide</span><span className="composer-style-guide-name">{styleGuide.name}</span>
      </div>} />}
  </>;
}
