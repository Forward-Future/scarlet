import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";
import { errorText } from "./tool-result.js";

/** The tool a harness that lists tools briefly reads a tool's whole description from. */
export const TOOL_HELP = "tool_help";
/** The tool a harness that lists tools briefly calls every tool not listed on its own through. */
export const TOOL_CALL = "tool_call";
/**
 * Claude Code's `_meta` key for a tool it sends whole from the start instead of behind tool search. A harness that lists
 * tools briefly sends the same tools whole, so "the tools nearly every request reads" is said once.
 */
export const ALWAYS_LOAD = "anthropic/alwaysLoad";

/** The most of a tool's first sentence its line in the index keeps: the listing grows by at most this per tool. */
export const INDEX_LINE_MAX = 160;

/** A tool's line in the index: its name and the first sentence of its description. */
export function indexLine(name: string, description: string): string {
  const first = /^[\s\S]*?[.!?](?=\s+[A-Z(`"“]|\s*$)/.exec(description.trim())?.[0] ?? description.trim();
  const lead = first.replace(/\s+/g, " ");
  return `${name}: ${lead.length > INDEX_LINE_MAX ? `${lead.slice(0, INDEX_LINE_MAX - 1).trimEnd()}…` : lead}`;
}

/** A tool's name as a harness may give it, without the prefix it adds for the scarlet server. */
const scarletName = (given: string) => given.trim().replace(/^(mcp__scarlet__|mcp_scarlet_|scarlet__|scarlet[._/:])/, "");

const CALL_LEAD = "Calls one of Scarlet's tools listed below by its name, with its arguments, and returns that tool's own result. " +
  `Read the tool's full description and parameters with ${TOOL_HELP} before you first call it. The tool checks its own arguments ` +
  "and says what it couldn't take. A tool listed on its own, outside this list, is called directly.";

type ListTools = (request: { method: "tools/list"; params?: unknown }, extra: unknown) => Promise<{ tools: Tool[] }>;
type CallTool = (request: { method: "tools/call"; params: { name: string; arguments?: Record<string, unknown> } }, extra: unknown) => Promise<CallToolResult>;

/** Tools one tool_help call reads in full; the rest of a longer list are named for another call. */
const HELP_AT_ONCE = 8;

/** What every tool `tool_call` reaches may do, so a harness asks about a call through it as it would about the boldest. */
function unionAnnotations(tools: readonly Tool[]): ToolAnnotations {
  const all = (hint: keyof ToolAnnotations) => tools.every(t => t.annotations?.[hint] === true);
  const any = (hint: keyof ToolAnnotations, absent: boolean) => tools.some(t => (t.annotations?.[hint] ?? absent) === true);
  // A hint left out reads as MCP's default: not read-only, destructive, not idempotent, open-world.
  return { readOnlyHint: all("readOnlyHint"), destructiveHint: any("destructiveHint", true), idempotentHint: all("idempotentHint"), openWorldHint: any("openWorldHint", true) };
}

/**
 * For a harness that keeps only so much of its tools' definitions and drops the rest without a word
 * (`AgentCapabilities.briefTools`): the tools sent whole to Claude Code from the start (`_meta[ALWAYS_LOAD]`) are listed
 * whole, and every other tool by its name and first sentence in `tool_call`'s description, which calls it by name.
 * `tool_help` gives a tool's whole description and parameters. The listing grows by one index line per tool, whatever
 * the tool's size. Called once every tool is registered.
 */
export function listToolsBriefly(server: McpServer) {
  // The SDK lists registered tools from this handler. Wrapping it keeps its conversion of each tool's input schema.
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListTools | CallTool> })._requestHandlers;
  const listed = handlers?.get("tools/list") as ListTools | undefined;
  if (!handlers || !listed || !handlers.get("tools/call")) throw new Error("Scarlet couldn't list its tools briefly: the MCP SDK no longer keeps its tools/list and tools/call handlers where Scarlet reads them.");
  let full: Promise<Tool[]> | undefined;
  const everyTool = (extra: unknown) => full ??= listed({ method: "tools/list" }, extra).then(({ tools }) => tools);
  const helpers = new Set([TOOL_HELP, TOOL_CALL]);
  const isWhole = (tool: Tool) => tool._meta?.[ALWAYS_LOAD] === true;
  const scarletTools = (tools: Tool[]) => tools.filter(t => !helpers.has(t.name));
  const unknownName = (names: string[], tools: Tool[]) => `No Scarlet tool is named ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]}. ` +
    `Its tools: ${scarletTools(tools).map(t => t.name).join(", ")}.`;

  server.registerTool(TOOL_HELP, {
    description: "A Scarlet tool's full description and parameters. Read it before you first call a tool.",
    inputSchema: { name: z.string().optional().describe("The tool's name, such as transcript_get"),
      names: z.array(z.string()).min(1).optional().describe(`Several tools' names instead, read in one call; up to ${HELP_AT_ONCE} are read, the rest listed for another call`) },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ name, names }, extra) => {
    if ((name === undefined) === (names === undefined)) return errorText("Give either name, for one tool, or names, for several.");
    const tools = await everyTool(extra);
    // Full descriptions run 3–5k characters each: a long list is read in part, with the rest named, rather than refused.
    const listed = [...new Set(names ?? [name!])];
    const later = listed.slice(HELP_AT_ONCE);
    const asked = listed.slice(0, HELP_AT_ONCE).map(given => ({ given, tool: scarletTools(tools).find(t => t.name === scarletName(given)) }));
    const unknown = asked.flatMap(a => a.tool ? [] : [a.given]);
    // An unknown name doesn't cost the model the tools it named right.
    const missing = unknown.length ? unknownName(unknown, tools) : undefined;
    const known = [...new Set(asked.flatMap(a => a.tool ? [a.tool] : []))];
    if (!known.length && !later.length) return errorText(missing!);
    const whole = known.map(tool => `${tool.name}\n\n${tool.description ?? ""}\n\nParameters (JSON schema):\n${JSON.stringify(tool.inputSchema, null, 1)}`);
    const rest = later.length ? `Not read in this call, to ask for next: ${later.join(", ")}.` : undefined;
    return { content: [{ type: "text" as const, text: [...(missing ? [missing] : []), ...whole, ...(rest ? [rest] : [])].join("\n\n---\n\n") }] };
  });

  server.registerTool(TOOL_CALL, {
    description: CALL_LEAD,
    inputSchema: { name: z.string().min(1).describe("The tool's name, such as transcript_get"),
      arguments: z.record(z.unknown()).optional().describe("The tool's arguments, as its parameters in tool_help give them") },
  }, async ({ name, arguments: args }, extra) => {
    const tools = await everyTool(extra);
    const tool = scarletTools(tools).find(t => t.name === scarletName(name));
    if (!tool) return scarletName(name) === TOOL_CALL ? errorText(`Give ${TOOL_CALL} the name of the tool to call.`) : errorText(unknownName([name], tools));
    // A question stops the run once its harness sees it asked, which it sees only of a call made directly.
    if (isWhole(tool)) return errorText(`${tool.name} is listed on its own: call it directly.`);
    // The SDK's own call, as the harness would make it: the tool's parameters check the arguments, and its result,
    // pictures and errors included, comes back as it is. Read at the call, so whatever wraps the handler sees it.
    const call = handlers.get("tools/call") as CallTool;
    return await call({ method: "tools/call", params: { name: tool.name, arguments: args ?? {} } }, extra);
  });

  handlers.set("tools/list", (async (_request: unknown, extra: unknown) => {
    const tools = await everyTool(extra);
    const whole = scarletTools(tools).filter(isWhole);
    const indexed = scarletTools(tools).filter(t => !isWhole(t));
    // A side check's few tools are all listed whole: there is nothing to call through tool_call.
    if (!indexed.length) return { tools: whole };
    const help = tools.find(t => t.name === TOOL_HELP)!, call = tools.find(t => t.name === TOOL_CALL)!;
    const index = indexed.map(t => indexLine(t.name, t.description ?? "")).join("\n");
    return { tools: [...whole, help, { ...call, description: `${CALL_LEAD}\n\nTools:\n${index}`, annotations: unionAnnotations(indexed) }] };
  }) satisfies ListTools);
}
