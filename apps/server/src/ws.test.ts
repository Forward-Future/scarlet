import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { createProject, type Project } from "@scarlet/timeline";
import type { WsEvent } from "@scarlet/shared";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken } from "./auth.js";
import { attachWebSocket } from "./ws.js";

let directory: string;
let workspace: ScarletApp;
let server: Server;
let wss: WebSocketServer;
let port: number;
let project: Project;
let lines: string[];
const open: Array<WebSocket | Socket> = [];

beforeEach(async () => {
  // The heartbeat runs on an interval. Only intervals are faked: sockets keep real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  directory = mkdtempSync(join(tmpdir(), "scarlet-ws-test-"));
  // Each test reads its own engine's log: a client closed in teardown is logged a moment later.
  const said: string[] = lines = [];
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line) });
  project = workspace.ctx.repos.projects.insert(createProject("Realtime"));
  server = createServer((_req, res) => res.end("ok"));
  wss = attachWebSocket(server, workspace.ctx);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const socket of open.splice(0)) "terminate" in socket ? socket.terminate() : socket.destroy();
  wss.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  vi.useRealTimers();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

const ws = () => lines.filter(line => line.startsWith("[ws]"));

/** A connected client and everything the engine has sent it, in order. */
async function client(query = `?token=${accessToken(workspace.ctx)}`, headers?: Record<string, string>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
  open.push(socket);
  const received: Array<Record<string, unknown>> = [];
  socket.on("message", data => received.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const say = (message: unknown) => socket.send(typeof message === "string" ? message : JSON.stringify(message));
  /** Messages arrive in the order sent, so a pong marks everything before it as handled. */
  const settled = async () => {
    const pongs = received.filter(m => m.type === "pong").length;
    say({ type: "ping" });
    await vi.waitFor(() => expect(received.filter(m => m.type === "pong")).toHaveLength(pongs + 1));
  };
  return { socket, received, say, settled, events: () => received.filter(m => m.type !== "pong") };
}

/** What the engine answers to a raw upgrade request, or "closed" when it only hangs up. */
function upgrade(requestLine: string, headers: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    open.push(socket);
    let answer = "";
    socket.on("data", chunk => { answer += chunk.toString(); });
    socket.on("close", () => resolve(answer.split("\r\n")[0] || "closed"));
    socket.on("error", reject);
    socket.write([requestLine, "Host: localhost", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", ...headers, "", ""].join("\r\n"));
  });
}

it("refuses a connection with no token or a wrong one, and says so in the log", async () => {
  expect(await upgrade("GET /ws HTTP/1.1")).toBe("HTTP/1.1 401 Unauthorized");
  expect(await upgrade("GET /ws?token=sct_wrong HTTP/1.1")).toBe("HTTP/1.1 401 Unauthorized");
  expect(await upgrade("GET /ws HTTP/1.1", ["Authorization: Bearer sct_wrong"])).toBe("HTTP/1.1 401 Unauthorized");
  // One line for the lot, and never what was sent as a token.
  expect(ws()).toEqual(["[ws] refused a connection: missing or invalid token"]);
});

it("accepts the access token in the address or in an Authorization header", async () => {
  await client();
  await client("", { Authorization: `Bearer ${accessToken(workspace.ctx)}` });
  expect(ws()).toEqual(["[ws] a client connected (1 open)", "[ws] a client connected (2 open)"]);
});

it("hangs up on an address it can't read and keeps serving", async () => {
  // "//" is not a URL Node can parse against a base. A throw here would be uncaught and stop the engine.
  expect(await upgrade("GET // HTTP/1.1")).toBe("closed");
  expect(ws()).toEqual(["[ws] dropped a connection: Invalid URL"]);
  const after = await client();
  await after.settled();
});

it("closes unowned upgrades and continues accepting the realtime channel", async () => {
  expect(await upgrade("GET /other HTTP/1.1")).toBe("closed");
  expect(ws()).toEqual([]);
  await (await client()).settled();
});

it("hands a different upgrade path to its explicit owner when embedded", () => {
  const shared = createServer();
  const owner = vi.fn();
  const realtime = attachWebSocket(shared, workspace.ctx, owner);
  const socket = new PassThrough(), head = Buffer.alloc(0), req = { url: "/other" };
  try {
    shared.emit("upgrade", req, socket, head);
    expect(owner).toHaveBeenCalledWith(req, socket, head);
    expect(socket.destroyed).toBe(false);
  } finally { socket.destroy(); realtime.close(); }
});

it("follows a project that exists and says when one doesn't", async () => {
  const { say, settled, events } = await client();
  say({ type: "subscribe", projectId: project.id });
  say({ type: "subscribe", projectId: "prj_missing" });
  // Neither of these is a message the engine knows: both are ignored and the connection stays up.
  say("not json");
  say({ type: "subscribe" });
  await settled();
  expect(events()).toEqual([
    { type: "media.speakerProgress", projectId: project.id, active: {} },
    { type: "project.subscribed", projectId: project.id, found: true },
    { type: "error", message: "no project prj_missing" },
    { type: "project.subscribed", projectId: "prj_missing", found: false },
  ]);
  expect(ws().slice(1)).toEqual([`[ws] a client follows ${project.id}`, "[ws] a client asked to follow an unknown project, prj_missing"]);
});

it("sends a project's events to the clients following it, and everything else to all", async () => {
  const follower = await client(), other = await client();
  follower.say({ type: "subscribe", projectId: project.id });
  await follower.settled();
  const publish = (event: unknown) => workspace.ctx.bus.publish(event as WsEvent);
  const scoped = { type: "media.previewReady", projectId: project.id, mediaId: "med_1" };
  const elsewhere = { type: "media.previewReady", projectId: "prj_other", mediaId: "med_2" };
  const everyone = [
    { type: "render.settings.updated" },
    { type: "activity.added", projectId: null, entry: { id: "act_1" } },
    // A notification names its project but is for the editor wherever they are.
    { type: "notification", title: "Change ready", projectId: "prj_other" },
  ];
  for (const event of [scoped, elsewhere, ...everyone]) publish(event);
  await Promise.all([follower.settled(), other.settled()]);
  expect(follower.events().slice(2)).toEqual([scoped, ...everyone]);
  expect(other.events()).toEqual(everyone);

  follower.say({ type: "unsubscribe", projectId: project.id });
  await follower.settled();
  publish(scoped);
  publish({ type: "render.settings.updated" });
  await follower.settled();
  expect(follower.events().slice(2 + 1 + everyone.length)).toEqual([{ type: "render.settings.updated" }]);
});

it("logs a client leaving, and stops sending to it", async () => {
  const leaving = await client(), staying = await client();
  leaving.socket.close(1000);
  await vi.waitFor(() => expect(ws().at(-1)).toBe("[ws] a client disconnected with code 1000 (1 open)"));
  workspace.ctx.bus.publish({ type: "render.settings.updated" });
  await staying.settled();
  expect(staying.events()).toEqual([{ type: "render.settings.updated" }]);
});

it("drops a client that stops answering the heartbeat, and keeps one that answers", async () => {
  const answering = await client();
  // A client that completes the handshake and then never answers a ping, as a frozen window doesn't.
  const silent = connect(port, "127.0.0.1");
  open.push(silent);
  const closed = new Promise<void>(resolve => silent.on("close", () => resolve()));
  let handshake = "";
  silent.on("data", chunk => { handshake += chunk.toString("latin1"); });
  silent.write(["GET /ws?token=" + accessToken(workspace.ctx) + " HTTP/1.1", "Host: localhost", "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"));
  await vi.waitFor(() => expect(handshake).toContain("101 Switching Protocols"));
  expect(ws().at(-1)).toBe("[ws] a client connected (2 open)");

  const pinged = new Promise<void>(resolve => answering.socket.once("ping", () => resolve()));
  vi.advanceTimersByTime(30_000);
  await pinged;
  await answering.settled(); // Its pong went out before this ping, so the engine has it.
  vi.advanceTimersByTime(30_000);
  await closed;
  expect(ws().at(-1)).toBe("[ws] a client stopped answering and was dropped (1 open)");
  await answering.settled();
});
