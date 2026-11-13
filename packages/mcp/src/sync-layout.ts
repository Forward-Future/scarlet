import { clipEnd, makeTrack, newId, Transform, type MediaAsset, type MediaClip, type Project, type Timeline, type TimelineOp } from "@scarlet/timeline";
import { z } from "zod/v3";

export const InsetFraming = z.object({
  scale: z.number().finite().positive(), x: z.number().finite(), y: z.number().finite(),
  ...Transform.pick({ cropLeft: true, cropRight: true, cropTop: true, cropBottom: true, cornerRadius: true }).partial().shape,
});

export type SyncPicture = "asPlaced" | { screenClipId: string; cameraClipId: string; framing?: z.infer<typeof InsetFraming> };

/** The preset inset: a quarter of the canvas, in its bottom-right corner. */
export function insetFraming(project: Project, asset: Pick<MediaAsset, "width" | "height">): Pick<Transform, "scale" | "x" | "y"> {
  const canvas = project.settings.width / project.settings.height;
  const aspect = asset.width && asset.height ? asset.width / asset.height : canvas;
  const scale = 0.25, margin = 0.025;
  const x = 0.5 - margin - scale * Math.min(1, aspect / canvas) / 2;
  const y = 0.5 - margin - scale * Math.min(1, canvas / aspect) / 2;
  return { scale, x, y };
}

/** Resolve the editor's picture roles after all source offsets have been placed. */
export function syncPictureOps(project: Project, placed: Timeline, layout?: SyncPicture): TimelineOp[] {
  if (!layout || layout === "asPlaced") return [];
  const videos = new Map(project.media.filter(m => m.kind === "video").map(m => [m.id, m]));
  const layers = placed.tracks.flatMap((track, index) => {
    if (track.kind !== "video" || track.hidden) return [];
    return track.clips.flatMap(clip => clip.kind === "media" && clip.enabled && clip.opacity > 0 && videos.has(clip.mediaId)
      ? [{ clip, track, index }] : []);
  });
  const screen = layers.find(l => l.clip.id === layout.screenClipId);
  const camera = layers.find(l => l.clip.id === layout.cameraClipId);
  if (!screen || !camera || screen.track === camera.track || screen.clip.mediaId === camera.clip.mediaId) {
    throw new Error("Choose a screen clip and a separate camera recording on visible video tracks.");
  }
  const clip = camera.clip;
  const start = Math.max(clip.timelineIn, screen.clip.timelineIn);
  const end = Math.min(clipEnd(clip), clipEnd(screen.clip));
  if (end <= start) throw new Error("The screen and camera clips must overlap after sync.");
  const tf = Transform.parse(clip.transform ?? {});
  if (clip.keyframes?.length || tf.scale !== 1 || tf.x || tf.y || tf.rotation || tf.cropLeft || tf.cropRight || tf.cropTop || tf.cropBottom || tf.cornerRadius ||
      clip.effects.some(effect => effect.enabled) || clip.videoFadeIn || clip.videoFadeOut || clip.audioFadeIn || clip.audioFadeOut) {
    throw new Error("The camera already has framing, effects or fades. Use 'asPlaced' to preserve them.");
  }

  // Isolate only the overlap. The ordinary timeline splits retain source clocks,
  // playback speed and gain through the camera-only lead and tail.
  const ops: TimelineOp[] = [];
  let insetId = clip.id;
  // Edges that differ only by floating-point error are the same edge. Two recordings laid in sync end together to
  // the thirteenth decimal, and a split there left a clip of no length that the agent then spent a turn removing.
  const apart = 1e-6;
  if (start > clip.timelineIn + apart) {
    insetId = newId("clip");
    ops.push({ op: "splitClip", clipId: clip.id, at: start, newClipId: insetId });
  }
  if (end < clipEnd(clip) - apart) ops.push({ op: "splitClip", clipId: insetId, at: end, newClipId: newId("clip") });
  if (camera.index < screen.index) {
    const track = { ...makeTrack("video", "Camera inset"), muted: camera.track.muted };
    ops.push({ op: "addTrack", track, index: screen.index + 1 }, { op: "moveClip", clipId: insetId, timelineIn: start, trackId: track.id });
  }
  ops.push({ op: "updateClip", clipId: insetId, patch: { transform: layout.framing ?? insetFraming(project, videos.get(clip.mediaId)!) } });
  return ops;
}
