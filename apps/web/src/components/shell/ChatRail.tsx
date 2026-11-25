import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const MIN_WIDTH = 250;
/** Under this a rail's header no longer has room for everything at full length. */
const NARROW = 360;

type RailProps = {
  compact: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
  label?: string;
  /** Hide the rail while keeping it mounted (for example an empty edits column). */
  hidden?: boolean;
  /** Optional ref to the underlying <aside> element. */
  railRef?: RefObject<HTMLElement | null>;
  /** localStorage key for the width the user dragged to. */
  storageKey?: string;
  /** Width to use before the user has dragged, given the room available. */
  initialWidth?: (available: number) => number;
  /** The narrowest the rail can be dragged: what its columns need to stay usable. */
  minWidth?: number;
  /** The widest the rail can be dragged, given the room available. */
  maxWidth?: (available: number) => number;
  /** The id (or ids) of other rails in the same row: their widths come out of the room this one can be dragged into. */
  beside?: string | readonly string[];
  /** Extra horizontal room to keep free beyond the player's 360px minimum (for example another rail's min width). */
  reserve?: number;
  /** Which side of the workspace the rail sits on: its divider is on the other edge, toward the player. */
  side?: "left" | "right";
  /** What the divider resizes, for its name and hover. */
  resizes?: string;
};

export function ChatRail({ compact, children, id = "edit-chat", className = "workspace-rail requests-panel", label = "Edits", hidden, railRef,
  storageKey = "scarlet.chatWidth", initialWidth = available => available * 0.4, minWidth = MIN_WIDTH, maxWidth, beside, reserve = 0, side = "left", resizes = "chat" }: RailProps) {
  // Dragging toward the player widens the rail, whichever side it is on.
  const toward = side === "left" ? 1 : -1;
  const rail = useRef<HTMLElement>(null);
  const setRail = (el: HTMLElement | null) => {
    rail.current = el;
    if (railRef) railRef.current = el;
  };
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [available, setAvailable] = useState(window.innerWidth);
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= minWidth ? saved : undefined;
    } catch { return undefined; }
  });
  useLayoutEffect(() => {
    const container = rail.current?.parentElement;
    if (!container) return;
    const measure = () => setAvailable(container.clientWidth || window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Other rails' widths as they stand, so all rails together always leave the player its room.
  const besideKey = typeof beside === "string" ? beside : beside ? beside.join(",") : "";
  const [taken, setTaken] = useState(0);
  useLayoutEffect(() => {
    const ids = besideKey ? besideKey.split(",") : [];
    const others = !compact ? ids.map(otherId => document.getElementById(otherId)).filter((el): el is HTMLElement => !!el) : [];
    if (!others.length) return setTaken(0);
    const read = () => setTaken(others.reduce((sum, el) => sum + (el.hidden ? 0 : el.getBoundingClientRect().width), 0));
    read();
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : undefined;
    const attrs = typeof MutationObserver !== "undefined" ? new MutationObserver(read) : undefined;
    for (const el of others) {
      resize?.observe(el);
      attrs?.observe(el, { attributes: true, attributeFilter: ["hidden", "style"] });
    }
    return () => {
      resize?.disconnect();
      attrs?.disconnect();
    };
  }, [besideKey, compact]);
  const max = Math.max(minWidth, Math.min(available - taken - 360 - reserve, maxWidth?.(available) ?? Infinity));
  const clamp = (value: number) => Math.round(Math.max(minWidth, Math.min(max, value)));
  const width = clamp(preferred ?? initialWidth(available));
  function save(value: number) {
    setPreferred(value);
    try { localStorage.setItem(storageKey, String(value)); } catch { /* ignore storage errors */ }
  }

  // Dragged near its narrowest, a rail says so, so its header can give the room it has to what matters most there.
  return <aside ref={setRail} id={id} className={className} aria-label={label} hidden={hidden} style={compact ? undefined : { width }} data-narrow={!compact && width < NARROW ? "" : undefined}>
    {children}
    {!compact && !hidden && <div role="separator" className={side === "left" ? "chat-divider" : "chat-divider is-left"} tabIndex={0}
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
        // A press that never moved is not a width the editor chose: the chat keeps following the window.
        if (start?.pointer === e.pointerId && e.clientX !== start.x) save(clamp(start.width + (e.clientX - start.x) * toward));
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
