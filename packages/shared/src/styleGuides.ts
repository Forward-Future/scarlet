/** Reusable visual, caption, motion, sound, and color style guides. */
import { z } from "zod/v3";
import { CaptionStyle, Id, RenderColor, TransitionDirection, TransitionType } from "@scarlet/timeline";
import { RunChoice } from "./agents.js";
import { BUILT_IN_STYLE_SOUNDS, findBuiltInStyleSound } from "./builtInSfx.js";
import { SkillSlug } from "./skills.js";

export const StyleGuideSlug = SkillSlug;

/** A brand asset (font, logo, screenshot, sound effect, `.cube`/`.3dl` LUT, brand doc) stored with a style guide. */
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

/** A preferred transition saved in a style guide, optionally paired with a sound effect. */
export const StyleGuideTransition = z.object({
  id: Id,
  name: z.string().trim().min(1).max(80),
  type: TransitionType,
  /** Seconds, centred on the join. */
  duration: z.number().positive().max(10).default(0.4),
  direction: TransitionDirection.default("left"),
  /** Dip colour when type === "dip". */
  color: RenderColor.optional(),
  /** Optional sound effect id: either a `StyleGuideSound.id` in this guide or `"builtin:<slug>"`. */
  soundId: z.string().trim().min(1).max(120).optional(),
  /** Editorial usage rule, e.g. "Default between sections". */
  usageRule: z.string().trim().max(240).default(""),
  isDefault: z.boolean().default(false),
});
export type StyleGuideTransition = z.infer<typeof StyleGuideTransition>;

/** A reusable sound effect in a style guide (either built-in starter SFX or an attached custom audio asset). */
export const StyleGuideSound = z.object({
  id: Id,
  name: z.string().trim().min(1).max(80),
  source: z.enum(["builtin", "asset"]),
  /** Starter SFX slug when `source === "builtin"` (e.g. "soft-whoosh"). */
  builtInId: z.string().trim().min(1).max(64).optional(),
  /** StyleGuideAsset id when `source === "asset"`. */
  assetId: Id.optional(),
  /** Default volume level in dB relative to full scale (e.g. -14 dB). */
  volumeDb: z.number().min(-48).max(6).default(-14),
  /** Duration in seconds when known. */
  duration: z.number().positive().max(120).optional(),
  /** Editorial usage rule, e.g. "Plays when lower thirds enter". */
  usageRule: z.string().trim().max(240).default(""),
});
export type StyleGuideSound = z.infer<typeof StyleGuideSound>;

/** Reusable video color adjustments matching Scarlet's `color` effect parameters. */
export const StyleGuideColorAdjustments = z.object({
  exposure: z.number().min(-3).max(3).default(0),
  contrast: z.number().min(0).max(3).default(1),
  saturation: z.number().min(0).max(3).default(1),
  warmth: z.number().min(-1).max(1).default(0),
  tint: z.number().min(-1).max(1).default(0),
  shadows: z.number().min(-1).max(1).default(0),
  highlights: z.number().min(-1).max(1).default(0),
  blacks: z.number().min(-1).max(1).default(0),
  whites: z.number().min(-1).max(1).default(0),
  gamma: z.number().min(0.1).max(10).default(1),
});
export type StyleGuideColorAdjustments = z.infer<typeof StyleGuideColorAdjustments>;

/** Saved camera color look inside a style guide (sliders and/or an attached `.cube`/`.3dl` LUT asset). */
export const StyleGuideColorLook = z.object({
  name: z.string().trim().max(80).default(""),
  notes: z.string().trim().max(500).default(""),
  /** Optional `.cube`/`.3dl` LUT asset id stored in `StyleGuideRecord.assets`. */
  lutAssetId: Id.optional(),
  lutName: z.string().trim().max(255).optional(),
  adjustments: StyleGuideColorAdjustments.default({}),
});
export type StyleGuideColorLook = z.infer<typeof StyleGuideColorLook>;

export const StyleGuideRecord = z.object({
  id: Id,
  /** Slug referenced as @name in chat or in skills. */
  name: StyleGuideSlug,
  description: z.string().default(""),
  /** Design direction, tokens, typography, and motion rules maintained by Scarlet. */
  instructions: z.string().default(""),
  /** Structured caption style defaults (font, weight, color, box, outline, position, accent) applied by captions_generate. */
  captionStyle: CaptionStyle.partial().optional(),
  /** When true, this style applies automatically to captions, graphics, transitions, sounds, and color across projects unless overridden with @name. */
  isDefault: z.boolean().default(false),
  assets: z.array(StyleGuideAsset).default([]),
  preview: StyleGuidePreview.optional(),
  /** Preferred clip transitions and optional paired sounds. */
  transitions: z.array(StyleGuideTransition).default([]),
  /** Saved sound effects (built-in starters or custom audio assets) with mix levels and usage rules. */
  sounds: z.array(StyleGuideSound).default([]),
  /** Saved reusable camera color look (adjustments and/or `.cube`/`.3dl` LUT). */
  colorLook: StyleGuideColorLook.optional(),
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
  captionStyle: CaptionStyle.partial().optional(),
  isDefault: z.boolean().optional(),
  transitions: z.array(StyleGuideTransition).max(32).optional(),
  sounds: z.array(StyleGuideSound).max(64).optional(),
  colorLook: StyleGuideColorLook.optional(),
});
export type CreateStyleGuideRequest = z.infer<typeof CreateStyleGuideRequest>;

export const UpdateStyleGuideRequest = z.object({
  name: StyleGuideSlug.optional(),
  description: z.string().max(1024).optional(),
  instructions: z.string().max(128 * 1024).optional(),
  captionStyle: CaptionStyle.partial().nullable().optional(),
  isDefault: z.boolean().optional(),
  transitions: z.array(StyleGuideTransition).max(32).optional(),
  sounds: z.array(StyleGuideSound).max(64).optional(),
  colorLook: StyleGuideColorLook.nullable().optional(),
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
  instructions: z.string().trim().min(1).max(128 * 1024).optional(),
  captionStyle: CaptionStyle.partial().optional().describe("Structured caption style matching this guide (fontFamily or attached font path, fontWeight, fontSize, color, backgroundColor, outlineColor, outlineWidth, y, align, maxWidth, uppercase, highlightColor)"),
  transitions: z.array(StyleGuideTransition).max(32).optional(),
  sounds: z.array(StyleGuideSound).max(64).optional(),
  colorLook: StyleGuideColorLook.nullable().optional(),
});
export type TaskStyleGuideDraft = z.infer<typeof TaskStyleGuideDraft>;

/** Import a built-in or style-guide sound effect into a project's media library for timeline placement. */
export const ImportStyleGuideSoundRequest = z.object({
  styleGuideId: Id.optional(),
  soundId: z.string().trim().min(1).max(120).optional(),
  builtInId: z.string().trim().min(1).max(64).optional(),
  assetId: Id.optional(),
}).refine(
  body => Boolean(body.builtInId || (body.styleGuideId && (body.soundId || body.assetId))),
  { message: "Provide builtInId, or styleGuideId with soundId or assetId." },
);
export type ImportStyleGuideSoundRequest = z.infer<typeof ImportStyleGuideSoundRequest>;

/** Active style guide resolved for a task (explicit @mention, skill @mention, or library Default). */
export const ActiveStyleGuide = z.object({
  id: Id,
  name: StyleGuideSlug,
  description: z.string(),
  instructions: z.string(),
  captionStyle: CaptionStyle.partial().optional(),
  reason: z.enum(["mentioned", "default"]),
  assets: z.array(StyleGuideAsset.extend({ path: z.string() })),
  transitions: z.array(StyleGuideTransition).optional(),
  sounds: z.array(StyleGuideSound.extend({ volumeLinear: z.number() })).optional(),
  colorLook: StyleGuideColorLook.extend({ lutFile: z.string().optional(), lutPath: z.string().optional() }).optional(),
});
export type ActiveStyleGuide = z.infer<typeof ActiveStyleGuide>;

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

/** Portable JSON definition for importing/exporting a Style Guide's full settings in one file. */
const StyleGuideDefinitionSoundInput = z.object({
  id: Id.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  source: z.enum(["builtin", "asset"]).optional(),
  builtInId: z.string().trim().min(1).max(64).optional(),
  builtin: z.string().trim().min(1).max(64).optional(),
  assetId: Id.optional(),
  volumeDb: z.number().min(-48).max(6).optional(),
  duration: z.number().positive().max(120).optional(),
  usageRule: z.string().trim().max(240).optional(),
});

const StyleGuideDefinitionTransitionInput = z.object({
  id: Id.optional(),
  name: z.string().trim().min(1).max(80),
  type: TransitionType,
  duration: z.number().positive().max(10).optional(),
  direction: TransitionDirection.optional(),
  color: RenderColor.optional(),
  soundId: z.string().trim().min(1).max(120).optional(),
  sound: z.string().trim().min(1).max(120).optional(),
  usageRule: z.string().trim().max(240).optional(),
  isDefault: z.boolean().optional(),
});

const StyleGuideDefinitionColorLookInput = z.object({
  name: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  lutAssetId: Id.optional(),
  lutName: z.string().trim().max(255).optional(),
  adjustments: StyleGuideColorAdjustments.partial().optional(),
});

const StyleGuideDefinitionSchema = z.object({
  version: z.number().int().positive().optional(),
  name: z.string().trim().max(120).optional(),
  description: z.string().max(1024).optional(),
  instructions: z.string().max(128 * 1024).optional(),
  captionStyle: CaptionStyle.partial().nullable().optional(),
  isDefault: z.boolean().optional(),
  transitions: z.array(StyleGuideDefinitionTransitionInput).max(32).optional(),
  sounds: z.array(StyleGuideDefinitionSoundInput).max(64).optional(),
  colorLook: StyleGuideDefinitionColorLookInput.nullable().optional(),
});

export interface ParsedStyleGuideDefinition {
  name?: string;
  description?: string;
  instructions?: string;
  captionStyle?: Partial<z.infer<typeof CaptionStyle>> | null;
  isDefault?: boolean;
  transitions?: StyleGuideTransition[];
  sounds?: StyleGuideSound[];
  colorLook?: StyleGuideColorLook | null;
}

const DEFINITION_SIGNAL_KEYS = ["description", "instructions", "captionStyle", "transitions", "sounds", "colorLook"] as const;

function stableId(prefix: string, seed: string, index: number, used: Set<string>): string {
  const slug = slugifyStyleGuideName(seed).replace(/-/g, "_").slice(0, 32) || String(index + 1);
  let candidate = `${prefix}_${slug}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let i = 2; i < 200; i++) {
    candidate = `${prefix}_${slug}_${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  candidate = `${prefix}_${index + 1}_${Date.now()}`;
  used.add(candidate);
  return candidate;
}

/**
 * Parse a portable JSON file defining a Style Guide's settings (graphics instructions, transitions,
 * sound effects, and camera color look). Returns `null` if the JSON is not a recognizable Style Guide
 * definition file (for example, arbitrary brand tokens JSON), so callers can fall back to sending it to Scarlet.
 */
export function parseStyleGuideDefinitionJson(
  rawText: string,
  opts: { fallbackName?: string; existingAssetIds?: ReadonlySet<string> } = {},
): ParsedStyleGuideDefinition | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!DEFINITION_SIGNAL_KEYS.some(key => key in obj)) return null;

  const parsed = StyleGuideDefinitionSchema.safeParse(obj);
  if (!parsed.success) return null;
  const data = parsed.data;
  const existingAssets = opts.existingAssetIds ?? new Set<string>();

  const slug = data.name ? slugifyStyleGuideName(data.name) : (opts.fallbackName ? slugifyStyleGuideName(opts.fallbackName) : "");
  const out: ParsedStyleGuideDefinition = {
    ...(slug ? { name: slug } : {}),
    ...(data.description !== undefined ? { description: data.description.trim() } : {}),
    ...(data.instructions !== undefined ? { instructions: data.instructions } : {}),
    ...(data.captionStyle !== undefined ? { captionStyle: data.captionStyle } : {}),
    ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
  };

  let normalizedSounds: StyleGuideSound[] | undefined;
  const soundIdByName = new Map<string, string>();
  const soundIdByBuiltIn = new Map<string, string>();
  if (data.sounds !== undefined) {
    const usedIds = new Set<string>();
    normalizedSounds = [];
    for (let i = 0; i < data.sounds.length; i++) {
      const s = data.sounds[i]!;
      const builtInSlug = s.builtInId ?? s.builtin;
      const builtIn = builtInSlug
        ? findBuiltInStyleSound(builtInSlug)
        : (s.source !== "asset" && s.name ? BUILT_IN_STYLE_SOUNDS.find(b => b.name.toLowerCase() === s.name!.toLowerCase()) : undefined);

      if (s.source === "asset" || (!builtIn && s.assetId)) {
        if (!s.assetId || !existingAssets.has(s.assetId)) continue;
        const id = s.id && !usedIds.has(s.id) ? (usedIds.add(s.id), s.id) : stableId("sfx", s.name ?? s.assetId, i, usedIds);
        const entry = StyleGuideSound.parse({
          id,
          name: s.name ?? "Custom sound",
          source: "asset",
          assetId: s.assetId,
          volumeDb: s.volumeDb ?? -14,
          ...(s.duration !== undefined ? { duration: s.duration } : {}),
          usageRule: s.usageRule ?? "",
        });
        normalizedSounds.push(entry);
        soundIdByName.set(entry.name.toLowerCase(), entry.id);
      } else if (builtIn) {
        const id = s.id && !usedIds.has(s.id) ? (usedIds.add(s.id), s.id) : stableId("sfx", builtIn.id, i, usedIds);
        const entry = StyleGuideSound.parse({
          id,
          name: s.name ?? builtIn.name,
          source: "builtin",
          builtInId: builtIn.id,
          volumeDb: s.volumeDb ?? builtIn.defaultVolumeDb,
          duration: s.duration ?? builtIn.duration,
          usageRule: s.usageRule ?? builtIn.defaultUsageRule,
        });
        normalizedSounds.push(entry);
        soundIdByName.set(entry.name.toLowerCase(), entry.id);
        soundIdByBuiltIn.set(builtIn.id, entry.id);
      }
    }
    out.sounds = normalizedSounds;
  }

  if (data.transitions !== undefined) {
    const usedIds = new Set<string>();
    let seenDefault = false;
    out.transitions = data.transitions.map((t, i) => {
      const id = t.id && !usedIds.has(t.id) ? (usedIds.add(t.id), t.id) : stableId("tr", t.name, i, usedIds);
      const rawSoundRef = t.soundId ?? t.sound;
      let resolvedSoundId: string | undefined;
      if (rawSoundRef) {
        if (normalizedSounds?.some(s => s.id === rawSoundRef)) {
          resolvedSoundId = rawSoundRef;
        } else if (soundIdByName.has(rawSoundRef.toLowerCase())) {
          resolvedSoundId = soundIdByName.get(rawSoundRef.toLowerCase());
        } else {
          const built = findBuiltInStyleSound(rawSoundRef);
          if (built) {
            resolvedSoundId = soundIdByBuiltIn.get(built.id) ?? `builtin:${built.id}`;
          } else if (rawSoundRef.startsWith("builtin:")) {
            resolvedSoundId = rawSoundRef;
          }
        }
      }
      const isDefault = Boolean(t.isDefault) && !seenDefault;
      if (isDefault) seenDefault = true;
      return StyleGuideTransition.parse({
        id,
        name: t.name,
        type: t.type,
        duration: t.duration ?? 0.4,
        direction: t.direction ?? "left",
        ...(t.color ? { color: t.color } : {}),
        ...(resolvedSoundId ? { soundId: resolvedSoundId } : {}),
        usageRule: t.usageRule ?? "",
        isDefault,
      });
    });
  }

  if (data.colorLook !== undefined) {
    if (data.colorLook === null) {
      out.colorLook = null;
    } else {
      const keepLut = Boolean(data.colorLook.lutAssetId && existingAssets.has(data.colorLook.lutAssetId));
      out.colorLook = StyleGuideColorLook.parse({
        name: data.colorLook.name ?? "",
        notes: data.colorLook.notes ?? "",
        ...(keepLut ? { lutAssetId: data.colorLook.lutAssetId, lutName: data.colorLook.lutName } : {}),
        adjustments: StyleGuideColorAdjustments.parse(data.colorLook.adjustments ?? {}),
      });
    }
  }

  return out;
}

/** Serialize a Style Guide into a clean portable JSON object containing all settings (graphics, transitions, sounds, color look). */
export function serializeStyleGuideDefinition(guide: StyleGuideRecord): Record<string, unknown> {
  return {
    version: 1,
    name: guide.name,
    description: guide.description,
    instructions: guide.instructions,
    ...(guide.captionStyle && Object.keys(guide.captionStyle).length ? { captionStyle: guide.captionStyle } : {}),
    transitions: guide.transitions.map(t => ({
      id: t.id,
      name: t.name,
      type: t.type,
      duration: t.duration,
      direction: t.direction,
      ...(t.color ? { color: t.color } : {}),
      ...(t.soundId ? { soundId: t.soundId } : {}),
      usageRule: t.usageRule,
      isDefault: t.isDefault,
    })),
    sounds: guide.sounds.map(s => ({
      id: s.id,
      name: s.name,
      source: s.source,
      ...(s.builtInId ? { builtInId: s.builtInId } : {}),
      ...(s.assetId ? { assetId: s.assetId } : {}),
      volumeDb: s.volumeDb,
      ...(s.duration !== undefined ? { duration: s.duration } : {}),
      usageRule: s.usageRule,
    })),
    ...(guide.colorLook
      ? {
          colorLook: {
            name: guide.colorLook.name,
            notes: guide.colorLook.notes,
            ...(guide.colorLook.lutName ? { lutName: guide.colorLook.lutName } : {}),
            adjustments: guide.colorLook.adjustments,
          },
        }
      : {}),
  };
}
