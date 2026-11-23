/** A project: its settings, its media and the head of its timeline. */
import { z } from "zod/v3";
import { Id } from "./schemaBase.js";
import { MediaAsset } from "./mediaSchema.js";

export const AspectPreset = z.enum(["16:9", "9:16", "1:1", "4:5", "custom"]);

export const ProjectSettings = z.object({
  fps: z.number().positive().default(30),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  aspect: AspectPreset.default("16:9"),
  sampleRate: z.number().int().positive().default(48000),
  audioChannels: z.number().int().min(1).max(2).default(2),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/**
 * The style guide the editor gave this project, one per project. Scarlet reads it as written and follows it for every
 * graphic it makes here. `text` is what the editor pasted; `file` is a file they attached, under the project's folder.
 */
export const StyleGuide = z.object({
  /** How the chat and the $ list name it: the file's name, or the guide's own title for pasted text. */
  name: z.string().min(1).max(200),
  text: z.string().max(200_000).optional(),
  /** Path relative to the project's folder. */
  file: z.string().max(1024).optional(),
  savedAt: z.string().datetime(),
});
export type StyleGuide = z.infer<typeof StyleGuide>;

export const Project = z.object({
  /** Orders saved project metadata independently of the timeline head and the displayed Last edited time. */
  rowRevision: z.number().int().nonnegative().optional(),
  /** Last conversation revision filed by the editor, independently of the timeline head. */
  completedThreads: z.record(z.string()).optional(),
  mediaPaused: z.boolean().optional(),
  /** The editor stopped project edits and must release the queue before any more start. */
  editingPaused: z.boolean().optional(),
  id: Id,
  archived: z.boolean().optional(),
  branch: z.string().optional(),
  name: z.string(),
  settings: ProjectSettings,
  media: z.array(MediaAsset).default([]),
  /** Version id of the current (head) timeline. */
  head: Id.nullable().default(null),
  styleGuide: StyleGuide.optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Project = z.infer<typeof Project>;
