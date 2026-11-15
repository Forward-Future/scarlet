import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const MIN_WIDTH = 250;

type RailProps = {
  compact: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
  label?: string;
  /** localStorage key for the width the user dragged to. */
  storageKey?: string;
  /** Width to use before the user has dragged, given the room available. */
  initialWidth?: (available: number) => number;
  /** The narrowest the rail can be dragged: what its columns need to stay usable. */
  minWidth?: number;
  /** The widest the rail can be dragged, given the room available. */
  maxWidth?: (available: number) => number;
  /** Which side of the workspace the rail sits on: its divider is on the other edge, toward the player. */
  side?: "left" | "right";
  /** What the divider resizes, for its name and hover. */
  resizes?: string;
};

export function ChatRail({ compact, children, id = "edit-chat", className = "workspace-rail requests-panel", label = "Edits",
  storageKey = "scarlet.chatWidth", initialWidth = available => available * 0.4, minWidth = MIN_WIDTH, maxWidth, side = "left", resizes = "chat" }: RailProps) {
  // Dragging toward the player widens the rail, whichever side it is on.
  const toward = side === "left" ? 1 : -1;
  const rail = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [available, setAvailable] = useState(window.innerWidth);
  const [preferred, setPreferred] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= minWidth ? saved : undefined;
  });
  useLayoutEffect(() => {
    const container = rail.current?.parentElement;
    if (!container) return;
    const measure = () => setAvailable(container.clientWidth || window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const max = Math.max(minWidth, Math.min(available - 360, maxWidth?.(available) ?? Infinity));
  const clamp = (value: number) => Math.round(Math.max(minWidth, Math.min(max, value)));
  const width = clamp(preferred ?? initialWidth(available));
  function save(value: number) {
    setPreferred(value);
    localStorage.setItem(storageKey, String(value));
  }

  return <aside ref={rail} id={id} className={className} aria-label={label} style={compact ? undefined : { width }}>
    {children}
    {!compact && <div role="separator" className={side === "left" ? "chat-divider" : "chat-divider is-left"} tabIndex={0}
      aria-label={`Resize ${resizes}`} title={`Drag to resize ${resizes}`}
      aria-orientation="vertical" aria-controls={id} aria-valuemin={minWidth} aria-valuemax={max} aria-valuenow={width}
      onPointerDown={e => {
        if (e.button !== 0 || !e.isPrimary) return;
        drag.current = { pointer: e.pointerId, x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={e => {
        const start = drag.current;
        if (start?.pointer === e.pointerId) setPreferred(clamp(start.width + (e.clientX - start.x) * toward));
      }}
      onPointerUp={e => {
        const start = drag.current;
        if (start?.pointer === e.pointerId) save(clamp(start.width + (e.clientX - start.x) * toward));
        drag.current = null;
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={e => {
        const target = { ArrowLeft: width - 16 * toward, ArrowRight: width + 16 * toward, Home: minWidth, End: max }[e.key];
        if (target === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        save(clamp(target));
      }} />}
  </aside>;
}
