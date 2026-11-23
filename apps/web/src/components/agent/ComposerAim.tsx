import { useEffect, useState, type ReactNode } from "react";
import { useUiStore } from "../../stores/ui";
import { DimMs, Icon } from "../ui/primitives";

/** One thing the message is about: a cut, edit, moment, or marked stretch. */
export interface AimItem {
  key: string;
  name: string;
  displayName?: ReactNode;
  title?: string;
  clearLabel: string;
  onClear(): void;
}

export function AimTimecode({ value, precise }: { value: string; precise?: string }) {
  const [showMs, setShowMs] = useState(false);
  const canToggle = !!precise && precise !== value;
  const shown = canToggle && showMs ? precise : value;
  if (!canToggle) return <span className="composer-aim-time"><DimMs text={shown} /></span>;
  return <button
    type="button"
    className="composer-aim-time"
    aria-pressed={showMs}
    onClick={e => { e.stopPropagation(); setShowMs(v => !v); }}
  ><DimMs text={shown} /></button>;
}

export function ComposerAim({ item, disabled, disabledReason }: {
  item: AimItem; disabled?: boolean; disabledReason?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const setLit = useUiStore(s => s.setAimLit);

  useEffect(() => {
    setLit(hovered || focused);
    return () => setLit(false);
  }, [hovered, focused, setLit]);

  return <div className="composer-aim" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
    <div className="composer-aim-main">
      <span className="composer-aim-name" title={item.title}>
        {typeof item.displayName === "string"
          ? <DimMs text={item.displayName} />
          : item.displayName ?? <DimMs text={item.name} />}
      </span>
    </div>
    <button type="button" className="composer-aim-clear" disabled={disabled}
      title={disabled ? disabledReason : item.clearLabel} aria-label={item.clearLabel} aria-description={disabled ? disabledReason : undefined}
      onClick={item.onClear}>
      <Icon name="x" size={12} />
    </button>
  </div>;
}
