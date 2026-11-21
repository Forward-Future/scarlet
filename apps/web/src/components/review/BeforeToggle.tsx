import { useRef } from "react";
import { COMPARE_KEY, useComparisonShortcut } from "../../lib/hotkeys";

interface BeforeToggleProps {
  on: boolean;
  toggle(): void;
  shortcutActive: boolean;
  disabled?: boolean;
  flash?: boolean;
}

/**
 * The current comparison owns both the button and its keyboard shortcut. It is one soft pill that reads Before and
 * After, the side playing lit, with its key at the end; a press anywhere on it, or the key, switches sides.
 */
export function BeforeToggle({ on, toggle, shortcutActive, disabled, flash }: BeforeToggleProps) {
  const button = useRef<HTMLButtonElement>(null);
  useComparisonShortcut(shortcutActive && !disabled, toggle, button);

  return (
    <button
      ref={button}
      type="button"
      className={flash ? "edit-card-before is-flash" : "edit-card-before"}
      data-log-control="toggle-before"
      aria-label="Before"
      aria-pressed={on}
      aria-keyshortcuts={COMPARE_KEY}
      title={on ? `Back to After (${COMPARE_KEY})` : `Play Before (${COMPARE_KEY})`}
      disabled={disabled}
      onClick={e => {
        // Give Space back to the player after a pointer click. Inside a dialog, keep shortcuts in that dialog.
        if (e.detail && !e.currentTarget.closest("dialog[open]")) e.currentTarget.blur();
        toggle();
      }}
    >
      <span className={on ? "edit-card-side-word is-on" : "edit-card-side-word"} aria-hidden>Before</span>
      <span className={on ? "edit-card-side-word" : "edit-card-side-word is-on"} aria-hidden>After</span>
      <kbd aria-hidden>{COMPARE_KEY}</kbd>
    </button>
  );
}
