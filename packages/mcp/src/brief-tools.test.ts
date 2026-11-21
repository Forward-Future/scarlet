import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentCapabilities, ScarletClient, Task, type AgentId } from "@scarlet/shared";
import { briefDescription, withoutDescriptions } from "./brief-tools.js";
import { createScarletMcpServer } from "./server.js";

/** A run of a request to edit, which has every editing tool. */
async function connect(agent: AgentId, opts: { resultChars?: number; fetch?: typeof fetch } = {}) {
  const task = Task.parse({ id: "tsk_1", state: "running", projectId: "prj_test", kind: "edit", agent, instruction: "/first-cut-dialogue",
    context: {}, hostId: "host_a", createdBy: { type: "human", name: "Editor" } });
  const server = createScarletMcpServer(new ScarletClient({ baseUrl: "http://127.0.0.1:9", token: "tok", ...(opts.fetch && { fetch: opts.fetch }) }), {
    projectId: "prj_test", agent, taskId: task.id, task, taskStartedAt: opts.fetch && "2026-11-20T10:00:00.000Z", author: { type: "agent", id: agent, name: agent },
    ...(opts.resultChars && { capabilities: { ...agentCapabilities(agent), resultChars: opts.resultChars } }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const hasDescription = (schema: unknown): boolean => Array.isArray(schema) ? schema.some(hasDescription)
  : !!schema && typeof schema === "object" && Object.entries(schema).some(([key, value]) =>
    key === "description" && typeof value === "string" || key !== "description" && hasDescription(value));

describe("brief tools", () => {
  it("lists every tool to Gemini inside the definitions agy keeps, and gives each one whole from tool_help", async () => {
    const [gemini, claude] = await Promise.all([connect("gemini"), connect("claude")]);
    try {
      const brief = (await gemini.listTools()).tools;
      const full = (await claude.listTools()).tools;
      // Claude Code is shown every tool whole, as before.
      expect(full.map(t => t.name)).not.toContain("tool_help");
      expect(brief.map(t => t.name).sort()).toEqual([...full.map(t => t.name), "tool_help"].sort());
      // agy dropped the largest of Scarlet's tools past about 60 KB of definitions (2026-11-19). A new tool that takes
      // this past the bound needs a shorter first sentence or fewer parameters, or Gemini loses a tool.
      expect(JSON.stringify(brief).length).toBeLessThan(55_000);
      for (const tool of brief.filter(t => t.name !== "tool_help")) {
        expect(tool.description).toMatch(/read its full description and parameters with tool_help\.$/);
        expect(hasDescription(tool.inputSchema), tool.name).toBe(false);
      }
      const whole = full.find(t => t.name === "dialogue_apply_cuts")!;
      const help = await gemini.callTool({ name: "tool_help", arguments: { name: "mcp_scarlet_dialogue_apply_cuts" } }) as CallToolResult;
      const text = (help.content[0] as { text: string }).text;
      expect(text).toContain(whole.description);
      // Compact, as every other result is.
      expect(text).toContain(JSON.stringify(whole.inputSchema));
      const unknown = await gemini.callTool({ name: "tool_help", arguments: { name: "timeline_delete" } }) as CallToolResult;
      expect(unknown.isError).toBe(true);
      expect((unknown.content[0] as { text: string }).text).toMatch(/^No Scarlet tool is named timeline_delete\. Its tools: .*timeline_propose/);
    } finally {
      await Promise.all([gemini.close(), claude.close()]);
    }
  });

  it("gives several tools whole in one call, and names any it doesn't know without failing the rest", async () => {
    const gemini = await connect("gemini");
    try {
      const help = async (args: object) => await gemini.callTool({ name: "tool_help", arguments: args }) as CallToolResult;
      const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
      const at = textOf(await help({ name: "timeline_at" })), cuts = textOf(await help({ name: "mcp_scarlet_dialogue_apply_cuts" }));
      const unknown = await help({ name: "timeline_delete" });
      expect(textOf(await help({ names: ["timeline_at"] }))).toBe(at);
      const some = await help({ names: ["timeline_at", "timeline_delete", "scarlet.dialogue_apply_cuts", "timeline_at"] });
      expect(some.isError).toBeFalsy();
      expect(textOf(some)).toBe([textOf(unknown), at, cuts].join("\n\n---\n\n"));
      const none = await help({ names: ["timeline_delete", "clip_move"] });
      expect(none.isError).toBe(true);
      expect(textOf(none)).toMatch(/^No Scarlet tool is named timeline_delete or clip_move\. Its tools: .*timeline_propose/);
      // A long list is read in part, with the rest named for another call, not refused.
      const tools = (await gemini.listTools()).tools.map(t => t.name).filter(n => n !== "tool_help");
      const long = textOf(await help({ names: tools.slice(0, 10) }));
      expect(long.split("\n\n---\n\n")).toHaveLength(9);
      expect(long.endsWith(`Not read in this call, to ask for next: ${tools[8]}, ${tools[9]}.`)).toBe(true);
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

  it("reads as many tools as fit one result and names the rest, and logs each call as any tool's", async () => {
    const diagnostics: unknown[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/tool-diagnostic")) diagnostics.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const gemini = await connect("gemini", { resultChars: 12_000, fetch });
    try {
      const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
      const names = ["dialogue_apply_cuts", "dialogue_check_join", "timeline_propose", "timeline_at"];
      const help = await gemini.callTool({ name: "tool_help", arguments: { names } }) as CallToolResult;
      const read = textOf(help).split("\n\n---\n\n");
      expect(textOf(help).length).toBeLessThan(12_000 + 2_000);
      expect(read[0]).toMatch(/^dialogue_apply_cuts\n/);
      const rest = read.at(-1)!.match(/^Not read in this call, to ask for next: (.*)\.$/)![1]!.split(", ");
      expect(read.length - 1 + rest.length).toBe(names.length);
      expect(rest.at(-1)).toBe("timeline_at");
      // Each call reaches the run's diagnostics with the size of what went back to the model.
      expect(diagnostics).toEqual([{ tool: "tool_help", outcome: "ok", elapsedMs: expect.any(Number), evidenceMisses: 0, resultChars: textOf(help).length }]);
    } finally {
      await gemini.close();
    }
  });

  it("keeps a description's first sentence and a parameter named description", () => {
    expect(briefDescription("Get the project: settings, e.g. fps. For clips use timeline_get.")).toBe(
      "Get the project: settings, e.g. fps. Before you first call it, read its full description and parameters with tool_help.");
    expect(withoutDescriptions({ type: "object", description: "x", properties: { description: { type: "string", description: "y" } } }))
      .toEqual({ type: "object", properties: { description: { type: "string" } } });
  });
});
