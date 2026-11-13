/**
 * The numbers of what a waiting pass needs the editor for: its calls and the edits of its request that ask for a look,
 * one run of numbers ("Cut 2", "Edit 6"). A number is given the first time its call or edit is shown and is that
 * one's for as long as the pass waits. Until 2026-11-11 the numbers were worked out afresh each time, calls first and
 * then the edits in timeline order, so on a pass still at work every new call moved all the edits up one and every
 * new edit renumbered the ones after it: the list read as coming and going. Now what arrives later takes the next
 * number, wherever it is in the video, and a number whose call or edit has gone isn't given again.
 *
 * Kept per request, for the pass that waits there (`root`, the run that staged it): another pass starts from 1. Saved
 * so a reload shows the numbers the editor has seen.
 */
const PREFIX = "scarlet.need-numbers.v1";
/** `sessionOnly` marks numbers storage refused: they stand for the session, whatever storage still holds. */
interface Kept { root: string; numbers: Map<string, number>; raw: string | null; sessionOnly?: boolean }
const cache = new Map<string, Kept>();

function stored(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function read(key: string, root: string): Kept {
  const raw = stored(key);
  const known = cache.get(key);
  if (known && known.root === root && (known.raw === raw || known.sessionOnly)) return known;
  let numbers = new Map<string, number>();
  try {
    const saved = JSON.parse(raw ?? "null") as { root?: unknown; numbers?: unknown } | null;
    if (saved?.root === root && Array.isArray(saved.numbers)) {
      numbers = new Map(saved.numbers.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && Number.isInteger(e[1]) && e[1] > 0));
    }
  } catch { /* An unreadable record numbers the pass afresh. */ }
  const kept = { root, numbers, raw };
  cache.set(key, kept);
  return kept;
}

/**
 * The number of each of `keys`, which are in the order they would be numbered from nothing. One already numbered
 * keeps its number; the rest take the next ones in that order.
 */
export function needNumbers(projectId: string, threadId: string, root: string, keys: readonly string[]): ReadonlyMap<string, number> {
  const key = `${PREFIX}/${projectId}/${threadId}`;
  const kept = read(key, root);
  let next = Math.max(0, ...kept.numbers.values());
  let numbers = kept.numbers;
  for (const item of keys) {
    if (numbers.has(item)) continue;
    if (numbers === kept.numbers) numbers = new Map(numbers);
    numbers.set(item, ++next);
  }
  if (numbers !== kept.numbers) {
    const raw = JSON.stringify({ root, numbers: [...numbers] });
    try {
      localStorage.setItem(key, raw);
      cache.set(key, { root, numbers, raw });
    } catch {
      cache.set(key, { root, numbers, raw: null, sessionOnly: true });
    }
  }
  return numbers;
}
