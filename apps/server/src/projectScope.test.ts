import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScarletClient } from "@scarlet/shared";
import { createScarletMcpServer } from "@scarlet/mcp";
import { accessToken } from "./auth.js";
import { createApp, type ScarletApp } from "./app.js";

let dir: string, workspace: ScarletApp, api: ScarletClient, first: string, second: string;
const editor = new Client({ name: "project-scope-test", version: "1" });
const call = (name: string, args: Record<string, unknown>) => editor.callTool({ name, arguments: args });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-project-scope-"));
  workspace = createApp({ dataDir: dir, env: {}, log: () => {} });
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(workspace.app.request(input, init));
  api = new ScarletClient({ baseUrl: "https://fixture.test", token: accessToken(workspace.ctx), fetch });
  first = (await api.createProject({ name: "Current" })).project.id;
  second = (await api.createProject({ name: "Other" })).project.id;
  const server = createScarletMcpServer(api, { projectId: first, author: { type: "agent", name: "Fixture" }, fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await editor.connect(b);
});

afterAll(async () => {
  await editor.close();
  await workspace?.ctx.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("treats a note ID as one segment and never dispatches another command", async () => {
  const { task } = await api.createTask(first, { instruction: "Fixture", kind: "edit", agent: "claude" });
  for (const noteId of [`../tasks/${task.id}/cancel#`, "%2e%2e%2ftasks", "..", ".", "bad\\id", "id?other=1"]) {
    expect((await call("note_reply", { noteId, text: "A reply" })).isError).toBe(true);
  }
  expect((await api.task(task.id)).task.state).toBe("queued");
});

it("refuses to change another project's notes and allows the current project's notes", async () => {
  const foreign = (await api.createNote(second, { time: 0, text: "Foreign note" })).note;
  const local = (await api.createNote(first, { time: 0, text: "Local note" })).note;
  for (const [name, args] of [["note_reply", { text: "A reply" }], ["note_resolve", {}]] as const) {
    expect((await call(name, { noteId: foreign.id, ...args })).isError).toBe(true);
    expect((await call(name, { noteId: local.id, ...args })).isError).toBeFalsy();
  }
  expect((await api.notes(second)).notes).toContainEqual(foreign);
  expect((await api.notes(first)).notes).toContainEqual(expect.objectContaining({
    id: local.id, state: "resolved", replies: [expect.objectContaining({ text: "A reply" })],
  }));
});

it("checks source ownership before reading existing transcripts", async () => {
  const { ctx } = workspace;
  for (const projectId of [first, second]) {
    const id = "media_" + projectId;
    ctx.repos.projects.putMedia(projectId, { id, kind: "audio", path: "fixture.wav", name: "Fixture", transcriptId: "tr_" + id }, "ready");
    ctx.repos.transcripts.put({ id: "tr_" + id, projectId, mediaId: id, segments: [{ id: "s", text: projectId, start: 0, end: 1, words: [] }] });
  }
  const local = await call("transcript_get", { mediaId: "media_" + first });
  expect(local.isError).toBeFalsy();
  expect(JSON.stringify(local.content)).toContain(first);
  const foreign = await call("transcript_get", { mediaId: "media_" + second });
  expect(foreign.isError).toBe(true);
});

it("limits change details and render status to the selected project", async () => {
  for (const projectId of [first, second]) {
    const { change } = await api.proposeChange(projectId, { description: "Fixture marker", skipRender: true,
      ops: [{ op: "addMarker", marker: { id: "beat", time: 0, text: "Opening" } }] });
    const render = workspace.ctx.repos.renders.put({ id: "render_" + projectId, projectId, version: change.toVersion,
      key: "key_" + projectId, kind: "full", quality: "preview", range: null, state: "done", path: "fixture.mp4", progress: 1 });
    const expectError = projectId !== first;
    expect(Boolean((await call("change_get", { changeId: change.id })).isError)).toBe(expectError);
    expect(Boolean((await call("render_status", { renderId: render.id })).isError)).toBe(expectError);
  }
});

it("refuses to post to a foreign task even when the embedded caller omits its task object", async () => {
  const { task } = await api.createTask(second, { instruction: "Other project task", kind: "edit", agent: "claude" });
  const linked = createScarletMcpServer(api, { projectId: first, taskId: task.id, author: { type: "agent", name: "Fixture" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const session = new Client({ name: "embedded-agent", version: "1" });
  await linked.connect(a);
  await session.connect(b);
  try {
    await session.callTool({ name: "task_log", arguments: { text: "Wrong project" } });
    expect((await api.task(task.id)).events).toEqual([]);
  } finally { await session.close(); }
});

it("only uses a legacy resource endpoint after checking the owning project's list", async () => {
  const local = (await api.createNote(first, { time: 0, text: "Legacy local" })).note;
  const foreign = (await api.createNote(second, { time: 0, text: "Legacy foreign" })).note;
  const routes: string[] = [];
  const legacy = new ScarletClient({ baseUrl: "https://fixture.test", token: accessToken(workspace.ctx),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      routes.push(path);
      if (path.startsWith(`/api/projects/${first}/notes/`)) return Response.json({
        error: { code: "not_found", message: `no route for ${init?.method} ${path}` },
      }, { status: 404 });
      return workspace.app.request(input, init);
    },
  }).forProject(first);
  await expect(legacy.replyNote(foreign.id, "Leak")).rejects.toMatchObject({ status: 404 });
  expect(routes).not.toContain(`/api/notes/${foreign.id}/reply`);
  const { note } = await legacy.replyNote(local.id, "Allowed");
  expect(note.replies?.map(reply => reply.text)).toEqual(["Allowed"]);
});
