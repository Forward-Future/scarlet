import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useMatch } from "react-router-dom";
import { IS_MOCK } from "../../lib/client";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";
import { ConnectionStatus } from "./StatusIndicators";

/** `description` says what the menu's mark means to someone who can't see it, such as "2 rules to review". */
export function Dropdown({ button, children, align = "left", width = 260, label, above = false, description }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: number; label: string; above?: boolean; description?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Whether the row being chosen was pressed with the pointer: a click carries a count, a key doesn't.
  const pointer = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A panel one of the rows opened, such as the model selector, closes on this Esc by itself and hands the focus
      // back to its row. Its listener runs after this one, so the menu has to leave the press to it.
      if (ref.current?.querySelector('[role="dialog"]')) return;
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
  return (
    <div ref={ref} className="relative" onBlur={e => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
    }} onKeyDown={e => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // A panel one of the rows opened, such as the model selector, has its own arrow keys.
      if (ref.current?.querySelector('[role="dialog"]')?.contains(e.target as Node)) return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!open) {
        if (e.target !== trigger.current || e.key !== "ArrowDown") return;
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
      } else if (items.length) {
        e.preventDefault();
        e.stopPropagation();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 :
          (index + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} aria-description={description} onClick={() => setOpen(!open)} className="inline-flex items-center rounded-md hover:bg-raised focus-visible:bg-raised">
        {button}
      </button>
      {open && (
        <div role="menu" aria-label={label} onClickCapture={e => { pointer.current = e.detail > 0; }} className={`absolute max-md:fixed max-md:inset-x-2 max-md:w-auto! ${above ? "bottom-full mb-1 max-md:bottom-10" : "top-full mt-1 max-md:top-10"} z-50 card shadow-2xl p-1 max-h-[75dvh] overflow-y-auto ${align === "right" ? "right-0" : "left-0"}`} style={{ width }}>
          {children(() => {
            setOpen(false);
            // A row chosen with the keyboard hands focus back to the menu's button, and Tab goes on from there. Chosen
            // with the pointer, the menu lets go of the focus, so the keys are the page's: Space plays, where it would
            // have pressed the button and opened the menu again, also once whatever the row opened has closed.
            if (!pointer.current) trigger.current?.focus();
            else if (ref.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
          })}
        </div>
      )}
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
  const projectId = useMatch("/p/:id/*")?.params.id;
  const setProjectSettingsOpen = useUiStore(s => s.setProjectSettingsOpen);
  return <div className="flex shrink-0 items-center gap-1">
      {IS_MOCK && <span className="demo-tag" title="This workspace uses sample projects">Demo</span>}
      <ConnectionStatus />

      {projectId ? <Dropdown label="Settings menu" align="right" width={180} button={<span className="btn-icon"><Icon name="settings" size={15} /></span>}>
        {(close) => (
          <>
            {projectId && (
              <MenuItem onClick={() => { close(); setProjectSettingsOpen(true); }}>
                Project settings
              </MenuItem>
            )}
            <MenuItem to="/settings" onClick={close}>
              App settings
            </MenuItem>
          </>
        )}
      </Dropdown> : !inSettings && <NavLink to="/settings" aria-label="Settings" title="Settings" className="btn-icon"><Icon name="settings" size={16} /></NavLink>}
  </div>;
}
