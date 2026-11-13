import { newId } from "@scarlet/timeline";
import { localUser } from "../auth.js";
import type { Ctx } from "../context.js";
import { now } from "../db.js";

/** Store a notification for the local user and push it over WS. */
export function notify(ctx: Ctx, title: string, opts: { body?: string; projectId?: string; link?: string } = {}) {
  const n = ctx.repos.notifications.put({
    id: newId("ntf"),
    userId: localUser(ctx).id,
    title,
    body: opts.body,
    projectId: opts.projectId,
    link: opts.link,
    read: false,
    createdAt: now(),
  });
  ctx.bus.publish({ type: "notification", title, body: n.body, projectId: n.projectId, link: n.link });
}
