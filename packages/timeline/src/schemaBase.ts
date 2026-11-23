/**
 * Scarlet cut-list schema.
 *
 * All times are seconds (floating point) on the project timeline or in source
 * media. Frame snapping happens at render time using the project frame rate.
 * Agents think in seconds (transcripts are in seconds), so the format does too.
 *
 * Positions and sizes in transforms are normalized to the project canvas:
 * x/y are offsets from center in units of canvas width/height (0 = centered,
 * 0.5 = half a canvas to the right/down). scale 1 = fit source to canvas.
 *
 * The schema is split by subject: these shared primitives, media and transcripts (`mediaSchema`), clips, tracks and
 * the timeline (`timelineSchema`), the project (`projectSchema`), and changes and notes (`changeSchema`).
 */
import { z } from "zod/v3";
import { parseColor } from "./color.js";

export const RenderColor = z.string().refine((value) => !!parseColor(value), "invalid render color");

export const Id = z.string().min(1);

export const Seconds = z.number().finite().min(0);

export const TimeRange = z
  .object({
    start: Seconds,
    end: Seconds,
  })
  .refine((r) => r.end >= r.start, { message: "end must be >= start" });
export type TimeRange = z.infer<typeof TimeRange>;
