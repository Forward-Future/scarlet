import { clipDuration, reviewReasons, timelineToSource, type Change, type CutReview, type MediaAsset, type TimeRange } from "@scarlet/timeline";
import { ScarletApiError, type InspectionResult, type ScarletClient, type SheetRequest } from "@scarlet/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod/v3";

export interface InspectionReceipt {
  complete: boolean;
  /** Verdict of the measured join audit on the suggestion's version; unset when the join could not be measured. */
  joinAudit?: string;
  /** Why the cut leaves no join to audit (a head or tail trim). */
  noJoin?: string;
  /** Only for a model that hears audio: whether the narrowed join's WAV arrived. */
  heardJoin?: boolean;
  picture: { id: string; start: number; end: number }[];
}

export interface DialogueInspection {
  content: CallToolResult["content"];
  receipt: InspectionReceipt;
  /** Activity sheets across this removal's long picture. */
  wholeSheets: number;
}

/** One result holds at most this many activity sheets. Longer removals go through frame_contact_sheet_batch. */
export const MAX_WHOLE_PICTURE_SHEETS = 48;
/** Activity sheets check every frame in windows up to twelve seconds. Neighbors overlap a little, so frame snapping never leaves a gap. */
const ACTIVITY_SECONDS = 11.9;
const OVERLAP = 0.04;

/** Equal, slightly overlapping activity windows that cover [from, to]. */
export function activityWindows(from: number, to: number) {
  const n = Math.max(1, Math.ceil((to - from) / ACTIVITY_SECONDS));
  const step = (to - from) / n;
  return Array.from({ length: n }, (_, i) => ({ from: i ? from + i * step - OVERLAP : from, to: i === n - 1 ? to : from + (i + 1) * step }));
}

type ReadySheet = (request: z.input<typeof SheetRequest>) => Promise<Extract<InspectionResult, { state: "ready" }>>;

interface Target {
  track: string; asset: MediaAsset;
  a: number; b: number; from: number; to: number;
  visible: boolean; audible: boolean;
}

/** Inspect original source clocks independently. A muted screen and an offset mic
 * often come from two different recordings. Missing evidence stays explicit.
 * The closing receipt line is the caller's: it depends on what the agent has already seen. */
export async function inspectDialogueSuggestion(client: ScarletClient, change: Change, review: CutReview,
  media: MediaAsset[], index: number, { audio, images, wholePicture = false, sheet, unavailable, playback }: {
    audio: boolean; images: boolean; wholePicture?: boolean; sheet: ReadySheet;
    playback?: { original: CutReview["original"]; range: TimeRange; previewVersion: string };
    /** Notes on stderr a read that failed and was answered without. */
    unavailable?: (what: string, err: unknown) => void;
  }): Promise<DialogueInspection> {
  const cut = review.cuts[index];
  if (!cut) throw new Error(`Cut ${index} is outside this proposal (${review.cuts.length} cuts, index 0–${review.cuts.length - 1}).`);
  const { start, end } = playback?.range ?? cut.removed;
  const content: CallToolResult["content"] = [];
  const info = (value: unknown, into = content) => into.push({ type: "text", text: JSON.stringify(value) });
  const receipt: InspectionReceipt = { complete: true, picture: [] };
  info({ index, total: review.cuts.length, fromVersion: change.fromVersion, toVersion: change.toVersion,
    ...cut.removed, firstPass: reviewReasons(change, [cut])[0], ...(playback && { inspectedVersion: playback.original.version,
      inspectedRange: playback.range, previewVersion: playback.previewVersion }) });

  // Overlay notes keep their place among the tracks.
  const parts: (Target | { note: unknown })[] = [];
  for (const track of (playback?.original ?? review.original).tracks) {
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      const lo = Math.max(start, clip.timelineIn), hi = Math.min(end, clip.timelineIn + clipDuration(clip));
      if (hi <= lo) continue;
      if (clip.kind !== "media") {
        if (!track.hidden && track.kind !== "audio") { receipt.complete = false; parts.push({ note: { track: track.name, note: "Check the composite overlay in the original." } }); }
        continue;
      }
      const asset = media.find(m => m.id === clip.mediaId);
      if (!asset) { receipt.complete = false; info({ missing: `Media ${clip.mediaId} on track ${track.name} is no longer in the project.` }); continue; }
      const visible = track.kind === "video" && !track.hidden && asset.kind !== "audio" && clip.opacity !== 0;
      const audible = !track.muted && clip.volume !== 0 && (asset.hasAudio || asset.kind === "audio");
      if (!visible && !audible) continue;
      const a = timelineToSource(clip, lo), b = timelineToSource(clip, hi);
      parts.push({ track: track.name, asset, a, b, from: Math.max(clip.sourceIn, a - 1.2), to: Math.min(clip.sourceOut, b + 1.2), visible, audible });
    }
  }
  const long = (t: Target) => t.visible && t.to - t.from > 12;
  const wholeSheets = parts.reduce((n, p) => "note" in p || !long(p) ? n : n + activityWindows(p.from, p.to).length, 0);
  // The agent chooses whether to look closer. Asked for, the whole removed picture comes in this one result.
  const whole = images && wholePicture && wholeSheets <= MAX_WHOLE_PICTURE_SHEETS;

  let heard = false;
  const inspectTarget = async ({ track, asset, a, b, from, to, visible, audible }: Target) => {
    const out: CallToolResult["content"] = [];
    info({ track, mediaId: asset.id, sourceStart: a, sourceEnd: b, visible, audible }, out);
    try {
      if (audible) {
        const transcript = await client.transcript(asset.id, { from, to, granularity: "word", audioSources: true }).catch((err: unknown) => {
          // A recording without a transcript has no words to show. Anything else is a read that failed.
          if (!(err instanceof ScarletApiError && err.status === 404)) unavailable?.(`failed to read the words of ${asset.id} for a cut inspection`, err);
          return null;
        });
        const words = transcript?.segments.flatMap(s => s.words).filter(w => w.end > from && w.start < to);
        info({ words: words?.map(w => [w.start, w.end, w.text, w.speaker ?? w.audioSource ?? null]) ?? null }, out);
        for (let t = from; t < to - 1e-6; t += 59) {
          const wf = await client.waveform(asset.id, t, Math.min(t + 59, to), 64, false, true);
          // RMS in dBFS, 64 buckets over the window, as every audio tool reports levels.
          info({ from: wf.from, to: wf.to, voice: wf.speechActivity, levelsDb: wf.rms?.map(v => Math.max(-99, Math.round(20 * Math.log10(v + 1e-7)))) }, out);
          if (!wf.speechActivity || !wf.rms) receipt.complete = false;
        }
        if (audio) {
          const windows = to - from <= 8 ? [[from, to]] : [[from, from + 4], [to - 4, to]];
          for (const [s, e] of windows) {
            const { wav } = await client.sourceAudio(change.projectId, { mediaId: asset.id, from: s!, to: e! });
            out.push({ type: "audio", mimeType: "audio/wav", data: wav });
          }
        }
        heard = true;
      }
      if (visible) {
        if (!images) { receipt.complete = false; info({ missing: "Frame inspection is unavailable in this session, so the picture of this cut is unchecked." }, out); return out; }
        const short = to - from <= 12;
        // Return an overview of longer removals and identify windows available for closer inspection.
        const requests = short ? [{ from, to, mode: "activity" as const }]
          : whole ? activityWindows(from, to).map(w => ({ ...w, mode: "activity" as const }))
          : Array.from({ length: Math.ceil((to - from - 1e-6) / 118) }, (_, i) => ({ from: from + i * 118, to: Math.min(from + (i + 1) * 118, to), mode: "uniform" as const }));
        const sheets = await Promise.all(requests.map(r => sheet({ mediaId: asset.id, count: 6, ...r })));
        for (const [i, result] of sheets.entries()) {
          const span = `${asset.id} ${requests[i]!.from.toFixed(1)}–${requests[i]!.to.toFixed(1)} s`;
          if (!result.windows.length) throw new Error(`Frames of ${span} are unavailable. Inspect this index again, or mark it ask.`);
          for (const w of result.windows) {
            if (!w.jpeg || !w.timestamps.length) throw new Error(`No frames could be decoded from ${span}. Check the source with media_frame, or mark it ask.`);
            info({ source: asset.id, timestamps: w.timestamps, changedFrames: w.changedFrames }, out);
            out.push({ type: "image", mimeType: "image/jpeg", data: w.jpeg });
          }
        }
        // Windows left for closer inspection. The whole picture leaves none.
        if (!short && !whole) receipt.picture.push({ id: asset.id, start: a, end: b });
      }
    } catch (err) { receipt.complete = false; info({ missing: (err as Error).message }, out); }
    return out;
  };
  // Tracks prepare together. The sheet reader bounds how many decode at once.
  const sections = await Promise.all(parts.map(p => "note" in p ? Promise.resolve([{ type: "text" as const, text: JSON.stringify(p.note) }]) : inspectTarget(p)));
  for (const section of sections) content.push(...section);
  receipt.complete &&= heard;
  return { content, receipt, wholeSheets };
}
