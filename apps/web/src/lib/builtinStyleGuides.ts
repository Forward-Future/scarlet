import type { StyleGuideColorLook, StyleGuideSound, StyleGuideTransition } from "@scarlet/shared";
import type { CaptionStyle } from "@scarlet/timeline";

export type BuiltinStyleVariant = "clean" | "editorial" | "tech" | "bold";

export interface BuiltinStyleGuide {
  /** Slug used when adding this starter to the editor's library (referenced as @name). */
  name: string;
  /** Short plain-English title shown on the starter card. */
  label: string;
  /** Distinct layout & visual language rendered by StyleSpecimen. */
  variant: BuiltinStyleVariant;
  /** Which visual area this starter is tailored around, while still covering the full set. */
  focus: "Captions" | "Lower thirds" | "Callout boxes" | "Graphics";
  /** One-line summary saved on the style guide. */
  description: string;
  /** Full written rules covering captions, lower thirds, callout boxes, and graphics. */
  instructions: string;
  /** Structured caption defaults applied automatically by captions_generate. */
  captionStyle: Partial<CaptionStyle>;
  /** Preferred clip transitions seeded when adding this starter. */
  transitions: StyleGuideTransition[];
  /** Built-in sound effects seeded when adding this starter. */
  sounds: StyleGuideSound[];
  /** Camera color look seeded when adding this starter. */
  colorLook: StyleGuideColorLook;
}

/**
 * Curated built-in starter style guides, each with its own visual world:
 * typography, surface polarity, geometry, caption style, transitions, SFX, and camera look.
 */
export const BUILTIN_STYLE_GUIDES: readonly BuiltinStyleGuide[] = [
  {
    name: "clean-captions",
    label: "Clean captions",
    variant: "clean",
    focus: "Captions",
    description: "Frosted pill captions, borderless lower thirds, and quiet fades.",
    instructions: [
      "## Visual World & Palette",
      "- Minimalist frosted glass over soft dark footage: pure white ink (#FFFFFF), cool mist secondary ink (#B8C0CC), frosted charcoal pill (#0B0C0ED9), whisper hairline border rgba(255,255,255,0.14).",
      "- No bright neon colors or heavy boxes; keep surfaces airy, rounded (full pill or 14px radius), and calm.",
      "",
      "## Typography",
      "- Clean humanist sans-serif: Inter SemiBold (600) for captions and names, Inter Regular (400) for roles and small labels.",
      "- Sentence case throughout with generous breathing room.",
      "",
      "## Captions",
      "- Centered at y = 0.86, maxWidth = 0.78, sentence case, Inter SemiBold (#FFFFFF) inside a soft dark frosted pill (#0B0C0ED9) with zero outline.",
      "- Active words get subtle bright-white weight emphasis rather than loud color flashes.",
      "",
      "## Lower thirds",
      "- Borderless, unboxed typography anchored bottom-left: crisp white speaker name above a short 18px hairline dash and muted gray role underneath. No backing box or vertical stripe.",
      "",
      "## Callout boxes & Graphics",
      "- Compact frosted pill badges (999px radius) with a single tiny dot and concise metric or chapter label.",
      "- Subtle 220ms opacity + 6px rise ease-out; zero bounce.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Inter",
      fontWeight: "semibold",
      fontSize: 0.048,
      color: "#FFFFFF",
      backgroundColor: "#0B0C0ED9",
      outlineWidth: 0,
      y: 0.86,
      align: "center",
      maxWidth: 0.78,
      uppercase: false,
    },
    transitions: [
      {
        id: "tr_clean_dissolve",
        name: "Clean dissolve",
        type: "dissolve",
        duration: 0.35,
        direction: "left",
        usageRule: "Default gentle crossfade between sections",
        isDefault: true,
      },
    ],
    sounds: [
      {
        id: "sfx_clean_slide",
        name: "Airy slide",
        source: "builtin",
        builtInId: "airy-slide",
        volumeDb: -18,
        duration: 0.38,
        usageRule: "Whisper-quiet accent when a minimal pill callout enters",
      },
    ],
    colorLook: {
      name: "Neutral Studio",
      notes: "Clean natural daylight balance with gentle shadow lift and soft highlight rolloff.",
      adjustments: {
        exposure: 0.05,
        contrast: 1.04,
        saturation: 1.02,
        warmth: 0,
        tint: 0,
        shadows: 0.08,
        highlights: -0.1,
        blacks: 0,
        whites: 0,
        gamma: 1,
      },
    },
  },
  {
    name: "editorial-lower-thirds",
    label: "Editorial lower thirds",
    variant: "editorial",
    focus: "Lower thirds",
    description: "Warm cream paper plaques, Georgia serif titles, and film dips.",
    instructions: [
      "## Visual World & Palette",
      "- Archival print magazine & documentary aesthetic: warm ivory paper (#F4EFE6), deep espresso ink (#1C1815), muted terracotta accent (#B84A2E), warm stone rules rgba(28,24,20,0.22).",
      "- Strictly sharp 0px corners everywhere — never rounded pills. Structure layouts with fine 1px hairline rules and generous margins.",
      "",
      "## Typography",
      "- Display chapter titles, pull quotes, and speaker names: Georgia Serif (mix roman with italic emphasis).",
      "- Eyebrows, part numbers, and roles: wide-tracked uppercase sans (0.14em letter-spacing, small size).",
      "",
      "## Lower thirds",
      "- Warm ivory/parchment rectangular plaque anchored bottom-left with a crisp 2px espresso top rule and 1px bottom hairline (0px corner radius).",
      "- Small tracked terracotta eyebrow (INTERVIEW / SPEAKER), Georgia Serif speaker name in dark espresso, and tracked uppercase role below.",
      "",
      "## Captions",
      "- Centered low at y = 0.89, maxWidth = 0.72, Georgia Regular (#F7F3EA) on a slim warm espresso band (#1C1815CC) with muted terracotta active-word highlight (#D96A47).",
      "",
      "## Callout boxes & Graphics",
      "- Full-bleed or margin-framed cream paper chapter cards divided by crisp horizontal and vertical hairlines; pull-stats sit beside vertical rules with no card chrome.",
      "- Unhurried 300ms editorial fade-and-reveal motion; never snappy or bouncy.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Georgia",
      fontWeight: "normal",
      fontSize: 0.044,
      color: "#F7F3EA",
      backgroundColor: "#1C1815CC",
      outlineWidth: 0,
      highlightColor: "#D96A47",
      y: 0.89,
      align: "center",
      maxWidth: 0.72,
      uppercase: false,
    },
    transitions: [
      {
        id: "tr_editorial_dip",
        name: "Film dip",
        type: "dip",
        duration: 0.55,
        direction: "left",
        color: "#12100E",
        usageRule: "Default transition between documentary acts and chapter cards",
        isDefault: true,
      },
      {
        id: "tr_editorial_dissolve",
        name: "Soft dissolve",
        type: "dissolve",
        duration: 0.6,
        direction: "left",
        usageRule: "Gentle passage of time or over archival stills",
        isDefault: false,
      },
    ],
    sounds: [
      {
        id: "sfx_editorial_chime",
        name: "Clean chime",
        source: "builtin",
        builtInId: "clean-chime",
        volumeDb: -18,
        duration: 0.55,
        usageRule: "Quiet tonal cue when a documentary chapter title enters",
      },
    ],
    colorLook: {
      name: "Warm Editorial Film",
      notes: "Warm skin tones, gently lifted matte blacks, restrained saturation, and soft highlights.",
      adjustments: {
        exposure: 0.05,
        contrast: 1.08,
        saturation: 0.94,
        warmth: 0.22,
        tint: 0.02,
        shadows: 0.1,
        highlights: -0.18,
        blacks: 0.14,
        whites: -0.04,
        gamma: 1,
      },
    },
  },
  {
    name: "tech-callouts",
    label: "Tech callout boxes",
    variant: "tech",
    focus: "Callout boxes",
    description: "Blueprint HUD callouts, corner brackets, and monospace captions.",
    instructions: [
      "## Visual World & Palette",
      "- Precision engineering HUD & blueprint diagram aesthetic: deep navy backdrop (#060F1C) with faint 1px cyan coordinate gridlines rgba(56,189,248,0.08), electric cyan telemetry (#22D3EE), mint status green (#34D399), crisp ice-white text (#E2F4FF).",
      "- Sharp 2px corners framed by L-shaped viewfinder corner brackets, thin 1px scanlines, and tabular numeric readouts.",
      "",
      "## Typography",
      "- Monospace-first throughout: Menlo / SF Mono / JetBrains Mono with tabular numerals, bracketed section indices ([01]), terminal prompts (>), and uppercase spec labels.",
      "",
      "## Callout boxes",
      "- Sharp corner-bracketed HUD panels connected to the subject with a crisp 1px leader line and targeting crosshair dot.",
      "- Include a compact header bar, oversized tabular metric readout, and optional segmented progress bar or delta pill.",
      "",
      "## Captions",
      "- Left-aligned at y = 0.88, maxWidth = 0.84, Menlo Bold (#E2F4FF) inside a sharp dark navy terminal strip (#071322E6) with bright cyan active-word highlight (#22D3EE).",
      "",
      "## Lower thirds & Graphics",
      "- Single-row inline terminal badge anchored bottom-left with a live green dot, monospace handle, and `//` separator before the role.",
      "- Fast, crisp 160ms linear/ease-out snap entrances paired with subtle mechanical ticks.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Menlo",
      fontWeight: "bold",
      fontSize: 0.042,
      color: "#E2F4FF",
      backgroundColor: "#071322E6",
      outlineWidth: 0,
      highlightColor: "#22D3EE",
      y: 0.88,
      align: "left",
      maxWidth: 0.84,
      uppercase: false,
    },
    transitions: [
      {
        id: "tr_tech_slide",
        name: "Crisp slide",
        type: "slide",
        duration: 0.28,
        direction: "left",
        soundId: "sfx_tech_tick",
        usageRule: "Default snap between screen demos and spec overlays",
        isDefault: true,
      },
      {
        id: "tr_tech_push",
        name: "Vertical push",
        type: "push",
        duration: 0.3,
        direction: "up",
        soundId: "sfx_tech_pop",
        usageRule: "Stepping into a new technical walkthrough section",
        isDefault: false,
      },
    ],
    sounds: [
      {
        id: "sfx_tech_tick",
        name: "Crisp tick",
        source: "builtin",
        builtInId: "crisp-tick",
        volumeDb: -14,
        duration: 0.09,
        usageRule: "When a HUD callout, metric readout, or slide locks into place",
      },
      {
        id: "sfx_tech_pop",
        name: "Subtle pop",
        source: "builtin",
        builtInId: "subtle-pop",
        volumeDb: -14,
        duration: 0.18,
        usageRule: "When a target annotation or badge appears",
      },
    ],
    colorLook: {
      name: "Cool Precision",
      notes: "Crisp cool-neutral studio grade with taut contrast and clean technical whites.",
      adjustments: {
        exposure: 0,
        contrast: 1.1,
        saturation: 0.96,
        warmth: -0.14,
        tint: -0.03,
        shadows: 0,
        highlights: -0.06,
        blacks: -0.05,
        whites: 0.08,
        gamma: 1,
      },
    },
  },
  {
    name: "bold-creator",
    label: "Bold creator graphics",
    variant: "bold",
    focus: "Graphics",
    description: "Oversized poster titles, tilted yellow stickers, and heavy pop captions.",
    instructions: [
      "## Visual World & Palette",
      "- High-impact brutalist poster & modern creator energy: solid electric yellow (#FACC15), hot vermilion (#FF4D2E), chalk white (#FFFFFF), and pure jet black (#000000) ink & strokes over deep charcoal (#121215).",
      "- Zero glassmorphism or soft blurs: use opaque solid color blocks, thick 2px solid black outlines, hard unblurred offset drop shadows (4px 4px 0 #000), and playful 2–3° sticker tilts.",
      "",
      "## Typography",
      "- Ultra-heavy display sans: Arial Black / Impact / Avenir Next Condensed Black (900 weight), tight -0.04em tracking, ALL CAPS for headlines, stickers, and captions.",
      "",
      "## Graphics & Chapter Titles",
      "- Oversized stacked chapter stamps combining a bright vermilion episode tag over massive outlined white display type with a hard black offset shadow.",
      "- Tilted electric-yellow sticker callouts with bold black stats and thick borders.",
      "",
      "## Captions",
      "- Centered high at y = 0.78, maxWidth = 0.86, ALL CAPS, large Arial Black (0.062) in pure white (#FFFFFF) with a thick 5px black outline (#000000), no box backdrop, and electric yellow (#FACC15) active-word pop.",
      "",
      "## Lower thirds",
      "- Two-tone stacked tape strips: solid white name block stamped tightly above a solid vermilion role tag with hard black borders and offset shadow.",
      "- Fast 150ms punchy snap entrances with whip transitions and whoosh/pop SFX.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Arial Black",
      fontWeight: "black",
      fontSize: 0.062,
      color: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 5,
      highlightColor: "#FACC15",
      y: 0.78,
      align: "center",
      maxWidth: 0.86,
      uppercase: true,
    },
    transitions: [
      {
        id: "tr_bold_whip",
        name: "Punch whip",
        type: "whip",
        duration: 0.25,
        direction: "left",
        soundId: "sfx_bold_whoosh",
        usageRule: "Default high-energy transition on topic jumps and scene switches",
        isDefault: true,
      },
    ],
    sounds: [
      {
        id: "sfx_bold_whoosh",
        name: "Soft whoosh",
        source: "builtin",
        builtInId: "soft-whoosh",
        volumeDb: -12,
        duration: 0.45,
        usageRule: "Paired with whip transitions and fast full-frame title sweeps",
      },
      {
        id: "sfx_bold_pop",
        name: "Subtle pop",
        source: "builtin",
        builtInId: "subtle-pop",
        volumeDb: -11,
        duration: 0.18,
        usageRule: "Punchy pop when tilted stat stickers or key badges land",
      },
      {
        id: "sfx_bold_riser",
        name: "Subtle riser",
        source: "builtin",
        builtInId: "subtle-riser",
        volumeDb: -15,
        duration: 0.85,
        usageRule: "Building momentum into big chapter reveal cards",
      },
    ],
    colorLook: {
      name: "Punchy Creator",
      notes: "Vibrant, high-contrast camera look with rich saturation and crisp dark shadows.",
      adjustments: {
        exposure: 0.08,
        contrast: 1.16,
        saturation: 1.18,
        warmth: 0.06,
        tint: 0,
        shadows: 0.06,
        highlights: -0.04,
        blacks: -0.08,
        whites: 0.1,
        gamma: 1,
      },
    },
  },
];

export function builtinStyleGuideByName(name: string): BuiltinStyleGuide | undefined {
  const slug = name.toLowerCase();
  return BUILTIN_STYLE_GUIDES.find(g => g.name === slug);
}
