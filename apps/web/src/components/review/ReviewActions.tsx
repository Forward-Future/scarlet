import { useEffect, useRef } from "react";
import { blurOnPointerClick, ignorePageShortcut } from "../../lib/hotkeys";
import { usePictureMarksStore } from "../../stores/pictureMarks";

/** The same decisions and shortcuts for every edit: Revise (R) or Later (L), and Apply (A), Keep (K), or Done (D). */
export function ReviewActions({ approve, revise, disabled, approvalDisabled, approveLabel = "Apply", approveKey = "A", reviseLabel = "Revise", reviseKey = "R" }: {
  approve?: () => void; revise?: () => void; disabled?: boolean; approvalDisabled?: boolean;
  approveLabel?: string; approveKey?: string; reviseLabel?: string; reviseKey?: string;
}) {
  const decide = useRef<(event: KeyboardEvent) => void>(undefined);
  decide.current = event => {
    const key = event.key.toLowerCase();
    // While the picture is being marked, D is Draw.
    if (disabled || event.repeat || event.shiftKey || (key === "d" && usePictureMarksStore.getState().marking)) return;
    const action = key === reviseKey.toLowerCase() ? revise : key === approveKey.toLowerCase() && !approvalDisabled ? approve : undefined;
    if (action) { event.preventDefault(); action(); }
  };
  // The card's keys come before the page's, as its ↑ ↓ and Esc do: the player's L changes the speed, and would take
  // Later's L.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (!ignorePageShortcut(event)) decide.current?.(event); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return <div className="review-actions">
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
