import { isAddRequest, isRejectRequest, type Task, type ThreadEdit } from "@scarlet/shared";
import { Icon } from "../../../components/ui/primitives";
import { editKindWord } from "../../../lib/editKind";
import { clock as clockLabel } from "../../../lib/format";
import { letGo } from "../types";

export interface RevisionTargetInfo {
  /** Short plain-English action label, e.g. "Revising graphic", "Revising cut", "Revising edit". */
  action: string;
  /** Formatted timeline timestamp for the target edit/cut, e.g. "6:21". */
  time?: string;
  /** Human-readable name of the edit or cut being revised. */
  title: string;
  /** Revision version number (e.g. 2 for v2, 3 for v3) when revising an edit. */
  version?: number;
  /** True when the target edit currently needs the editor's review (matches amber time badge). */
  needsReview?: boolean;
  /** True when this target edit or call is currently open on the timeline. */
  active?: boolean;
  /** Open this edit/call in the player and review card. */
  onOpen?(): void;
  /** Highlight this edit/call's marker on the timeline on hover. */
  onHover?(on: boolean): void;
}

/** Plain action kicker for a single-edit revision bubble header. */
export function revisionActionLabel(
  task: Pick<Task, "instruction" | "context">,
  edit?: Pick<ThreadEdit, "beforeCut" | "kind" | "marker">,
  isCall?: boolean,
): string {
  if (isAddRequest(task)) return "Adding to-do";
  if (isRejectRequest(task)) return "Removing edit";
  if (isCall || edit?.beforeCut || edit?.kind === "cut") return "Revising cut";
  if (edit?.marker) return "Revising to-do";
  const kind = edit && editKindWord(edit);
  if (kind && kind !== "Edit") {
    const noun = kind === "B-roll" ? "B-roll" : kind.toLowerCase();
    return `Revising ${noun}`;
  }
  return "Revising edit";
}

/** Build a fallback title when a target edit row isn't loaded or was already removed. */
export function fallbackRevisionTitle(
  task: Pick<Task, "context">,
  fallbackTag?: string,
): { time?: string; title: string } {
  const { time, cutIndex } = task.context;
  const formattedTime = time !== undefined ? clockLabel(time) : undefined;
  if (fallbackTag) {
    const timed = /^(Cut|Edit|\d+ edits) at (.+)$/.exec(fallbackTag);
    if (timed) return { time: timed[2], title: timed[1] === "Edit" ? "This edit" : timed[1]! };
    return { time: formattedTime, title: fallbackTag };
  }
  return { time: formattedTime, title: cutIndex !== undefined ? "Cut" : "This edit" };
}

/**
 * Flush reference header inside a single-edit revision bubble (and queued revision bubble) in the beta layout.
 * Mirrors the composer's own aim bar (time badge + edit title + version) so it is immediately clear which
 * specific edit is being revised, and clicking it jumps straight to that edit on the timeline.
 */
export function RevisionTargetHeader({ target }: { target: RevisionTargetInfo }) {
  const content = <>
    <span className="rev-target-kicker">
      <Icon name="reply" size={11} />
      <span className="rev-target-action">{target.action}</span>
      {target.version && target.version > 1 ? <span className="rev-target-ver">v{target.version}</span> : null}
    </span>
    <span className="rev-target-edit">
      {target.time && <span className={target.needsReview ? "rev-target-time is-need" : "rev-target-time"}>{target.time}</span>}
      <span className="rev-target-title">{target.title}</span>
      {target.onOpen && <span className="rev-target-go" aria-hidden="true"><Icon name="chevron" size={10} /></span>}
    </span>
  </>;
  const fullLabel = `${target.action}${target.time ? ` at ${target.time}` : ""}: ${target.title}${target.version && target.version > 1 ? ` (v${target.version})` : ""}`;
  if (target.onOpen) {
    return <button type="button"
      className={`rev-target is-link${target.active ? " is-active" : ""}`}
      aria-label={`Open ${fullLabel}`}
      title={`${target.title}\nClick to view on timeline`}
      onClick={letGo(() => target.onOpen!())}
      onPointerEnter={target.onHover ? () => target.onHover!(true) : undefined}
      onPointerLeave={target.onHover ? () => target.onHover!(false) : undefined}>
      {content}
    </button>;
  }
  return <div className="rev-target" title={fullLabel}>{content}</div>;
}
