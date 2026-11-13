import { Hono } from "hono";
import { z } from "zod/v3";
import { AgentAvailability, RegisterHostRequest, type AgentHost } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { waitFor } from "../events.js";
import { notFound } from "../errors.js";
import { claimTask } from "../services/tasks.js";
import { jsonBody } from "./util.js";

const ONLINE_WINDOW_MS = 90_000;

export function hostRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  function withOnline(h: AgentHost): AgentHost {
    const seen = h.lastSeenAt ? Date.parse(h.lastSeenAt) : 0;
    return { ...h, online: Date.now() - seen < ONLINE_WINDOW_MS };
  }

  function requireHost(hostId: string) {
    const host = ctx.repos.hosts.get(hostId);
    if (!host) throw notFound(`host ${hostId}`);
    return host;
  }

  function save(host: AgentHost): AgentHost {
    const saved = ctx.repos.hosts.put(host);
    const out = withOnline(saved);
    ctx.bus.publish({ type: "host.updated", host: out });
    return out;
  }

  r.post("/hosts/register", async (c) => {
    const body = await jsonBody(c, RegisterHostRequest);
    // Re-registering the same host name for the same user reuses the id.
    const existing = ctx.repos.hosts.select("user_id = ?", [c.var.user.id]).find((h) => h.name === body.name && h.platform === body.platform);
    const host = save({
      id: existing?.id ?? newId("host"),
      userId: c.var.user.id,
      name: body.name,
      platform: body.platform,
      agents: body.agents,
      online: true,
      lastSeenAt: now(),
    });
    return c.json({ host }, existing ? 200 : 201);
  });

  r.post("/hosts/:hostId/heartbeat", async (c) => {
    const host = requireHost(c.req.param("hostId"));
    const body = await jsonBody(c, z.object({ agents: z.array(AgentAvailability).optional(), running: z.array(z.string()).optional() }));
    save({ ...host, agents: body.agents ?? host.agents, lastSeenAt: now(), online: true });
    // An older host only reports its presence. Current hosts renew exactly the jobs they own.
    const running = body.running ? JSON.stringify(body.running) : null;
    ctx.db.prepare(`UPDATE tasks SET worker_seen_at = ? WHERE host_id = ? AND state IN ('claimed','running')
      AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))`)
      .run(now(), host.id, running, running);
    // A cancellation may have happened before the host subscribed, or in another engine.
    const cancelled = body.running?.length ? ctx.db.prepare(`SELECT id FROM tasks WHERE host_id = ? AND state = 'cancelled'
      AND id IN (SELECT value FROM json_each(?))`).all(host.id, running) as { id: string }[] : [];
    return c.json({ cancelled: cancelled.map(task => task.id) });
  });

  r.post("/hosts/:hostId/claim", async (c) => {
    const host = requireHost(c.req.param("hostId"));
    const body = await jsonBody(c, z.object({ taskId: z.string().optional(), agents: z.array(z.string()).optional(), desktopPid: z.number().int().positive().optional() }));
    const desktopPid = body.desktopPid === ctx.options.desktopPid ? body.desktopPid : undefined;
    const fresh = ctx.repos.hosts.put({ ...host, lastSeenAt: now(), online: true });
    const waitSeconds = Math.min(60, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
    const deadline = Date.now() + waitSeconds * 1000;
    // A host that hung up can't receive a claim. Its task would sit claimed until recovery failed it.
    const signal = AbortSignal.any([c.req.raw.signal, ctx.shutdown]);
    let task = claimTask(ctx, fresh, body.taskId, body.agents, desktopPid);
    while (!task && !body.taskId && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const fired = await waitFor(ctx.bus, "task.queued", Math.min(remaining, 25_000), undefined, signal);
      if (!fired || signal.aborted) break;
      task = claimTask(ctx, fresh, undefined, body.agents, desktopPid);
    }
    return c.json({ task });
  });

  r.get("/hosts", (c) => {
    return c.json({ hosts: ctx.repos.hosts.select().map(withOnline) });
  });

  return r;
}
