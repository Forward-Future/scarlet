import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_CALL, TOOL_HELP } from "./brief-tools.js";

/**
 * Every tool a session's model can reach, each as the model reads it whole: the tools listed, and for a harness that
 * lists tools briefly (Gemini's) each tool `tool_call` names, with its description and parameters from `tool_help`.
 */
export async function reachableTools(client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
  const call = tools.find(t => t.name === TOOL_CALL);
  if (!call) return tools;
  const names = call.description!.split("\nTools:\n")[1]!.split("\n").map(line => line.slice(0, line.indexOf(":")));
  const read: Tool[] = [];
  let pending = [...names];
  while (pending.length) {
    const batch = pending.slice(0, 8);
    const help = await client.callTool({ name: TOOL_HELP, arguments: { names: batch } }) as CallToolResult;
    const parts = (help.content[0] as { text: string }).text.split("\n\n---\n\n");
    let count = 0;
    for (const part of parts) {
      if (part.startsWith("Not read in this call, to ask for next: ")) continue;
      const [head, schema] = part.split("\n\nParameters (JSON schema):\n");
      const [name, ...description] = head!.split("\n\n");
      read.push({ name: name!, description: description.join("\n\n"), inputSchema: JSON.parse(schema!) });
      count++;
    }
    if (!count) throw new Error(`tool_help returned no tools for batch: ${batch.join(", ")}`);
    pending = pending.slice(count);
  }
  return [...tools.filter(t => t.name !== TOOL_CALL && t.name !== TOOL_HELP), ...read];
}
