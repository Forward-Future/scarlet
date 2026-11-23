import type { ReactNode } from "react";
import { blurOnPointerClick, useHotkeys } from "../../lib/hotkeys";

/**
 * The same decisions and shortcuts for every edit: Revise (R) or Later (L), and Apply (A), Keep (K), or Done (D).
 * `lead` is a pill of the card's own before them, such as a to-do's Add (A).
 */
export function ReviewActions({ lead, approve, revise, disabled, approvalDisabled, approveLabel = "Apply", approveKey = "A", reviseLabel = "Revise", reviseKey = "R" }: {
  lead?: ReactNode; approve?: () => void; revise?: () => void; disabled?: boolean; approvalDisabled?: boolean;
  approveLabel?: string; approveKey?: string; reviseLabel?: string; reviseKey?: string;
}) {
  useHotkeys(event => {
    if (disabled || event.repeat || event.shiftKey) return;
    const key = event.key.toLowerCase();
    const action = key === reviseKey.toLowerCase() ? revise : key === approveKey.toLowerCase() && !approvalDisabled ? approve : undefined;
    if (action) { event.preventDefault(); action(); }
  });
  return <div className="review-actions">
    {lead}
    {revise && <button type="button" className="btn-ghost" data-key={reviseKey} data-log-control={reviseKey === "L" ? "defer-todo" : "revise-edit"} aria-keyshortcuts={reviseKey} title={`${reviseLabel} (${reviseKey})`} disabled={disabled} onClick={e => {
      if (reviseKey !== "R") blurOnPointerClick(e);
      revise();
    }}>{reviseLabel}</button>}
    {approve && <button type="button" className="btn-primary" data-key={approveKey} data-log-control={approveKey === "K" ? "keep-edit" : approveKey === "D" ? "mark-done" : "apply-edit"} aria-keyshortcuts={approveKey} title={`${approveLabel} (${approveKey})`}
      disabled={disabled || approvalDisabled} onClick={e => {
        // The button stays for the next edit. Clicked, it lets go of the focus (WebView2 leaves it there), or Space
        // would press it again while the video is paused. Pressed by keyboard, it keeps it.
        blurOnPointerClick(e);
        approve();
      }}>{approveLabel}</button>}
  </div>;
}
