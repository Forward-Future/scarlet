import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";

/** The tool a harness that lists tools briefly reads a tool's whole description from. */
export const TOOL_HELP = "tool_help";

/** A description's first sentence, then where the rest is. */
export function briefDescription(description: string): string {
  const first = /^[\s\S]*?[.!?](?=\s+[A-Z(`"“]|\s*$)/.exec(description.trim())?.[0] ?? description.trim();
  const lead = first.length > 300 ? `${first.slice(0, 299).trimEnd()}…` : first;
  return `${lead} Before you first call it, read its full description and parameters with ${TOOL_HELP}.`;
}

/** A JSON schema without its descriptions: the shape a call takes, which a model can't call without. */
export function withoutDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDescriptions);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // A property named "description" is part of the shape; a description of a schema isn't.
    if (key === "description" && typeof value === "string") continue;
    out[key] = key === "properties" && value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([name, property]) => [name, withoutDescriptions(property)]))
      : withoutDescriptions(value);
  }
  return out;
}

type ListTools = (request: { method: "tools/list"; params?: unknown }, extra: unknown) => Promise<{ tools: Tool[] }>;

/** Most tools one tool_help call reads in full; the rest of a longer list, and any past the result's size, are named for another call. */
const HELP_AT_ONCE = 8;

/**
 * List every tool with its first sentence and the shape of its parameters, and add `tool_help`, which gives a tool's
 * whole description and parameters. Called once every tool is registered. For a harness that drops tools whose
 * definitions don't fit its budget (`AgentCapabilities.briefTools`): each tool is listed, and the model reads what a
 * tool does before it calls it.
 */
export function listToolsBriefly(server: McpServer, opts: {
  /** Characters one result may hold (`AgentCapabilities.resultChars`). */
  resultChars: number;
  /** Logs a call and its refusal, as every other tool's are. */
  report(name: string, began: number, result: CallToolResult): Promise<void>;
}) {
  // The SDK lists registered tools from this handler. Wrapping it keeps its conversion of each tool's input schema.
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListTools> })._requestHandlers;
  const listed = handlers?.get("tools/list");
  if (!handlers || !listed) throw new Error("Scarlet couldn't list its tools briefly: the MCP SDK no longer keeps its tools/list handler where Scarlet reads it.");
  let full: Promise<Tool[]> | undefined;
  const everyTool = (extra: unknown) => full ??= listed({ method: "tools/list" }, extra).then(({ tools }) => tools);

  server.registerTool(TOOL_HELP, {
    description: "A Scarlet tool's full description and parameters. Read it before you first call a tool.",
    inputSchema: { name: z.string().optional().describe("The tool's name, such as transcript_get"),
      names: z.array(z.string()).min(1).optional().describe(`Several tools' names instead, read in one call; up to ${HELP_AT_ONCE} that fit one result are read, the rest listed for another call`) },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ name, names }, extra) => {
    const began = performance.now();
    const result = await help(name, names, extra);
    await opts.report(TOOL_HELP, began, result);
    return result;
  });

  async function help(name: string | undefined, names: string[] | undefined, extra: unknown): Promise<CallToolResult> {
    const failed = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
    if ((name === undefined) === (names === undefined)) return failed("Give either name, for one tool, or names, for several.");
    const tools = await everyTool(extra);
    // Full descriptions run 3–5k characters each: a long list is read in part, with the rest named, rather than refused.
    const listed = [...new Set(names ?? [name!])];
    const later = listed.slice(HELP_AT_ONCE);
    const asked = listed.slice(0, HELP_AT_ONCE).map(given => ({ given, tool: tools.find(t => t.name !== TOOL_HELP && t.name === given.replace(/^(mcp__scarlet__|mcp_scarlet_|scarlet[._/:])/, "")) }));
    const unknown = asked.flatMap(a => a.tool ? [] : [a.given]);
    // An unknown name doesn't cost the model the tools it named right.
    const missing = unknown.length ? `No Scarlet tool is named ${unknown.length > 1 ? `${unknown.slice(0, -1).join(", ")} or ${unknown.at(-1)}` : unknown[0]}. ` +
      `Its tools: ${tools.filter(t => t.name !== TOOL_HELP).map(t => t.name).join(", ")}.` : undefined;
    const known = [...new Set(asked.flatMap(a => a.tool ? [a.tool] : []))];
    if (!known.length && !later.length) return failed(missing!);
    // As many as fit one result, the first always: past the harness's limit a result is put where the model can't read it.
    const whole: string[] = [];
    let size = missing?.length ?? 0;
    for (const tool of known) {
      const read = `${tool.name}\n\n${tool.description ?? ""}\n\nParameters (JSON schema):\n${JSON.stringify(tool.inputSchema)}`;
      if (whole.length && size + read.length > opts.resultChars) {
        later.unshift(...known.slice(whole.length).map(t => asked.find(a => a.tool === t)!.given));
        break;
      }
      whole.push(read);
      size += read.length;
    }
    const rest = later.length ? `Not read in this call, to ask for next: ${later.join(", ")}.` : undefined;
    return { content: [{ type: "text" as const, text: [...(missing ? [missing] : []), ...whole, ...(rest ? [rest] : [])].join("\n\n---\n\n") }] };
  }

  handlers.set("tools/list", async (request, extra) => {
    const tools = await everyTool(extra);
    return { tools: tools.map(tool => tool.name === TOOL_HELP ? tool : {
      ...tool,
      description: briefDescription(tool.description ?? ""),
      inputSchema: withoutDescriptions(tool.inputSchema) as Tool["inputSchema"],
    }) };
  });
}
