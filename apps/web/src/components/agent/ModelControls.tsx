import { useRef, useState } from "react";
import type { ModelOptions } from "@scarlet/shared";
import { Icon } from "../ui/primitives";
import { effortLevel, optionLabel } from "./modelOptions";

const DIAL_SWEEP = 125;
function dialPoint(degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return `${(8 + 6 * Math.sin(radians)).toFixed(2)} ${(9 - 6 * Math.cos(radians)).toFixed(2)}`;
}

export function EffortDial({ level, size = 14 }: { level?: number; size?: number }) {
  const start = -DIAL_SWEEP;
  const end = level === undefined ? undefined : start + 2 * DIAL_SWEEP * level;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="shrink-0" aria-hidden="true">
      <path d={`M${dialPoint(start)}A6 6 0 1 1 ${dialPoint(DIAL_SWEEP)}`} opacity="0.3" />
      {end !== undefined && end > start && <path d={`M${dialPoint(start)}A6 6 0 ${end - start > 180 ? 1 : 0} 1 ${dialPoint(end)}`} />}
      {end !== undefined && <path d="M8 9V4.5" strokeWidth="1.5" transform={`rotate(${end.toFixed(1)} 8 9)`} />}
      <circle cx="8" cy="9" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BoltIcon() {
  return (
    <svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
      <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8l1-5.5z" />
    </svg>
  );
}

export function GaugeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
      <path d="M2.5 11.5a6 6 0 1 1 11 0" />
      <path d="M8 9l2.6-2.8" />
      <circle cx="8" cy="9.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function EffortSlider({ options, value, visualId, onChange }: {
  options: Array<{ id: string; label: string; title?: string }>;
  value?: string;
  visualId?: string;
  onChange: (v: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const activeIndex = options.findIndex(o => o.id === value);
  const visualIndex = activeIndex >= 0 ? activeIndex : options.findIndex(o => o.id === visualId);

  if (options.length === 1) {
    const only = options[0]!;
    const checked = value === only.id;
    return (
      <div role="radiogroup" aria-label="Effort" className="flex items-center">
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          title={only.title}
          onClick={() => onChange(only.id)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${checked ? "border-fg/35 bg-raised text-fg" : "border-line bg-bg text-muted hover:text-fg"}`}
        >
          <span className={`size-2 rounded-full ${checked ? "bg-fg" : "bg-muted"}`} aria-hidden />
          {only.label}
        </button>
      </div>
    );
  }

  const settledRatio = visualIndex > 0 ? visualIndex / (options.length - 1) : 0;
  const displayRatio = dragRatio ?? settledRatio;
  const isDragging = dragRatio !== null;
  const isExplicit = activeIndex >= 0 || isDragging;
  const alphaLeft = isExplicit ? 0.14 + displayRatio * 0.14 : 0.1;
  const alphaRight = isExplicit ? 0.24 + displayRatio * 0.24 : 0.18;
  const shimmerOpacity = isExplicit ? (displayRatio >= 0.95 ? 0.85 : displayRatio >= 0.6 ? 0.35 : 0) : 0;

  function ratioFromClientX(clientX: number): number | null {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - 26;
    if (usable <= 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left - 13) / usable));
  }

  function pickRatio(pos: number, lastPicked: { current: string | undefined }) {
    const picked = options[Math.round(pos * (options.length - 1))];
    if (picked && picked.id !== lastPicked.current) {
      lastPicked.current = picked.id;
      onChange(picked.id);
    }
  }

  return (
    <div role="radiogroup" aria-label="Effort" className="select-none touch-none">
      <div
        ref={trackRef}
        className="relative h-[26px] cursor-pointer overflow-hidden rounded-full bg-bg shadow-[inset_0_0_0_1px_var(--color-line),inset_0_1px_2px_rgba(0,0,0,0.35)]"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const target = e.currentTarget;
          const lastPicked = { current: value };
          draggedRef.current = true;
          target.setPointerCapture?.(e.pointerId);
          const startPos = ratioFromClientX(e.clientX);
          if (startPos !== null) {
            setDragRatio(startPos);
            pickRatio(startPos, lastPicked);
          }
          const onMove = (ev: PointerEvent) => {
            const pos = ratioFromClientX(ev.clientX);
            if (pos !== null) {
              setDragRatio(pos);
              pickRatio(pos, lastPicked);
            }
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            setDragRatio(null);
            setTimeout(() => { draggedRef.current = false; }, 0);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onUp);
        }}
      >
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-full ${isDragging ? "" : "transition-[width] duration-150 ease-out"}`}
          style={{
            width: `calc(26px + (100% - 26px) * ${displayRatio})`,
            background: `linear-gradient(90deg, rgba(244, 244, 245, ${alphaLeft.toFixed(3)}), rgba(244, 244, 245, ${alphaRight.toFixed(3)}))`,
          }}
        >
          <div
            className="effort-capsule-shimmer absolute inset-0 rounded-full transition-opacity duration-200"
            style={{ opacity: shimmerOpacity }}
            aria-hidden="true"
          />
        </div>
        {options.map((o, i) => {
          const stepRatio = i / (options.length - 1);
          const isVisual = visualIndex === i;
          const isPassed = visualIndex >= 0 && i < visualIndex;
          return (
            <span
              key={o.id}
              aria-hidden="true"
              style={{ left: `calc(13px + (100% - 26px) * ${stepRatio})` }}
              className={`pointer-events-none absolute top-1/2 z-10 size-[4px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-150 ${
                isVisual
                  ? "opacity-0"
                  : isPassed
                    ? "bg-fg opacity-40"
                    : "bg-muted opacity-40"
              }`}
            />
          );
        })}
        <span
          aria-hidden="true"
          style={{ left: `calc(13px + (100% - 26px) * ${displayRatio})` }}
          className={`pointer-events-none absolute top-[3px] z-20 size-[20px] -translate-x-1/2 rounded-full ${
            isExplicit ? "bg-fg" : "bg-fg/85"
          } ${
            isDragging
              ? "scale-110 shadow-[0_2px_8px_rgba(0,0,0,0.6),0_0_0_2px_rgba(255,255,255,0.22)]"
              : "shadow-[0_1px_4px_rgba(0,0,0,0.52),0_0_0_1px_rgba(255,255,255,0.14)] transition-[left,transform,box-shadow] duration-150 ease-out"
          }`}
        />
      </div>
      <div className="relative mt-1.5 h-[18px]">
        {options.map((o, i) => {
          const stepRatio = i / (options.length - 1);
          const isFirst = i === 0;
          const isLast = i === options.length - 1;
          const isSelected = value === o.id;
          const isVisual = visualIndex === i;
          const posStyle = isFirst
            ? { left: 0 }
            : isLast
              ? { right: 0 }
              : { left: `calc(13px + (100% - 26px) * ${stepRatio})` };
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              title={o.title}
              style={posStyle}
              onClick={() => { if (!draggedRef.current) onChange(o.id); }}
              className={`absolute top-0 rounded text-[10.5px] leading-[18px] whitespace-nowrap transition-colors focus-visible:outline-offset-2 ${
                isFirst || isLast ? "" : "-translate-x-1/2"
              } ${
                isSelected
                  ? "font-semibold text-fg"
                  : isVisual
                    ? "font-medium text-fg/85"
                    : "text-muted hover:text-fg"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SpeedSegmented({ options, value, onChange, inline = false }: {
  options: Array<{ id: string; label: string; title?: string }>;
  value: string;
  onChange: (v: string) => void;
  inline?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Speed"
      className={`flex gap-0.5 rounded-md border border-line bg-bg p-0.5 ${inline ? "min-w-0 flex-1 max-w-[14rem]" : "w-full"}`}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id || "__default"}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={`min-w-0 flex-1 truncate rounded-[4px] px-2 py-[3px] text-center text-[11px] font-medium transition-colors ${active ? "bg-raised text-fg shadow-xs" : "text-muted hover:text-fg"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The model selector's drawer for the selected model's effort and speed, with Done to fold it. AgentChip calls it as a
 * function (it holds no hooks) so its Done button stays the very element the dock's Tune button was, keeping focus.
 */
export function TuneDrawer({ efforts, dialEffort, effortSummary, effortValue, speedOptions, activeSpeedId, onEffortChange, onSpeedChange, onDone }: {
  efforts: ModelOptions["efforts"];
  dialEffort?: ModelOptions["efforts"][number];
  effortSummary: string;
  effortValue?: string;
  speedOptions: Array<{ id: string; label: string; title?: string }>;
  activeSpeedId: string;
  onEffortChange: (effort: string) => void;
  onSpeedChange: (speed: string) => void;
  onDone: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={true}
        onClick={onDone}
        className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-raised/40"
      >
        <span className="inline-flex items-center gap-1.5 eyebrow text-muted">
          {efforts.length > 0 ? (
            <>
              <EffortDial level={effortLevel(efforts, dialEffort?.id)} size={12} />
              Effort
              <span className="font-sans text-[11.5px] font-semibold normal-case tracking-normal text-fg">
                · {effortSummary}
              </span>
            </>
          ) : (
            <>
              <BoltIcon />
              Speed
            </>
          )}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-fg">
          Done
          <span className="inline-flex rotate-180">
            <Icon name="down" size={10} />
          </span>
        </span>
      </button>
      <div className="px-3 pb-2.5">
        {efforts.length > 0 && (
          <EffortSlider
            options={efforts.map(e => ({ id: e.id, label: optionLabel(e), title: e.description }))}
            value={effortValue}
            visualId={dialEffort?.id}
            onChange={onEffortChange}
          />
        )}
        {speedOptions.length > 0 && (
          efforts.length > 0 ? (
            <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-line/60 pt-2.5">
              <span className="inline-flex shrink-0 items-center gap-1 eyebrow text-muted">
                <BoltIcon />
                Speed
              </span>
              <SpeedSegmented
                inline
                options={speedOptions}
                value={activeSpeedId}
                onChange={onSpeedChange}
              />
            </div>
          ) : (
            <SpeedSegmented
              options={speedOptions}
              value={activeSpeedId}
              onChange={onSpeedChange}
            />
          )
        )}
      </div>
    </div>
  );
}
