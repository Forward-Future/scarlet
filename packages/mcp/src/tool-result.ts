/**
 * What a tool hands back to the model: text or compact JSON, an error in words it can act on, and the line that
 * says what a result was answered without.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScarletApiError } from "@scarlet/shared";
import { OpError } from "@scarlet/timeline";

export type ToolResult = CallToolResult;

export class MediaPreparing extends Error {}

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

/** Compact JSON. A tool returns either this or a text rendering of the same data, never both. */
export function json(value: unknown): ToolResult {
  return text(JSON.stringify(value));
}

/** A result that tells the model its call failed, in these words. */
export function errorText(s: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: s }] };
}

export function errorResult(err: unknown): ToolResult {
  return errorText(describeError(err));
}

const REFUSAL_LIMIT = 8000;

/** Why a tool result saved nothing, or undefined when it did its work. Kept whole up to a generous limit. */
export function toolRefusal(result: ToolResult): { text: string; data: Record<string, unknown> } | undefined {
  const body = result.content?.flatMap(c => c.type === "text" ? [c.text] : []).join("\n") ?? "";
  if (result.isError) return { text: body.slice(0, REFUSAL_LIMIT), data: { error: true } };
  // The save's own answer is the first item. Lines added after it (what wasn't measured, what the editor kept) aren't JSON.
  const first = result.content?.find(c => c.type === "text");
  const answer = first?.type === "text" ? first.text : "";
  if (!answer.startsWith("{")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(answer); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || !(parsed as { needsRevision?: unknown }).needsRevision) return undefined;
  const { next, ...rest } = parsed as { next?: unknown };
  const detail = JSON.stringify(rest);
  return { text: typeof next === "string" ? next : "Nothing was saved.",
    data: detail.length <= REFUSAL_LIMIT ? { result: rest } : { result: `${detail.slice(0, REFUSAL_LIMIT)}…` } };
}

export function describeError(err: unknown): string {
  if (err instanceof OpError) return `Invalid op ${JSON.stringify(err.op)}: ${err.message}`;
  if (err instanceof ScarletApiError) {
    // The engine lists what failed validation. Without it the agent can only guess and resubmit.
    const issues = err.code === "validation_error" ? z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
      .safeParse(err.details) : undefined;
    const detail = issues?.success && issues.data.length ? `\n${formatIssues(issues.data)}` : "";
    return `Scarlet server error ${err.status} (${err.code}): ${err.message}${detail}`;
  }
  if (err instanceof z.ZodError) return `Validation failed:\n${formatZodError(err)}`;
  if (err instanceof Error) return `${err.name}: ${err.message}${errorCause(err)}`;
  return String(err);
}

/** Node's fetch reports every network failure as "fetch failed"; the cause says which (refused, reset, headers timeout). */
function errorCause(err: Error): string {
  const cause = err.cause;
  if (!(cause instanceof Error)) return "";
  const code = (cause as { code?: unknown }).code;
  return ` (${typeof code === "string" ? `${code}: ` : ""}${cause.message})`;
}

/**
 * A read that failed and was answered without, so the result says less and can't say why. The reason goes to stderr;
 * stdout is the protocol's. Media still being prepared is expected, and the tool that waits for it says so itself.
 */
export function unavailable(what: string, err: unknown) {
  if (err instanceof MediaPreparing) return;
  noteEvidenceMiss(what);
  console.error(`[scarlet-mcp] ${what}: ${describeError(err)}`);
}

/** Report in-band waits and missing evidence separately from the result payload. */
export const toolDiagnostics = new AsyncLocalStorage<{ misses: Set<string>; preparing: boolean }>();
export function noteEvidenceMiss(what: string) {
  toolDiagnostics.getStore()?.misses.add(what);
}
export function notePreparing() {
  const diagnostic = toolDiagnostics.getStore();
  if (diagnostic) diagnostic.preparing = true;
}

/** What each tool call answered without, keyed by what failed, so concurrent calls never see each other's. */
export const unmeasured = new AsyncLocalStorage<Map<string, string>>();
/** Notes a read the current call answered without, for the line its result ends with. */
export function noteUnmeasured(what: string, err: unknown) {
  if (!(err instanceof MediaPreparing)) unmeasured.getStore()?.set(what, describeError(err));
}
/** The plain line a result ends with when it was answered without something it measures. */
export function unmeasuredLine(missed: ReadonlyMap<string, string>): string | undefined {
  return missed.size ? `Not measured: ${[...missed].map(([what, why]) => `${what} (${why})`).join("; ")}.` : undefined;
}

export function formatZodError(err: z.ZodError): string {
  return formatIssues(err.issues);
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): string {
  return issues
    .slice(0, 20)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/**
 * Lines too many for one result, from `offset`, as many as fit `budget` characters (one at least), and the line that
 * says where the next page starts. `noun` names what a line is, as "changes".
 */
export function pageOfLines(lines: readonly string[], offset: number, budget: number, noun: string): string {
  const shown: string[] = [];
  let size = 0;
  for (const line of lines.slice(offset)) {
    if (shown.length && size + line.length + 1 > budget) break;
    shown.push(line);
    size += line.length + 1;
  }
  const end = offset + shown.length;
  const more = end < lines.length || offset > 0 ? [`Showing ${noun} ${Math.min(offset + 1, lines.length)}–${end} of ${lines.length}${end < lines.length ? `; continue with offset=${end}` : ""}.`] : [];
  return [...shown, ...more].join("\n");
}

/**
 * A value too long for one result, with each of its lists cut to the same run of items: from `offset`, as many as fit
 * `budget` characters as JSON (one at least). `listed` gives each list not shown whole by its path, as [first, end,
 * total], and `nextOffset` is where the next page starts. A list inside a list's items stays whole with its item.
 */
export function pageOfLists<T extends object>(value: T, offset: number, budget: number): T & { listed?: Record<string, [number, number, number]>; nextOffset?: number } {
  if (offset === 0 && JSON.stringify(value).length <= budget) return value;
  let longest = 0;
  const cut = (item: unknown, count: number, path: string, listed: Record<string, [number, number, number]>): unknown => {
    if (Array.isArray(item)) {
      longest = Math.max(longest, item.length);
      if (offset === 0 && item.length <= count) return item;
      const from = Math.min(offset, item.length), end = Math.min(item.length, offset + count);
      listed[path] = [from, end, item.length];
      return item.slice(from, end);
    }
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, field]) => [key, cut(field, count, path ? `${path}.${key}` : key, listed)]));
  };
  const page = (count: number) => {
    const listed: Record<string, [number, number, number]> = {};
    const items = cut(value, count, "", listed) as T;
    const more = Object.values(listed).some(([, end, total]) => end < total);
    return { ...items, ...(Object.keys(listed).length && { listed }), ...(more && { nextOffset: offset + count }) };
  };
  page(1);
  // The most items each list can give that still fit.
  let fits = 1, over = Math.max(2, longest + 1);
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (JSON.stringify(page(mid)).length <= budget) fits = mid;
    else over = mid;
  }
  return page(fits);
}

/**
 * A value whose text field `key` is too long for one result, with that text from `offset`, as much as fits `budget`
 * characters as JSON (one at least). `<key>Chars` is the text's whole length and `nextOffset` where the rest starts.
 */
export function pageOfText<T extends Record<string, unknown>>(value: T, key: string, offset: number, budget: number): T {
  const whole = value[key];
  if (typeof whole !== "string" || (offset === 0 && JSON.stringify(value).length <= budget)) return value;
  let room = Math.max(1, budget - JSON.stringify({ ...value, [key]: "" }).length - 60);
  let part = whole.slice(offset, offset + room);
  // Quotes and line breaks take two characters each in JSON.
  for (let size = JSON.stringify(part).length; size > room + 2 && part.length > 1; size = JSON.stringify(part).length) part = part.slice(0, Math.max(1, Math.floor(part.length * room / size)));
  const end = Math.min(whole.length, offset + part.length);
  return { ...value, [key]: part, [`${key}Chars`]: whole.length, ...(end < whole.length && { nextOffset: end }) };
}
