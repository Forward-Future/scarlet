import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ScarletClient, Task, type AgentId } from "@scarlet/shared";
import { INDEX_LINE_MAX, indexLine, parameterLines, toolDoc } from "./brief-tools.js";
import { ALWAYS_LOADED_TOOLS, createScarletMcpServer } from "./server.js";

/** A run of a request of `kind` (an edit has every editing tool), with `more` tools registered before it connects. */
async function connect(agent: AgentId, { kind = "edit", more }: { kind?: string; more?: (server: McpServer) => void } = {}) {
  const task = Task.parse({ id: "tsk_1", state: "running", projectId: "prj_test", kind, agent, instruction: "/first-cut-dialogue",
    context: {}, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
  const server = createScarletMcpServer(new ScarletClient({ baseUrl: "http://127.0.0.1:9", token: "tok" }), {
    projectId: "prj_test", agent, taskId: task.id, task, author: { type: "agent", id: agent, name: agent } });
  more?.(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

async function listed(agent: AgentId, options?: Parameters<typeof connect>[1]) {
  const client = await connect(agent, options);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

const size = (tools: Tool[]) => JSON.stringify(tools).length;
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/** Tools a test calls through tool_call: one that says something, one that shows a picture, one that fails. */
function fakeTools(server: McpServer) {
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("fake_text", { description: "Says what it was given. More.", inputSchema: { word: z.string(), times: z.number().int().min(1).default(1) }, annotations: read },
    async ({ word, times }) => ({ content: [{ type: "text" as const, text: Array(times).fill(word).join(" ") }] }));
  server.registerTool("fake_picture", { description: "Shows a picture.", inputSchema: {}, annotations: read },
    async () => ({ content: [{ type: "text" as const, text: "A frame:" }, { type: "image" as const, data: PIXEL, mimeType: "image/png" }] }));
  server.registerTool("fake_refusal", { description: "Refuses.", inputSchema: {}, annotations: read },
    async () => ({ content: [{ type: "text" as const, text: "Nothing to cut there." }], isError: true }));
}

describe("brief tools", () => {
  it("lists Gemini the tools nearly every request reads whole, and every other tool on one line of tool_call", async () => {
    const [brief, full] = await Promise.all([listed("gemini"), listed("claude")]);
    const whole = full.filter(t => ALWAYS_LOADED_TOOLS.has(t.name));
    expect(whole.map(t => t.name).sort()).toEqual([...ALWAYS_LOADED_TOOLS].sort());
    // The same tools, defined once: what Claude Code gets whole from the start, Gemini gets whole too.
    expect(brief.slice(0, -2)).toEqual(whole);
    expect(brief.slice(-2).map(t => t.name)).toEqual(["tool_help", "tool_call"]);
    const call = brief.at(-1)!;
    const index = call.description!.split("\nTools:\n")[1]!.split("\n");
    // Gemini hears a passage Scarlet writes to its folder, so it has source_audio where Claude Code, which can't hear, hasn't.
    expect(index.filter(line => !line.startsWith("source_audio:"))).toEqual(full.filter(t => !ALWAYS_LOADED_TOOLS.has(t.name)).map(t => indexLine(t.name, t.description!)));
    expect(index.some(line => line.startsWith("source_audio: Listen to up to 20 seconds"))).toBe(true);
    for (const line of index) expect(line.length).toBeLessThanOrEqual(line.indexOf(":") + 2 + INDEX_LINE_MAX);
    expect(call.inputSchema.required).toEqual(["name"]);
    // A call through it may save an edit or open a web page, so the harness treats it as the boldest tool it reaches.
    expect(call.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    // agy dropped the largest of Scarlet's tools past about 60 KB of definitions (2026-11-19). 54 KB listed each tool
    // by its first sentence and parameters; one line each stays well under 15 KB.
    expect(size(brief)).toBeLessThan(15_000);
  });

  it("grows the listing by one index line per tool, however large the tool", async () => {
    const huge = (server: McpServer, count: number) => {
      for (let i = 0; i < count; i++) {
        const shape = Object.fromEntries(Array.from({ length: 40 }, (_, p) => [`parameter_${p}`, z.string().optional().describe("A parameter. ".repeat(40))]));
        server.registerTool(`extra_tool_${i}`, { description: `Does extra thing ${i} ${"in great detail, ".repeat(30)}and more. ${"More. ".repeat(800)}`, inputSchema: shape }, async () => ({ content: [] }));
      }
    };
    const base = size(await listed("gemini"));
    const many = await listed("gemini", { more: server => huge(server, 150) });
    const added = many.at(-1)!.description!.split("\n").filter(line => line.startsWith("extra_tool_"));
    expect(added).toHaveLength(150);
    // Each tool costs its line and nothing more, whatever its description and parameters (here 7 KB and 40 of them)…
    expect(size(many) - base).toBeLessThanOrEqual(added.reduce((sum, line) => sum + line.length + 2, 0));
    for (const line of added) expect(line.length).toBeLessThanOrEqual("extra_tool_149: ".length + INDEX_LINE_MAX);
    // …so three times Scarlet's tools still fit in agy's 60 KB with room to spare.
    expect(size(many)).toBeLessThan(45_000);
  });

  it("calls any tool through tool_call as directly, its pictures and errors included", async () => {
    const gemini = await connect("gemini", { more: fakeTools });
    try {
      const direct = (name: string, args: object = {}) => gemini.callTool({ name, arguments: args }) as Promise<CallToolResult>;
      const through = (name: string, args?: object) => direct("tool_call", { name, ...(args && { arguments: args }) });
      expect(await through("fake_text", { word: "hello", times: 2 })).toEqual(await direct("fake_text", { word: "hello", times: 2 }));
      expect(textOf(await through("mcp_scarlet_fake_text", { word: "hi" }))).toBe("hi");
      expect(textOf(await through("scarlet.fake_text", { word: "hi" }))).toBe("hi");
      const picture = await through("fake_picture");
      expect(picture).toEqual(await direct("fake_picture"));
      expect(picture.content[1]).toEqual({ type: "image", data: PIXEL, mimeType: "image/png" });
      const refused = await through("fake_refusal");
      expect(refused).toEqual({ content: [{ type: "text", text: "Nothing to cut there." }], isError: true });
      // The tool's own parameters check the arguments, and say what they couldn't take.
      const wrong = await through("fake_text", { word: 3 });
      expect(wrong).toEqual(await direct("fake_text", { word: 3 }));
      expect(wrong.isError).toBe(true);
      expect(textOf(wrong)).toBe("MCP error -32602: Input validation error: Invalid arguments for tool fake_text: Expected string, received number at word");
      // A Scarlet tool's: its schema's error, or its own words for what it needs.
      const real = await through("transcript_get", { mediaId: 5 });
      expect(real).toEqual(await direct("transcript_get", { mediaId: 5 }));
      expect(textOf(real)).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool transcript_get: Expected string, received number at mediaId/);
      expect(await through("transcript_get", {})).toEqual({ content: [{ type: "text", text: "Error: Give mediaId, or mediaIds to read the same range on several recordings." }], isError: true });
      const unknown = await through("timeline_delete", {});
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toMatch(/^No Scarlet tool is named timeline_delete\. Its tools: project_get, .*timeline_propose.*fake_text/);
      expect(textOf(unknown)).not.toMatch(/tool_help|tool_call/);
      // A tool listed on its own is called directly: a question stops the run only once its harness sees it asked.
      const question = await through("task_question", { text: "Which take?" });
      expect(question).toEqual({ content: [{ type: "text", text: "task_question is listed on its own: call it directly." }], isError: true });
      expect((await through("tool_call", { name: "fake_text" })).isError).toBe(true);
      expect((await direct("tool_call", {})).isError).toBe(true);
    } finally {
      await gemini.close();
    }
  });

  it("gives tool_help a tool whole, several in one call, and names any it doesn't know without failing the rest", async () => {
    const [gemini, full] = await Promise.all([connect("gemini"), listed("claude")]);
    try {
      const help = async (args: object) => await gemini.callTool({ name: "tool_help", arguments: args }) as CallToolResult;
      const whole = full.find(t => t.name === "dialogue_apply_cuts")!;
      const cuts = textOf(await help({ name: "mcp_scarlet_dialogue_apply_cuts" }));
      expect(cuts).toBe(toolDoc(whole));
      expect(cuts.startsWith(`dialogue_apply_cuts\n\n${whole.description}\n\nParameters (* = required):\n- version* (string)\n`)).toBe(true);
      expect(cuts).toContain("\n- cuts* (array of object)\n  - mediaId (string): ");
      expect(cuts).toContain("\n  - kind* (\"pause\" | \"filler\" | \"retake\" | \"coaching\")\n");
      // agy spills a result over its budget to a file and shows its head and tail: the model then read the whole doc
      // again with read_file, in every Gemini pass (2026-11-26). It now fits Gemini's resultChars (9,000) on its own.
      expect(Buffer.byteLength(cuts)).toBeLessThan(9_000);
      const at = textOf(await help({ name: "timeline_at" })), diff = textOf(await help({ name: "mcp_scarlet_timeline_diff" }));
      const unknown = await help({ name: "timeline_delete" });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toMatch(/^No Scarlet tool is named timeline_delete\. Its tools: .*timeline_propose/);
      expect(textOf(await help({ names: ["timeline_at"] }))).toBe(at);
      const some = await help({ names: ["timeline_at", "timeline_delete", "scarlet.timeline_diff", "timeline_at"] });
      expect(some.isError).toBeFalsy();
      expect(textOf(some)).toBe([textOf(unknown), at, diff].join("\n\n---\n\n"));
      const none = await help({ names: ["timeline_delete", "clip_move"] });
      expect(none.isError).toBe(true);
      expect(textOf(none)).toMatch(/^No Scarlet tool is named timeline_delete or clip_move\. Its tools: .*timeline_propose/);
      // A long list stays under Gemini's resultChars budget (9,000) so agy keeps it inline, naming the rest for next.
      const batch = full.map(t => t.name).slice(0, 10);
      const long = textOf(await help({ names: batch }));
      expect(long.length).toBeLessThanOrEqual(9_000);
      const parts = long.split("\n\n---\n\n");
      const readNames = parts.slice(0, -1).map(part => part.split("\n")[0]!);
      expect(readNames.length).toBeGreaterThanOrEqual(1);
      expect(readNames.length).toBeLessThan(batch.length);
      // Read in the order asked, and every name not read is named once, in order, for the next call.
      expect(readNames).toEqual(batch.filter(n => readNames.includes(n)));
      expect(parts.at(-1)).toBe(`Not read in this call, to ask for next: ${batch.filter(n => !readNames.includes(n)).join(", ")}.`);
      // One too long for what is left is named for later, and the shorter ones after it are still read.
      const propose = full.find(t => t.name === "timeline_propose")!;
      expect(toolDoc(propose).length).toBeGreaterThan(9_000 - at.length);
      const packed = textOf(await help({ names: ["timeline_at", "timeline_propose", "timeline_diff"] }));
      expect(packed).toBe([at, diff, "Not read in this call, to ask for next: timeline_propose."].join("\n\n---\n\n"));
      const unknownFirst = await help({ names: [...Array.from({ length: 8 }, (_, i) => `nothing_${i}`), "timeline_at"] });
      expect(unknownFirst.isError).toBeFalsy();
      expect(textOf(unknownFirst)).toMatch(/Not read in this call, to ask for next: timeline_at\.$/);
      for (const args of [{}, { name: "timeline_at", names: ["timeline_at"] }]) {
        const wrong = await help(args);
        expect(wrong.isError).toBe(true);
        expect(textOf(wrong)).toBe("Give either name, for one tool, or names, for several.");
      }
    } finally {
      await gemini.close();
    }
  });

  it("lists a side check's few tools whole, as Claude Code gets them", async () => {
    for (const kind of ["area_check", "learning_check"]) {
      const [brief, full] = await Promise.all([listed("gemini", { kind }), listed("claude", { kind })]);
      expect(brief, kind).toEqual(full);
    }
  });

  it("leaves Claude Code's and Codex's tools as they were", async () => {
    for (const agent of ["claude", "codex"] as const) {
      const tools = await listed(agent);
      expect(tools.map(t => t.name)).not.toContain("tool_help");
      expect(tools.map(t => t.name)).not.toContain("tool_call");
      expect(tools.length).toBeGreaterThan(40);
      // Whole descriptions and parameters, with tool search's mark on the few sent from the start.
      for (const tool of tools) {
        expect(tool.description, tool.name).not.toMatch(/tool_help|tool_call/);
        expect(tool._meta?.["anthropic/alwaysLoad"] === true, tool.name).toBe(ALWAYS_LOADED_TOOLS.has(tool.name));
      }
      expect(JSON.stringify(tools.find(t => t.name === "dialogue_apply_cuts")!.inputSchema)).toContain("\"description\"");
    }
  });

  it("keeps every tool inside Claude Code's 4,096-character description cap on Ollama, LM Studio and OpenRouter", async () => {
    for (const agent of ["ollama", "lmstudio", "openrouter"] as const) {
      const [brief, full] = await Promise.all([listed(agent), listed("claude")]);
      for (const tool of brief) {
        expect(tool.description?.length ?? 0, `${agent}:${tool.name}`).toBeLessThanOrEqual(4_000);
      }
      const call = brief.find(t => t.name === "tool_call")!;
      const indexedNames = call.description!.split("\nTools:\n")[1]!.split("\n").map(l => l.split(":")[0]);
      // Text-only providers omit frame/audio-only tools; every remaining non-whole tool is present in the index.
      const expected = full.filter(t => !ALWAYS_LOADED_TOOLS.has(t.name) && indexedNames.includes(t.name)).map(t => t.name);
      expect(indexedNames).toContain("timeline_first_cut");
      expect(indexedNames).toContain("skills_list");
      expect(indexedNames).toContain("captions_generate");
      expect(indexedNames.length).toBe(expected.length);
    }
  });

  it("keeps a description's first sentence on its line, cut to its most", () => {
    expect(indexLine("project_get", "Get the project: settings, e.g. fps. For clips use timeline_get.")).toBe("project_get: Get the project: settings, e.g. fps.");
    expect(indexLine("x", `${"a".repeat(400)}.`)).toBe(`x: ${"a".repeat(INDEX_LINE_MAX - 1)}…`);
    expect(indexLine("x", "Two\n  lines. Then more.")).toBe("x: Two lines.");
  });

  it("lists a tool's parameters one line each, with their types, limits, defaults and nesting, and anything else as JSON", () => {
    const schema = {
      type: "object", required: ["version", "cuts"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        version: { type: "string" },
        fade: { type: "integer", minimum: 0, maximum: 12, description: "Frames." },
        at: { type: "number", exclusiveMinimum: 0 },
        mode: { type: "string", enum: ["ask", "cut"], description: "Which." },
        times: { type: "integer", minimum: 1, default: 1 },
        title: { type: "string", minLength: 1, maxLength: 80 },
        note: { type: "string", minLength: 1 },
        ids: { type: "array", items: { type: "string" }, maxItems: 20 },
        quotes: { anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }] },
        patch: { type: "object", additionalProperties: {} },
        layout: { anyOf: [{ type: "object", properties: { clipId: { type: "string" } }, required: ["clipId"] }, { type: "string", const: "asPlaced" }] },
        shape: { anyOf: [{ type: "object", properties: { a: { type: "number" } } }, { type: "object", properties: { b: { type: "number" } } }] },
        cuts: { type: "array", minItems: 1, items: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["pause"] }, range: { type: "object", properties: { start: { type: "number", minimum: 0 } } } } } },
        odd: { type: "string", pattern: "^a", description: "Starts with a." },
      },
    };
    expect(parameterLines(schema)).toEqual([
      "- version* (string)",
      "- fade (integer, 0 to 12): Frames.",
      "- at (number, > 0)",
      "- mode (\"ask\" | \"cut\"): Which.",
      "- times (integer, >= 1, default 1)",
      "- title (string, 1 to 80 chars)",
      "- note (string, nonempty)",
      "- ids (array of string, <= 20 items)",
      "- quotes (string, nonempty | array of (string, nonempty), >= 1 items)",
      "- patch (object)",
      "- layout (object | \"asPlaced\")",
      "  - clipId* (string)",
      "- shape (object | object)",
      "  - either (object):",
      "    - a (number)",
      "  - or (object):",
      "    - b (number)",
      "- cuts* (array of object, >= 1 items)",
      "  - kind* (\"pause\")",
      "  - range (object)",
      "    - start (number, >= 0)",
      "- odd (JSON schema {\"type\":\"string\",\"pattern\":\"^a\"}): Starts with a.",
    ]);
    expect(toolDoc({ name: "bare", description: "Nothing to give.", inputSchema: { type: "object", properties: {} } }))
      .toBe("bare\n\nNothing to give.\n\nParameters (* = required):\nnone");
  });
});
