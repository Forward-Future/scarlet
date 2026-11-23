import type { Render, ServerSettings } from "@scarlet/shared";
import type { Project } from "@scarlet/timeline";
import { now } from "./util";

type Quality = "preview" | "delivery";

export function renderHeight(project: Project, quality: Quality, settings: ServerSettings["render"]): number {
  return quality === "delivery" ? project.settings.height : Math.min(project.settings.height, settings.previewHeight);
}

/** The cache key of a whole-video render, made of everything that changes its picture. */
export function fullRenderKey(project: Project, version: string, quality: Quality, settings: ServerSettings["render"]): string {
  return JSON.stringify(["full", quality, project.id, version, project.settings, renderHeight(project, quality, settings), settings.hwaccel]);
}

export function markRenderDone(render: Render) {
  render.state = "done";
  render.progress = 1;
  render.path = `renders/${render.id}.mp4`;
  render.finishedAt = now();
}
