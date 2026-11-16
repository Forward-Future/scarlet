/** A run of text that stayed, was added or was taken out. */
export interface DiffPiece { kind: "same" | "add" | "del"; text: string }
/** One line of the later text, with what changed in it. A line the later text dropped is all `del`. */
export interface DiffLine { changed: boolean; pieces: DiffPiece[] }

type Op = { kind: "same" | "add" | "del"; a: string[]; b: string[] };

/** The longest common run of two lists, as ops in order: what stayed, what was taken out, what was added. */
function ops(a: string[], b: string[]): Op[] {
  // Trim what both share at either end, so a long text with one change costs little.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const n = midA.length, m = midB.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: Op[] = [];
  const push = (kind: Op["kind"], x?: string, y?: string) => {
    const last = out.at(-1);
    const op = last?.kind === kind ? last : (out.push({ kind, a: [], b: [] }), out.at(-1)!);
    if (x !== undefined) op.a.push(x);
    if (y !== undefined) op.b.push(y);
  };
  if (start) out.push({ kind: "same", a: a.slice(0, start), b: b.slice(0, start) });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) push("same", midA[i++], midB[j++]);
    // What was taken out comes before what took its place.
    else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) push("del", midA[i++]);
    else push("add", undefined, midB[j++]);
  }
  for (let k = endA, l = endB; k < a.length; k++, l++) push("same", a[k], b[l]);
  return out;
}

const words = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
const sentences = (s: string) => s.match(/[^.!?]+[.!?]*\s*|[.!?]+\s*/g) ?? [];

/** How alike two runs of words are, from 0 to 1. */
function likeness(a: string, b: string) {
  const x = a.split(/\s+/).filter(Boolean), y = b.split(/\s+/).filter(Boolean);
  if (!x.length || !y.length) return 0;
  const same = ops(x, y).filter(op => op.kind === "same").reduce((n, op) => n + op.a.length, 0);
  return (2 * same) / (x.length + y.length);
}

/**
 * A changed paragraph, read as a reader would: a sentence barely touched shows the words that changed, and one
 * rewritten shows whole, taken out and then as it reads now.
 */
function paragraphPieces(a: string, b: string): DiffPiece[] {
  const pieces: DiffPiece[] = [];
  const put = (kind: DiffPiece["kind"], text: string) => {
    if (!text) return;
    const last = pieces.at(-1);
    if (last?.kind === kind) last.text += text;
    else pieces.push({ kind, text });
  };
  for (const op of ops(sentences(a), sentences(b))) {
    const was = op.a.join(""), now = op.b.join("");
    if (op.kind === "same") put("same", now);
    else if (op.kind === "del" || op.kind === "add") put(op.kind, op.kind === "del" ? was : now);
  }
  // Pair a sentence taken out with the one added in its place, when they are near enough to show by word.
  const merged: DiffPiece[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k]!, next = pieces[k + 1];
    if (piece.kind === "del" && next?.kind === "add" && likeness(piece.text, next.text) > 0.75) {
      for (const op of ops(words(piece.text), words(next.text))) {
        if (op.kind === "same") merged.push({ kind: "same", text: op.b.join("") });
        else merged.push({ kind: op.kind, text: (op.kind === "del" ? op.a : op.b).join("") });
      }
      k++;
    } else merged.push(piece);
  }
  return merged;
}

/** The later text line by line, with what changed since the earlier one marked in it. */
export function diffLines(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  const all = ops(before.split("\n"), after.split("\n"));
  for (let k = 0; k < all.length; k++) {
    const op = all[k]!;
    if (op.kind === "same") {
      for (const line of op.b) lines.push({ changed: false, pieces: [{ kind: "same", text: line }] });
      continue;
    }
    // Paragraphs taken out right before others were added are read, in order, as those paragraphs changed.
    const gone = op.kind === "del" ? op.a : [];
    const next = all[k + 1];
    const added = op.kind === "add" ? op.b : next?.kind === "add" ? (k++, next.b) : [];
    for (let i = 0; i < Math.max(gone.length, added.length); i++) {
      const was = gone[i], now = added[i];
      if (was !== undefined && now !== undefined && likeness(was, now) > 0.3) {
        lines.push({ changed: true, pieces: paragraphPieces(was, now) });
        continue;
      }
      if (was?.trim()) lines.push({ changed: true, pieces: [{ kind: "del", text: was }] });
      if (now !== undefined) lines.push({ changed: true, pieces: [{ kind: "add", text: now }] });
    }
  }
  return lines;
}
