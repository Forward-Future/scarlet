import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { CrossfadeFrames } from "@scarlet/shared";
import { EditReason, SUMMARY_MAX } from "@scarlet/timeline";
import { AIR_AFTER_SPEECH, AIR_BEFORE_SPEECH, LEAST_VOICE_IN, PAUSE_BEAT } from "./dialogue-join.js";
import type { ToolResult } from "./tool-result.js";

/**
 * A copy of a schema that shares no part with any other. The SDK lists a tool's parameters through zod-to-json-schema,
 * which writes a schema it meets a second time in one tool as a `$ref` to the first: a node with no type or description
 * of its own, which a harness may show the model untyped. Eighteen parameters of seven tools read that way, the word
 * references in dialogue_check_join's `cuts` and timelineEdits' reason among them (2026-11-20).
 */
function unshared<T extends z.ZodTypeAny>(schema: T): T {
  const copy = (value: unknown): unknown => value instanceof z.ZodType ? unshared(value)
    : Array.isArray(value) ? value.map(copy)
    : value instanceof Map ? new Map([...value].map(([key, item]) => [key, copy(item)]))
    : value;
  const def = Object.fromEntries(Object.entries(schema._def as Record<string, unknown>).map(([key, value]) => {
    // An object schema keeps its fields behind a function.
    if (key !== "shape" || typeof value !== "function") return [key, copy(value)];
    const fields = unsharedShape((value as () => z.ZodRawShape)());
    return [key, () => fields];
  }));
  return new (schema.constructor as new (def: unknown) => T)(def);
}

export function unsharedShape<Shape extends z.ZodRawShape>(shape: Shape): Shape {
  return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, unshared(value)])) as Shape;
}

/**
 * The same fields without their descriptions, for a list whose items are given as the tool's own fields are: the model
 * reads each field's description once. dialogue_check_join's `cuts` repeated its word and pause references' 1.6 KB
 * of descriptions (2026-11-27).
 */
export function undescribed<Shape extends z.ZodRawShape>(shape: Shape): Shape {
  return Object.fromEntries(Object.entries(shape).map(([key, value]) =>
    [key, new (value.constructor as new (def: unknown) => z.ZodTypeAny)({ ...value._def, description: undefined })])) as Shape;
}

type CallTool = (request: { method: "tools/call"; params: { name: string; arguments?: unknown } }, extra: unknown) => Promise<ToolResult>;

/**
 * The SDK checks a call's arguments against its tool's parameters before the tool runs, and answers one that doesn't
 * fit itself: such a call never reaches the tool, so nothing logged it or put its refusal in the task's history. Each
 * call that comes back an error goes to `failed`, which says whether its arguments were what was refused.
 */
export function watchRefusedArguments(server: McpServer, failed: (name: string, args: unknown, began: number, result: ToolResult) => Promise<void>) {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, CallTool> })._requestHandlers;
  const called = handlers?.get("tools/call");
  // Missing the record of refused arguments is no reason to stop a run from editing: it says so and the tools work on.
  if (!handlers || !called) {
    console.error("[scarlet-mcp] calls refused for their arguments go unrecorded: the MCP SDK no longer keeps its tools/call handler where Scarlet reads it.");
    return;
  }
  handlers.set("tools/call", async (request, extra) => {
    const began = performance.now();
    const result = await called(request, extra);
    if (result.isError) await failed(request.params.name, request.params.arguments, began, result);
    return result;
  });
}

/** The includeAudio flag exists only for a model that can hear; the type always carries it so handlers stay simple. */
export type AudioShape = { includeAudio: z.ZodDefault<z.ZodBoolean> };
export const createAudioOption = (hearing: boolean, defaultValue = false) => (description: string) =>
  (hearing ? { includeAudio: z.boolean().default(defaultValue).describe(description) } : {}) as AudioShape;

/**
 * An area of a picture as [left, top, right, bottom] in percent of it. An array of one item type, not a tuple: Codex
 * drops a tool whose schema lists an item per position, without a word, and a run then framed by hand with neither
 * timeline_framing nor media_frame in its tool list (2026-11-16).
 */
export const percentBox = z.array(z.number().min(0).max(100)).length(4);

export const editReasonInput = EditReason.optional().describe(
  "One short, simple sentence for the card above the timeline saying why you made this choice, in plain everyday words (no timestamps, durations, arrows, or production jargon).",
);

export const timelineEditsInput = z.array(z.object({
  label: z.string().min(1).max(180).describe("Short, plain editor-facing title, at most 50 characters"),
  range: z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() }).describe("Seconds in the resulting timeline. For a cut, give the point where it joins with start equal to end. For any other edit, give all the footage as it plays, from its first second to its last."),
  summary: z.string().trim().min(1).max(SUMMARY_MAX).optional().describe("A short sentence for the chat about what this edit changed, including notable side effects"),
  reason: editReasonInput.describe("One short, simple sentence for the card saying why you made this edit, in plain everyday words. Supply one for every item; for a To do marker, keep it brief and don't repeat the marker's text."),
  check: z.string().trim().min(1).max(120).optional().describe("A few words naming a doubt the editor must settle by listening or looking, which holds the edit for them until they keep it. The card plays the whole range: for a few seconds of a longer edit, flag those with edit_flag once saved instead."),
  replaces: z.object({ changeId: z.string(), spot: z.number().int().nonnegative() }).optional(),
})).optional().describe("Each edit this save makes, with its own specific title and exact range in the resulting timeline: never one range spanning separate edits across untouched footage (only edits acting on the same time range share one), and overlapping edits stay separate. A passage left as it was is not an edit, even one you checked. For a revision, set replaces to the original change id and zero-based edit index, with the full updated range and reason.");

export function makeIntentInput(hasTaskId: boolean) {
  const intent = z.enum(["requested", "suggestion", "alternative"]);
  return (hasTaskId ? intent : intent.optional()).describe(
    "requested only for edits the editor asked you to make; suggestion for extra ideas or previews; alternative for each option offered. Omitted, the edit waits in review.",
  );
}

export const WordRef = {
  mediaId: z.string().optional().describe("The recording the word indices are from"),
  fromWord: z.number().int().nonnegative().optional().describe("Word reference: first removed word index"),
  toWord: z.number().int().nonnegative().optional().describe("Word reference: last removed word index"),
};

export const PauseRef = {
  afterWord: z.number().int().nonnegative().optional().describe("Pause reference, with mediaId: the index of the word the pause follows. Scarlet trims the pause to the next word within the measured quiet."),
  leave: z.number().finite().min(0.05).max(10).optional().describe(`Seconds of pause the join plays, word to word; yours to judge by the delivery and the skill's pace. Required with afterWord. With fromWord/toWord, omitted: pace's after and before (${PAUSE_BEAT} s by default). With start/end: an edge in measured quiet moves within it to play this pause; one on sound stays. Leave it off where the quiet beside an edge matters, such as a result appearing.`),
  voiceIn: z.number().finite().min(LEAST_VOICE_IN).max(2).optional().describe(`Seconds of quiet from the cut to the next word (with a word or pause reference, or start/end); the rest of the pause plays before the cut. pace's before when omitted (${AIR_BEFORE_SPEECH} s by default); 0 cuts on the word's first sound. A voice takes about 0.04 s more to reach speaking level, so 0.03 plays as about two frames. Yours to judge at each cut.`),
};

export const paceInput = z.object({
  after: z.number().finite().min(0.01).max(2).describe("Seconds of room tone after the last kept word"),
  before: z.number().finite().min(0.01).max(2).describe("Seconds of room tone before speech resumes"),
}).optional().describe(`Room tone either side of each join of this call whose edges Scarlet places in the quiet, and where an edge moved off sound settles; from the skill and the editor. Omitted: ${AIR_AFTER_SPEECH} s after and ${AIR_BEFORE_SPEECH} s before.`);

/** What a cut Scarlet starts after the last kept word does with a breath between that word and the quiet (`wordCutRange`). */
export const breathInput = (refs: string, found: string) => z.enum(["cut", "keep"]).optional().describe(`A breath after the last kept word, before the quiet, on a cut placed from words (${refs}): cut (the default) takes it out; keep plays it. ${found} Your skill says which.`);
export const unsureJoinsInput = z.enum(["ask", "cut"]).optional().describe("A cut whose join Scarlet can't place cleanly (no quiet at an edge, an edge moving more than a few frames, both edges in running speech, a production aside with no silence at its edges, a restart resuming on the word it broke off on): ask (the default) stages it for the editor with what Scarlet measured; cut applies it as placed and reports the evidence. Your skill says which.");

export const cutCoordinates = `Give edges as word indices with mediaId (fromWord/toWord, the first and last removed words; or afterWord, the word before a pause, with leave), and Scarlet places them in the measured quiet with pace's room tone either side. Or give start/end in TIMELINE seconds: an edge already in quiet keeps that padding.`;

export const crossfadeFrames = CrossfadeFrames.optional()
  .describe("Total audio-only overlap at the new dialogue joins, in project frames; 0 or omitted cuts straight.");

export const repeatedPhrase = z.string().trim().min(1);

export const resumeWith = z.string().trim().min(1).max(240).optional().describe("For a retake: quote the first words kept right after the removal, enough to tell this delivery apart. When the scan reads other words there, the result says which.");

/**
 * A cut's row in the chat, where the editor reads what Scarlet wants them to approve. Passes wrote what they had done
 * to check it ("Reviewed the restart…", "Kept the stronger reveal") and the editor couldn't tell what the change was
 * (2026-11-20).
 */
export const cutRow = "Its row in the editor's list of edits: what the change does to the video, by the words it takes out or beside it (\"Shortened the pause after ‘okay’\"). Name the change, not your checking (\"Reviewed…\"), what stays (\"Kept…\") or why (the reason says why). No two rows alike.";
