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
  if (!body.startsWith("{")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
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
  if (!(err instanceof MediaPreparing)) console.error(`[scarlet-mcp] ${what}: ${describeError(err)}`);
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
