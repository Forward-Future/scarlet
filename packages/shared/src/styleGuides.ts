/** Reusable visual style guides for motion graphics and titles. */
import { z } from "zod/v3";
import { Id } from "@scarlet/timeline";
import { RunChoice } from "./agents.js";
import { SkillSlug } from "./skills.js";

export const StyleGuideSlug = SkillSlug;

/** A brand asset (font, logo, reference screenshot, brand doc) stored with a style guide. */
export const StyleGuideAsset = z.object({
  id: Id,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mime: z.string().max(200).optional(),
  createdAt: z.string().datetime().optional(),
});
export type StyleGuideAsset = z.infer<typeof StyleGuideAsset>;

/** Metadata for a style guide's rendered 16:9 preview sheet. */
export const StyleGuidePreview = z.object({
  updatedAt: z.string().datetime(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type StyleGuidePreview = z.infer<typeof StyleGuidePreview>;

export const StyleGuideRecord = z.object({
  id: Id,
  /** Slug referenced as @name in chat or in skills. */
  name: StyleGuideSlug,
  description: z.string().default(""),
  /** Design direction, tokens, typography, and motion rules maintained by Scarlet. */
  instructions: z.string().default(""),
  /** When true, this style applies automatically to graphics across projects unless overridden with @name. */
  isDefault: z.boolean().default(false),
  assets: z.array(StyleGuideAsset).default([]),
  preview: StyleGuidePreview.optional(),
  /** How this style was created (e.g. "graphic" when saved from an edit card). */
  source: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type StyleGuideRecord = z.infer<typeof StyleGuideRecord>;

export const CreateStyleGuideRequest = z.object({
  name: StyleGuideSlug,
  description: z.string().max(1024).optional(),
  instructions: z.string().max(128 * 1024).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateStyleGuideRequest = z.infer<typeof CreateStyleGuideRequest>;

export const UpdateStyleGuideRequest = z.object({
  name: StyleGuideSlug.optional(),
  description: z.string().max(1024).optional(),
  instructions: z.string().max(128 * 1024).optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateStyleGuideRequest = z.infer<typeof UpdateStyleGuideRequest>;

/** Create a library style guide directly from a rendered graphic in a project. */
export const StyleGuideFromGraphicRequest = z.object({
  projectId: Id,
  mediaId: Id,
  name: StyleGuideSlug,
  description: z.string().max(1024).optional(),
  isDefault: z.boolean().optional(),
});
export type StyleGuideFromGraphicRequest = z.infer<typeof StyleGuideFromGraphicRequest>;

/** Ask Scarlet to design or update a style guide in chat, optionally with files attached to the message. */
export const EditStyleGuideRequest = RunChoice.extend({
  prompt: z.string().trim().max(8000).default(""),
  attachments: z.array(StyleGuideAsset.pick({ id: true, name: true, size: true, mime: true })).max(20).optional(),
}).refine(
  body => body.prompt.length > 0 || (body.attachments?.length ?? 0) > 0,
  { message: "Describe a look or attach a file.", path: ["prompt"] },
);
export type EditStyleGuideRequest = z.infer<typeof EditStyleGuideRequest>;

/** What Scarlet saves to a style guide during a style_guide_edit task. */
export const TaskStyleGuideDraft = z.object({
  description: z.string().trim().max(1024).regex(/^[^\r\n]*$/).optional(),
  instructions: z.string().trim().min(1).max(128 * 1024),
});
export type TaskStyleGuideDraft = z.infer<typeof TaskStyleGuideDraft>;

/** Render a 16:9 still HTML style sheet preview for a style guide. */
export const StyleGuidePreviewRenderRequest = z.object({
  html: z.string().min(1).max(512 * 1024),
  width: z.number().int().positive().max(3840).optional(),
  height: z.number().int().positive().max(2160).optional(),
  at: z.number().nonnegative().max(60).optional(),
});
export type StyleGuidePreviewRenderRequest = z.infer<typeof StyleGuidePreviewRenderRequest>;

export const StyleGuidePreviewRenderResponse = z.object({
  styleGuide: StyleGuideRecord.optional(),
  missingFonts: z.array(z.object({ family: z.string(), sample: z.string() })),
  installedFonts: z.array(z.string()).optional(),
  problems: z.array(z.string()),
  width: z.number(),
  height: z.number(),
  jpeg: z.string().optional(),
});
export type StyleGuidePreviewRenderResponse = z.infer<typeof StyleGuidePreviewRenderResponse>;

/** Whole whitespace-delimited @tokens, used to locate style mentions in the composer. */
export function styleGuideCommands(draft: string) {
  return Array.from(draft.matchAll(/(?:^|\s)(@([a-z0-9][a-z0-9-]*)?)(?=\s|$)/gi), match => {
    const end = match.index + match[0].length;
    return { start: end - match[1]!.length, end, name: (match[2] ?? "").toLowerCase() };
  });
}

/** Unique @style-name slugs referenced in chat text or skill instructions (ignoring emails). */
export function styleGuideMentions(text: string): string[] {
  const names = Array.from(
    text.matchAll(/(?:^|[\s(])@([a-z0-9][a-z0-9-]*)(?=[\s.,;:!?)]|$)/gim),
    match => match[1]!.toLowerCase(),
  );
  return [...new Set(names)];
}

/** Turn a free-form label into a valid StyleGuideSlug, or empty string if none remains. */
export function slugifyStyleGuideName(text: string): string {
  return text
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
