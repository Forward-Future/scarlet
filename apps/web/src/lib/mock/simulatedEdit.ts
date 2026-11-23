import { applyOps, clipEnd, newId, timelineDuration, type TimelineOp } from "@scarlet/timeline";
import type { Clip, MediaAsset, Timeline } from "@scarlet/timeline";
import { mc } from "./fixtures";

/** The edit a demo run proposes on `base`, near the playhead `time` when there is one. */
export function plausibleEdit(base: Timeline, media: MediaAsset[] | undefined, time: number | undefined): { target: Clip | undefined; ops: TimelineOp[] | undefined; after: Timeline } {
  // A plausible edit: trim 0.3 s off the end of the last clip on the first video track (or the clip under the playhead).
  const vTrack = base.tracks.find((t) => t.kind === "video" && t.clips.length);
  const target = vTrack?.clips.find((c) => time !== undefined && c.timelineIn <= time && time < clipEnd(c)) ?? vTrack?.clips[vTrack.clips.length - 1];
  let after: Timeline;
  let ops: TimelineOp[] | undefined;
  try {
    ops = target && target.kind === "media" ? [{ op: "updateClip", clipId: target.id, patch: { sourceOut: Math.max(target.sourceIn + 0.5, target.sourceOut - 0.3) } }] : undefined;
    if (timelineDuration(base) === 0) {
      const footage = media?.find(m => (m.kind === "video" || m.kind === "audio") && m.duration);
      const track = base.tracks.find(t => t.kind === footage?.kind);
      if (footage?.duration && track) {
        ops = [{ op: "addClip", trackId: track.id, clip: mc(newId("clip"), footage.id, 0, footage.duration, 0, { label: footage.name }) }];
      }
    }
    after = ops ? applyOps(base, ops) : structuredClone(base);
  } catch {
    ops = undefined;
    after = structuredClone(base);
  }
  return { target, ops, after };
}
