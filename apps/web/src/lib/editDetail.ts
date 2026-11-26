import { clipRange, splitEditWords, type Change, type Clip, type MediaAsset, type Timeline, type TimeRange, type Transition } from "@scarlet/timeline";
import type { EditKind } from "@scarlet/shared";

type Op = Record<string, unknown>;

/** Kinds whose card says exactly what they did, read from the change's own steps. A cut's words are read elsewhere. */
const DETAILED = new Set<EditKind>(["overlay", "graphic", "text", "zoom", "reframe", "audio", "dip", "voice", "speed", "transition", "split"]);
/** A step this far either side of an edit still lands on it: Scarlet's times and a clip's edge differ by rounding. */
const SLACK = 0.5;
/** Two stretches that share less than this only touch. */
const TOUCH = 0.05;
/** A quote longer than this is cut short. */
const QUOTE_MOST = 90;

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (value: number) => `${Math.round(value * 10) / 10} s`;
const plainName = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "");
/**
 * Default camera, phone, and screen-recorder names (such as "2026-11-24 10-26-50" or "IMG_4821") tell the editor
 * nothing about what is in the clip, so the card leaves them out unless the clip has a label of its own.
 */
const RAW_MEDIA_NAME = /^(?:(?:screen\s*recording|screenshot|recording|cleanshot|movie\s*recording|audio\s*recording|video|audio|capture|clip|take)[\s_-]*)?(?:\d{4}[-_.]\d{2}[-_.]\d{2}(?:(?:[\s_T-]+|[\s_]+at[\s_]+)\d{1,2}[-_.:]\d{2}(?:[-_.:]\d{2})?(?:[\s_]*(?:am|pm))?)?|\d{8}[_-]\d{6,9})[\s_-]*(?:\(\d+\)|\d+)?$|^(?:img|vid|mov|mvi|dsc|dscf|dscn|pxl|dji|gopr|gh\d{2}|gx\d{2}|mah|clip|rec|cam|c|a\d{3}c\d{3})[_-]?\d{3,}(?:[_-][a-z0-9]+)*$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\d+$/i;
const helpfulName = (name: string | undefined) => {
  const clean = name?.trim();
  return clean && !RAW_MEDIA_NAME.test(plainName(clean)) ? clean : undefined;
};
const quote = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? `“${flat.length > QUOTE_MOST ? `${flat.slice(0, QUOTE_MOST - 1).trimEnd()}…` : flat}”` : undefined;
};
const gain = (volume: number) => {
  if (volume <= 0) return "muted";
  const db = Math.round(20 * Math.log10(volume));
  return db === 0 ? "at full level" : `${db > 0 ? "+" : "−"}${Math.abs(db)} dB`;
};
const decibels = (db: number) => {
  const whole = Math.round(db);
  return whole === 0 ? "0 dB" : `${whole > 0 ? "+" : "−"}${Math.abs(whole)} dB`;
};
/**
 * How a clip's volume keyframes move its level, on top of its volume: how far it goes and in how many places, as runs
 * of keys under (or over) the clip's own level.
 */
const levelWords = (keys: unknown, volume: number) => {
  if (!Array.isArray(keys)) return;
  const dbs = (keys as { time?: unknown; db?: unknown }[]).filter(k => typeof k?.db === "number" && typeof k.time === "number")
    .sort((a, b) => (a.time as number) - (b.time as number)).map(k => k.db as number);
  if (!dbs.length) return;
  const low = Math.min(...dbs), high = Math.max(...dbs);
  const down = low < 0 && -low >= high;
  const runs = dbs.filter((db, i) => (down ? db < 0 : db > 0) && !(i > 0 && (down ? dbs[i - 1]! < 0 : dbs[i - 1]! > 0))).length;
  const base = volume > 0 ? 20 * Math.log10(volume) : 0;
  if (!runs) return;
  return `${down ? "down" : "up"} to ${decibels(base + (down ? low : high))}${runs > 1 ? ` in ${runs} places` : ""}`;
};
const cleanupOf = (effects: unknown) => Array.isArray(effects)
  ? (effects as { type?: unknown; enabled?: unknown; params?: { mix?: unknown } }[]).find(e => e?.type === "voiceCleanup" && e.enabled !== false)
  : undefined;
const voiceWords = (effects: unknown) => {
  const cleanup = cleanupOf(effects);
  if (!cleanup) return;
  const mix = cleanup.params?.mix;
  return typeof mix === "number" && mix < 1 ? `at ${percent(Math.max(0, mix))}` : "";
};
const transitionWords = (t: Partial<Transition>) => {
  if (!t.type) return;
  const name = t.type[0]!.toUpperCase() + t.type.slice(1);
  const way = t.type === "push" || t.type === "slide" || t.type === "whip" ? ` ${t.direction ?? "left"}` : "";
  return typeof t.duration === "number" ? `${name}${way}, ${seconds(t.duration)}` : `${name}${way}`;
};

/**
 * One plain line that says exactly what an edit did, from the steps of the change that made it: the words a caption
 * reads, the file laid over the picture, how far a zoom goes, how loud the sound now plays, how far a join's sound
 * leads or trails its picture. None when the steps say nothing a line can name, or the edit is a cut, whose words are
 * read from its transcript. `fps` lets a split edit under a second read in frames.
 */
export function editDetail(change: Pick<Change, "ops"> | undefined, edit: { kind?: EditKind; range: TimeRange },
  { timeline, before, media, fps }: { timeline?: Timeline | null; before?: Timeline | null; media: readonly Pick<MediaAsset, "id" | "name">[]; fps?: number }): string | undefined {
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
    const labeled = helpfulName(clip.label);
    if (labeled) return labeled;
    const file = media.find(m => m.id === clip.mediaId);
    return file && helpfulName(plainName(file.name));
  };
  const rangeOf = (clip: Clip | undefined) => {
    if (!clip) return;
    try { return clipRange(clip); } catch { return; }
  };
  // A clip that only touches an edit of some length belongs to the edit beside it: a punch-in starting where an inset ends.
  const near = (range: TimeRange | undefined) => !range || (range.start <= edit.range.end + SLACK && range.end >= edit.range.start - SLACK
    && (edit.range.end - edit.range.start <= TOUCH || range.end - range.start <= TOUCH
      || Math.min(range.end, edit.range.end) - Math.max(range.start, edit.range.start) > TOUCH));

  const said = (op: Op): (string | undefined)[] => {
    if (op.op === "addClip") {
      const clip = op.clip as Clip | undefined;
      if (!clip || !near(rangeOf(clip))) return [];
      if (clip.kind === "caption") return [quote(clip.text)];
      if (clip.kind === "color") return ["A color card"];
      const name = mediaName(clip);
      const track = typeof op.trackId === "string" ? trackOf.get(op.trackId) : undefined;
      const moves = levelWords(clip.volumeKeyframes, clip.volume ?? 1), cleaned = voiceWords(clip.effects);
      const sound = [moves && `${name ?? "Sound"} ${moves}`, cleaned !== undefined ? `Voice cleanup${cleaned ? ` ${cleaned}` : ""}` : undefined];
      if (track?.kind === "audio") {
        const added = name ? `Added ${name}${clip.volume !== undefined && clip.volume !== 1 ? `, ${gain(clip.volume)}` : ""}`
          : clip.volume !== undefined && clip.volume !== 1 ? `Added sound, ${gain(clip.volume)}` : undefined;
        return [added, ...sound];
      }
      return [name, ...sound];
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
      if (keyframes.length > 1 && keyframes[0] !== keyframes.at(-1)) {
        if (edit.kind !== "reframe" || keyframes.every(s => s <= 1.001)) {
          lines.push(`${edit.kind === "zoom" ? "Zooms" : "Scales"} ${percent(keyframes[0]!)} → ${percent(keyframes.at(-1)!)}`);
        }
      } else if (typeof transform?.scale === "number") {
        if (transform.scale > 1.001 && edit.kind !== "reframe") lines.push(`Zoom to ${percent(transform.scale)}`);
        else if (transform.scale < 0.999) lines.push(`Inset at ${percent(transform.scale)}`);
      }
      if (typeof patch.volume === "number") lines.push(`${name ? `${name} ` : "Sound "}${gain(patch.volume)}`);
      if ("volumeKeyframes" in patch) {
        const volume = typeof patch.volume === "number" ? patch.volume : clip?.kind === "media" ? clip.volume ?? 1 : 1;
        const moves = levelWords(patch.volumeKeyframes, volume);
        lines.push(moves ? `${name ?? "Sound"} ${moves}` : `${name ? `${name} back` : "Sound back"} to a steady level`);
      }
      // Voice cleanup is named only where this edit put it on or changed it, read against the version the edit was made
      // on: an edit to another effect of a clip already cleaned didn't. Until that version is read, only a voice edit did.
      const was = before?.tracks.flatMap(t => t.clips).find(c => c.id === op.clipId);
      const cleanupChanged = before ? JSON.stringify(cleanupOf(patch.effects)) !== JSON.stringify(cleanupOf(was?.kind === "media" ? was.effects : undefined))
        : edit.kind === "voice";
      if ("effects" in patch && cleanupChanged) {
        const cleaned = voiceWords(patch.effects);
        if (cleaned !== undefined) lines.push(`Voice cleanup${name ? ` on ${name}` : ""}${cleaned ? ` ${cleaned}` : ""}`);
      }
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

  if (edit.kind === "split") {
    // A split edit says only how far each join's sound moved: the copy it handed to a dialogue track and the silenced
    // picture are how it did it, not what it did. A sound whose split was taken off says so only when nothing moved.
    let straight = false;
    const lines = [...new Set(ops.flatMap(op => {
      const clip = op.op === "addClip" ? op.clip as Clip | undefined : op.op === "updateClip" && typeof op.clipId === "string" ? clips.get(op.clipId) : undefined;
      const record = op.op === "addClip" ? (clip as { splitEdit?: unknown } | undefined)?.splitEdit
        : op.op === "updateClip" && op.patch && typeof op.patch === "object" ? (op.patch as { splitEdit?: unknown }).splitEdit : undefined;
      if (record === undefined || !near(rangeOf(clip))) return [];
      if (record === null) { straight = true; return []; }
      return typeof record === "object" ? splitEditWords(record as { leads?: number; trails?: number }, fps) : [];
    }))];
    if (!lines.length) return straight ? "Sound cuts with the picture" : undefined;
    return lines.length > 2 ? `${lines.slice(0, 2).join(" · ")} · ${lines.length - 2} more` : lines.join(" · ");
  }
  const lines = [...new Set(ops.flatMap(said).filter((line): line is string => !!line))];
  if (!lines.length) return;
  // Two say most edits whole. A change of many steps (a run of captions) names its first two and counts the rest.
  const shown = lines.slice(0, 2).join(" · ");
  return lines.length > 2 ? `${shown} · ${lines.length - 2} more` : shown;
}
