import { clipEnd, mergeRanges, timelineDuration, type MediaClip, type Project, type Timeline } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";

/** Count repeated placements. Removing the second playing of a recording is still a removal. */
function losesSourceTime(before: MediaClip[], after: MediaClip[]): boolean {
  const events = new Map<number, number>();
  function add(clips: MediaClip[], weight: number) {
    for (const clip of clips) {
      events.set(clip.sourceIn, (events.get(clip.sourceIn) ?? 0) + weight);
      events.set(clip.sourceOut, (events.get(clip.sourceOut) ?? 0) - weight);
    }
  }
  add(before, 1);
  add(after, -1);
  let missing = 0, previous = 0;
  for (const [time, delta] of [...events].sort((a, b) => a[0] - b[0])) {
    if (missing > 0 && time - previous > 1e-6) return true;
    missing += delta;
    previous = time;
  }
  return false;
}

interface Placements { clips: MediaClip[]; audible: MediaClip[] }

function placements(timeline: Timeline, media: Map<string, Project["media"][number]>) {
  const byMedia = new Map<string, Placements>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind !== "media" || !clip.enabled) continue;
    const asset = media.get(clip.mediaId);
    if (asset?.kind !== "audio" && asset?.kind !== "video") continue;
    let placed = byMedia.get(asset.id);
    if (!placed) byMedia.set(asset.id, placed = { clips: [], audible: [] });
    placed.clips.push(clip);
    if (!track.muted && clip.volume > 0 && (asset.kind === "audio" || asset.hasAudio !== false)) placed.audible.push(clip);
  }
  return byMedia;
}

const coverage = (clips: MediaClip[]) => mergeRanges(clips.map(c => ({ start: c.sourceIn, end: c.sourceOut })), 1e-6);

/** A generic edit can omit dialogue by cutting existing footage or by assembling only selected pieces of a recording.
 * Compare the source time that plays. The tool caller supplies the editorial classification. */
export function removesRecordedFootage(before: Timeline, after: Timeline, project: Project, context?: Task["context"]): boolean {
  const media = new Map(project.media.map(m => [m.id, m]));
  const old = placements(before, media), next = placements(after, media);
  for (const [id, was] of old) {
    const now = next.get(id);
    // Changing the mix alone or removing an unused muted duplicate leaves the source edit intact.
    if (was.audible.length && losesSourceTime(was.audible, now?.audible ?? []) && losesSourceTime(was.clips, now?.clips ?? [])) return true;
  }

  const tolerance = 1e-6;
  const duration = timelineDuration(after);
  const wholeReferences = new Set<string>();
  const needsReference: string[] = [];
  for (const [id, placed] of next) {
    const was = old.get(id);
    const selected = context?.mediaId === id && context.time !== undefined && context.end !== undefined;
    const sourceStart = selected ? context.time! : 0;
    const sourceEnd = selected ? context.end : media.get(id)?.duration;
    const ranges = coverage(placed.clips);
    const complete = ranges.length === 1 && ranges[0]!.start <= sourceStart + tolerance &&
      (sourceEnd === undefined || ranges[0]!.end >= sourceEnd - tolerance);
    const played = mergeRanges(placed.clips.map(c => ({ start: c.timelineIn, end: clipEnd(c) })), tolerance);
    if (complete && played.length === 1 && played[0]!.start <= tolerance && played[0]!.end >= duration - tolerance) wholeReferences.add(id);
    if (!placed.audible.length || was && !losesSourceTime(placed.clips, was.clips)) continue;

    // Adding another piece of an existing recording may introduce a new gap beyond its previous source extent.
    // Gaps already present in the working edit remain available for unrelated edits.
    const heard = coverage(placed.audible);
    const previous = coverage(was?.audible ?? []);
    if (heard.some((r, i) => i > 0 && (!previous.length || r.start > previous.at(-1)!.end + tolerance ||
        heard[i - 1]!.end < previous[0]!.start - tolerance))) return true;
    const heardWholeSource = heard.length === 1 && heard[0]!.start <= sourceStart + tolerance &&
      (sourceEnd === undefined || heard[0]!.end >= sourceEnd - tolerance);
    if (previous.length || heardWholeSource) continue;

    // A synced secondary recording can extend beyond the primary recording. Only the overlapping part plays.
    // Its head or tail may be clipped at the corresponding timeline edge, once a complete reference is present.
    const first = placed.audible.reduce((a, b) => a.sourceIn <= b.sourceIn ? a : b);
    const last = placed.audible.reduce((a, b) => a.sourceOut >= b.sourceOut ? a : b);
    if (first.sourceIn > sourceStart + tolerance && first.timelineIn > tolerance ||
        sourceEnd !== undefined && last.sourceOut < sourceEnd - tolerance && clipEnd(last) < duration - tolerance) return true;
    needsReference.push(id);
  }
  return needsReference.some(id => wholeReferences.size === 0 || wholeReferences.size === 1 && wholeReferences.has(id));
}
