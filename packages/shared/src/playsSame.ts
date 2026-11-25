import { clipRange, timelineDuration, type Timeline, type TimeRange } from "@scarlet/timeline";

/** A fade this short eases a join, and is no change the editor looks at: two frames at 30 fps is 0.067 s. */
export const SHORT_FADE = 0.25;

type Clip = Timeline["tracks"][number]["clips"][number];

/** A saved timeline may leave out what a clip has by default. */
const MEDIA_DEFAULTS = { speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [] };

/** What a clip plays, apart from where and for how long: the same key is the same footage, laid the same way. */
function playKey(clip: Clip, role: string) {
  const { id: _id, timelineIn, label: _label, enabled: _enabled, ...rest } = clip as Clip & Record<string, unknown>;
  const fields: Record<string, unknown> = clip.kind === "media" ? { ...MEDIA_DEFAULTS, ...rest } : { ...rest };
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  if (clip.kind === "media") {
    // The moment of the recording the clip plays at the timeline's zero: trimming or lengthening a clip keeps it.
    fields.sourceIn = Math.round((clip.sourceIn - timelineIn * (clip.speed ?? 1)) * 1000) / 1000;
    delete fields.sourceOut;
    for (const fade of ["audioFadeIn", "audioFadeOut"] as const) if ((clip[fade] ?? 0) <= SHORT_FADE) delete fields[fade];
    if (role === "sound") for (const key of ["transform", "keyframes", "opacity", "videoFadeIn", "videoFadeOut", "transitionIn"]) delete fields[key];
    else for (const key of ["volume", "volumeKeyframes", "audioFadeIn", "audioFadeOut", "audioTrack", "splitEdit"]) delete fields[key];
  } else delete fields.timelineOut;
  return `${role}|${stable(fields)}`;
}

/** JSON with every object's keys in order, so two clips saved with their fields in another order read the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** How long each thing the timeline plays plays within `range`, by what it plays. */
function playing(timeline: Timeline, range: TimeRange) {
  const seconds = new Map<string, number>();
  let videoTrack = 0;
  for (const track of timeline.tracks) {
    const layer = track.kind === "video" ? videoTrack++ : -1;
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      let placed: TimeRange;
      try { placed = clipRange(clip); } catch { continue; }
      const length = Math.min(placed.end, range.end) - Math.max(placed.start, range.start);
      if (length <= 1e-6) continue;
      const roles: string[] = [];
      // A clip on a video track is seen, and heard too when it is a recording; one on an audio track is only heard.
      if (track.kind !== "audio" && !track.hidden && (clip.kind !== "media" || (clip.opacity ?? 1) > 0)) roles.push(`picture@${track.kind}${layer}`);
      if (track.kind !== "caption" && !track.muted && clip.kind === "media" && (clip.volume ?? 1) > 0) roles.push("sound");
      for (const role of roles) {
        const key = playKey(clip, role);
        seconds.set(key, (seconds.get(key) ?? 0) + length);
      }
    }
  }
  return seconds;
}

/**
 * Whether `after` plays what `before` played through `range`, a stretch on both their clocks: the same recordings at
 * the same moments, laid over one another the same way and at the same level. Which track carries a sound is no
 * difference, and nor is a fade or an overlap no longer than SHORT_FADE: moving a voice to the dialogue track, or
 * easing a join with a two-frame fade, changes nothing the editor sees or hears.
 */
export function playsSame(before: Timeline, after: Timeline, range: TimeRange, fps: number): boolean {
  if (Math.abs(timelineDuration(before) - timelineDuration(after)) > 0.5 / fps) return false;
  const was = playing(before, range), now = playing(after, range);
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    if (Math.abs((was.get(key) ?? 0) - (now.get(key) ?? 0)) > SHORT_FADE) return false;
  }
  return true;
}
