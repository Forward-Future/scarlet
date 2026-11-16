import type { CSSProperties, ReactNode, RefObject } from "react";
import type { GraphicTemplateSummary, TransitionStyle } from "@scarlet/shared";
import { clipEnd, type Timeline } from "@scarlet/timeline";
import { templatePreview } from "../../stores/templates";
import { interactiveFrameUrl, thumbUrl } from "../review/thumbs";
import { Icon } from "../ui/primitives";

/** The templates a `$query` lists: graphics first, then transitions, each with the names that start with it first. */
export function templateMatches(templates: readonly GraphicTemplateSummary[], query: string) {
  const q = query.toLowerCase();
  const rank = (t: GraphicTemplateSummary) => (t.kind === "transition" ? 2 : 0) + (t.name.startsWith(q) ? 0 : 1);
  return templates.filter(t => t.name.includes(q) || t.title.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b));
}

/** How long a transition lasts, as an editor counts it: in frames when the project's rate is known. */
export function transitionLength(transition: Pick<TransitionStyle, "duration">, fps?: number) {
  if (fps) {
    const frames = Math.round(transition.duration * fps);
    return `${frames} frame${frames === 1 ? "" : "s"}`;
  }
  return `${Math.round(transition.duration * 100) / 100} s`;
}

/** What a template's row says under its title: a graphic's fields, a transition's length. */
export function templateDetail(template: GraphicTemplateSummary, fps?: number) {
  return template.kind === "transition" && template.transition ? transitionLength(template.transition, fps) : template.fields.join(", ");
}

/**
 * The two pictures a transition shows best between: either side of the next join on the bottom video track after
 * `time`, or the picture at `time` on both sides when there is none.
 */
export function joinFrames(timeline: Timeline | null, time: number, width: number): { from?: string; to?: string } {
  const track = timeline?.tracks.find(t => t.kind === "video");
  const clips = track?.clips.filter(c => c.enabled !== false) ?? [];
  const join = clips.map(c => c.timelineIn).filter(t => t > time + 1e-3 && clips.some(o => Math.abs(clipEnd(o) - t) <= 1e-3)).sort((a, b) => a - b)[0];
  const at = (t: number) => interactiveFrameUrl(thumbUrl(timeline, Math.max(0, t), width));
  if (join === undefined) {
    const here = at(time);
    return { from: here, to: here };
  }
  return { from: at(join - 0.1), to: at(join + 0.05) };
}

/**
 * A transition drawn with two pictures: the one leaving and the one arriving. Still, it shows the transition halfway,
 * the moment that says what it is; playing, it runs on a loop.
 */
export function TransitionPicture({ transition, from, to, playing, className }: {
  transition: Pick<TransitionStyle, "type" | "direction" | "color" | "duration">; from?: string; to?: string; playing?: boolean; className?: string;
}) {
  const style = { "--transition-color": transition.color ?? "#000", "--transition-seconds": `${Math.max(0.6, transition.duration * 2.5)}s` } as CSSProperties;
  return <span className={`transition-picture is-${transition.type} to-${transition.direction ?? "left"}${playing ? " is-playing" : ""}${className ? ` ${className}` : ""}`}
    style={style} aria-hidden="true">
    <span className="transition-from">{from && <img src={from} alt="" loading="lazy" />}</span>
    <span className="transition-to">{to && <img src={to} alt="" loading="lazy" />}</span>
    <span className="transition-veil" />
  </span>;
}

interface MenuProps {
  listId: string;
  rows: readonly GraphicTemplateSummary[];
  active: GraphicTemplateSummary | undefined;
  makeActive: boolean;
  activeRow: RefObject<HTMLButtonElement | null>;
  /** The picture under the playhead, which each graphic's row draws its preview over. */
  frame?: string;
  /** The pictures either side of a join, which each transition's row moves between. */
  joins?: { from?: string; to?: string };
  fps?: number;
  status: "idle" | "loading" | "ready" | "error";
  query: string;
  empty: boolean;
  footer?: ReactNode;
  style?: CSSProperties;
  onHover(row: GraphicTemplateSummary): void;
  onChoose(row: GraphicTemplateSummary): void;
  onMake(): void;
  onRetry(): void;
}

/**
 * The $ list: the editor's templates, graphics and then transitions, each with its picture. A graphic's row shows it
 * over the picture under the playhead; a transition's moves between the pictures either side of the next cut.
 */
export function TemplateMenu({ listId, rows, active, makeActive, activeRow, frame, joins, fps, status, query, empty, footer, style, onHover, onChoose, onMake, onRetry }: MenuProps) {
  const groups = (["graphic", "transition"] as const).map(kind => ({ kind, rows: rows.filter(r => (r.kind ?? "graphic") === kind) })).filter(g => g.rows.length);
  return <div className="composer-skills composer-templates" role="listbox" id={listId} aria-label="Templates" data-shortcut-overlay style={style}>
    {groups.map(group => <div key={group.kind} className="composer-template-group" role="group" aria-label={group.kind === "transition" ? "Transitions" : "Graphics"}>
      <div className="eyebrow px-2 py-1" aria-hidden="true">{group.kind === "transition" ? "Transitions" : "Graphics"}</div>
      <div className="composer-skill-list">
        {group.rows.map(row => <button key={row.id} type="button" role="option" tabIndex={-1} className="composer-template"
          id={`${listId}-template-${row.name}`} aria-selected={row === active} ref={row === active ? activeRow : undefined} title={`$${row.name}`}
          onMouseDown={e => e.preventDefault()} onMouseEnter={() => onHover(row)} onClick={() => onChoose(row)}>
          <span className="composer-template-thumb" aria-hidden="true">
            {row.kind === "transition" && row.transition ? <TransitionPicture transition={row.transition} from={joins?.from} to={joins?.to} />
              : <>{frame && <img src={frame} alt="" loading="lazy" />}<img src={templatePreview(row)} alt="" loading="lazy" /></>}
          </span>
          <span className="composer-template-words">
            <span className="composer-template-title">{row.title}</span>
            {templateDetail(row, fps) && <span className="composer-template-fields">{templateDetail(row, fps)}</span>}
          </span>
        </button>)}
      </div>
    </div>)}
    {!rows.length && <div role="status" className="px-2 py-1 text-muted text-[12px]">
      {status === "error" ? <>Couldn’t load templates. <button type="button" className="underline" onMouseDown={e => e.preventDefault()} onClick={onRetry} title="Press Enter to retry">Retry</button></>
        : status !== "ready" ? "Loading templates…" : query && !empty ? "No matching templates."
        : "No templates yet. Ask Scarlet to make one, or save a graphic from its card."}
    </div>}
    <div className="composer-skill-footer">
      <button type="button" role="option" tabIndex={-1} id={`${listId}-create-action`} aria-selected={makeActive}
        onMouseDown={e => e.preventDefault()} onClick={onMake}>
        <Icon name="plus" size={14} /> Make a template
      </button>
    </div>
    {footer}
  </div>;
}
