/** Graphics Scarlet draws from a page, and the project's style guide. */
import { z } from "zod/v3";
import { Id } from "@scarlet/timeline";

/**
 * POST /projects/:id/graphics, the `options` field of the multipart form; the page is the `html` file field,
 * and any `asset` file fields are files it links to by relative path (the part's filename).
 */
export const GraphicRenderRequest = z.object({
  /** The graphic this one revises: its files come along. */
  basedOn: Id.optional(),
  duration: z.number().positive().max(600).optional(),
  width: z.number().int().positive().max(8192).optional(),
  height: z.number().int().positive().max(8192).optional(),
  fps: z.number().positive().max(120).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  /** Timeline seconds to lay the check pictures over, on the head version. */
  checkAt: z.number().nonnegative().optional(),
  /** Seconds into the graphic to check; default three moments spread through it. */
  checkTimes: z.array(z.number().nonnegative()).max(6).optional(),
  /** Return the check pictures (JPEG), for a model that can see them. */
  pictures: z.boolean().optional(),
  provenance: z.object({ name: z.string().optional(), model: z.string().optional(), prompt: z.string().max(4000).optional() }).optional(),
});
export type GraphicRenderRequest = z.infer<typeof GraphicRenderRequest>;

const GraphicCheck = z.object({
  /** Seconds into the graphic. */
  time: z.number(),
  /** The part of the frame the graphic covers at that moment, as fractions of the frame; null when nothing shows. */
  box: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).nullable(),
  /** The graphic over the picture at that moment, base64 JPEG, when pictures were asked for. */
  jpeg: z.string().optional(),
});

export const GraphicRenderResponse = z.object({
  /** Absent when the graphic was not imported (a font is missing). */
  media: z.unknown().optional(),
  /** The page Scarlet kept for this graphic, to read or revise. */
  source: z.string().optional(),
  missingFonts: z.array(z.object({ family: z.string(), sample: z.string() })),
  /** With a font missing, the common families installed here. */
  installedFonts: z.array(z.string()).optional(),
  problems: z.array(z.string()),
  checks: z.array(GraphicCheck),
  /** Timeline seconds the checks were laid over, when there was a picture there. */
  checkAt: z.number().optional(),
  width: z.number(), height: z.number(), fps: z.number(), duration: z.number(),
  renderMs: z.number(),
});
export type GraphicRenderResponse = z.infer<typeof GraphicRenderResponse>;

/** PUT /projects/:id/style-guide: the project's one style guide, from pasted text or a file. */
export const SaveStyleGuideRequest = z.object({
  name: z.string().trim().min(1).max(200),
  text: z.string().max(200_000).optional(),
  /** A file the editor attached to a request in this project. */
  attachmentId: Id.optional(),
}).refine(b => b.text?.trim() || b.attachmentId, { message: "Give the guide's text or the attachment it is in." });
export type SaveStyleGuideRequest = z.infer<typeof SaveStyleGuideRequest>;
