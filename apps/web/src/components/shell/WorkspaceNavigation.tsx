import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink } from "react-router-dom";
import { IS_MOCK } from "../../lib/client";
import { Icon } from "../ui/primitives";
import { ConnectionStatus } from "./StatusIndicators";

/** A menu's rows the keys can land on. */
const ENABLED_ITEM = '[role="menuitem"]:not(:disabled)';

/** `description` explains a visual mark. `floating` lets the menu escape a scrolling container. */
export function Dropdown({ button, children, align = "left", width = 260, label, above = false, description, floating = false }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: number; label: string; above?: boolean; description?: string; floating?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const contains = (target: Node | null) => ref.current?.contains(target) || menu.current?.contains(target);
  /** On the next frame, once the menu that just opened is drawn, the keyboard starts on its first row. */
  const focusFirstItem = () => requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>(ENABLED_ITEM)?.focus());
  // Whether the row being chosen was pressed with the pointer: a click carries a count, a key doesn't.
  const pointer = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A panel one of the rows opened, such as the model selector, closes on this Esc by itself and hands the focus
      // back to its row. Its listener runs after this one, so the menu has to leave the press to it.
      if (menu.current?.querySelector('[role="dialog"]')) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Keep a menu on a request anchored to its trigger while scrolling the chat or the list of edits.
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const position = () => {
      const panel = menu.current;
      const anchor = trigger.current?.getBoundingClientRect();
      if (!panel || !anchor) return;
      const inset = 8, gap = 4;
      const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
      const panelWidth = Math.max(0, Math.min(width, viewportWidth - 2 * inset));
      const left = align === "right" ? anchor.right - panelWidth : anchor.left;
      panel.style.width = `${panelWidth}px`;
      panel.style.left = `${Math.max(inset, Math.min(left, viewportWidth - panelWidth - inset))}px`;
      const roomBelow = viewportHeight - anchor.bottom - gap - inset;
      const roomAbove = anchor.top - gap - inset;
      const flip = above || (panel.offsetHeight > roomBelow && roomAbove > roomBelow);
      const top = flip ? anchor.top - gap - panel.offsetHeight : anchor.bottom + gap;
      panel.style.top = `${Math.max(inset, Math.min(top, viewportHeight - panel.offsetHeight - inset))}px`;
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open, floating, align, width, above]);
  const panel = open && (
    <div ref={menu} role="menu" aria-label={label} onClickCapture={e => { pointer.current = e.detail > 0; }}
      className={`${floating ? "fixed" : `absolute max-md:fixed max-md:inset-x-2 max-md:w-auto! ${above ? "bottom-full mb-1 max-md:bottom-10" : "top-full mt-1 max-md:top-10"} ${align === "right" ? "right-0" : "left-0"}`} z-50 card shadow-2xl p-1 max-h-[75dvh] overflow-y-auto`} style={{ width }}>
      {children(() => {
        setOpen(false);
        // A row chosen with the keyboard hands focus back to the menu's button, and Tab goes on from there. Chosen
        // with the pointer, the menu lets go of the focus, so the keys are the page's: Space plays, where it would
        // have pressed the button and opened the menu again, also once whatever the row opened has closed.
        if (!pointer.current) trigger.current?.focus();
        else if (contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      })}
    </div>
  );
  return (
    <div ref={ref} className="relative" onBlur={e => {
      if (e.relatedTarget && !contains(e.relatedTarget as Node)) setOpen(false);
    }} onKeyDown={e => {
      // A key the page has already taken is the page's: ↓ steps edits while a card is open, and a menu's button that
      // kept the focus opened its menu on the same press.
      if (e.defaultPrevented) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // A panel one of the rows opened, such as the model selector, has its own arrow keys.
      if (menu.current?.querySelector('[role="dialog"]')?.contains(e.target as Node)) return;
      const items = Array.from(menu.current?.querySelectorAll<HTMLElement>(ENABLED_ITEM) ?? []);
      if (!open) {
        if (e.target !== trigger.current || e.key !== "ArrowDown") return;
        e.preventDefault();
        setOpen(true);
        focusFirstItem();
      } else if (items.length) {
        e.preventDefault();
        e.stopPropagation();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 :
          (index + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} aria-description={description} onClick={() => {
        setOpen(!open);
        if (!open && floating) focusFirstItem();
      }} className="inline-flex items-center rounded-md hover:bg-raised focus-visible:bg-raised">
        {button}
      </button>
      {floating && panel ? createPortal(panel, document.body) : panel}
    </div>
  );
}

/** A row of a menu. A control that isn't a MenuItem, such as the model selector's row, takes the same shape from it. */
export const MENU_ITEM_CLASS = "w-full min-h-8 rounded-sm text-left px-2.5 py-1.5 text-[12.5px] enabled:hover:bg-raised focus-visible:bg-raised disabled:text-dim flex items-center gap-2.5";

export function MenuItem({ onClick, children, to, danger, disabled, title }: { onClick?: () => void; children: ReactNode; to?: string; danger?: boolean; disabled?: boolean; title?: string }) {
  const cls = `${MENU_ITEM_CLASS} ${danger ? "text-bad" : "text-fg"}`;
  if (to)
    return (
      <Link role="menuitem" to={to} className={cls + " hover:bg-raised"} title={title} onClick={onClick}>
        {children}
      </Link>
    );
  return (
    <button type="button" role="menuitem" className={cls} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export function WindowActions({ inSettings = false }: { inSettings?: boolean }) {
  return <div className="flex shrink-0 items-center gap-1">
      {IS_MOCK && <span className="demo-tag" title="This workspace uses sample projects">Demo</span>}
      <ConnectionStatus />

      {!inSettings && <NavLink to="/settings" aria-label="Settings" title="Settings" className="btn-icon"><Icon name="settings" size={16} /></NavLink>}
  </div>;
}
