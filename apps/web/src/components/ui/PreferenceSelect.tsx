import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mediaPlaying } from "../../lib/hotkeys";
import { Icon } from "./primitives";

/**
 * `detail` is a second, dimmer line under the label; `tag` is a word at the row's right, such as "Now"; a new
 * `group` starts a heading over the rows that share it, such as a day.
 */
type Choice<T> = { value: T; label: string; detail?: string; tag?: string; group?: string };

/** Where the list can be seen: inside the open dialog or the element that is full screen, which draw over the page. */
function layerOf(trigger: HTMLElement | null) {
  const full = document.fullscreenElement;
  return trigger?.closest("dialog") ?? (full?.contains(trigger) ? full : document.body);
}

/**
 * `title` is what the field says on hover, such as its whole value where a narrow place cuts it short. `more` ends a
 * long list that shows only its latest choices: picking it shows the rest and leaves the list open.
 */
export function PreferenceSelect<const T extends string | number>({ id, label, options, value, onChange, onClose, disabled, compact, valueLabel, title, more }: {
  id?: string; label?: string; options: Choice<T>[]; value: T; onChange(value: NoInfer<T>): void; onClose?(): void;
  disabled?: boolean; compact?: boolean; valueLabel?: string; title?: string; more?: { label: string; onPick(): void };
}) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const list = triggerId + "-choices";
  const [active, setActive] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLUListElement>(null);
  const selected = options.findIndex(option => option.value === value);
  const initialIndex = Math.max(0, selected);
  const unavailable = disabled || options.length === 0;
  const open = active !== null && !unavailable;
  // The rows the keys step through: every choice, then `more` when there is one.
  const last = options.length - (more ? 0 : 1);
  const index = Math.min(active ?? 0, last);

  useEffect(() => { if (unavailable) setActive(null); }, [unavailable]);

  function choose(i: number) {
    if (more && i === options.length) return more.onPick();
    const option = options[i];
    if (option && option.value !== value && !trigger.current?.matches(":disabled")) onChange(option.value);
    setActive(null);
    onClose?.();
  }

  // Escape scrolling panes, while staying inside the top layer the field is in.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!;
    const menu = panel.current!;
    function place() {
      const box = anchor.getBoundingClientRect();
      const below = window.innerHeight - box.bottom - 8;
      const above = box.top - 8;
      menu.style.minWidth = Math.min(box.width, window.innerWidth - 16) + "px";
      const upwards = menu.scrollHeight + 2 > below && above > below;
      menu.style.maxHeight = Math.max(0, upwards ? above : below) + "px";
      menu.style.top = (upwards ? box.top - menu.offsetHeight - 4 : box.bottom + 4) + "px";
      menu.style.left = Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    observer.observe(menu);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  useLayoutEffect(() => {
    if (open) document.getElementById(list + "-" + index)?.scrollIntoView({ block: "nearest" });
  }, [open, index]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return <>
    <button type="button" role="combobox" ref={trigger} id={triggerId} aria-label={label} title={title} disabled={unavailable}
      aria-expanded={open} aria-controls={open ? list : undefined} aria-activedescendant={open ? list + "-" + index : undefined}
      className={compact ? "preference-select compact" : "preference-select"} onBlur={() => setActive(null)}
      onMouseDown={e => e.preventDefault()}
      onClick={e => {
        e.currentTarget.focus();
        setActive(open ? null : initialIndex);
        if (open) onClose?.();
      }}
      onKeyDown={e => {
        // A key the page has already acted on, such as ↑ or ↓ stepping to another edit, doesn't also open the list.
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        // While something plays, Space pauses it, as it does from any button that keeps focus. Enter and the arrows still open the list.
        if (e.key === " " && !open && mediaPlaying()) return;
        switch (e.key) {
          case "ArrowDown": setActive(open ? Math.min(last, index + 1) : initialIndex); break;
          case "ArrowUp": setActive(open ? Math.max(0, index - 1) : initialIndex); break;
          case "Home": setActive(0); break;
          case "End": setActive(last); break;
          case "Enter": case " ": if (open) choose(index); else setActive(initialIndex); break;
          case "Escape": if (!open) return; setActive(null); onClose?.(); break;
          default: {
            if (e.key.length !== 1) return;
            const match = options.findIndex(option => option.label.toLowerCase().startsWith(e.key.toLowerCase()));
            if (match < 0) return;
            if (open) setActive(match); else choose(match);
          }
        }
        e.preventDefault();
        e.stopPropagation();
      }}>
      <span className="truncate">{valueLabel ?? options[selected]?.label ?? value}</span>
      <span className={open ? "-rotate-90" : "rotate-90"}><Icon name="chevron" size={12} /></span>
    </button>
    {open && createPortal(<ul ref={panel} role="listbox" id={list} aria-labelledby={triggerId} data-shortcut-overlay className="preference-options">
      {options.map((option, i) => <Fragment key={option.value}>
        {option.group && option.group !== options[i - 1]?.group && <li role="presentation" className="preference-group">{option.group}</li>}
        <li id={list + "-" + i} role="option" aria-selected={i === selected} data-detailed={option.detail ? "" : undefined}
          data-active={i === index} onPointerMove={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => choose(i)}>
          {option.detail ? <span className="preference-option-text"><span>{option.label}</span><span className="preference-option-detail">{option.detail}</span></span> : option.label}
          {option.tag && <span className="preference-option-tag">{option.tag}</span>}
          {i === selected && <Icon name="check" size={14} />}
        </li>
      </Fragment>)}
      {more && <li id={list + "-" + options.length} role="option" aria-selected={false} className="preference-more" data-active={index === options.length}
        onPointerMove={() => setActive(options.length)} onMouseDown={e => e.preventDefault()} onClick={() => choose(options.length)}>{more.label}</li>}
    </ul>, layerOf(trigger.current))}
  </>;
}
