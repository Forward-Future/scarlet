import { createHash } from "node:crypto";

/** Word references depend on occurrence order, spelling and source times. */
export function wordDigest(words: ReadonlyArray<{ text: string; start: number; end: number }>) {
  return createHash("sha256").update(JSON.stringify(words.map(w => [w.text, w.start, w.end]))).digest("hex");
}
