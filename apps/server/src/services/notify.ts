import type { Ctx } from "../context.js";

/** Push a notification to the local user over WS. */
export function notify(ctx: Ctx, title: string, opts: { body?: string; projectId?: string; link?: string } = {}) {
  ctx.bus.publish({ type: "notification", title, body: opts.body, projectId: opts.projectId, link: opts.link });
}
