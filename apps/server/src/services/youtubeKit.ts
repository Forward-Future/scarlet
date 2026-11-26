/**
 * Publishing Kit drafting for YouTube:
 * - Accurate final-cut chapter timestamps computed against the edited timeline clock
 *   (accounting for cuts, trims, rearrangements, and clip speeds — never raw source timestamps).
 * - Title, title options, description (with chapters), and tags: fast AI draft when an API key
 *   is configured, plus an instant deterministic fallback so it always works cleanly offline.
 * - 3–4 sharp, visually distinct candidate thumbnails extracted from the final timeline using
 *   `@scarlet/render`, avoiding near-black, blown-out, blank, or blurry frames, plus on-demand
 *   playhead capture and custom image upload (normalized to YouTube's <= 2 MiB requirement).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  extractFrame,
  fileInDirectory,
  fileInDirectoryAsync,
  renderTimelineFrame,
  resolveFfmpeg,
  timelinePreviewDecoder,
} from "@scarlet/render";
import {
  normalizeTranscriptToken,
  type YouTubeChapter,
  type YouTubePublishingKit,
  type YouTubeThumbnailCandidate,
} from "@scarlet/shared";
import {
  clipDuration,
  timelineDuration,
  type MediaClip,
  type Project,
  type Timeline,
  type Transcript,
} from "@scarlet/timeline";
import { z } from "zod/v3";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { pictureDecoder, pictureLane } from "./pictureWork.js";
import { previewPictures } from "./previewPictures.js";

export const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB YouTube limit
const AI_DRAFT_TIMEOUT_MS = 8_000;

const DIRECT_DEFAULT_MODEL = {
  anthropic: "claude-haiku-4-5",
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
} as const;

export interface FinalTimelineWord {
  mediaId: string;
  text: string;
  /** Final edited timeline clock seconds. */
  start: number;
  end: number;
  /** Original source seconds (used only to detect editorial jumps between clips). */
  sourceStart: number;
  sourceEnd: number;
  speaker?: string;
}

export interface FrameQualityScore {
  mean: number;
  std: number;
  sharpness: number;
  quality: number;
  isDarkOrBlank: boolean;
  /** 16×9 luma fingerprint (0..255) for visual distinctness comparison. */
  fingerprint: Uint8Array;
}

// ---------------------------------------------------------------------------
// Final-cut timeline timestamp & chapter calculation
// ---------------------------------------------------------------------------

/** Format a final-cut timeline time in YouTube chapter notation (`0:00`, `2:15`, `1:04:12`). */
export function formatYouTubeTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Collect spoken words played by `timeline` in playback order, mapped strictly onto the
 * final edited timeline clock (skipping cut footage and respecting clip trims & speed).
 */
export function collectFinalTimelineWords(
  timeline: Timeline,
  transcripts: Map<string, Transcript>,
): FinalTimelineWord[] {
  if (!transcripts.size) return [];
  const audioClips: MediaClip[] = [];
  const videoClips: MediaClip[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || !clip.enabled || !transcripts.has(clip.mediaId)) continue;
      if (track.kind === "audio" && clip.volume > 0) audioClips.push(clip);
      else if (track.kind === "video") videoClips.push(clip);
    }
  }
  const sourceClips = audioClips.length ? audioClips : videoClips;
  sourceClips.sort((a, b) => a.timelineIn - b.timelineIn);

  const out: FinalTimelineWord[] = [];
  for (const clip of sourceClips) {
    const tr = transcripts.get(clip.mediaId);
    if (!tr) continue;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const clipLen = clipDuration(clip);
    for (const seg of tr.segments) {
      const words = seg.words && seg.words.length > 0
        ? seg.words
        : segmentToPseudoWords(seg.text, seg.start, seg.end, seg.speaker);
      for (const w of words) {
        const text = w.text.trim();
        if (!text) continue;
        const mid = (w.start + w.end) / 2;
        if (mid < clip.sourceIn - 1e-4 || mid > clip.sourceOut + 1e-4) continue;
        const relStart = Math.max(0, w.start - clip.sourceIn) / speed;
        const relEnd = Math.min(clip.sourceOut - clip.sourceIn, Math.max(w.start, w.end) - clip.sourceIn) / speed;
        const start = round3(clip.timelineIn + Math.min(clipLen, relStart));
        const end = round3(clip.timelineIn + Math.min(clipLen, Math.max(relStart, relEnd)));
        out.push({
          mediaId: clip.mediaId,
          text,
          start,
          end,
          sourceStart: w.start,
          sourceEnd: w.end,
          ...(w.speaker && { speaker: w.speaker }),
        });
      }
    }
  }

  out.sort((a, b) => a.start - b.start);
  // Deduplicate simultaneous words from multi-track / dual-mic recordings.
  return out.filter((w, i) => !out.slice(Math.max(0, i - 3), i).some(
    p => Math.abs(p.start - w.start) < 0.03 && normalizeTranscriptToken(p.text) === normalizeTranscriptToken(w.text),
  ));
}

function segmentToPseudoWords(
  text: string,
  start: number,
  end: number,
  speaker?: string,
): Array<{ text: string; start: number; end: number; speaker?: string }> {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const span = Math.max(0.1, end - start);
  const step = span / tokens.length;
  return tokens.map((token, i) => ({
    text: token,
    start: start + i * step,
    end: start + (i + 1) * step,
    ...(speaker && { speaker }),
  }));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const LEADING_FILLERS = new Set([
  "um", "uh", "uhm", "ah", "er", "so", "well", "okay", "ok", "right", "now", "alright",
  "yeah", "yes", "and", "but", "like", "basically", "actually", "hey", "hi", "hello",
]);

const STOPWORDS = new Set([
  ...LEADING_FILLERS,
  "the", "a", "an", "to", "of", "in", "on", "for", "with", "at", "by", "from", "up", "about",
  "into", "over", "after", "this", "that", "these", "those", "it", "its", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "can", "may", "might", "i", "we", "you", "they", "he", "she", "my", "our",
  "your", "their", "me", "us", "him", "her", "them", "what", "which", "who", "when", "where",
  "why", "how", "all", "just", "very", "here", "there", "then", "than", "also", "more", "some",
  "any", "not", "no", "or", "if", "as", "out", "get", "got", "make", "go", "going", "let", "lets",
  "let's", "we're", "you're", "it's", "that's", "i'm", "don't", "can't", "won't", "really",
  "thing", "things", "something", "look", "see", "want", "need", "know", "think", "first",
  "next", "finally", "second", "third", "quick", "today", "video",
]);

function cleanChapterTitle(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-–—•*\d.:)\s]+/, "")
    .replace(/["'“”`]+/g, "")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 68 ? `${cleaned.slice(0, 67).trimEnd()}…` : cleaned;
}

function titleFromWords(words: FinalTimelineWord[], fallback: string): string {
  if (!words.length) return fallback;
  // Take the first sentence (up to ~12 words), drop leading fillers, keep up to 6 meaningful words.
  const firstSentence: string[] = [];
  for (const w of words.slice(0, 14)) {
    firstSentence.push(w.text);
    if (/[.?!]["”’)]*$/.test(w.text) && firstSentence.length >= 3) break;
  }
  const stripped = firstSentence.map(w => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9'-]+$/g, "")).filter(Boolean);
  let startIdx = 0;
  while (startIdx < stripped.length - 2 && LEADING_FILLERS.has(stripped[startIdx]!.toLowerCase())) {
    startIdx++;
  }
  const picked = stripped.slice(startIdx, startIdx + 6);
  if (!picked.length) return fallback;
  const phrase = picked.join(" ");
  return cleanChapterTitle(phrase.charAt(0).toUpperCase() + phrase.slice(1), fallback);
}

/**
 * Enforce YouTube chapter rules:
 * - Starts at `0:00`
 * - Strictly ascending whole-second timestamps within `[0, duration)`
 * - Respects minimum chapter spacing (`minSpacingSeconds`) so YouTube accepts them
 */
export function normalizeYouTubeChapters(
  raw: Array<{ time: number; title: string }>,
  duration: number,
  opts: { minSpacingSeconds?: number } = {},
): YouTubeChapter[] {
  const maxSecond = Math.max(0, Math.floor(Math.max(0, duration) - 0.5));
  const minSpacing = opts.minSpacingSeconds ?? (duration >= 35 ? 10 : duration >= 15 ? 5 : 2);
  const sorted = [...raw]
    .filter(c => Number.isFinite(c.time) && c.time >= 0)
    .map(c => ({
      sec: Math.min(maxSecond, Math.max(0, Math.floor(c.time + 1e-6))),
      title: cleanChapterTitle(c.title, "Section"),
    }))
    .sort((a, b) => a.sec - b.sec);

  const out: Array<{ sec: number; title: string }> = [];
  if (!sorted.length) {
    out.push({ sec: 0, title: "Intro" });
  } else {
    // YouTube requires the first chapter to start at 0:00.
    if (sorted[0]!.sec <= 4) {
      out.push({ sec: 0, title: sorted[0]!.title });
    } else {
      out.push({ sec: 0, title: "Intro" });
      if (sorted[0]!.sec >= minSpacing) out.push(sorted[0]!);
    }
    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i]!;
      const prev = out[out.length - 1]!;
      if (item.sec <= prev.sec) continue;
      if (item.sec - prev.sec < minSpacing) continue;
      if (duration - item.sec < Math.min(3, minSpacing / 2)) continue;
      out.push(item);
    }
  }

  return out.map(item => ({
    time: item.sec,
    timestamp: formatYouTubeTimestamp(item.sec),
    title: item.title,
  }));
}

/**
 * Build final-cut chapters from explicit `chapter` markers on the timeline (highest priority),
 * or from playback-order edited transcript words, or from video clip switches.
 */
export function buildFinalCutChapters(
  timeline: Timeline,
  words: FinalTimelineWord[],
  duration: number,
): YouTubeChapter[] {
  // 1. Explicit chapter markers on the edited timeline already sit on the final clock.
  const chapterMarkers = timeline.markers
    .filter(m => m.kind === "chapter" && m.text.trim().length > 0 && m.time >= 0 && m.time <= duration + 1e-3)
    .sort((a, b) => a.time - b.time);

  if (chapterMarkers.length > 0) {
    return normalizeYouTubeChapters(
      chapterMarkers.map(m => ({ time: m.time, title: m.text.trim() })),
      duration,
      { minSpacingSeconds: 1 },
    );
  }

  if (duration < 12) {
    return [{ time: 0, timestamp: "0:00", title: words.length ? titleFromWords(words, "Intro") : "Intro" }];
  }

  // 2. Segment playback-order transcript words on the final edited clock.
  if (words.length >= 6) {
    const targetCount = duration < 30 ? 3 : duration < 120 ? 4 : duration < 420 ? 5 : duration < 900 ? 6 : 8;
    const minSpacing = duration >= 35 ? 10 : Math.max(5, Math.floor(duration / (targetCount + 1)));

    // Candidate split points: sentence starts, editorial source jumps, or speaker transitions.
    const candidates: Array<{ idx: number; time: number; priority: number }> = [];
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1]!;
      const cur = words[i]!;
      const timelineGap = cur.start - prev.end;
      const sourceJump = prev.mediaId !== cur.mediaId || Math.abs(cur.sourceStart - prev.sourceEnd) > 1.2;
      const sentenceEnd = /[.?!]["”’)]*$/.test(prev.text);
      const speakerSwitch = !!prev.speaker && !!cur.speaker && prev.speaker !== cur.speaker && timelineGap >= 0.25;
      if (sourceJump || speakerSwitch || sentenceEnd || timelineGap >= 0.8) {
        const priority = (sourceJump ? 3 : 0) + (speakerSwitch ? 2 : 0) + (sentenceEnd ? 2 : 0) + (timelineGap >= 0.8 ? 1 : 0);
        candidates.push({ idx: i, time: cur.start, priority });
      }
    }

    const rawChapters: Array<{ time: number; title: string }> = [
      { time: 0, title: titleFromWords(words.slice(0, 12), "Intro") },
    ];
    let lastTime = 0;
    for (let slot = 1; slot < targetCount; slot++) {
      const ideal = (duration * slot) / targetCount;
      const windowHalf = (duration / targetCount) * 0.42;
      const eligible = candidates.filter(
        c => c.time >= lastTime + minSpacing && c.time <= duration - Math.max(4, minSpacing * 0.6) && Math.abs(c.time - ideal) <= windowHalf,
      );
      let chosen: { idx: number; time: number } | undefined;
      if (eligible.length) {
        eligible.sort((a, b) => {
          const scoreA = a.priority * 3 - Math.abs(a.time - ideal) / Math.max(1, windowHalf);
          const scoreB = b.priority * 3 - Math.abs(b.time - ideal) / Math.max(1, windowHalf);
          return scoreB - scoreA;
        });
        chosen = eligible[0];
      } else {
        const fallbackIdx = words.findIndex(w => w.start >= Math.max(ideal, lastTime + minSpacing) && w.start <= duration - 4);
        if (fallbackIdx > 0) chosen = { idx: fallbackIdx, time: words[fallbackIdx]!.start };
      }
      if (chosen) {
        rawChapters.push({
          time: chosen.time,
          title: titleFromWords(words.slice(chosen.idx, chosen.idx + 12), `Part ${rawChapters.length + 1}`),
        });
        lastTime = chosen.time;
      }
    }
    return normalizeYouTubeChapters(rawChapters, duration, { minSpacingSeconds: minSpacing });
  }

  // 3. No transcript: derive clean chapters from video clip boundaries.
  const videoClips = timeline.tracks
    .filter(t => t.kind === "video" && !t.hidden)
    .flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled))
    .sort((a, b) => a.timelineIn - b.timelineIn);

  if (videoClips.length >= 2) {
    const raw = videoClips.slice(0, 8).map((clip, i) => ({
      time: clip.timelineIn,
      title: clip.label?.trim() || (i === 0 ? "Intro" : `Section ${i + 1}`),
    }));
    return normalizeYouTubeChapters(raw, duration);
  }

  return [{ time: 0, timestamp: "0:00", title: "Intro" }];
}

export function formatChaptersBlock(chapters: readonly YouTubeChapter[]): string {
  return chapters.map(c => `${c.timestamp} ${c.title}`).join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic fallback for title, description & tags
// ---------------------------------------------------------------------------

function extractTags(projectName: string, chapters: readonly YouTubeChapter[], words: readonly FinalTimelineWord[]): string[] {
  const counts = new Map<string, number>();
  const addTokens = (text: string, weight: number) => {
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + weight);
    }
  };
  addTokens(projectName, 4);
  for (const ch of chapters) addTokens(ch.title, 3);
  for (const w of words.slice(0, 400)) addTokens(w.text, 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([tag]) => tag);
}

function buildFallbackText(
  project: Pick<Project, "name">,
  chapters: readonly YouTubeChapter[],
  words: readonly FinalTimelineWord[],
  recentSummaries: readonly string[],
): { title: string; titleOptions: string[]; description: string; tags: string[] } {
  const baseTitle = project.name.trim().slice(0, 100) || "Untitled Video";
  const options = new Set<string>([baseTitle]);
  if (chapters.length >= 2) {
    const alt = `${baseTitle} — ${chapters[1]!.title}`.slice(0, 100);
    if (alt.length <= 100) options.add(alt);
  }
  if (words.length >= 4) {
    const hook = titleFromWords(words.slice(0, 10), "");
    if (hook && hook.length >= 8 && hook.toLowerCase() !== baseTitle.toLowerCase()) {
      options.add(hook.slice(0, 100));
    }
  }

  // Opening summary sentences from final-cut transcript
  let summary = "";
  if (words.length > 0) {
    const joined = words.slice(0, 48).map(w => w.text).join(" ");
    const sentences = joined.match(/[^.!?]+[.!?]+/g);
    summary = sentences && sentences.length > 0
      ? sentences.slice(0, 2).join(" ").trim()
      : joined.trim();
  } else if (recentSummaries.length > 0) {
    summary = recentSummaries[0]!.trim();
  }

  const chapterBlock = formatChaptersBlock(chapters);
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (chapterBlock) parts.push(`Chapters:\n${chapterBlock}`);
  const description = parts.join("\n\n").slice(0, 5000);

  return {
    title: baseTitle,
    titleOptions: [...options].slice(0, 3),
    description,
    tags: extractTags(baseTitle, chapters, words),
  };
}

// ---------------------------------------------------------------------------
// Optional fast AI drafting (reuses configured direct API keys, falls back cleanly)
// ---------------------------------------------------------------------------

const AiKitSchema = z.object({
  title: z.string().trim().min(1).max(100),
  titleOptions: z.array(z.string().trim().min(1).max(100)).max(4).optional(),
  summary: z.string().trim().max(2500).optional(),
  chapters: z.array(z.object({
    seconds: z.number().nonnegative(),
    title: z.string().trim().min(1).max(80),
  })).max(20).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(15).optional(),
});

type DirectProvider = "anthropic" | "gemini" | "openai";

function pickDirectAiProvider(ctx: Ctx): { provider: DirectProvider; model: string } | undefined {
  const env = ctx.options.env ?? process.env;
  const preferred = ctx.settings().noteCleanup.provider;
  const keyOf = (p: DirectProvider) =>
    p === "anthropic" ? ctx.env.anthropicKey : p === "gemini" ? ctx.env.geminiKey : ctx.env.openaiKey;
  const order: DirectProvider[] = preferred !== "none"
    ? [preferred, ...(["anthropic", "gemini", "openai"] as const).filter(p => p !== preferred)]
    : ["anthropic", "gemini", "openai"];
  const provider = order.find(p => !!keyOf(p));
  if (!provider) return undefined;
  const envModel = provider === "anthropic" ? env.SCARLET_CLEANUP_ANTHROPIC_MODEL
    : provider === "gemini" ? env.SCARLET_CLEANUP_GEMINI_MODEL
    : env.SCARLET_CLEANUP_OPENAI_MODEL;
  return { provider, model: envModel || DIRECT_DEFAULT_MODEL[provider] };
}

function buildCompactTranscriptForAi(words: readonly FinalTimelineWord[], maxChars = 9000): string {
  const lines: string[] = [];
  let lineWords: FinalTimelineWord[] = [];
  let chars = 0;
  const flush = () => {
    if (!lineWords.length) return;
    const line = `[${formatYouTubeTimestamp(lineWords[0]!.start)}] ${lineWords.map(w => w.text).join(" ")}`;
    if (chars + line.length + 1 <= maxChars) {
      lines.push(line);
      chars += line.length + 1;
    }
    lineWords = [];
  };
  for (const w of words) {
    if (lineWords.length >= 18 || (lineWords.length > 0 && w.start - lineWords[lineWords.length - 1]!.end > 1.2)) {
      flush();
      if (chars >= maxChars) break;
    }
    lineWords.push(w);
    if (/[.?!]["”’)]*$/.test(w.text) && lineWords.length >= 6) flush();
  }
  flush();
  return lines.join("\n");
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function tryDraftWithAi(
  ctx: Ctx,
  project: Project,
  duration: number,
  words: readonly FinalTimelineWord[],
  existingChapters: readonly YouTubeChapter[],
  hasExplicitMarkers: boolean,
  recentSummaries: readonly string[],
  signal?: AbortSignal,
): Promise<z.infer<typeof AiKitSchema> | null> {
  const direct = pickDirectAiProvider(ctx);
  if (!direct || (!words.length && !recentSummaries.length)) return null;

  const system = [
    "You draft concise, engaging YouTube publishing metadata for a finished edited video.",
    "Return ONLY valid JSON matching this schema:",
    '{"title":"string (<=100 chars)","titleOptions":["string"],"summary":"1-3 sentence YouTube description intro (no chapters list inside summary)","chapters":[{"seconds":0,"title":"Intro"}],"tags":["tag"]}',
    "Rules:",
    "- Use ONLY the exact edited timeline timestamps shown in brackets [M:SS] (never invent times past the video duration).",
    "- First chapter must be at seconds: 0.",
    "- Keep chapter titles short, clear, and scannable (2-6 words).",
    "- Provide 3 distinct title options (including the main title), and 5-10 relevant tags.",
  ].join("\n");

  const transcript = buildCompactTranscriptForAi(words);
  const userPrompt = [
    `Project name: ${project.name}`,
    `Final edited duration: ${formatYouTubeTimestamp(duration)} (${Math.round(duration)} seconds)`,
    ...(hasExplicitMarkers ? [`Editor chapter markers (keep these timestamps): ${formatChaptersBlock(existingChapters)}`] : []),
    ...(recentSummaries.length ? [`Recent edit notes: ${recentSummaries.slice(0, 5).join("; ")}`] : []),
    ...(transcript ? [`Final edited timeline transcript:\n${transcript}`] : []),
  ].join("\n\n");

  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(AI_DRAFT_TIMEOUT_MS), ctx.shutdown])
    : AbortSignal.any([AbortSignal.timeout(AI_DRAFT_TIMEOUT_MS), ctx.shutdown]);

  try {
    let rawText = "";
    if (direct.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ctx.env.anthropicKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: direct.model,
          max_tokens: 700,
          system,
          messages: [{ role: "user", content: userPrompt }],
        }),
        signal: combinedSignal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      rawText = (json.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("");
    } else if (direct.provider === "gemini") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(direct.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": ctx.env.geminiKey! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { maxOutputTokens: 700, responseMimeType: "application/json" },
        }),
        signal: combinedSignal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
      rawText = (json.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? "").join("");
    } else {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctx.env.openaiKey!}` },
        body: JSON.stringify({
          model: direct.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 700,
        }),
        signal: combinedSignal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      rawText = json.choices?.[0]?.message?.content ?? "";
    }
    const parsed = AiKitSchema.safeParse(parseJsonObject(rawText));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Frame sharpness, brightness & visual distinctness scoring + thumbnail I/O
// ---------------------------------------------------------------------------

/** Run FFmpeg with binary input piped to stdin and capture bounded stdout. */
function runFfmpegStdin(
  args: string[],
  input: Buffer,
  opts: { signal?: AbortSignal; maxStdout?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpeg(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const limit = opts.maxStdout ?? 10 * 1024 * 1024;
    let settled = false;

    const done = (err: Error | null, out?: Buffer) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(out!);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      done(new DOMException("Aborted", "AbortError"));
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        child.kill("SIGKILL");
        done(new Error("FFmpeg output exceeded limit."));
        return;
      }
      chunks.push(chunk);
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", err => done(err));
    child.on("close", code => {
      if (code === 0) done(null, Buffer.concat(chunks));
      else done(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.on("error", () => { /* ignore EPIPE if ffmpeg exits early */ });
    child.stdin.end(input);
  });
}

/**
 * Score a decoded JPEG frame for brightness, contrast, sharpness (Laplacian edge energy),
 * and a 16×9 fingerprint so we skip black/blank/blurry frames and pick visually distinct stills.
 */
export async function scoreThumbnailFrame(jpeg: Buffer, signal?: AbortSignal): Promise<FrameQualityScore> {
  const W = 64, H = 36;
  const stdout = await runFfmpegStdin([
    "-hide_banner", "-loglevel", "error", "-f", "mjpeg", "-i", "pipe:0",
    "-frames:v", "1", "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], jpeg, { signal, maxStdout: W * H + 1024 });

  if (stdout.length < W * H) {
    return { mean: 128, std: 30, sharpness: 10, quality: 10, isDarkOrBlank: false, fingerprint: new Uint8Array(16 * 9) };
  }

  const n = W * H;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += stdout[i]!;
  const mean = sum / n;

  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = stdout[i]! - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / n);

  // Laplacian edge energy across interior pixels -> higher = sharper, less blurry.
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      const lap = Math.abs(
        4 * stdout[idx]! - stdout[idx - 1]! - stdout[idx + 1]! - stdout[idx - W]! - stdout[idx + W]!,
      );
      edgeSum += lap;
      edgeCount++;
    }
  }
  const sharpness = edgeCount > 0 ? edgeSum / edgeCount : 0;

  // 16×9 downsampled fingerprint (4×4 block averages) for visual distinctness.
  const fp = new Uint8Array(16 * 9);
  for (let by = 0; by < 9; by++) {
    for (let bx = 0; bx < 16; bx++) {
      let acc = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          acc += stdout[(by * 4 + dy) * W + (bx * 4 + dx)]!;
        }
      }
      fp[by * 16 + bx] = Math.round(acc / 16);
    }
  }

  const isDarkOrBlank = mean < 18 || mean > 240 || std < 12;
  // Exposure penalty peaks around healthy mid-tones and strongly discounts black/white/flat frames.
  const exposureFactor = isDarkOrBlank ? 0.05 : Math.max(0.25, 1 - Math.abs(mean - 120) / 140);
  const contrastFactor = Math.min(1.5, std / 35);
  const quality = sharpness * exposureFactor * contrastFactor;
  return { mean, std, sharpness, quality, isDarkOrBlank, fingerprint: fp };
}

export function frameDistance(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let diff = 0;
  for (let i = 0; i < len; i++) diff += Math.abs(a[i]! - b[i]!);
  return diff / len;
}

/**
 * Greedily select up to `count` frames that are sharp, well-exposed (not dark/blank),
 * and visually distinct from one another.
 */
export function selectDistinctSharpFrames<T extends { time: number; score: FrameQualityScore }>(
  candidates: readonly T[],
  count = 4,
): T[] {
  if (candidates.length <= count) return [...candidates].sort((a, b) => a.time - b.time);
  const usable = candidates.filter(c => !c.score.isDarkOrBlank);
  const pool = usable.length >= Math.min(count, 2) ? usable : [...candidates];

  const chosen: T[] = [];
  const remaining = [...pool].sort((a, b) => b.score.quality - a.score.quality);
  if (remaining.length) chosen.push(remaining.shift()!);

  while (chosen.length < count && remaining.length > 0) {
    let bestIdx = 0;
    let bestCombined = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      let minDist = Infinity;
      for (const picked of chosen) {
        minDist = Math.min(minDist, frameDistance(cand.score.fingerprint, picked.score.fingerprint));
      }
      // Reward visual distinctness (up to ~35 luma units mean abs diff) while keeping sharp frames high.
      const distinctBoost = Math.min(1.2, 0.25 + minDist / 28);
      const combined = cand.score.quality * distinctBoost;
      if (combined > bestCombined) {
        bestCombined = combined;
        bestIdx = i;
      }
    }
    chosen.push(remaining.splice(bestIdx, 1)[0]!);
  }

  return chosen.sort((a, b) => a.time - b.time);
}

async function decodeTimelineJpeg(
  ctx: Ctx,
  project: Project,
  timeline: Timeline,
  time: number,
  maxDimension: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { fps, width, height } = project.settings;
  const duration = timelineDuration(timeline);
  const clamped = Math.max(0, Math.min(Math.max(0, duration - 1 / fps), time));
  const frameIndex = Math.max(0, Math.floor(clamped * fps + 1e-6));
  const range = { start: frameIndex / fps, end: (frameIndex + 1) / fps };

  const targetHeight = Math.min(height, Math.ceil((maxDimension * height) / Math.max(width, height)));
  const preview = ctx.renders.coveringPreview(project, timeline.version, range, targetHeight);
  const previewFile = preview?.path && await fileInDirectoryAsync(ctx.paths.renders(project.id), preview.path);
  if (preview && previewFile) {
    try {
      const local = clamped - (preview.range?.start ?? 0);
      return await extractFrame(previewFile, Math.max(0, local + 0.5 / fps), {
        width: Math.round(width * Math.min(1, maxDimension / Math.max(width, height))),
        quality: maxDimension >= 1000 ? 3 : 5,
        fps,
        signal,
      });
    } catch {
      signal?.throwIfAborted();
    }
  }

  const root = ctx.paths.media(project.id);
  const pictures = previewPictures(root, { signal });
  const accel = ctx.settings().render.hwaccel;
  const decoder = timelinePreviewDecoder(accel, await pictureDecoder(accel));
  try {
    return await renderTimelineFrame(project, timeline, range, root, signal, maxDimension, {
      decoder,
      pictureSource: (asset, ...args) => pictures(asset, ...args),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return renderTimelineFrame(project, timeline, range, root, signal, maxDimension);
  }
}

async function ensureUnderThumbnailLimit(jpeg: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (jpeg.length <= YOUTUBE_THUMBNAIL_MAX_BYTES) return jpeg;
  for (const q of [6, 10, 16]) {
    const stdout = await runFfmpegStdin([
      "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0",
      "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-c:v", "mjpeg", "-q:v", String(q), "-f", "image2pipe", "pipe:1",
    ], jpeg, { signal, maxStdout: YOUTUBE_THUMBNAIL_MAX_BYTES + 65536 });
    if (stdout.length > 0 && stdout.length <= YOUTUBE_THUMBNAIL_MAX_BYTES) return stdout;
  }
  throw badRequest("thumbnail_too_large", "Thumbnail image exceeds YouTube’s 2 MB limit.");
}

function makeThumbId(): string {
  return `yt_${randomBytes(8).toString("hex")}`;
}

function storeThumbnailFile(ctx: Ctx, projectId: string, bytes: Buffer, ext: ".jpg" | ".png"): { id: string; file: string } {
  const dir = ctx.paths.youtubeThumbs(projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = makeThumbId();
  const file = join(dir, `${id}${ext}`);
  writeFileSync(file, bytes);
  return { id, file };
}

/** Resolve a stored thumbnail candidate id to its local file path and MIME type. */
export function resolveStoredThumbnail(ctx: Ctx, projectId: string, thumbId: string): { path: string; mime: string } | null {
  if (!/^yt_[a-f0-9]{16}$/.test(thumbId)) return null;
  const dir = ctx.paths.youtubeThumbs(projectId);
  for (const [ext, mime] of [[".jpg", "image/jpeg"], [".png", "image/png"]] as const) {
    const candidate = fileInDirectory(dir, `${thumbId}${ext}`);
    if (candidate && existsSync(candidate)) return { path: candidate, mime };
  }
  return null;
}

async function makeSmallPreviewDataUrl(jpeg: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
  if (jpeg.length <= 45_000) {
    return `data:${mime};base64,${jpeg.toString("base64")}`;
  }
  try {
    const stdout = await runFfmpegStdin([
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-c:v", "mjpeg", "-q:v", "6", "-f", "image2pipe", "pipe:1",
    ], jpeg, { signal, maxStdout: 256 * 1024 });
    if (stdout.length > 0) return `data:image/jpeg;base64,${stdout.toString("base64")}`;
  } catch {
    // Fall back to original buffer below
  }
  return `data:${mime};base64,${jpeg.toString("base64")}`;
}

async function extractThumbnailCandidates(
  ctx: Ctx,
  project: Project,
  timeline: Timeline,
  chapters: readonly YouTubeChapter[],
  duration: number,
  signal?: AbortSignal,
): Promise<YouTubeThumbnailCandidate[]> {
  if (duration <= 0) return [];
  const hasVisibleVideo = timeline.tracks.some(t => t.kind === "video" && !t.hidden && t.clips.some(c => c.enabled));
  if (!hasVisibleVideo) return [];

  const sampleSet = new Set<number>();
  const sampleSlots = duration < 8 ? 4 : 9;
  for (let i = 0; i < sampleSlots; i++) {
    const frac = 0.07 + (0.85 * i) / Math.max(1, sampleSlots - 1);
    sampleSet.add(round3(duration * frac));
  }
  for (const ch of chapters.slice(0, 4)) {
    const offset = Math.min(duration * 0.94, ch.time + Math.min(2, duration * 0.08));
    sampleSet.add(round3(offset));
  }
  const sampleTimes = [...sampleSet].sort((a, b) => a - b).slice(0, 10);

  const lane = pictureLane(ctx);
  const scored = (await Promise.all(sampleTimes.map(async time => {
    try {
      const small = await lane.run(() => decodeTimelineJpeg(ctx, project, timeline, time, 320, signal), { signal });
      const score = await scoreThumbnailFrame(small, signal);
      return { time, small, score };
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }))).filter((x): x is { time: number; small: Buffer; score: FrameQualityScore } => x !== null);

  if (!scored.length) return [];
  const winners = selectDistinctSharpFrames(scored, Math.min(4, scored.length));
  const { width, height } = project.settings;
  const outW = Math.round(width * Math.min(1, 1280 / Math.max(width, height)));
  const outH = Math.round(height * Math.min(1, 1280 / Math.max(width, height)));

  const results = await Promise.all(winners.map(async (w) => {
    let hiRes: Buffer;
    try {
      hiRes = await lane.run(() => decodeTimelineJpeg(ctx, project, timeline, w.time, 1280, signal), { signal });
      hiRes = await ensureUnderThumbnailLimit(hiRes, signal);
    } catch {
      signal?.throwIfAborted();
      hiRes = w.small;
    }
    const { id } = storeThumbnailFile(ctx, project.id, hiRes, ".jpg");
    const previewUrl = await makeSmallPreviewDataUrl(w.small, "image/jpeg", signal);
    return {
      id,
      time: round3(w.time),
      label: formatYouTubeTimestamp(w.time),
      source: "auto" as const,
      previewUrl,
      width: outW,
      height: outH,
      score: Math.round(w.score.quality * 10) / 10,
    };
  }));

  return results;
}

/** Capture a single crisp thumbnail frame at a chosen final-cut timeline time (e.g. current playhead). */
export async function capturePlayheadThumbnail(
  ctx: Ctx,
  project: Project,
  timeline: Timeline,
  time: number,
  signal?: AbortSignal,
): Promise<YouTubeThumbnailCandidate> {
  const duration = timelineDuration(timeline);
  if (duration <= 0) throw badRequest("empty_timeline", "There’s no video frame to capture yet.");
  const clamped = Math.max(0, Math.min(Math.max(0, duration - 1 / project.settings.fps), time));
  const lane = pictureLane(ctx);
  const raw = await lane.run(() => decodeTimelineJpeg(ctx, project, timeline, clamped, 1280, signal), { signal });
  const jpeg = await ensureUnderThumbnailLimit(raw, signal);
  const { id } = storeThumbnailFile(ctx, project.id, jpeg, ".jpg");
  const previewUrl = await makeSmallPreviewDataUrl(jpeg, "image/jpeg", signal);
  const { width, height } = project.settings;
  const scale = Math.min(1, 1280 / Math.max(width, height));
  return {
    id,
    time: round3(clamped),
    label: `Playhead ${formatYouTubeTimestamp(clamped)}`,
    source: "playhead",
    previewUrl,
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** Save a user-chosen custom thumbnail image (from local path or uploaded bytes), converting to <= 2 MiB JPEG if needed. */
export async function saveCustomThumbnail(
  ctx: Ctx,
  projectId: string,
  input: { path: string } | { bytes: Buffer; mime?: string; name?: string },
  signal?: AbortSignal,
): Promise<YouTubeThumbnailCandidate> {
  let bytes: Buffer;
  let extHint = "";
  let label = "Custom image";

  if ("path" in input) {
    const filePath = input.path.trim();
    if (!filePath || !existsSync(filePath)) {
      throw badRequest("thumbnail_not_found", "Couldn’t find the selected image file.");
    }
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) {
      throw badRequest("invalid_thumbnail", "Choose a valid image file (JPG, PNG, or WebP).");
    }
    if (st.size > 25 * 1024 * 1024) {
      throw badRequest("thumbnail_too_large", "Choose an image smaller than 25 MB.");
    }
    bytes = readFileSync(filePath);
    extHint = extname(filePath).toLowerCase();
    label = filePath.split(/[\\/]/).pop() || label;
  } else {
    if (!input.bytes.length) throw badRequest("invalid_thumbnail", "The selected image file is empty.");
    if (input.bytes.length > 25 * 1024 * 1024) {
      throw badRequest("thumbnail_too_large", "Choose an image smaller than 25 MB.");
    }
    bytes = input.bytes;
    extHint = input.name ? extname(input.name).toLowerCase() : "";
    if (input.name) label = input.name;
  }

  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

  let finalBytes: Buffer;
  let finalExt: ".jpg" | ".png";
  let finalMime: string;

  if ((isJpeg || isPng) && bytes.length <= YOUTUBE_THUMBNAIL_MAX_BYTES) {
    finalBytes = bytes;
    finalExt = isPng ? ".png" : ".jpg";
    finalMime = isPng ? "image/png" : "image/jpeg";
  } else {
    // Convert WebP / HEIC / oversized JPG/PNG cleanly into a 1280px JPEG under YouTube's 2 MB limit.
    try {
      const stdout = await runFfmpegStdin([
        "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
        "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1",
      ], bytes, { signal, maxStdout: 10 * 1024 * 1024 });
      if (!stdout.length) throw new Error("empty");
      finalBytes = await ensureUnderThumbnailLimit(stdout, signal);
      finalExt = ".jpg";
      finalMime = "image/jpeg";
    } catch {
      throw badRequest("invalid_thumbnail", `Couldn’t read this image${extHint ? ` (${extHint})` : ""}. Choose a JPG, PNG, or WebP file.`);
    }
  }

  const { id } = storeThumbnailFile(ctx, projectId, finalBytes, finalExt);
  const previewUrl = await makeSmallPreviewDataUrl(finalBytes, finalMime, signal);
  return {
    id,
    label,
    source: "custom",
    previewUrl,
  };
}

// ---------------------------------------------------------------------------
// Main entry point: draft full Publishing Kit
// ---------------------------------------------------------------------------

export async function generateYouTubePublishingKit(
  ctx: Ctx,
  project: Project,
  timeline: Timeline,
  opts: { useAi?: boolean; signal?: AbortSignal } = {},
): Promise<YouTubePublishingKit> {
  const duration = timelineDuration(timeline);

  // Load transcripts for media referenced on the project.
  const transcripts = new Map<string, Transcript>();
  for (const asset of project.media) {
    if (!asset.transcriptId) continue;
    const tr = ctx.repos.transcripts.get(asset.transcriptId);
    if (tr) transcripts.set(asset.id, tr);
  }

  const words = collectFinalTimelineWords(timeline, transcripts);
  const hasExplicitMarkers = timeline.markers.some(m => m.kind === "chapter" && m.text.trim().length > 0);
  const baseChapters = buildFinalCutChapters(timeline, words, duration);

  const recentChanges = ctx.repos.changes.select(
    "project_id = ? AND state = 'approved'",
    [project.id],
    "created_at DESC LIMIT 8",
  );
  const recentSummaries = recentChanges
    .map(c => c.description?.trim())
    .filter((s): s is string => !!s && !s.startsWith("Rejected ·"));

  const fallback = buildFallbackText(project, baseChapters, words, recentSummaries);

  // Run optional AI drafting and thumbnail candidate extraction concurrently so the Export sheet feels instant.
  const [aiDraft, thumbnails] = await Promise.all([
    opts.useAi === false
      ? Promise.resolve(null)
      : tryDraftWithAi(ctx, project, duration, words, baseChapters, hasExplicitMarkers, recentSummaries, opts.signal),
    extractThumbnailCandidates(ctx, project, timeline, baseChapters, duration, opts.signal),
  ]);

  if (aiDraft) {
    const chapters = hasExplicitMarkers || !aiDraft.chapters?.length
      ? baseChapters
      : normalizeYouTubeChapters(
          aiDraft.chapters.map(c => ({ time: c.seconds, title: c.title })),
          duration,
        );
    const chapterBlock = formatChaptersBlock(chapters);
    const summary = aiDraft.summary?.trim() || "";
    const description = [summary, chapterBlock ? `Chapters:\n${chapterBlock}` : ""]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 5000);
    const titleOptions = [
      aiDraft.title,
      ...(aiDraft.titleOptions ?? []).filter(t => t.toLowerCase() !== aiDraft.title.toLowerCase()),
    ].slice(0, 3);
    return {
      version: timeline.version,
      duration: round3(duration),
      title: aiDraft.title,
      titleOptions,
      description,
      chapters,
      tags: aiDraft.tags?.length ? aiDraft.tags.slice(0, 15) : fallback.tags,
      thumbnails,
      draftedWith: "ai",
    };
  }

  return {
    version: timeline.version,
    duration: round3(duration),
    title: fallback.title,
    titleOptions: fallback.titleOptions,
    description: fallback.description,
    chapters: baseChapters,
    tags: fallback.tags,
    thumbnails,
    draftedWith: "fallback",
  };
}
