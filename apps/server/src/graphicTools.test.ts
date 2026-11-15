import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentCapabilities, ScarletClient, type AgentCapabilities, type Task } from "@scarlet/shared";
import { createScarletMcpServer } from "@scarlet/mcp";
import { hasChrome } from "@scarlet/render";
import { accessToken } from "./auth.js";
import { createApp, type ScarletApp } from "./app.js";

let dir: string, workspace: ScarletApp, api: ScarletClient, projectId: string;
const sessions: Client[] = [];

async function session(capabilities: AgentCapabilities, task?: Task) {
  const server = createScarletMcpServer(api, { projectId, author: { type: "agent", name: "Fixture", model: "opus" }, capabilities, task, taskId: task?.id });
  const client = new Client({ name: "graphic-tools-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  sessions.push(client);
  return async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as CallToolResult;
}
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const images = (r: CallToolResult) => r.content.filter(c => c.type === "image");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-graphic-tools-"));
  workspace = createApp({ dataDir: dir, skillsSeedDir: join(dir, "empty-seed"), env: {}, log: () => {} });
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(workspace.app.request(input, init));
  api = new ScarletClient({ baseUrl: "https://fixture.test", token: accessToken(workspace.ctx), fetch });
  projectId = (await api.createProject({ name: "Graphics", settings: { width: 320, height: 180, fps: 10, aspect: "custom" } })).project.id;
});

afterAll(async () => {
  for (const s of sessions) await s.close();
  await workspace?.ctx.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the style guide and attachments", () => {
  it("saves pasted text as the project's guide and reads an attached file back", async () => {
    const call = await session(agentCapabilities("claude"));
    const saved = await call("style_guide_save", { name: "House style", text: "Lower thirds bottom left, Helvetica, white on red." });
    expect(saved.isError).toBeFalsy();
    expect((await api.project(projectId)).project.styleGuide).toMatchObject({ name: "House style" });
    expect(textOf(await call("attachment_read", { styleGuide: true }))).toContain("\"name\":\"House style\"");

    const form = new FormData();
    form.append("file", new Blob(["Accent: #E11D48"]), "colors.txt");
    const { attachment } = await api.post<{ attachment: { id: string } }>(`/projects/${projectId}/attachments`, form);
    const read = await call("attachment_read", { attachmentId: attachment.id });
    expect((read.content[1] as { text: string }).text).toBe("Accent: #E11D48");
    expect((await call("attachment_read", {})).isError).toBe(true);
  });
});

describe.skipIf(!hasChrome())("graphics", () => {
  const PAGE = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:absolute;left:8%;bottom:10%;padding:6px 10px;background:#c81e3c;color:#fff;font:bold 16px Helvetica, Arial, sans-serif;animation:in .3s both">{{Name}}</div>
    <style>@keyframes in{from{opacity:0}}</style></body></html>`;

  it("draws a page, shows it over the picture, reads it back and places it with timeline_propose", async () => {
    const call = await session(agentCapabilities("claude"));
    const drawn = await call("graphic_render", { html: PAGE.replace("{{Name}}", "Daniel"), duration: 1, name: "Daniel" });
    expect(drawn.isError).toBeFalsy();
    const result = JSON.parse(textOf(drawn));
    expect(result).toMatchObject({ mediaId: expect.stringMatching(/^med_/), name: "Daniel.mov", duration: expect.closeTo(1, 1), width: 320, height: 180, fps: 10 });
    expect(result.checks).toHaveLength(3);
    expect(result.checks[0]).not.toHaveProperty("jpeg");
    expect(images(drawn)).toHaveLength(3);
    expect(await readFile(result.source, "utf8")).toContain("Daniel");

    const source = JSON.parse(textOf(await call("graphic_get", { mediaId: result.mediaId })));
    expect(source.html).toContain("Daniel");
    const listed = JSON.parse(textOf(await call("project_get", {})));
    expect(listed.media.find((m: { id: string }) => m.id === result.mediaId)).toMatchObject({ kind: "graphic", graphic: { source: expect.stringMatching(/^graphics\//) } });

    const placed = await call("timeline_propose", { intent: "requested", description: "Lower third for Daniel", ops: [
      { op: "addTrack", track: { id: "v9", kind: "video", name: "Graphics", clips: [] } },
      { op: "addClip", trackId: "v9", clip: { id: "lt1", kind: "media", mediaId: result.mediaId, sourceIn: 0, sourceOut: 1, timelineIn: 0 } },
    ] });
    expect(placed.isError, textOf(placed)).toBeFalsy();
  });

  it("gives no pictures to a harness that can't see them, and doesn't add a graphic with a missing font", async () => {
    const call = await session({ ...agentCapabilities("claude"), images: false });
    const missing = await call("graphic_render", { html: `<p style="font-family:'Brand Nope';color:#fff">Hi</p>`, duration: 0.5 });
    const result = JSON.parse(textOf(missing));
    expect(result).toMatchObject({ added: false, missingFonts: [{ family: "Brand Nope", sample: "Hi" }], next: expect.stringContaining("A font the editor named: ask them"), installedFonts: expect.arrayContaining([expect.any(String)]) });
    expect(images(missing)).toEqual([]);
  });

  it("saves a template, lists it, reads it and fills it, and names it for a request that types $ and its name", async () => {
    const call = await session(agentCapabilities("claude"));
    const saved = await call("template_save", { name: "name-card", title: "Name card", description: "A name, bottom left", fields: ["Name"],
      html: PAGE, sample: { Name: "Ada Lovelace" }, duration: 1 });
    expect(saved.isError, textOf(saved)).toBeFalsy();
    expect(images(saved)).toHaveLength(1);
    const { templateId } = JSON.parse(textOf(saved));
    expect(JSON.parse(textOf(await call("template_list", {})))).toEqual([{ id: templateId, name: "name-card", title: "Name card", description: "A name, bottom left", fields: ["Name"] }]);
    expect(JSON.parse(textOf(await call("template_get", { template: "$name-card" })))).toMatchObject({ html: PAGE, sample: { Name: "Ada Lovelace" }, width: 320 });
    const filled = JSON.parse(textOf(await call("graphic_render", { template: "name-card", fields: { Name: "Grace" } })));
    expect(filled).toMatchObject({ name: "Name card – Grace.mov", duration: expect.closeTo(1, 1) });
    expect(await readFile(filled.source, "utf8")).toContain(">Grace</div>");

    const { task } = await api.createTask(projectId, { instruction: "$name-card for Grace at 0:12", kind: "edit", agent: "claude" });
    const { systemPrompt } = await api.taskPrompt(task.id);
    expect(systemPrompt).toContain(`The editor picked the graphic template $name-card: "Name card" (template ${templateId}), with the fields "Name".`);
    expect(systemPrompt).toContain("# Style guide");
  });
});
