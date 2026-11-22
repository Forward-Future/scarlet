import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatingPosition } from "../../lib/uiHooks";

/**
 * A small button that is only an icon, named by `tip`: the name shows over it the moment the pointer rests on it or the
 * keyboard reaches it, with no delay, as a note fixed to the window so a scrolling box doesn't clip it. It sits above
 * the button with its right edge at the button's, or under it when there's no room above.
 */
export function TipButton({ tip, children, className, ...props }: { tip: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title">) {
  const ref = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useFloatingPosition(open, ref, note, { rightOffset: 6 });
  return <>
    <button ref={ref} type="button" aria-label={tip} className={className} {...props}
      onPointerEnter={e => { if (e.pointerType !== "touch") setOpen(true); props.onPointerEnter?.(e); }}
      onPointerLeave={e => { if (!ref.current?.matches(":focus-visible")) setOpen(false); props.onPointerLeave?.(e); }}
      onFocus={e => { setOpen(true); props.onFocus?.(e); }}
      onBlur={e => { setOpen(false); props.onBlur?.(e); }}>
      {children}
    </button>
    {open && createPortal(<span ref={note} className="button-tip" aria-hidden>{tip}</span>, document.body)}
  </>;
}
