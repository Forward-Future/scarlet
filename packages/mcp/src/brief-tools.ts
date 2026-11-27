import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_RESULT_CHARS } from "@scarlet/shared";
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

/** A tool's line in the index: its name and the first sentence of its description, kept within `maxLead` characters. */
export function indexLine(name: string, description: string, maxLead = INDEX_LINE_MAX): string {
  if (maxLead <= 0) return name;
  const first = /^[\s\S]*?[.!?](?=\s+[A-Z(`"“]|\s*$)/.exec(description.trim())?.[0] ?? description.trim();
  const lead = first.replace(/\s+/g, " ");
  return `${name}: ${lead.length > maxLead ? `${lead.slice(0, Math.max(1, maxLead - 1)).trimEnd()}…` : lead}`;
}

/** A tool's name as a harness may give it, without the prefix it adds for the scarlet server. */
const scarletName = (given: string) => given.trim().replace(/^(mcp__scarlet__|mcp_scarlet_|scarlet__|scarlet[._/:])/, "");

const CALL_LEAD = "Calls one of Scarlet's tools listed below by its name, with its arguments, and returns that tool's own result. " +
  `Read the tool's full description and parameters with ${TOOL_HELP} before you first call it. The tool checks its own arguments ` +
  "and says what it couldn't take. A tool listed on its own, outside this list, is called directly.";

type ListTools = (request: { method: "tools/list"; params?: unknown }, extra: unknown) => Promise<{ tools: Tool[] }>;
type CallTool = (request: { method: "tools/call"; params: { name: string; arguments?: Record<string, unknown> } }, extra: unknown) => Promise<CallToolResult>;

/** Upper bound on tools one tool_help call reads in full; the rest of a longer list are named for another call. */
const HELP_AT_ONCE = 8;
const SEPARATOR = "\n\n---\n\n";
const notReadTail = (names: readonly string[]) => `Not read in this call, to ask for next: ${names.join(", ")}.`;

type Schema = Record<string, unknown>;
/** The keywords `parameterLines` writes out; a node with any other is written as its JSON, so nothing is dropped. */
const READ_KEYWORDS = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "default", "$schema"]);
const isSchema = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
const between = (low: unknown, high: unknown, unit = "") => low !== undefined && high !== undefined
  ? (low === high ? `${low}${unit}` : `${low} to ${high}${unit}`) : low !== undefined ? `>= ${low}${unit}` : high !== undefined ? `<= ${high}${unit}` : "";

/** What a schema node takes, on one line: its type, values and limits, such as `integer, 0 to 12` or `"cut" | "keep"`. */
function typeOf(node: Schema): string {
  if (Object.keys(node).some(key => !READ_KEYWORDS.has(key))) {
    const { description: _description, ...rest } = node;
    return `JSON schema ${JSON.stringify(rest)}`;
  }
  if (Array.isArray(node.anyOf)) return node.anyOf.map(branch => isSchema(branch) ? typeOf(branch) : JSON.stringify(branch)).join(" | ");
  const parts: string[] = [];
  if (node.const !== undefined) parts.push(JSON.stringify(node.const));
  else if (Array.isArray(node.enum)) parts.push(node.enum.map(value => JSON.stringify(value)).join(" | "));
  else {
    const types = Array.isArray(node.type) ? node.type.join(" | ") : typeof node.type === "string" ? node.type : "any";
    const item = isSchema(node.items) ? typeOf(node.items) : undefined;
    if (types === "array") parts.push(item ? `array of ${item.includes(", ") ? `(${item})` : item}` : "array");
    else if (types === "object" && isSchema(node.additionalProperties) && Object.keys(node.additionalProperties).length)
      parts.push(node.properties ? `object, other fields ${typeOf(node.additionalProperties)}` : `object of ${typeOf(node.additionalProperties)}`);
    else parts.push(types);
  }
  const low = node.exclusiveMinimum !== undefined ? undefined : node.minimum, high = node.exclusiveMaximum !== undefined ? undefined : node.maximum;
  const range = [between(low, high), node.exclusiveMinimum !== undefined ? `> ${node.exclusiveMinimum}` : "", node.exclusiveMaximum !== undefined ? `< ${node.exclusiveMaximum}` : ""].filter(Boolean).join(", ");
  if (range) parts.push(range);
  const chars = node.minLength === 1 && node.maxLength === undefined ? "nonempty" : between(node.minLength, node.maxLength, " chars");
  const items = between(node.minItems, node.maxItems, " items");
  if (chars) parts.push(chars);
  if (items) parts.push(items);
  if (node.default !== undefined) parts.push(`default ${JSON.stringify(node.default)}`);
  return parts.join(", ");
}

/** The object a node's fields are listed under: itself, the items of an array of them, or each such branch of a choice. */
const fieldHolders = (node: Schema): Schema[] => isSchema(node.properties) ? [node]
  : isSchema(node.items) ? fieldHolders(node.items)
  : Array.isArray(node.anyOf) ? node.anyOf.filter(isSchema).flatMap(fieldHolders) : [];

/**
 * A tool's parameters as one line each, nested fields indented under theirs: name (`*` when required), type and limits,
 * and description. The same facts as its JSON schema, without the schema's braces, quotes and keywords on every field
 * (2.8 of dialogue_apply_cuts' 7 KB of parameters were those, 2026-11-27).
 */
export function parameterLines(schema: Schema, depth = 0): string[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  return Object.entries(isSchema(schema.properties) ? schema.properties : {}).flatMap(([field, value]) => {
    const node = isSchema(value) ? value : {};
    const describe = typeof node.description === "string" ? `: ${node.description}` : "";
    const own = `${"  ".repeat(depth)}- ${field}${required.has(field) ? "*" : ""} (${typeOf(node)})${describe}`;
    if (own.includes("(JSON schema ")) return [own];
    const holders = fieldHolders(node);
    // Two shapes to choose from are listed apart, each under its own line, so their fields aren't read as one object's.
    if (holders.length < 2) return [own, ...holders.flatMap(holder => parameterLines(holder, depth + 1))];
    return [own, ...holders.flatMap((holder, i) => [`${"  ".repeat(depth + 1)}- ${i ? "or" : "either"} (object):`, ...parameterLines(holder, depth + 2)])];
  });
}

/** A tool's whole description and parameters, as tool_help gives them. */
export function toolDoc(tool: Tool): string {
  const fields = parameterLines(tool.inputSchema as Schema);
  return `${tool.name}\n\n${tool.description ?? ""}\n\nParameters (* = required):\n${fields.length ? fields.join("\n") : "none"}`;
}

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
 * `tool_help` gives a tool's whole description and parameters, budgeted under `maxChars` (`AgentCapabilities.resultChars`)
 * so the harness keeps replies inline instead of spilling them to a file. The listing grows by one index line per tool,
 * whatever the tool's size. Called once every tool is registered.
 */
export function listToolsBriefly(server: McpServer, maxChars = DEFAULT_RESULT_CHARS, maxDescriptionChars?: number) {
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
      names: z.array(z.string()).min(1).optional().describe("Several tools' names instead, read in one call: every one that fits is read, in the order asked, and the rest are named at the end to ask for next") },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ name, names }, extra) => {
    if ((name === undefined) === (names === undefined)) return errorText("Give either name, for one tool, or names, for several.");
    const tools = await everyTool(extra);
    // A long list is read in part within maxChars (up to HELP_AT_ONCE), with the rest named, rather than refused or spilled.
    const listed = [...new Set(names ?? [name!])];
    const overflowCount = listed.slice(HELP_AT_ONCE);
    const asked = listed.slice(0, HELP_AT_ONCE).map(given => ({ given, tool: scarletTools(tools).find(t => t.name === scarletName(given)) }));
    const unknown = asked.flatMap(a => a.tool ? [] : [a.given]);
    // An unknown name doesn't cost the model the tools it named right.
    const missing = unknown.length ? unknownName(unknown, tools) : undefined;
    const known = [...new Set(asked.flatMap(a => a.tool ? [a.tool] : []))];
    if (!known.length && !overflowCount.length) return errorText(missing!);
    const whole: string[] = [];
    const deferred: string[] = [];
    // Room kept for naming every tool that may be left for later, so whatever is deferred the reply stays within maxChars.
    const tailRoom = SEPARATOR.length + notReadTail([...known.map(t => t.name), ...overflowCount]).length;
    let used = missing ? missing.length : 0;
    // Every asked tool that fits is read, in the order asked: one too long for what is left is named for the next call
    // and the ones after it are still tried, so a call fills its budget instead of stopping at the first that doesn't
    // fit (passes asked for the same names again and again, 2026-11-26). The first is read whole however long it is.
    known.forEach((tool, i) => {
      const entry = toolDoc(tool);
      const added = (used > 0 ? SEPARATOR.length : 0) + entry.length;
      const tail = deferred.length || overflowCount.length || i < known.length - 1 ? tailRoom : 0;
      if (whole.length > 0 && used + added + tail > maxChars) deferred.push(tool.name);
      else {
        whole.push(entry);
        used += added;
      }
    });
    const later = [...deferred, ...overflowCount];
    const rest = later.length ? notReadTail(later) : undefined;
    return { content: [{ type: "text" as const, text: [...(missing ? [missing] : []), ...whole, ...(rest ? [rest] : [])].join(SEPARATOR) }] };
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
    const head = `${CALL_LEAD}\n\nTools:\n`;
    const formatIndex = (lead: number) => indexed.map(t => indexLine(t.name, t.description ?? "", lead)).join("\n");
    let index = formatIndex(INDEX_LINE_MAX);
    if (maxDescriptionChars && head.length + index.length > maxDescriptionChars) {
      // Fit every tool into the harness's description ceiling so none at the end of the list are cut off unseen.
      const namesCost = indexed.reduce((sum, t) => sum + t.name.length + 3, 0);
      let lead = Math.min(INDEX_LINE_MAX, Math.max(0, Math.floor((maxDescriptionChars - head.length - namesCost) / indexed.length)));
      index = formatIndex(lead);
      while (lead > 0 && head.length + index.length > maxDescriptionChars) {
        lead = Math.max(0, lead - 4);
        index = formatIndex(lead);
      }
    }
    return { tools: [...whole, help, { ...call, description: `${head}${index}`, annotations: unionAnnotations(indexed) }] };
  }) satisfies ListTools);
}
