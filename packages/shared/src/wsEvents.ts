/** What the engine pushes over the WebSocket, and what a client may send it. */
import { z } from "zod/v3";
import { Change, Id, MediaAsset, Note, Project } from "@scarlet/timeline";
import { ActivityEntry, Render } from "./api.js";
import { AgentHost } from "./agents.js";
import { Learning } from "./learnings.js";
import { Skill } from "./skills.js";
import { StyleGuideRecord } from "./styleGuides.js";
import { Task, TaskEvent } from "./tasks.js";
import { UsageTotals } from "./usage.js";

export const SpeakerProgress = z.object({
  phase: z.enum(["audio", "models", "segmenting", "identifying", "grouping", "matching"]),
  percent: z.number().int().min(0).max(100).optional(),
});
export type SpeakerProgress = z.infer<typeof SpeakerProgress>;

export const WsEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.subscribed"), projectId: Id, found: z.boolean() }),
  z.object({ type: z.literal("project.updated"), projectId: Id, project: Project }),
  z.object({ type: z.literal("media.updated"), projectId: Id, media: MediaAsset }),
  /** A file was taken out of the project. */
  z.object({ type: z.literal("media.removed"), projectId: Id, mediaId: Id }),
  z.object({ type: z.literal("media.previewReady"), projectId: Id, mediaId: Id }),
  z.object({ type: z.literal("media.speakerProgress"), projectId: Id, active: z.record(Id, SpeakerProgress) }),
  z.object({ type: z.literal("media.import.checking"), projectId: Id, importId: z.string().uuid(), fraction: z.number().min(0).max(1) }),
  z.object({ type: z.literal("change.updated"), projectId: Id, change: Change }),
  z.object({ type: z.literal("note.updated"), projectId: Id, note: Note }),
  z.object({ type: z.literal("render.updated"), projectId: Id, render: Render }),
  z.object({ type: z.literal("render.settings.updated") }),
  z.object({ type: z.literal("task.updated"), projectId: Id, task: Task }),
  z.object({ type: z.literal("task.event"), projectId: Id, taskId: Id, event: TaskEvent }),
  /** The task's token totals across its runs, after a run reported usage. */
  z.object({ type: z.literal("task.usage"), projectId: Id, taskId: Id, usage: UsageTotals }),
  z.object({ type: z.literal("host.updated"), host: AgentHost }),
  z.object({ type: z.literal("host.quota_refresh"), force: z.boolean().optional() }),
  z.object({ type: z.literal("skill.updated"), skill: Skill }),
  z.object({ type: z.literal("style_guide.updated"), styleGuide: StyleGuideRecord }),
  z.object({ type: z.literal("style_guide.deleted"), styleGuideId: Id }),
  z.object({ type: z.literal("learning.updated"), projectId: Id, learning: Learning }),
  z.object({ type: z.literal("batch_summary.updated"), projectId: Id, key: z.string(), title: z.string() }),
  z.object({ type: z.literal("activity.added"), projectId: Id.nullable(), entry: ActivityEntry }),
  z.object({
    type: z.literal("notification"),
    title: z.string(),
    body: z.string().optional(),
    projectId: Id.optional(),
    link: z.string().optional(),
  }),
]);
export type WsEvent = z.infer<typeof WsEvent>;

export const WsClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), projectId: Id }),
  z.object({ type: z.literal("unsubscribe"), projectId: Id }),
  z.object({ type: z.literal("ping") }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;
