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
export const createAudioOption = (hearing: boolean) => (description: string) =>
  (hearing ? { includeAudio: z.boolean().default(false).describe(description) } : {}) as AudioShape;

/**
 * An area of a picture as [left, top, right, bottom] in percent of it. An array of one item type, not a tuple: Codex
 * drops a tool whose schema lists an item per position, without a word, and a run then framed by hand with neither
 * timeline_framing nor media_frame in its tool list (2026-11-16).
 */
export const percentBox = z.array(z.number().min(0).max(100)).length(4);

export const editReasonInput = EditReason.optional().describe(
  "One short sentence for the card above the timeline explaining the footage cue, editorial tradeoff, or editor request that motivated this choice.",
);

export const timelineEditsInput = z.array(z.object({
  label: z.string().min(1).max(180).describe("Short editor-facing title, at most 50 characters"),
  range: z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() }).describe("Seconds in the resulting timeline. For a cut, give the point where it joins with start equal to end. For any other edit, give all the footage as it plays, from its first second to its last."),
  summary: z.string().trim().min(1).max(SUMMARY_MAX).optional().describe("A short sentence for the chat about what this edit changed, including notable side effects"),
  reason: editReasonInput.describe("Why you made this specific edit, shown on its card. Supply one for every item."),
  check: z.string().trim().min(1).max(120).optional().describe("A few words naming a doubt the editor must settle by listening or looking. Marks the edit as needing the editor until they keep it. The card plays the edit's range: for a doubt about a few seconds of a longer edit, flag those seconds with edit_flag once it is saved instead."),
  replaces: z.object({ changeId: z.string(), spot: z.number().int().nonnegative() }).optional(),
})).optional().describe("List each distinct edit this save makes and its exact playback range in the resulting timeline. A passage it leaves as it was is not an edit, even one you checked. Keep overlapping edits separate. For a revision set replaces to the original change ID and zero-based edit index, and give the full updated range and reason.");

export function makeIntentInput(hasTaskId: boolean) {
  const intent = z.enum(["requested", "suggestion", "alternative"]);
  return (hasTaskId ? intent : intent.optional()).describe(
    "Use requested only for edits the editor asked you to make. Choose suggestion for extra ideas or previews, and alternative for each option offered. Omitting intent leaves the edit in review.",
  );
}

export const WordRef = {
  mediaId: z.string().optional().describe("The mediaId shown with the word indices in timeline_transcript or transcript_get"),
  fromWord: z.number().int().nonnegative().optional().describe("Word reference: first removed word index"),
  toWord: z.number().int().nonnegative().optional().describe("Word reference: last removed word index"),
};

export const PauseRef = {
  afterWord: z.number().int().nonnegative().optional().describe("Pause reference, with mediaId: the transcript_get index of the word the pause follows. Scarlet trims the pause between it and the next word, both edges in the measured quiet."),
  leave: z.number().finite().min(0.05).max(10).optional().describe(`Seconds of pause that should still play, word to word, as the editor hears it. Required with afterWord: how long a pause plays is yours to judge, by the delivery around it and the pace the skill asks for. Optional with fromWord/toWord: the pause the join plays, which is pace's after and before together when omitted (${PAUSE_BEAT} s by default). Optional with start/end: each edge that sits in measured quiet moves within that quiet so the join plays this pause, from the sound before it to the sound after, as on a word reference; an edge on sound is placed as without it. Leave it off where the quiet beside an edge is something to watch, such as a result appearing.`),
  voiceIn: z.number().finite().min(LEAST_VOICE_IN).max(2).optional().describe(`With a word or pause reference, or start/end: seconds of quiet between the cut and the next word, as the editor hears it, which is how soon the voice comes in once the picture cuts. pace's before when omitted (${AIR_BEFORE_SPEECH} s by default), and 0 puts the cut on the word's first sound, kept whole. A voice takes about 0.04 s more to reach speaking level, so 0.03 plays as about two frames from the cut to the voice. The rest of the pause plays before the cut. Yours to judge at each cut, by the delivery, what the line begins and the pace the skill and the editor ask for.`),
};

export const paceInput = z.object({
  after: z.number().finite().min(0.01).max(2).describe("Seconds of room tone after the last kept word, as the editor hears it"),
  before: z.number().finite().min(0.01).max(2).describe("Seconds of room tone before speech resumes, as the editor hears it"),
}).optional().describe(`The room tone a join leaves either side when Scarlet places its edges in the quiet: the pause a word cut plays when it gives no leave, the quiet a leave keeps between the cut and the next word (the rest of it plays before the cut), and where an edge moved off sound settles. A pace for every join of this call, from the skill and the editor. Omitted: ${AIR_AFTER_SPEECH} s after and ${AIR_BEFORE_SPEECH} s before.`);

/** What a cut Scarlet starts after the last kept word does with a breath between that word and the quiet (`wordCutRange`). */
export const breathInput = (refs: string, found: string) => z.enum(["cut", "keep"]).optional().describe(`A breath after the last kept word, before the quiet, where Scarlet starts a cut from words (${refs}): cut (the default) starts it right after the word, so the breath goes; keep starts it after the breath, so it plays. ${found} Your skill says which.`);
export const unsureJoinsInput = z.enum(["ask", "cut"]).optional().describe("A cut you decided whose join Scarlet can't place cleanly: no measured quiet at an edge, an edge that has to move more than a few frames, both edges inside running speech, a production aside with no silence at its edges, or a restart joined where the take resumes on the word it broke off on, placed by matching the two deliveries on their sound with nothing measured to say how it plays. ask (the default) stages it for the editor with what Scarlet measured; cut applies it where Scarlet placed it and reports the evidence to you. Your skill says which.");

export const cutCoordinates = `To have Scarlet place the edges, give mediaId and the first and last removed word indices (fromWord/toWord), or mediaId and the word before a pause (afterWord, with leave: the seconds it should still play). Measured word edges leave the room tone of pace after kept speech and before it resumes, and a pause you give as leave plays before the cut but for pace's before (or the voiceIn you give). For edges you place yourself, give start/end in TIMELINE seconds. The edge check preserves that padding where those times are already quiet, unless you give leave: then an edge in quiet goes where that pause puts it.`;

export const crossfadeFrames = CrossfadeFrames.optional()
  .describe("Total audio-only overlap at the new dialogue joins, in project frames. Zero or omitted makes a straight cut.");

export const repeatedPhrase = z.string().trim().min(1);

export const resumeWith = z.string().trim().min(1).max(240).optional().describe("For a retake, quote the first consecutive words to keep immediately after the removal. Include the continuation that distinguishes this delivery.");

/**
 * A cut's row in the chat, where the editor reads what Scarlet wants them to approve. Passes wrote what they had done
 * to check it ("Reviewed the restart…", "Kept the stronger reveal") and the editor couldn't tell what the change was
 * (2026-11-20).
 */
export const cutRow = "Its row in the editor's list of edits: say plainly what the change does to the video, by the words it takes out or the words beside it (\"Cut the repeated start before ‘just explain’\", \"Cut the first ‘But first, the benchmarks’\", \"Shortened the pause after ‘okay’\"). Name the change, not your checking (\"Reviewed…\") or what stays (\"Kept…\"), and never why: the reason says why. Rows read in a list, so no two alike.";
