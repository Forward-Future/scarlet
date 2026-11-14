import { useHotkeys } from "../../lib/hotkeys";
import { Icon } from "../ui/primitives";

/** The same decisions and shortcuts for every edit: Revise (R), and Apply (A) for a proposal or Keep (K) for an applied edit. */
export function ReviewActions({ approve, revise, disabled, approvalDisabled, approveLabel = "Apply", approveKey = "A", scheduled }: {
  approve?: () => void; revise: () => void; disabled?: boolean; approvalDisabled?: boolean; approveLabel?: string; approveKey?: string;
  /** Apply already happened in advance, such as when Scarlet finishes: say so in place of the button, with a way to take it back. */
  scheduled?: { label: string; cancel(): void };
}) {
  useHotkeys(event => {
    if (disabled || event.repeat || event.shiftKey) return;
    const key = event.key.toLowerCase();
    const action = key === "r" ? revise : key === approveKey.toLowerCase() && !approvalDisabled && !scheduled ? approve : undefined;
    if (action) { event.preventDefault(); action(); }
  });
  return <div className="review-actions">
    <button type="button" className="btn-ghost" data-key="R" aria-keyshortcuts="R" title="Revise (R)" disabled={disabled} onClick={revise}>Revise</button>
    {scheduled ? <button type="button" className="review-scheduled" disabled={disabled} onClick={scheduled.cancel}
      aria-label={`${scheduled.label}. Cancel`} title="Cancel">
      {/* Says what will happen; pointing at it or focusing it offers to take it back. */}
      <span className="review-scheduled-state"><Icon name="check" size={12} />{scheduled.label}</span>
      <span className="review-scheduled-cancel" aria-hidden><Icon name="x" size={12} />Cancel</span>
    </button> : approve && <button type="button" className="btn-primary" data-key={approveKey} aria-keyshortcuts={approveKey} title={`${approveLabel} (${approveKey})`}
      disabled={disabled || approvalDisabled} onClick={e => {
        // The button stays for the next edit. Clicked, it lets go of the focus (WebView2 leaves it there), or Space
        // would press it again while the video is paused. Pressed by keyboard, it keeps it.
        if (e.detail) e.currentTarget.blur();
        approve();
      }}>{approveLabel}</button>}
  </div>;
}
