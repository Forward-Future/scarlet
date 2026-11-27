import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_CALL, TOOL_HELP } from "./brief-tools.js";

const NOT_READ = "Not read in this call, to ask for next: ";
const PARAMETERS = "\n\nParameters (* = required):\n";

type Node = { type?: string; properties?: Record<string, Node>; required?: string[] };

/** A field line `- name* (type): description`, its type read to its closing bracket, since a type may hold brackets. */
function fieldLine(line: string): { depth: number; name: string; required: boolean; type: string } | undefined {
  const head = /^(\s*)- (\S+?)(\*?) \(/.exec(line);
  if (!head) return undefined;
  let depth = 1, i = head[0].length;
  for (; i < line.length && depth; i++) depth += line[i] === "(" ? 1 : line[i] === ")" ? -1 : 0;
  return { depth: head[1]!.length / 2, name: head[2]!, required: head[3] === "*", type: line.slice(head[0].length, i - 1) };
}

/**
 * The parameters tool_help lists, back as a schema's fields: each field's `type` is the type as written (`integer, 0 to
 * 12`), and nested fields sit under theirs. A field written as `any` or as raw JSON schema has no type.
 */
export function parametersSchema(lines: string): Node {
  const root: Node = { type: "object", properties: {} };
  const stack: Node[] = [root];
  for (const line of lines.split("\n")) {
    const field = fieldLine(line);
    if (!field) continue;
    // `- either (object):` and `- or (object):` head a shape to choose from; their fields belong to the field above.
    const parent = stack[Math.min(field.depth, stack.length - 1)]!;
    if ((field.name === "either" || field.name === "or") && field.type === "object") {
      stack[field.depth + 1] = parent;
      continue;
    }
    const node: Node = /^(any|JSON schema)\b/.test(field.type) ? {} : { type: field.type };
    (parent.properties ??= {})[field.name] = node;
    if (field.required) (parent.required ??= []).push(field.name);
    stack[field.depth + 1] = node;
    stack.length = field.depth + 2;
  }
  return root;
}

/** Every tool tool_help gives a brief harness's model, as it reads them: name, description and parameter lines. */
export async function reachableDocs(client: Client, names: readonly string[]): Promise<Array<{ name: string; description: string; parameters: string }>> {
  const read: Array<{ name: string; description: string; parameters: string }> = [];
  let pending = [...names];
  while (pending.length) {
    const batch = pending.slice(0, 8);
    const help = await client.callTool({ name: TOOL_HELP, arguments: { names: batch } }) as CallToolResult;
    const parts = (help.content[0] as { text: string }).text.split("\n\n---\n\n");
    let later: string[] = [];
    for (const part of parts) {
      if (part.startsWith(NOT_READ)) {
        later = part.slice(NOT_READ.length, -1).split(", ");
        continue;
      }
      const [head, parameters] = part.split(PARAMETERS);
      const [name, ...description] = head!.split("\n\n");
      read.push({ name: name!, description: description.join("\n\n"), parameters: parameters ?? "" });
    }
    if (later.length === batch.length) throw new Error(`tool_help returned no tools for batch: ${batch.join(", ")}`);
    pending = [...later, ...pending.slice(8)];
  }
  return read;
}

/**
 * Every tool a session's model can reach, each as the model reads it whole: the tools listed, and for a harness that
 * lists tools briefly (Gemini's) each tool `tool_call` names, with its description and parameters from `tool_help`.
 */
export async function reachableTools(client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
  const call = tools.find(t => t.name === TOOL_CALL);
  if (!call) return tools;
  const names = call.description!.split("\nTools:\n")[1]!.split("\n").map(line => line.slice(0, line.indexOf(":")));
  const read = (await reachableDocs(client, names)).map(doc => ({ name: doc.name, description: doc.description,
    inputSchema: parametersSchema(doc.parameters) as Tool["inputSchema"] }));
  return [...tools.filter(t => t.name !== TOOL_CALL && t.name !== TOOL_HELP), ...read];
}
