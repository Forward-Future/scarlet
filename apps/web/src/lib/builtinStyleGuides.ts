import type { CaptionStyle } from "@scarlet/timeline";

export interface BuiltinStyleGuide {
  /** Slug used when adding this starter to the editor's library (referenced as @name). */
  name: string;
  /** Short plain-English title shown on the starter card. */
  label: string;
  /** Which visual area this starter is tailored around, while still covering the full set. */
  focus: "Captions" | "Lower thirds" | "Callout boxes" | "Graphics";
  /** One-line summary saved on the style guide. */
  description: string;
  /** Full written rules covering captions, lower thirds, callout boxes, and graphics. */
  instructions: string;
  /** Structured caption defaults applied automatically by captions_generate. */
  captionStyle: Partial<CaptionStyle>;
  /** Visual tokens for the miniature 16:9 specimen rendered on the Style guides page. */
  specimen: {
    canvas: string;
    surface: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    captionBg: string;
    captionText: string;
    captionHighlight?: string;
    captionUppercase?: boolean;
    titleFont?: "sans" | "serif" | "mono";
  };
}

/**
 * Curated built-in starter style guides covering captions, lower thirds, callout boxes, and graphics.
 * Adding one creates a normal editable style guide in the editor's library (with structured captionStyle).
 */
export const BUILTIN_STYLE_GUIDES: readonly BuiltinStyleGuide[] = [
  {
    name: "clean-captions",
    label: "Clean captions",
    focus: "Captions",
    description: "Crisp white captions in a soft dark pill with matching minimalist lower thirds and callouts.",
    instructions: [
      "## Palette & Typography",
      "- Primary ink: #FFFFFF, secondary ink: #CBD5E1, dark backdrop pill: #0B0C0ECC, subtle accent: #F5F5F5.",
      "- Font family: Inter (SemiBold 600 for captions and titles, Regular 400 for subtitles).",
      "",
      "## Captions",
      "- Centered at y = 0.86, maxWidth = 0.78, sentence case (not uppercase), fontWeight = semibold.",
      "- Pure white text (#FFFFFF) inside a soft dark semi-transparent pill (#0B0C0ECC) with clean breathing room and no harsh outline.",
      "",
      "## Lower thirds",
      "- Bottom-left anchor with a thin 2px crisp white left rule, dark frosted plate (#0B0C0ED9), name in 600 weight and role in muted #CBD5E1.",
      "",
      "## Callout boxes & Graphics",
      "- Clean dark translucent cards (#0B0C0EE6) with 1px rgba(255,255,255,0.14) hairline border and 12px radius.",
      "- Subtle fade + 8px vertical ease-out entrance (220ms); keep motion restrained and legible.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Inter",
      fontWeight: "semibold",
      fontSize: 0.048,
      color: "#FFFFFF",
      backgroundColor: "#0B0C0ECC",
      outlineWidth: 0,
      y: 0.86,
      align: "center",
      maxWidth: 0.78,
      uppercase: false,
    },
    specimen: {
      canvas: "#111214",
      surface: "rgba(255,255,255,0.06)",
      border: "rgba(255,255,255,0.14)",
      text: "#FFFFFF",
      muted: "#A1A1AA",
      accent: "#F4F4F5",
      captionBg: "rgba(11,12,14,0.88)",
      captionText: "#FFFFFF",
      titleFont: "sans",
    },
  },
  {
    name: "editorial-lower-thirds",
    label: "Editorial lower thirds",
    focus: "Lower thirds",
    description: "Warm ivory & terracotta lower thirds, documentary titles, framed callouts, and calm captions.",
    instructions: [
      "## Palette & Typography",
      "- Warm ivory ink: #F7F4EE, espresso card: #1C1917E6, terracotta accent: #E06D4B, muted stone: #C7BFB3.",
      "- Display titles & speaker names: Georgia / editorial serif; body, subtitles & captions: Inter Medium.",
      "",
      "## Lower thirds",
      "- Editorial magazine bar anchored bottom-left: 3px terracotta (#E06D4B) vertical accent bar beside a warm dark plate (#1C1917E6).",
      "- Speaker name in warm ivory (#F7F4EE) serif; title/affiliation in uppercase tracked small caps (#C7BFB3).",
      "",
      "## Captions",
      "- Centered at y = 0.86, maxWidth = 0.76, Inter Medium (#F7F4EE) over a warm charcoal band (#1C1917D9), terracotta accent highlight (#E06D4B) when highlighting active words.",
      "",
      "## Callout boxes & Graphics",
      "- Warm dark panels with thin warm-gray rules, generous padding, and a small uppercase eyebrow label in terracotta.",
      "- Smooth editorial slide-and-fade entrance (280ms ease-out); never bouncy.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Inter",
      fontWeight: "medium",
      fontSize: 0.047,
      color: "#F7F4EE",
      backgroundColor: "#1C1917D9",
      outlineWidth: 0,
      highlightColor: "#E06D4B",
      y: 0.86,
      align: "center",
      maxWidth: 0.76,
      uppercase: false,
    },
    specimen: {
      canvas: "#171412",
      surface: "rgba(28,25,23,0.92)",
      border: "rgba(247,244,238,0.16)",
      text: "#F7F4EE",
      muted: "#C7BFB3",
      accent: "#E06D4B",
      captionBg: "rgba(28,25,23,0.9)",
      captionText: "#F7F4EE",
      captionHighlight: "#E06D4B",
      titleFont: "serif",
    },
  },
  {
    name: "tech-callouts",
    label: "Tech callout boxes",
    focus: "Callout boxes",
    description: "Structured slate callout boxes with sky-blue accents, monospace tags, crisp lower thirds, and captions.",
    instructions: [
      "## Palette & Typography",
      "- Deep slate surface: #0F172AE8, crisp border: #334155, text: #F1F5F9, muted label: #94A3B8, accent: #38BDF8.",
      "- UI sans (Inter SemiBold) paired with monospace tags (SF Mono / Menlo / JetBrains Mono) for badges, keys, and numbers.",
      "",
      "## Callout boxes",
      "- Rounded 10px dark slate card (#0F172AE8) with a 1px #334155 border and subtle top or left sky-blue (#38BDF8) indicator.",
      "- Monospace uppercase eyebrow tag above a bold metric or takeaway line; crisp 16–20px inner padding.",
      "",
      "## Captions",
      "- Centered at y = 0.87, maxWidth = 0.8, Inter SemiBold (#F1F5F9) on #0F172AE0 box with #38BDF8 active-word highlight.",
      "",
      "## Lower thirds & Graphics",
      "- Compact slate pill in the lower-left with a monospace role tag and clean sky-blue dot indicator.",
      "- Fast, precise ease-out motion (180ms); zero clutter.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Inter",
      fontWeight: "semibold",
      fontSize: 0.046,
      color: "#F1F5F9",
      backgroundColor: "#0F172AE0",
      outlineWidth: 0,
      highlightColor: "#38BDF8",
      y: 0.87,
      align: "center",
      maxWidth: 0.8,
      uppercase: false,
    },
    specimen: {
      canvas: "#0B1120",
      surface: "rgba(15,23,42,0.92)",
      border: "rgba(56,189,248,0.3)",
      text: "#F1F5F9",
      muted: "#94A3B8",
      accent: "#38BDF8",
      captionBg: "rgba(15,23,42,0.9)",
      captionText: "#F1F5F9",
      captionHighlight: "#38BDF8",
      titleFont: "mono",
    },
  },
  {
    name: "bold-creator",
    label: "Bold creator graphics",
    focus: "Graphics",
    description: "High-impact chapter graphics, punchy uppercase captions with amber highlight, and crisp dark callouts.",
    instructions: [
      "## Palette & Typography",
      "- Pure black canvas/outline: #000000, pure white ink: #FFFFFF, charcoal card: #141416F0, energetic amber accent: #F59E0B.",
      "- Heavy geometric sans (Inter Black 900 for headlines & captions, Inter Bold 700 for callouts and lower thirds).",
      "",
      "## Graphics & Chapter Titles",
      "- Bold full-frame or corner chapter titles with tight tracking, strong contrast, and an amber accent underline or pill tag.",
      "- Energetic, snappy entrance (160ms cubic-bezier ease-out) with crisp exits.",
      "",
      "## Captions",
      "- Centered at y = 0.82, maxWidth = 0.82, uppercase, Inter Black (#FFFFFF) with crisp 4px black outline (#000000) and amber active-word highlight (#F59E0B).",
      "",
      "## Lower thirds & Callout boxes",
      "- High-contrast charcoal badge (#141416F0) with bold white headline and amber accent stripe for names, key stats, and takeaways.",
    ].join("\n"),
    captionStyle: {
      fontFamily: "Inter",
      fontWeight: "black",
      fontSize: 0.056,
      color: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 4,
      highlightColor: "#F59E0B",
      y: 0.82,
      align: "center",
      maxWidth: 0.82,
      uppercase: true,
    },
    specimen: {
      canvas: "#0E0E10",
      surface: "rgba(24,24,27,0.95)",
      border: "rgba(245,158,11,0.35)",
      text: "#FFFFFF",
      muted: "#A1A1AA",
      accent: "#F59E0B",
      captionBg: "transparent",
      captionText: "#FFFFFF",
      captionHighlight: "#F59E0B",
      captionUppercase: true,
      titleFont: "sans",
    },
  },
];

export function builtinStyleGuideByName(name: string): BuiltinStyleGuide | undefined {
  const slug = name.toLowerCase();
  return BUILTIN_STYLE_GUIDES.find(g => g.name === slug);
}
