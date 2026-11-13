import { useEffect, useLayoutEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { errorMessage } from "../../lib/client";
import { initials } from "../../lib/format";

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block size-4 rounded-full border-2 border-line border-t-fg animate-spin ${className}`}
    />
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-muted">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, body, action, icon = "film" }: { title: string; body?: string; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty-state">
      <span className="empty-glyph"><Icon name={icon} size={27} /></span>
      <div className="text-[17px] font-semibold tracking-tight">{title}</div>
      {body && <div className="text-muted max-w-sm">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", body, onRetry }: { title?: string; body?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 rounded-lg border border-bad/40 bg-bad/5 p-4">
      <div className="text-bad font-medium">{title}</div>
      {body && <div className="text-muted mt-1 break-words">{body}</div>}
      {onRetry && (
        <button className="btn-ghost mt-3" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="text-bad text-[12px] mt-1">
      {children}
    </div>
  );
}

export function Progress({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1 w-full rounded-full bg-line overflow-hidden ${className}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-fg/70 transition-[width] duration-300" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function ActivityProgress({ label, value, children }: { label: string; value?: number; children: ReactNode }) {
  return <>
    <progress aria-label={label} className="activity-progress" value={value} max={1} />
    <div role="status" className="mt-1.5 text-xs text-muted tnum">{children}</div>
  </>;
}

export function Avatar({ name, size = 22, tone = "neutral" }: { name: string; size?: number; tone?: "neutral" | "accent" }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold select-none shrink-0 ${tone === "accent" ? "bg-hi-dim text-fg" : "bg-raised text-muted"}`}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }}
      title={name}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-raised text-muted",
  accent: "bg-hi-dim text-fg",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-raised text-fg",
};

export function Chip({ tone = "neutral", children, className = "", title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={`chip ${TONE[tone]} ${className}`} title={title}>
      {children}
    </span>
  );
}

/**
 * Native modality keeps focus inside the topmost overlay and restores its opener. The keyboard starts on the first
 * field or button, or with `focusSelf` on the dialog itself: for a list whose first button would act on a row at once.
 */
export function DialogSurface({ children, onDismiss, focusSelf, ...props }: ComponentPropsWithoutRef<"dialog"> & { onDismiss(): void; focusSelf?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  // A press that began inside, such as a text selection dragged past the edge, is not a click on the backdrop.
  const pressedOutside = useRef(false);
  const outside = (e: { clientX: number; clientY: number; currentTarget: HTMLDialogElement }) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    return e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom;
  };
  // Chromium closes a dialog on a second Esc in a row whatever its cancel handler answered, and says so with a toggle.
  // One its owner still shows comes back: left closed, a dialog that stays while its action runs could never be reopened.
  useEffect(() => {
    const dialog = ref.current!;
    // Checked once the commit is over: a dialog its owner took away is off the page by then.
    const reopen = () => queueMicrotask(() => { if (dialog.isConnected && !dialog.open) dialog.showModal(); });
    for (const type of ["toggle", "close"]) dialog.addEventListener(type, reopen);
    return () => { for (const type of ["toggle", "close"]) dialog.removeEventListener(type, reopen); };
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const first = focusSelf ? dialog : dialog.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button:not([data-close])");
    first?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog {...props} ref={ref} tabIndex={focusSelf ? -1 : undefined} onCancel={(e) => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    }}
      onPointerDown={(e) => { pressedOutside.current = e.target === e.currentTarget && outside(e); }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (pressedOutside.current && outside(e)) onDismiss();
        pressedOutside.current = false;
      }}>
      {children}
    </dialog>
  );
}

export function Modal({ open, onClose, title, children, width = 440, footer, focusSelf }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number; footer?: ReactNode; focusSelf?: boolean }) {
  const id = useId();
  if (!open) return null;
  return (
    <DialogSurface onDismiss={onClose} focusSelf={focusSelf} aria-labelledby={id} className="studio-dialog fixed inset-0 m-auto card text-fg shadow-2xl w-[calc(100%-2rem)] max-h-[90dvh] flex flex-col backdrop:bg-black/60" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 id={id} className="font-semibold text-[14px]">
            {title}
          </h2>
          <button data-close className="btn-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-line flex justify-end gap-2">{footer}</div>}
    </DialogSurface>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = "Confirm", danger }: { open: boolean; onClose: () => void; onConfirm: () => void | Promise<void>; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A dialog that stays mounted while closed opens clean: the last attempt's error isn't this one's.
  useEffect(() => { if (!open) setErr(null); }, [open]);
  return (
    <Modal
      open={open}
      // The dialog stays until its action settles, as Cancel does: closed by Esc or the ×, a failure would have nowhere to show.
      onClose={() => { if (!busy) onClose(); }}
      title={title}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setErr(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner className="size-3" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-muted">{body}</div>
      <InlineError>{err}</InlineError>
    </Modal>
  );
}

/** Right-side drawer. */
export function Drawer({ open, onClose, title, children, footer, width = 380, wrapContents }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number; wrapContents?: (contents: ReactNode) => ReactNode }) {
  if (!open) return null;
  const contents = <>
    <div className="flex items-center justify-between px-5 py-3 min-h-[57px] border-b border-line">
      <h2 className="font-semibold text-[14px]">{title}</h2>
      <button className="btn-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
    <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
    {footer}
  </>;
  return (
    <DialogSurface onDismiss={onClose} aria-label={title} className="studio-drawer fixed inset-y-0 left-auto right-0 m-0 h-full max-h-full max-w-full bg-panel text-fg border-l border-line shadow-2xl flex flex-col backdrop:bg-transparent" style={{ width }}>
      {wrapContents ? wrapContents(contents) : contents}
    </DialogSurface>
  );
}

export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: string; htmlFor?: string }) {
  return (
    <div className="mb-3">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="text-dim text-[11.5px] mt-1">{hint}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-hi" : "bg-line"}`}
    >
      <span className={`inline-block size-3.5 rounded-full transition-transform ${checked ? "translate-x-4 bg-bg" : "translate-x-0.5 bg-muted"}`} />
    </button>
  );
}

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </header>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3 mt-1">
      <h3 className="text-[14px] font-semibold text-fg">{children}</h3>
      {right}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

export type IconName = "fullscreen" | "more" | "undo" | "refresh" | "play" | "pause" | "prev" | "next" | "mic" | "stop" | "bell" | "plus" | "chevron" | "check" | "x" | "note" | "diff" | "down" | "upload" | "export" | "link" | "trash" | "copy" | "search" | "zoom" | "settings" | "help" | "swap" | "compare" | "bolt" | "film" | "library" | "history" | "clock" | "stack" | "audio" | "image" | "arrow" | "monitor" | "review" | "star" | "trim" | "captions" | "warning" | "scissors" | "bulb" | "pencil";

const iconPaths: Record<IconName, ReactNode> = {
  scissors: <><circle cx="4" cy="4" r="2" /><circle cx="4" cy="12" r="2" /><path d="M5.4 5.4 8 8m5.3-5.3-7.9 7.9m4.4-.7 3.5 3.5" /></>,
  trim: <path d="M8 2v2m0 3v2m0 3v2M1 8h4L3 6m2 2-2 2m12-2h-4l2-2m-2 2 2 2" />,
  warning: <path d="M8 1.8 15 14H1zM8 6.5v3.2M8 11.9h.01" />,
  captions: <><rect x="1" y="3" width="14" height="10" rx="2" /><path d="M3.5 7h3m2 0h3.5m-8.5 3h5m2 0H13" /></>,
  more: <g fill="currentColor" stroke="none"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></g>,
  star: <path d="m8 1.5 2 4.1 4.5.7-3.25 3.2.75 4.5L8 11.85l-4 2.15.75-4.5L1.5 6.3l4.5-.7z" />,
  play: <path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M4 3v10M12 3v10" strokeWidth="2.4" />,
  fullscreen: <path d="M6 2H2v4m8-4h4v4M2 10v4h4m4 0h4v-4" />,
  prev: <path d="M11 3L5 8l6 5M4 3v10" />,
  next: <path d="M5 3l6 5-6 5M12 3v10" />,
  mic: <path d="M8 2a2.5 2.5 0 0 1 2.5 2.5v4A2.5 2.5 0 0 1 8 11a2.5 2.5 0 0 1-2.5-2.5v-4A2.5 2.5 0 0 1 8 2zM3.5 8.5a4.5 4.5 0 0 0 9 0M8 13v2" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />,
  bell: <path d="M4 11V7a4 4 0 1 1 8 0v4l1 1.5H3zM6.5 14a1.5 1.5 0 0 0 3 0" />,
  plus: <path d="M8 3v10M3 8h10" />,
  chevron: <path d="M6 3l5 5-5 5" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  x: <path d="M3 3l10 10M13 3L3 13" />,
  pencil: <path d="M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3" />,
  refresh: <path d="M13.5 6a5.8 5.8 0 1 0 .2 3.5M13.5 2.5V6H10" />,
  undo: <path d="M4 6.5h5.5a3.25 3.25 0 0 1 0 6.5H6.5M6.5 4 4 6.5 6.5 9" />,
  note: <path d="M12.8 8v4.5H7L3.5 15v-2.5H2V3h6m4-2v6m-3-3h6" />,
  diff: <path d="M3 4h10M3 8h6M3 12h10" />,
  down: <path d="M3 6l5 5 5-5" />,
  export: <path d="M2.5 8v5.5h11V8M8 10V2M4.8 5.2 8 2l3.2 3.2" />,
  upload: <path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" />,
  link: <path d="M6.5 9.5l3-3M5 11a2.5 2.5 0 0 1 0-3.5l1.5-1.5M11 5a2.5 2.5 0 0 1 0 3.5L9.5 10" />,
  trash: <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8.5h5l.5-8.5" />,
  copy: <path d="M6 6h7v7H6zM3 10V3h7" />,
  zoom: <><circle cx="6.7" cy="6.7" r="4.6" /><path d="m10.2 10.2 3.8 3.8M4.7 6.7h4m-2-2v4" /></>,
  search: <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5L14 14" />,
  settings: <path d="M2 4h4m3 0h5M2 8h7m3 0h2M2 12h2m3 0h7M6 2.5v3M10 6.5v3M5 10.5v3" />,
  film: <><rect x="1.5" y="2.5" width="13" height="11" rx="1.7" /><path d="M4.5 3v10m7-10v10M2 6h2m-2 4h2m8-4h2m-2 4h2" /></>,
  library: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9.5" y="2" width="4.5" height="5" rx="1" /><rect x="2" y="9.5" width="5" height="4.5" rx="1" /><rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1" /></>,
  history: <path d="M2 7a6 6 0 1 1 1.5 5M2 3v4h4m2-3v4l2.5 1.5" />,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  stack: <path d="m8 2 6 3.5L8 9 2 5.5 8 2Zm-6 7 6 3.5L14 9m-12 3 6 3.5 6-3.5" />,
  audio: <path d="M2 6v4m3-7v10m3-8v6m3-10v14m3-9v4" />,
  image: <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="m3 12 4-4 2 2 2-3 3 4" /><circle cx="5.5" cy="5.5" r=".6" /></>,
  arrow: <path d="M3 8h10m-5-5 5 5-5 5" />,
  monitor: <><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" /><path d="M8 12v2m-3 0h6" /></>,
  review: <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="m5 8 2 2 4-4" /></>,
  help: <path d="M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6 6.5a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M8 12h.01" />,
  swap: <path d="M3 5.5h8l-2.5-2.5M13 10.5H5l2.5 2.5" />,
  // A frame split down the middle, its earlier half filled: the footage as it was before an edit.
  compare: <><path d="M2.75 5.25A1.75 1.75 0 0 1 4.5 3.5H8v9H4.5a1.75 1.75 0 0 1-1.75-1.75z" fill="currentColor" stroke="none" opacity=".45" /><rect x="2.75" y="3.5" width="10.5" height="9" rx="1.75" /><path d="M8 1.75v12.5" /></>,
  bolt: <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor" stroke="none" />,
  bulb: <path d="M5.6 10.4a4.2 4.2 0 1 1 4.8 0c-.4.3-.6.8-.6 1.3H6.2c0-.5-.2-1-.6-1.3zM6.6 14h2.8" />,
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {iconPaths[name]}
    </svg>
  );
}
