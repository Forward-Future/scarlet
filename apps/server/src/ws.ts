import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { WsClientMessage, type WsEvent } from "@scarlet/shared";
import { bearerToken, resolveToken } from "./auth.js";
import type { Ctx } from "./context.js";
import { throttledLog } from "./logText.js";

interface Client {
  ws: WebSocket;
  projects: Set<string>;
  alive: boolean;
}

/**
 * Attach the realtime channel at `/ws?token=`. An embedding server that shares
 * this listener can pass an owner for other upgrade paths.
 */
export function attachWebSocket(server: Server, ctx: Ctx, otherUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();

  // A flood of refused connections is one line a minute, with a count.
  const refused = throttledLog(line => ctx.log(line));

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      if (otherUpgrade) otherUpgrade(req, socket, head);
      else socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? bearerToken(req.headers.authorization);
    if (!token || !resolveToken(ctx, token)) {
      refused("token", "[ws] refused a connection: missing or invalid token");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, projects: new Set(), alive: true };
      clients.add(client);
      ctx.log(`[ws] a client connected (${clients.size} open)`);
      ws.on("message", (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const parsed = WsClientMessage.safeParse(msg);
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "subscribe") {
          const found = !!ctx.repos.projects.header(m.projectId);
          ctx.log(`[ws] a client ${found ? "follows" : "asked to follow an unknown project,"} ${m.projectId}`);
          if (found) {
            client.projects.add(m.projectId);
            ws.send(JSON.stringify({ type: "media.speakerProgress", projectId: m.projectId, active: ctx.speakers.progressFor(m.projectId) } satisfies WsEvent));
          } else ws.send(JSON.stringify({ type: "error", message: `no project ${m.projectId}` }));
          ws.send(JSON.stringify({ type: "project.subscribed", projectId: m.projectId, found } satisfies WsEvent));
        } else if (m.type === "unsubscribe") client.projects.delete(m.projectId);
        else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      });
      ws.on("pong", () => (client.alive = true));
      ws.on("close", (code) => {
        if (clients.delete(client)) ctx.log(`[ws] a client disconnected with code ${code} (${clients.size} open)`);
      });
      ws.on("error", (error) => {
        if (clients.delete(client)) ctx.log(`[ws] a client’s connection failed: ${error.message} (${clients.size} open)`);
      });
    });
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Nothing catches a throw from this listener, so one would stop the engine. `GET //` is an address URL can't read.
    try {
      upgrade(req, socket, head);
    } catch (error) {
      refused("dropped", `[ws] dropped a connection: ${(error as Error).message}`);
      socket.destroy();
    }
  });

  const onEvent = (event: WsEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.ws.readyState !== client.ws.OPEN) continue;
      if (event.type !== "notification" && "projectId" in event && event.projectId !== null) {
        if (client.projects.has(event.projectId)) client.ws.send(payload);
      } else {
        client.ws.send(payload);
      }
    }
  };
  ctx.bus.on("ws", onEvent);

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        if (clients.delete(client)) ctx.log(`[ws] a client stopped answering and was dropped (${clients.size} open)`);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  wss.on("close", () => {
    clearInterval(heartbeat);
    ctx.bus.off("ws", onEvent);
  });
  return wss;
}
