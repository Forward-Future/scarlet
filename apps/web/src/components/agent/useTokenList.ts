import { useState, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";

/** Where a `$template` or `/skill` being typed sits in the text. */
export type TypedToken = { start: number; end: number };

/**
 * The list that opens at a `$` (or `/`) as the editor types, shared by the message box and a skill's instructions:
 * where the caret is, whether the list was put away, which row is lit ("create" for the action after the rows), and
 * putting a row's name in place of what was typed.
 */
export function useTokenList(field: RefObject<HTMLTextAreaElement | null>, value: string, onChange: (value: string) => void) {
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState<number | "create">(0);

  /** Follows the caret. A move lights the first row again and brings back a list that was put away. */
  const syncCaret = (el: HTMLTextAreaElement) => {
    const next = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    if (next !== caret) { setIndex(0); setDismissed(false); setCaret(next); }
  };
  const focus = (el: HTMLTextAreaElement) => { syncCaret(el); setFocused(true); setDismissed(false); };
  const typed = (el: HTMLTextAreaElement) => { syncCaret(el); setIndex(0); setDismissed(false); };
  /** Puts the list away after its action, lighting the first row for next time. */
  const close = () => { setIndex(0); setDismissed(true); };
  /** The lit row among `count`, or `count` for the action after them. */
  const activeIndex = (count: number) => index === "create" ? count : Math.min(index, count - 1);

  /** Esc puts the list away and ↑ ↓ light a row, wrapping round through the action after the rows: true when the key was the list's. */
  const navigate = (e: KeyboardEvent, count: number) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const total = count + 1, next = (activeIndex(count) + (e.key === "ArrowDown" ? 1 : -1) + total) % total;
      setIndex(next === count ? "create" : next);
      return true;
    }
    return false;
  };

  /** Put `words` in the place of `token`, with a space after them, and the caret after that. */
  const replaceToken = (token: TypedToken | undefined, words: string) => {
    const el = field.current;
    if (!el || !token) return;
    const suffix = value.slice(token.end), prefix = value.slice(0, token.start) + words;
    const next = prefix + (suffix || words.endsWith(" ") ? "" : " ") + suffix;
    const position = words.endsWith(" ") ? prefix.length : prefix.length + 1;
    flushSync(() => onChange(next));
    el.focus();
    el.setSelectionRange(position, position);
    setCaret(position);
  };

  return { caret, focused, setFocused, dismissed, index, setIndex, syncCaret, focus, typed, close, activeIndex, navigate, replaceToken };
}
