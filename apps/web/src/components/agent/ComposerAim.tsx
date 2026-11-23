import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePopoverDismiss } from "../../lib/uiHooks";
import { useUiStore } from "../../stores/ui";
import { Icon, type IconName } from "../ui/primitives";

/** Monospace tabular timecode with dimmed fractional milliseconds (e.g. 10:13.908). */
export function AimTimecode({ value }: { value: string }) {
  const parts = value.split(/(\.\d+)/);
  return <span className="composer-aim-time">{parts.map((part, i) =>
    part.startsWith(".") ? <span key={i} className="composer-aim-ms">{part}</span> : part,
  )}</span>;
}

/** One thing the message is about: a cut, edit, moment, or marked stretch. */
export interface AimItem {
  key: string;
  name: string;
  displayName?: ReactNode;
  icon?: IconName;
  clearLabel: string;
  onClear(): void;
}

export function ComposerAim({ items, detail, disabled, disabledReason }: {
  items: [AimItem, ...AimItem[]]; detail?: ReactNode; disabled?: boolean; disabledReason?: string;
}) {
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const setLit = useUiStore(s => s.setAimLit);
  const [primary, ...additional] = items;
  if (open && !additional.length) setOpen(false);

  useEffect(() => {
    setLit(hovered || focused || open);
    return () => setLit(false);
  }, [hovered, focused, open, setLit]);

  usePopoverDismiss(open, group, trigger, () => setOpen(false));

  const showLabel = `Show ${additional.map(item => item.name).join(" and ")}`;
  const clear = (item: AimItem) => <button type="button" className="composer-aim-clear" disabled={disabled}
    title={disabled ? disabledReason : item.clearLabel} aria-label={item.clearLabel} aria-description={disabled ? disabledReason : undefined}
    onClick={() => { setOpen(false); item.onClear(); }}>
    <Icon name="x" size={12} />
  </button>;

  return <div ref={group} className="composer-aim" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
    <div className="composer-aim-main">
      {primary.icon && <span className="composer-aim-icon" aria-hidden="true"><Icon name={primary.icon} size={12} /></span>}
      <span className="composer-aim-name" title={`About ${primary.name}`}>{primary.displayName ?? primary.name}</span>
      {additional.length > 0 && <button ref={trigger} type="button" className="composer-aim-button"
        aria-label={showLabel} title={showLabel}
        aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={e => { e.currentTarget.focus({ preventScroll: true }); setOpen(value => !value); }}>
        <span aria-hidden="true">+{additional.length}</span>
        <Icon name="chevron" size={11} />
      </button>}
      {detail}
    </div>
    {clear(primary)}
    {open && <div id={id} className="composer-aim-card" data-escape-owner data-shortcut-overlay>
      {additional.map(item => <div key={item.key} className="composer-aim-row" role="group" aria-label={item.name}>
        <span aria-hidden="true" title={item.name}>{item.displayName ?? item.name}</span>
        {clear(item)}
      </div>)}
    </div>}
  </div>;
}
