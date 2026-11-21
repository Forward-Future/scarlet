import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScarletClient } from "@scarlet/shared";
import { expect, it } from "vitest";
import { createScarletMcpServer } from "./server.js";

it("reports tool completion and degraded evidence without awaiting diagnostics or sending footage data", async () => {
  const diagnosticPath = "/api/projects/prj_fixture/tasks/tsk_fixture/tool-diagnostic";
  const diagnostics: Array<{ headers: Headers; body: unknown }> = [];
  const respond: Array<() => void> = [];
  const sc = new ScarletClient({
    baseUrl: "https://fixture.test",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === diagnosticPath) {
        diagnostics.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        // The model's tool response should not depend on this endpoint answering.
        return await new Promise<Response>(resolve => respond.push(() => resolve(new Response(null, { status: 204 }))));
      }
      if (path === "/api/projects/prj_fixture")
        return Response.json({ project: { id: "prj_fixture", name: "Private project", media: [{ id: "med_fixture", duration: 60, kind: "audio" }] } });
      if (path.endsWith("/waveform"))
        return Response.json({ mediaId: "med_fixture", from: 0, to: 10, peaks: [.1], rms: [.05] });
      if (path.endsWith("/loudness"))
        return Response.json({ error: { code: "engine_error", message: "Private failure" } }, { status: 500 });
      if (path.endsWith("/transcript"))
        return Response.json({ id: "tr_fixture", mediaId: "med_fixture", segments: [] });
      return Response.json({});
    },
  });
  const startedAt = "2026-11-16T16:45:00.000Z";
  const server = createScarletMcpServer(sc, {
    projectId: "prj_fixture", taskId: "tsk_fixture", taskStartedAt: startedAt, author: { type: "agent", name: "fixture" },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "fixture", version: "0" });
  await c.connect(b);
  try {
    const project = await c.callTool({ name: "project_get", arguments: {} });
    expect(project.isError).toBeFalsy();
    const profile = await c.callTool({ name: "media_profile", arguments: { mediaId: "med_fixture", to: 10 } });
    expect(profile.isError).toBeFalsy();
    expect(diagnostics.map(record => record.body)).toEqual([
      // The size of what went back to the model, never the words.
      { tool: "project_get", outcome: "ok", elapsedMs: expect.any(Number), evidenceMisses: 0, resultChars: expect.any(Number) },
      { tool: "media_profile", outcome: "degraded", elapsedMs: expect.any(Number), evidenceMisses: 1, resultChars: expect.any(Number) },
    ]);
    expect((diagnostics[0]!.body as { resultChars: number }).resultChars).toBe((project.content as Array<{ text: string }>)[0]!.text.length);
    expect(diagnostics[1]?.headers.get("x-scarlet-task-started-at")).toBe(startedAt);
  } finally {
    for (const finish of respond) finish();
    await c.close();
    await server.close();
  }
});

it("logs a call whose arguments don't fit its tool and puts the refusal in the task's history, as any refusal", async () => {
  const diagnostics: unknown[] = [], events: unknown[] = [];
  const sc = new ScarletClient({
    baseUrl: "https://fixture.test",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/tool-diagnostic")) diagnostics.push(JSON.parse(String(init?.body)));
      else if (path.endsWith("/events")) events.push(JSON.parse(String(init?.body)));
      return path.endsWith("/tool-diagnostic") ? new Response(null, { status: 204 }) : Response.json({});
    },
  });
  const server = createScarletMcpServer(sc, {
    projectId: "prj_fixture", taskId: "tsk_fixture", taskStartedAt: "2026-11-16T16:45:00.000Z", author: { type: "agent", name: "fixture" },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "fixture", version: "0" });
  await c.connect(b);
  try {
    // The SDK refuses a time given as words before timeline_at runs.
    const wrong = await c.callTool({ name: "timeline_at", arguments: { time: "soon" } });
    expect(wrong.isError).toBe(true);
    const refusal = (wrong.content as Array<{ text: string }>)[0]!.text;
    expect(refusal).toContain("timeline_at");
    expect(diagnostics).toEqual([{ tool: "timeline_at", outcome: "failed", elapsedMs: expect.any(Number), evidenceMisses: 0, resultChars: refusal.length }]);
    expect(events).toEqual([expect.objectContaining({ type: "log", text: refusal, data: { kind: "tool_refused", tool: "scarlet.timeline_at", error: true } })]);
    // A call that reaches its tool and fails there is reported once, by the tool.
    await c.callTool({ name: "timeline_at", arguments: {} });
    expect(diagnostics).toHaveLength(2);
    expect(events).toHaveLength(2);
  } finally {
    await c.close();
    await server.close();
  }
});
