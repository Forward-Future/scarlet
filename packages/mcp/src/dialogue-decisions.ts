import { dialogueAudioStream, type JoinPage } from "./dialogue-join.js";
import { normalizeTranscriptToken, type AcousticFiller, type DialogueDetections } from "@scarlet/shared";
import { clipRange, rangesOverlap, timelineToSource, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { audibleMediaClips } from "./analysis.js";

export interface FillerCue extends TimeRange {
  whisper?: TranscriptWord;
  uhm?: AcousticFiller;
}
export function matchFillers(words: TranscriptWord[], acoustic: AcousticFiller[]): FillerCue[] {
  const unused = new Set(words);
  const cues: FillerCue[] = acoustic.map(uhm => {
    let best: TranscriptWord | undefined, distance = Infinity;
    for (const w of unused) {
      const d = Math.abs(w.start + w.end - uhm.start - uhm.end) / 2;
      if (d < distance && d <= 0.25 && w.start <= uhm.end + 0.1 && w.end >= uhm.start - 0.1) {
        best = w; distance = d;
      }
    }
    if (best) unused.delete(best);
    return { start: uhm.start, end: uhm.end, uhm, whisper: best };
  });
  for (const w of unused) cues.push({ start: w.start, end: w.end, whisper: w });
  return cues.sort((a, b) => a.start - b.start);
}

interface Scan extends JoinPage {
  segments?: DialogueDetections["segments"];
}
export class DialogueEvidence {
  readonly scans: Scan[] = [];

  checkProductionQuote(c: TimeRange, productionQuote: string, tl: Timeline, project: Project) {
    const quote = productionQuote.split(/\s+/u).map(normalizeTranscriptToken).filter(Boolean);
    if (!quote.length) return "The supplied quote contains no spoken words.";
    let matched = false;
    for (const clip of audibleMediaClips(tl)) {
      const placed = clipRange(clip);
      if (!rangesOverlap(c, placed)) continue;
      const asset = project.media.find(m => m.id === clip.mediaId);
      if (asset && asset.kind !== "audio" && !asset.hasAudio) continue;
      if (!asset || placed.start > c.start || placed.end < c.end)
        return "Check the change of audio source during this aside.";
      const range = { start: timelineToSource(clip, c.start), end: timelineToSource(clip, c.end) };
      const stream = dialogueAudioStream(clip) ?? dialogueAudioStream(asset) ?? 0;
      const pages = this.scans.filter(s => s.mediaId === clip.mediaId && (s.audioStream ?? 0) === stream && rangesOverlap(s, range));
      // Compare the quoted words against the most complete scan page for this source interval.
      const margin = (s: Scan) => Math.min(range.start - s.start, s.end - range.end);
      const page = pages.filter(s => margin(s) >= 0).sort((a, b) => margin(b) - margin(a))[0];
      const segments = page?.segments?.filter(s => s.text.trim() && rangesOverlap(s, range));
      if (!segments?.length || segments.some(s => !s.words.length)) return "Part of the production exchange lacks word timings.";
      const words = segments.flatMap(s => s.words).filter(w => rangesOverlap(w, range) || (w.start === range.start && w.end === range.start));
      const tokens = words.flatMap(w => w.text.split(/\s+/u)).map(normalizeTranscriptToken).filter(Boolean);
      if (words.some(w => w.end <= w.start || w.start < range.start - 1e-6 || w.end > range.end + 1e-6))
        return "A quoted word lacks a complete timing inside the proposed range.";
      if (!words.length || tokens.length !== quote.length || !tokens.every((w, i) => w === quote[i]))
        return "The words inside the proposed range differ from the supplied production quote.";
      matched = true;
    }
    if (!matched) return "The production aside has no verified dialogue source.";
    return undefined;
  }
}
