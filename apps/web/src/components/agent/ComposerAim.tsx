import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";

/** One thing the message is about: the cut, edit or moment the box is aimed at, or a stretch marked on the ruler. */
export interface AimItem {
  key: string;
  kind: "target" | "range";
  /** "Cut at 0:35", "2:40 – 2:58" */
  name: string;
  /** "the cut that’s open", "18 s you marked" */
  detail: string;
  clearLabel: string;
  onClear(): void;
}

/** How long the card shows by itself when something is attached, and how long the icon's pulse runs after it folds. */
export const ARRIVAL_MS = 2000;
const PULSE_MS = 700;
/** A pointer that leaves the icon for its card, or back, crosses a gap: the card waits this long before it closes. */
const LEAVE_MS = 150;

/** An edit point: two clips meeting at a line. */
function EditPoint() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d="M8 1.5v13" /><path d="M3 4.5h3.5v7H3M13 4.5H9.5v7H13" /></svg>;
}

/**
 * What the message is about, folded into one icon of a fixed size at the start of the box. Hovering it, focusing it or
 * clicking it opens a card that lists each thing with its own ×, and lights them on the timeline. When something is
 * attached, the card shows by itself for a moment with that line lit, then folds into the icon with one pulse.
 */
export function ComposerAim({ items, disabled, disabledReason }: { items: AimItem[]; disabled?: boolean; disabledReason?: string }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [arrived, setArrived] = useState<string>();
  const [pulse, setPulse] = useState(false);
  const leave = useRef<number>(undefined);
  const setLit = useUiStore(s => s.setAimLit);
  // A line attached since the last render arrives: the card shows it for a moment. What was there when the box opened doesn't.
  const known = useRef<Set<string>>(undefined);
  const keys = items.map(i => i.key).join("\n");
  useLayoutEffect(() => {
    const now = new Set(items.map(i => i.key));
    const before = known.current;
    known.current = now;
    // Only something added shows: stepping from one cut to the next swaps one line for another, and stays folded.
    const added = before && now.size > before.size && items.find(i => !before.has(i.key));
    if (added) setArrived(added.key);
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!arrived) return;
    const fold = window.setTimeout(() => { setArrived(undefined); setPulse(true); }, ARRIVAL_MS);
    return () => clearTimeout(fold);
  }, [arrived]);
  useEffect(() => {
    if (!pulse) return;
    const done = window.setTimeout(() => setPulse(false), PULSE_MS);
    return () => clearTimeout(done);
  }, [pulse]);
  const open = hovered || pinned || !!arrived;
  useEffect(() => { setLit(hovered || pinned); }, [hovered, pinned, setLit]);
  useEffect(() => () => { clearTimeout(leave.current); setLit(false); }, [setLit]);
  const enter = () => { clearTimeout(leave.current); setHovered(true); };
  const exit = () => { clearTimeout(leave.current); leave.current = window.setTimeout(() => setHovered(false), LEAVE_MS); };
  const summary = items.map(i => i.name).join(" and ");
  return <span className="composer-aim" onPointerEnter={enter} onPointerLeave={exit}
    onFocus={() => setPinned(true)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPinned(false); }}
    onKeyDown={e => { if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setPinned(false); setHovered(false); setArrived(undefined); (e.target as HTMLElement).blur(); } }}>
    <button type="button" className={pulse ? "composer-aim-icon is-pulsing" : "composer-aim-icon"} aria-label={`About ${summary}`}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setPinned(v => !v)}>
      <EditPoint />
    </button>
    {open && <span id={id} className="composer-aim-card" role="group" aria-label="What this message is about">
      {items.map(item => <span key={item.key} className={item.key === arrived ? "composer-aim-row is-new" : "composer-aim-row"}>
        <span className="composer-aim-kind" aria-hidden="true">{item.kind === "range"
          ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 3H2.5v10h2M11.5 3h2v10h-2M5.5 8h5" /></svg>
          : <EditPoint />}</span>
        <span className="composer-aim-name">{item.name}</span>
        <span className="composer-aim-detail">{item.detail}</span>
        {/* A spoken message stays where it was said until it is out: aiming the box elsewhere would drop it. */}
        <button type="button" className="composer-aim-clear" disabled={disabled} aria-label={item.clearLabel}
          title={disabled ? disabledReason : item.clearLabel} onClick={() => { item.onClear(); setPinned(false); }}>
          <Icon name="x" size={10} />
        </button>
      </span>)}
    </span>}
  </span>;
}
