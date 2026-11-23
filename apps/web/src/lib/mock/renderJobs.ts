import { fullRenderContext, type Render, type RenderRequest } from "@scarlet/shared";
import { newId, timelineDuration } from "@scarlet/timeline";
import { fullRenderKey, markRenderDone, renderHeight } from "./renders";
import type { MockStore } from "./store";
import { now, sleep } from "./util";

export function requestRender(store: MockStore, projectId: string, body: Partial<RenderRequest>) {
  const project = store.projectById(projectId);
  const version = body.version ?? project.head ?? "draft";
  const delivery = body.quality === "delivery";
  const quality = body.quality ?? "preview";
  const kind = body.range && (body.kind ?? "full") === "full" ? "segment" : body.kind ?? "full";
  if (kind === "export") throw new Error("The demo saves its included sample video. Use a library project for a custom video export.");
  let key: string;
  if (kind === "full") key = fullRenderKey(project, version, quality, store.db.settings.render);
  else if (kind === "segment") key = JSON.stringify([kind, fullRenderKey(project, version, quality, store.db.settings.render), body.range]);
  else key = newId("k");
  const cached = store.db.renders.find(r => r.key === key && r.state !== "failed" && r.state !== "cancelled");
  if (cached) {
    if (body.owner) store.renderOwners.get(cached.id)?.add(body.owner);
    else store.renderOwners.delete(cached.id);
    return { render: cached };
  }
  const height = renderHeight(project, quality, store.db.settings.render);
  const width = Math.round(project.settings.width * height / project.settings.height / 2) * 2;
  const render: Render = { id: newId("rnd"), projectId, version, kind, quality, range: body.range ?? null, key, path: null, state: "queued", progress: 0, width, height, createdAt: now() };
  store.db.renders.push(render);
  if (body.owner) store.renderOwners.set(render.id, new Set([body.owner]));
  void simulateRender(store, render, delivery ? 6000 : 3000);
  return { render };
}

async function simulateRender(store: MockStore, render: Render, totalMs: number) {
  const cancelled = () => render.state === "cancelled";
  await sleep(300);
  if (cancelled()) return;
  render.state = "running";
  store.emitRender(render);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await sleep(totalMs / steps);
    if (cancelled()) return;
    render.progress = Math.min(0.99, i / steps);
    store.emitRender(render);
  }
  markRenderDone(render);
  store.renderOwners.delete(render.id);
  const tl = store.db.timelines[render.version];
  render.durationSeconds = render.range ? render.range.end - render.range.start : tl ? timelineDuration(tl) : 20;
  store.emitRender(render);
}

export function releaseRender(store: MockStore, id: string, owner: string) {
  const owners = store.renderOwners.get(id);
  if (!owners?.delete(owner) || owners.size) return;
  store.renderOwners.delete(id);
  const render = store.db.renders.find(r => r.id === id);
  if (render && (render.state === "queued" || render.state === "running")) {
    render.state = "cancelled";
    render.finishedAt = now();
    store.emitRender(render);
  }
}

export function renders(store: MockStore, projectId: string, q: { kind?: string; version?: string; currentDelivery?: boolean } = {}) {
  const project = store.projectById(projectId);
  const target = !q.currentDelivery && q.version && q.version !== "head" ? q.version : project.head;
  const fullRenderKeys = target ? { context: fullRenderContext({ ...project, head: target }),
    delivery: fullRenderKey(project, target, "delivery", store.db.settings.render), preview: fullRenderKey(project, target, "preview", store.db.settings.render) } : undefined;
  if (q.currentDelivery) {
    const key = fullRenderKeys?.delivery ?? null;
    return { currentDeliveryKey: key, renders: store.db.renders.filter((r) => r.projectId === projectId && r.key === key) };
  }
  const version = q.version === "head" ? project.head : q.version;
  return { fullRenderKeys, renders: store.db.renders.filter((r) => r.projectId === projectId && (!q.kind || r.kind === q.kind) && (!q.version || r.version === version)) };
}
