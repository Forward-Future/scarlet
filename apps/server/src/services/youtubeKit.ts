/**
 * Final-cut YouTube chapter timestamp calculation.
 *
 * Computes accurate chapter timestamps (`0:00 ...`) strictly against the edited timeline clock
 * (accounting for cuts, trims, rearrangements, and clip speeds — never raw source timestamps).
 */
import {
  normalizeTranscriptToken,
  type YouTubeChapter,
  type YouTubeChaptersResponse,
} from "@scarlet/shared";
import {
  clipDuration,
  timelineDuration,
  type MediaClip,
  type Project,
  type Timeline,
  type Transcript,
} from "@scarlet/timeline";
import type { Ctx } from "../context.js";

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

export function computeYouTubeChapters(
  ctx: Ctx,
  project: Project,
  timeline: Timeline,
): YouTubeChaptersResponse {
  const duration = Math.max(0, timelineDuration(timeline));
  const transcripts = new Map<string, Transcript>();
  for (const media of project.media) {
    const tr = ctx.repos.transcripts.get(media.id);
    if (tr) transcripts.set(media.id, tr);
  }
  const words = collectFinalTimelineWords(timeline, transcripts);
  const chapters = buildFinalCutChapters(timeline, words, duration);
  return {
    version: timeline.version,
    duration,
    chapters,
    chaptersText: formatChaptersBlock(chapters),
  };
}
