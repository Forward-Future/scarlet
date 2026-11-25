import type { MouseEvent, ReactNode } from "react";
import { desktop } from "../../lib/desktop";

/**
 * A web address in Scarlet's words, written out or as a Markdown link, which is how a model often writes one. A
 * Markdown link's address keeps a pair of brackets of its own, as in a Wikipedia title.
 */
const link = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|https?:\/\/[^\s<>"”’]+/g;

/** The address as it reads in a sentence: no scheme, and short enough to leave the sentence its room. */
function addressLabel(url: string) {
  const plain = url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");
  return plain.length > 44 ? `${plain.slice(0, 43)}…` : plain;
}

/** Scarlet's words cut into text and the addresses in them. Punctuation that ends the sentence isn't the address's. */
export function linkParts(text: string): Array<string | { url: string; label: string }> {
  const parts: Array<string | { url: string; label: string }> = [];
  let from = 0;
  for (const match of text.matchAll(link)) {
    let url = match[2] ?? match[0];
    let end = match.index + match[0].length;
    if (!match[2]) {
      const closed = /[.,;:!?)\]]+$/.exec(url)?.[0] ?? "";
      // A bracket that closes one inside the address is the address's own, as in a Wikipedia title.
      const kept = closed.startsWith(")") && url.slice(0, -closed.length).includes("(") ? 1 : 0;
      url = url.slice(0, url.length - closed.length + kept);
      end -= closed.length - kept;
    }
    if (match.index > from) parts.push(text.slice(from, match.index));
    parts.push({ url, label: match[1]?.trim() || addressLabel(url) });
    from = end;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** The same words with each address as its label: what a hover or a screen reader says. */
export const linkedText = (text: string) => linkParts(text).map(part => typeof part === "string" ? part : part.label).join("");

/**
 * Scarlet's words with the addresses in them as links that open in the browser. A press on one is the link's alone:
 * it doesn't fold or open the words it is in. Scarlet opens https pages only, so any other address stays as text.
 */
export function Linked({ text }: { text: string }): ReactNode {
  const parts = linkParts(text);
  if (parts.every(part => typeof part === "string")) return text;
  return parts.map((part, i) => {
    if (typeof part === "string") return part;
    // An address Scarlet doesn't open still says itself whole on hover, since its label may be cut short.
    if (!/^https:\/\//i.test(part.url)) return <span key={i} title={part.url}>{part.label}</span>;
    const open = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void desktop.openUrl(part.url).catch(() => undefined);
    };
    return <a key={i} className="said-link" href={part.url} title={part.url} onClick={open}>{part.label}</a>;
  });
}
