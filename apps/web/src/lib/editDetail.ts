import { clipRange, type Change, type Clip, type MediaAsset, type Timeline, type TimeRange, type Transition } from "@scarlet/timeline";
import type { EditKind } from "@scarlet/shared";

type Op = Record<string, unknown>;

/** Kinds whose card says exactly what they did, read from the change's own steps. A cut's words are read elsewhere. */
const DETAILED = new Set<EditKind>(["overlay", "graphic", "text", "zoom", "reframe", "audio", "speed", "transition"]);
/** A step this far either side of an edit still lands on it: Scarlet's times and a clip's edge differ by rounding. */
const SLACK = 0.5;
/** A quote longer than this is cut short. */
const QUOTE_MOST = 90;

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (value: number) => `${Math.round(value * 10) / 10} s`;
const plainName = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "");
const quote = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? `“${flat.length > QUOTE_MOST ? `${flat.slice(0, QUOTE_MOST - 1).trimEnd()}…` : flat}”` : undefined;
};
const gain = (volume: number) => {
  if (volume <= 0) return "muted";
  const db = Math.round(20 * Math.log10(volume));
  return db === 0 ? "at full level" : `${db > 0 ? "+" : "−"}${Math.abs(db)} dB`;
};
const transitionWords = (t: Partial<Transition>) => {
  if (!t.type) return;
  const name = t.type[0]!.toUpperCase() + t.type.slice(1);
  const way = t.type === "push" || t.type === "slide" || t.type === "whip" ? ` ${t.direction ?? "left"}` : "";
  return typeof t.duration === "number" ? `${name}${way}, ${seconds(t.duration)}` : `${name}${way}`;
};

/**
 * One plain line that says exactly what an edit did, from the steps of the change that made it: the words a caption
 * reads, the file laid over the picture, how far a zoom goes, how loud the sound now plays. None when the steps say
 * nothing a line can name, or the edit is a cut, whose words are read from its transcript.
 */
export function editDetail(change: Pick<Change, "ops"> | undefined, edit: { kind?: EditKind; range: TimeRange },
  { timeline, media }: { timeline?: Timeline | null; media: readonly Pick<MediaAsset, "id" | "name">[] }): string | undefined {
  if (!change?.ops?.length || !edit.kind || !DETAILED.has(edit.kind)) return;
  const ops = change.ops as Op[];
  const clips = new Map<string, Clip>();
  const trackOf = new Map<string, { kind: string; name: string }>();
  for (const track of timeline?.tracks ?? []) {
    trackOf.set(track.id, { kind: track.kind, name: track.name });
    for (const clip of track.clips) if (!clips.has(clip.id)) clips.set(clip.id, clip);
  }
  for (const op of ops) {
    const track = op.op === "addTrack" ? op.track as { id?: string; kind?: string; name?: string } | undefined : undefined;
    if (track?.id && track.kind) trackOf.set(track.id, { kind: track.kind, name: track.name ?? "" });
  }
  const mediaName = (clip: Clip | undefined) => {
    if (clip?.kind !== "media") return;
    const file = media.find(m => m.id === clip.mediaId);
    return file && plainName(file.name);
  };
  const rangeOf = (clip: Clip | undefined) => {
    if (!clip) return;
    try { return clipRange(clip); } catch { return; }
  };
  const near = (range: TimeRange | undefined) => !range || (range.start <= edit.range.end + SLACK && range.end >= edit.range.start - SLACK);

  const said = (op: Op): (string | undefined)[] => {
    if (op.op === "addClip") {
      const clip = op.clip as Clip | undefined;
      if (!clip || !near(rangeOf(clip))) return [];
      if (clip.kind === "caption") return [quote(clip.text)];
      if (clip.kind === "color") return ["A colour card"];
      const name = mediaName(clip);
      const track = typeof op.trackId === "string" ? trackOf.get(op.trackId) : undefined;
      if (track?.kind === "audio") return [name && `Added ${name}${clip.volume !== undefined && clip.volume !== 1 ? `, ${gain(clip.volume)}` : ""}`];
      return [name];
    }
    if (op.op === "updateClip") {
      const clip = typeof op.clipId === "string" ? clips.get(op.clipId) : undefined;
      if (!near(rangeOf(clip))) return [];
      const patch = op.patch && typeof op.patch === "object" ? op.patch as Record<string, unknown> : {};
      const name = mediaName(clip);
      const lines: (string | undefined)[] = [];
      const transform = patch.transform as { scale?: unknown } | undefined;
      const keyframes = Array.isArray(patch.keyframes) ? (patch.keyframes as { transform?: { scale?: unknown } }[])
        .map(k => k.transform?.scale).filter((s): s is number => typeof s === "number") : [];
      if (keyframes.length > 1 && keyframes[0] !== keyframes.at(-1)) lines.push(`${edit.kind === "zoom" ? "Zooms" : "Scales"} ${percent(keyframes[0]!)} → ${percent(keyframes.at(-1)!)}`);
      else if (typeof transform?.scale === "number") lines.push(transform.scale > 1.001 ? `Zoom to ${percent(transform.scale)}` : transform.scale < 0.999 ? `Inset at ${percent(transform.scale)}` : undefined);
      if (typeof patch.volume === "number") lines.push(`${name ? `${name} ` : "Sound "}${gain(patch.volume)}`);
      if (typeof patch.audioFadeIn === "number" && patch.audioFadeIn > 0) lines.push(`Sound fades in over ${seconds(patch.audioFadeIn)}`);
      if (typeof patch.audioFadeOut === "number" && patch.audioFadeOut > 0) lines.push(`Sound fades out over ${seconds(patch.audioFadeOut)}`);
      if (typeof patch.speed === "number") lines.push(`${Math.round(patch.speed * 100) / 100}× speed`);
      if (typeof patch.text === "string") lines.push(quote(patch.text));
      if (patch.transitionIn && typeof patch.transitionIn === "object") lines.push(transitionWords(patch.transitionIn as Partial<Transition>));
      if (typeof patch.opacity === "number") lines.push(`${name ? `${name} at ` : ""}${percent(patch.opacity)} opacity`);
      if (typeof patch.videoFadeIn === "number" && patch.videoFadeIn > 0) lines.push(`Fades in over ${seconds(patch.videoFadeIn)}`);
      if (typeof patch.videoFadeOut === "number" && patch.videoFadeOut > 0) lines.push(`Fades out over ${seconds(patch.videoFadeOut)}`);
      return lines;
    }
    if (op.op === "updateTrack") {
      const patch = op.patch && typeof op.patch === "object" ? op.patch as Record<string, unknown> : {};
      const track = typeof op.trackId === "string" ? trackOf.get(op.trackId) : undefined;
      if (patch.muted === true) return [`Muted ${track?.name || "a track"}`];
      if (patch.muted === false) return [`Unmuted ${track?.name || "a track"}`];
    }
    return [];
  };

  const lines = [...new Set(ops.flatMap(said).filter((line): line is string => !!line))];
  if (!lines.length) return;
  // Two say most edits whole. A change of many steps (a run of captions) names its first two and counts the rest.
  const shown = lines.slice(0, 2).join(" · ");
  return lines.length > 2 ? `${shown} · ${lines.length - 2} more` : shown;
}
