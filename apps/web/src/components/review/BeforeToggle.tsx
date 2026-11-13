import { useRef } from "react";
import { COMPARE_KEY, useComparisonShortcut } from "../../lib/hotkeys";
import { Icon } from "../ui/primitives";

interface BeforeToggleProps {
  on: boolean;
  toggle(): void;
  shortcutActive: boolean;
  disabled?: boolean;
  flash?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
}

/** The current comparison owns both the button and its keyboard shortcut. */
export function BeforeToggle({ on, toggle, shortcutActive, disabled, flash, busy, autoFocus }: BeforeToggleProps) {
  const button = useRef<HTMLButtonElement>(null);
  useComparisonShortcut(shortcutActive && !disabled, toggle, button);

  return (
    <button
      ref={button}
      type="button"
      className={flash ? "edit-card-icon edit-card-before is-flash" : "edit-card-icon edit-card-before"}
      aria-label="Before"
      aria-pressed={on}
      aria-keyshortcuts={COMPARE_KEY}
      aria-busy={busy}
      title={on ? `Back to After (${COMPARE_KEY})` : `Play Before (${COMPARE_KEY})`}
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={e => {
        // Give Space back to the player after a pointer click. Inside a dialog, keep shortcuts in that dialog.
        if (e.detail && !e.currentTarget.closest("dialog[open]")) e.currentTarget.blur();
        toggle();
      }}
    >
      <Icon name="compare" size={15} />
    </button>
  );
}
