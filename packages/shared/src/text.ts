/**
 * Text cut for display or a prompt without breaking a character in two. JavaScript strings count UTF-16 units, so a
 * plain `slice` can keep half of an emoji (👍, 🎬) or any other character outside the basic plane, and a lone half is
 * no character: it shows as a box, and the desktop host's JSON reader refuses the whole message that carries it.
 */

/** The first `max` units of `text`, one fewer when the cut would split a character in two. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** `text` with any lone half of a character replaced by U+FFFD, so every reader takes it. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}
