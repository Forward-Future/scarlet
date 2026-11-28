import type { ReactNode } from "react";
import { blurOnPointerClick, useHotkeys } from "../../lib/hotkeys";
import { inFullScreen } from "../../pages/simple/types";
import { ariaKeyShortcut, matchesBinding, shortKeyLabel, useShortcutsStore } from "../../stores/shortcuts";

/**
 * The same decisions and shortcuts for every edit: Revise (R), and Apply (A), Keep (K), or Done (D).
 * `lead` is a pill of the card's own before them, such as a to-do's Add (A).
 */
export function ReviewActions({ lead, approve, revise, disabled, approvalDisabled, approveLabel = "Apply", approveKey = "A", reviseLabel = "Revise", reviseKey = "R" }: {
  lead?: ReactNode; approve?: () => void; revise?: () => void; disabled?: boolean; approvalDisabled?: boolean;
  approveLabel?: string; approveKey?: string; reviseLabel?: string; reviseKey?: string;
}) {
  const keepBinding = useShortcutsStore(s => s.bindings.keep);
  const reviseBinding = useShortcutsStore(s => s.bindings.revise);
  const isKeep = approveLabel === "Keep" || approveLabel.startsWith("Keep ");
  const effectiveApprove = isKeep ? keepBinding : approveKey;
  const effectiveRevise = reviseLabel === "Revise" ? reviseBinding : reviseKey;
  const shownApprove = shortKeyLabel(effectiveApprove);
  const shownRevise = shortKeyLabel(effectiveRevise);
  useHotkeys(event => {
    if (disabled || event.repeat) return;
    // Full screen hides the card, so only Revise (which leaves full screen for the message box) acts there.
    const action = matchesBinding(event, effectiveRevise) ? revise
      : !approvalDisabled && matchesBinding(event, effectiveApprove) && !inFullScreen() ? approve : undefined;
    if (action) { event.preventDefault(); action(); }
  });
  return <div className="review-actions">
    {lead}
    {revise && <button type="button" className="btn-ghost" data-key={shownRevise || undefined} data-log-control="revise-edit" aria-keyshortcuts={ariaKeyShortcut(effectiveRevise)} title={shownRevise ? `${reviseLabel} (${shownRevise})` : reviseLabel} disabled={disabled} onClick={e => {
      if (reviseLabel !== "Revise") blurOnPointerClick(e);
      revise();
    }}>{reviseLabel}</button>}
    {approve && <button type="button" className="btn-primary" data-key={shownApprove || undefined} data-log-control={isKeep ? "keep-edit" : approveLabel === "Done" ? "mark-done" : "apply-edit"} aria-keyshortcuts={ariaKeyShortcut(effectiveApprove)} title={shownApprove ? `${approveLabel} (${shownApprove})` : approveLabel}
      disabled={disabled || approvalDisabled} onClick={e => {
        // The button stays for the next edit. Clicked, it lets go of the focus (WebView2 leaves it there), or Space
        // would press it again while the video is paused. Pressed by keyboard, it keeps it.
        blurOnPointerClick(e);
        approve();
      }}>{approveLabel}</button>}
  </div>;
}
