import { memo, useId, useMemo, useState } from "react";
import { clock } from "../../lib/format";
import type { EditMarker } from "./EditReferences";
import { Icon } from "../ui/primitives";

export type TimelineMarker = EditMarker & { id: string; kind: "caption" | "edit" };

/** Nearby marks share a hit target when the full cut is zoomed out. */
export const TimelineMarkers = memo(function TimelineMarkers({ markers, from, to, width, onChoose }: {
  markers: TimelineMarker[]; from: number; to: number; width: number; onChoose(time: number): void;
}) {
  const tipId = useId();
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const groups = useMemo(() => {
    const groups: { x: number; marks: TimelineMarker[] }[] = [];
    if (to <= from || width <= 0) return groups;
    const visible = markers.filter(m => m.time >= from && m.time <= to).sort((a, b) => a.time - b.time);
    for (const mark of visible) {
      const x = Math.min(width - 8, Math.max(8, (mark.time - from) / (to - from) * width));
      const last = groups.at(-1);
      if (last && x - last.x < 16) last.marks.push(mark);
      else groups.push({ x, marks: [mark] });
    }
    return groups;
  }, [markers, from, to, width]);

  return <div className="timeline-markers" onPointerLeave={() => setHovered(undefined)}
    onKeyDown={e => { if (e.key === "Escape") { setHovered(undefined); setFocused(undefined); e.stopPropagation(); } }}>
    {groups.map(({ x, marks }) => {
      const first = marks[0]!;
      const open = (hovered ?? focused) === first.id;
      const label = marks.length > 1 ? `${marks.length} timeline markers` : first.kind === "caption" ? "Caption marker" : "Edit marker";
      return <div key={first.id}>
        <button type="button" className="timeline-marker" style={{ left: x }}
          aria-label={`${label} at ${clock(first.time)}`} aria-describedby={open ? tipId : undefined}
          onPointerEnter={e => { if (e.pointerType !== "touch") setHovered(first.id); }}
          onFocus={() => setFocused(first.id)} onBlur={() => setFocused(undefined)}
          onClick={e => {
            e.currentTarget.focus({ preventScroll: true });
            setFocused(first.id);
            onChoose(first.time);
          }} />
        {open && <div className="timeline-marker-tip" role="tooltip" id={tipId}
          style={x < width / 2 ? { left: x - 8, maxWidth: width - x + 8 } : { right: width - x - 8, maxWidth: x + 8 }}>
          {marks.map(mark => <div className="timeline-marker-note" key={mark.id}>
            <span><Icon name={mark.icon} size={12} /> {clock(mark.time)}</span>{mark.description}
          </div>)}
        </div>}
      </div>;
    })}
  </div>;
});
