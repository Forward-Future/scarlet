/**
 * Final Cut Pro XML (FCPXML 1.10), which Final Cut Pro and DaVinci Resolve import. The lowest video track is the
 * primary storyline; every other track is a lane of connected clips (video above, sound below, captions on top).
 * Every time is a whole number of frames, as Final Cut requires, counted the way `toOtio` counts them so cuts don't
 * drift against the sound.
 */
import { exactRate, isDropFrameRate, sourceStartQ, type ExactRate, type HandoffSource } from "./handoff.js";
import { trackLayers } from "./otio.js";
import { add, div, fraction, frames, mul, q, secondsQ, snapQ, sub, type Q } from "./rational.js";
import type { CaptionClip, Clip, ColorClip, Marker, MediaClip, Project, Timeline, TransformKeyframe } from "./schema.js";
import { clipEnd } from "./time.js";

// ---------------------------------------------------------------------------
// Rational seconds
// ---------------------------------------------------------------------------

const fmt = (t: Q) => (t.n === 0 ? "0s" : t.d === 1 ? `${t.n}s` : `${t.n}/${t.d}s`);

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // XML 1.0 has no place for most control characters.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

class Node {
  children: Node[] = [];
  text?: string;
  constructor(public name: string, public attrs: Record<string, string | number | undefined> = {}) {}
  add(child: Node) { this.children.push(child); return child; }
  render(indent = ""): string {
    const attrs = Object.entries(this.attrs).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join("");
    if (this.text !== undefined) return `${indent}<${this.name}${attrs}>${esc(this.text)}</${this.name}>`;
    if (!this.children.length) return `${indent}<${this.name}${attrs}/>`;
    return `${indent}<${this.name}${attrs}>\n${this.children.map(c => c.render(indent + "    ")).join("\n")}\n${indent}</${this.name}>`;
  }
}
const el = (name: string, attrs: Record<string, string | number | undefined> = {}, children: Node[] = []) => {
  const node = new Node(name, attrs);
  node.children.push(...children);
  return node;
};

const num = (v: number) => String(Number(v.toFixed(4)));
const decibels = (gain: number) => (gain <= 0.0000158 ? "-96dB" : `${num(20 * Math.log10(gain))}dB`);
const AUDIO_RATES: Record<number, string> = { 32000: "32k", 44100: "44.1k", 48000: "48k", 88200: "88.2k", 96000: "96k", 176400: "176.4k", 192000: "192k" };

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface FcpxmlOptions {
  /** A still for each solid colour the timeline uses, keyed by the colour as written in the cut list. */
  colorStills?: Map<string, HandoffSource>;
}

type Layer = { clips: Clip[]; kind: "video" | "audio"; muted: boolean; hidden: boolean; name: string };

export function toFcpxml(project: Project, timeline: Timeline, sources: Map<string, HandoffSource>, opts: FcpxmlOptions = {}): string {
  const fps = project.settings.fps;
  const rate = exactRate(fps).rate;
  const frameOf = (seconds: number) => Math.round(seconds * rate.num / rate.den);
  const sec = (seconds: number) => secondsQ(seconds, rate);
  const W = project.settings.width, H = project.settings.height;

  // Resources: the sequence's format, one format per kind of footage, one asset per file.
  const resources = el("resources");
  let nextId = 1;
  const formats = new Map<string, string>();
  const formatFor = (r: ExactRate | undefined, width?: number, height?: number) => {
    const key = `${r ? `${r.den}/${r.num}` : "still"}:${width ?? ""}x${height ?? ""}`;
    let id = formats.get(key);
    if (!id) {
      id = `r${nextId++}`;
      formats.set(key, id);
      // A still has no frame rate; Final Cut names that format so.
      resources.add(el("format", { id, name: r ? undefined : "FFVideoFormatRateUndefined", frameDuration: r ? fmt(q(r.den, r.num)) : undefined, width, height }));
    }
    return id;
  };
  const sequenceFormat = formatFor(rate, W, H);

  const assets = new Map<HandoffSource, string>();
  const assetFor = (source: HandoffSource, name: string) => {
    let id = assets.get(source);
    if (id) return id;
    const format = source.hasVideo ? formatFor(source.still ? undefined : source.rate ?? rate, source.width, source.height) : undefined;
    id = `r${nextId++}`;
    assets.set(source, id);
    const start = sourceStartQ(source);
    resources.add(el("asset", {
      id, name, start: fmt(start), duration: source.still ? "0s" : fmt(secondsQ(source.duration, source.rate ?? rate)),
      hasVideo: source.hasVideo ? 1 : undefined, format,
      hasAudio: source.hasAudio ? 1 : undefined,
      audioSources: source.hasAudio ? Math.max(1, source.audioStreams ?? 1) : undefined,
      audioChannels: source.hasAudio ? source.audioChannels ?? 2 : undefined,
      audioRate: source.hasAudio ? source.audioRate ?? 48000 : undefined,
    }, [el("media-rep", { kind: "original-media", src: source.url })]));
    return id;
  };
  const media = new Map(project.media.map(m => [m.id, m]));

  // Tracks, bottom first, each split where its clips overlap.
  const videoLayers: Layer[] = [], audioLayers: Layer[] = [], captionLayers: Layer[] = [];
  for (const track of timeline.tracks) {
    const target = track.kind === "video" ? videoLayers : track.kind === "audio" ? audioLayers : captionLayers;
    for (const clips of trackLayers(track.clips, true, track.kind === "audio")) {
      target.push({ clips, kind: track.kind === "audio" ? "audio" : "video", muted: track.muted, hidden: track.hidden, name: track.name });
    }
  }
  const primary = videoLayers.shift() ?? { clips: [], kind: "video" as const, muted: false, hidden: false, name: "V1" };

  const ends = timeline.tracks.flatMap(t => t.clips.map(clipEnd));
  const totalFrames = Math.max(1, frameOf(Math.max(0, ...ends, ...timeline.markers.map(m => m.end ?? m.time))));

  // The primary storyline: its clips, and gaps between them and after them so every lane has something to hang on.
  type SpineItem = { node: Node; from: number; to: number; localStart: Q };
  const spine: SpineItem[] = [];
  let cursor = 0;
  const gap = (from: number, to: number) => {
    const localStart = frames(from, rate);
    spine.push({ node: el("gap", { name: "Gap", offset: fmt(frames(from, rate)), start: fmt(localStart), duration: fmt(frames(to - from, rate)) }), from, to, localStart });
  };
  for (const clip of [...primary.clips].sort((a, b) => a.timelineIn - b.timelineIn)) {
    const from = frameOf(clip.timelineIn), to = frameOf(clipEnd(clip));
    if (to <= from || from < cursor) continue;
    if (from > cursor) gap(cursor, from);
    const built = clipNode(clip, primary, 0, frames(from, rate), from, to);
    if (built) spine.push({ node: built.node, from, to, localStart: built.localStart });
    else gap(from, to);
    cursor = to;
  }
  if (cursor < totalFrames) gap(cursor, totalFrames);

  /** The storyline item a connected clip at this frame hangs on, and where that frame is on the item's own clock. */
  function anchor(frame: number): { item: SpineItem; offset: Q } {
    const item = spine.find(s => frame >= s.from && frame < s.to) ?? spine[spine.length - 1]!;
    return { item, offset: add(item.localStart, frames(frame - item.from, rate)) };
  }
  const anchored: Array<{ item: SpineItem; node: Node }> = [];
  const connect = (layer: Layer, lane: number) => {
    for (const clip of layer.clips) {
      const from = frameOf(clip.timelineIn), to = frameOf(clipEnd(clip));
      if (to <= from) continue;
      const { item, offset } = anchor(from);
      const built = clipNode(clip, layer, lane, offset, from, to);
      if (built) anchored.push({ item, node: built.node });
    }
  };
  videoLayers.forEach((layer, i) => connect(layer, i + 1));
  audioLayers.forEach((layer, i) => connect(layer, -(i + 1)));
  captionLayers.forEach((layer, i) => connect(layer, videoLayers.length + i + 1));

  // Markers sit on the storyline item at their time, on its clock.
  const markers: Array<{ item: SpineItem; node: Node }> = [];
  for (const marker of timeline.markers) {
    const from = Math.min(frameOf(marker.time), totalFrames - 1);
    const length = Math.max(1, marker.end !== undefined ? frameOf(marker.end) - from : 1);
    const { item, offset } = anchor(from);
    markers.push({ item, node: markerNode(marker, offset, frames(length, rate)) });
  }
  // Connected clips come before markers inside each storyline item, as the DTD orders them.
  for (const item of spine) {
    for (const a of anchored) if (a.item === item) item.node.add(a.node);
    for (const m of markers) if (m.item === item) item.node.add(m.node);
  }

  /** A clip as an `asset-clip` (a still as a `video`, a caption as a `caption`), placed at `offset` on its parent's clock. */
  function clipNode(clip: Clip, layer: Layer, lane: number, offset: Q, from: number, to: number): { node: Node; localStart: Q } | undefined {
    const duration = frames(to - from, rate);
    const laneAttr = lane || undefined;
    if (clip.kind === "caption") {
      const node = captionNode(clip, laneAttr, offset, duration);
      if (layer.hidden) node.attrs.enabled = 0;
      return { node, localStart: q(0) };
    }
    const source = clip.kind === "color" ? opts.colorStills?.get(clip.color) : sources.get(clip.mediaId);
    if (!source) return;
    const name = clip.kind === "color" ? `Solid ${clip.color}` : clip.label || media.get(clip.mediaId)?.name || source.fileName;
    const ref = assetFor(source, clip.kind === "color" ? name : source.fileName);
    const speed = clip.kind === "media" ? clip.speed ?? 1 : 1;
    const sourceRate = source.rate ?? rate;
    // Where the clip starts reading: the footage's own clock (its timecode) plus the clip's start, on the footage's frames.
    let localStart = clip.kind === "media" && !source.still ? add(sourceStartQ(source), secondsQ(clip.sourceIn, sourceRate)) : q(0);
    // Final Cut places a still image as a `video`, an asset with no length of its own.
    const node = el(source.still ? "video" : "asset-clip", { ref, lane: laneAttr, offset: fmt(offset), name, start: undefined, duration: fmt(duration) });
    if (speed !== 1 && clip.kind === "media" && !source.still) {
      // A retimed clip's own clock runs at its speed: the time map turns that clock back into the footage's. Its start
      // is on the sequence's frames like every other time, and the map uses the same speed the duration was counted at.
      const rateQ = fraction(speed);
      localStart = snapQ(div(localStart, rateQ), rate);
      const footageEnd = snapQ(div(add(sourceStartQ(source), q(Math.ceil(source.duration * 1000), 1000)), rateQ), rate);
      const clipStop = add(localStart, duration);
      const last = sub(footageEnd, clipStop).n >= 0 ? footageEnd : clipStop;
      node.add(el("timeMap", {}, [
        el("timept", { time: "0s", value: "0s", interp: "linear" }),
        el("timept", { time: fmt(last), value: fmt(mul(last, rateQ)), interp: "linear" }),
      ]));
    }
    node.attrs.start = localStart.n ? fmt(localStart) : undefined;

    // A hidden picture track that is heard keeps only its sound; one that isn't heard either is off.
    const heard = clip.kind === "media" && source.hasAudio && !layer.muted && clip.volume > 0;
    const shown = source.hasVideo && layer.kind === "video" && !layer.hidden;
    if (layer.kind === "audio" && source.hasVideo && source.hasAudio) node.attrs.srcEnable = "audio";
    else if (layer.kind === "video" && source.hasVideo && source.hasAudio && shown !== heard) node.attrs.srcEnable = heard ? "audio" : "video";
    const enabled = clip.enabled !== false && (layer.kind === "audio" ? !layer.muted : shown || heard);
    if (!enabled) node.attrs.enabled = 0;

    if (source.hasVideo && layer.kind === "video" && node.attrs.srcEnable !== "audio") {
      for (const adjustment of pictureAdjustments(clip, localStart, duration, source)) node.add(adjustment);
    }
    if (clip.kind === "media" && source.hasAudio && !layer.muted && node.attrs.srcEnable !== "video") {
      const volume = soundAdjustment(clip);
      if (volume) node.add(volume);
    }
    return { node, localStart };
  }

  function pictureAdjustments(clip: MediaClip | ColorClip, localStart: Q, duration: Q, source: HandoffSource): Node[] {
    const out: Node[] = [];
    const tf = clip.transform;
    const srcW = source.width ?? W, srcH = source.height ?? H;
    if (tf && (tf.cropLeft || tf.cropRight || tf.cropTop || tf.cropBottom)) {
      // Crop is measured in percent of the footage's height, on every side.
      out.push(el("adjust-crop", { mode: "crop" }, [el("crop-rect", {
        left: num(tf.cropLeft * srcW / srcH * 100), right: num(tf.cropRight * srcW / srcH * 100),
        top: num(tf.cropTop * 100), bottom: num(tf.cropBottom * 100),
      })]));
    }
    // Position is in percent of the frame's height, up and to the right; rotation turns anticlockwise.
    const position = (x: number, y: number) => `${num(x * W / H * 100)} ${num(-y * 100)}`;
    const keyframes = clip.kind === "media" ? clip.keyframes ?? [] : [];
    if (tf || keyframes.length) {
      const base = { x: tf?.x ?? 0, y: tf?.y ?? 0, scale: tf?.scale ?? 1, rotation: tf?.rotation ?? 0 };
      const transform = el("adjust-transform", {
        position: position(base.x, base.y), scale: `${num(base.scale)} ${num(base.scale)}`,
        rotation: base.rotation ? num(-base.rotation) : undefined,
      });
      const sorted = [...keyframes].sort((a, b) => a.time - b.time);
      const at = (k: TransformKeyframe) => fmt(add(localStart, sec(Math.max(0, k.time))));
      const moves = sorted.filter(k => k.transform.x !== undefined || k.transform.y !== undefined);
      if (moves.length) {
        transform.add(el("param", { name: "position" }, [el("keyframeAnimation", {}, moves.map(k => el("keyframe", {
          time: at(k), value: position(k.transform.x ?? base.x, k.transform.y ?? base.y), ...ease(k),
        })))]));
      }
      const zooms = sorted.filter(k => k.transform.scale !== undefined);
      if (zooms.length) {
        transform.add(el("param", { name: "scale" }, [el("keyframeAnimation", {}, zooms.map(k => el("keyframe", {
          time: at(k), value: `${num(k.transform.scale!)} ${num(k.transform.scale!)}`, ...ease(k),
        })))]));
      }
      out.push(transform);
    }
    const opacity = clip.opacity ?? 1;
    const fadeIn = clip.kind === "media" ? clip.videoFadeIn : 0, fadeOut = clip.kind === "media" ? clip.videoFadeOut : 0;
    if (opacity < 1 || fadeIn > 0 || fadeOut > 0) {
      const blend = el("adjust-blend", { amount: num(opacity) });
      if (fadeIn > 0 || fadeOut > 0) {
        const end = add(localStart, duration);
        const keys: Node[] = [];
        if (fadeIn > 0) {
          keys.push(el("keyframe", { time: fmt(localStart), value: "0" }));
          keys.push(el("keyframe", { time: fmt(add(localStart, sec(fadeIn))), value: num(opacity) }));
        }
        if (fadeOut > 0) {
          keys.push(el("keyframe", { time: fmt(sub(end, sec(fadeOut))), value: num(opacity) }));
          keys.push(el("keyframe", { time: fmt(end), value: "0" }));
        }
        blend.add(el("param", { name: "amount" }, [el("keyframeAnimation", {}, keys)]));
      }
      out.push(blend);
    }
    return out;
  }

  function soundAdjustment(clip: MediaClip): Node | undefined {
    if (clip.volume === 1 && !clip.audioFadeIn && !clip.audioFadeOut) return;
    const volume = el("adjust-volume", { amount: decibels(clip.volume) });
    if (clip.audioFadeIn || clip.audioFadeOut) {
      const param = volume.add(el("param", { name: "amount" }));
      if (clip.audioFadeIn) param.add(el("fadeIn", { type: "linear", duration: fmt(sec(clip.audioFadeIn)) }));
      if (clip.audioFadeOut) param.add(el("fadeOut", { type: "linear", duration: fmt(sec(clip.audioFadeOut)) }));
    }
    return volume;
  }

  function captionNode(clip: CaptionClip, lane: number | undefined, offset: Q, duration: Q): Node {
    const node = el("caption", { lane, offset: fmt(offset), name: clip.text.slice(0, 60), duration: fmt(duration),
      enabled: clip.enabled === false ? 0 : undefined, role: "SRT?captionFormat=SRT.en" });
    const text = el("text");
    text.text = clip.text;
    node.add(text);
    return node;
  }

  function markerNode(marker: Marker, start: Q, duration: Q): Node {
    if (marker.kind === "chapter") return el("chapter-marker", { start: fmt(start), duration: fmt(duration), value: marker.text || "Chapter" });
    return el("marker", { start: fmt(start), duration: fmt(duration), value: marker.text || "Marker",
      completed: marker.kind === "todo" ? (marker.resolved ? 1 : 0) : undefined });
  }

  const dropFrame = isDropFrameRate(rate);
  const sequence = el("sequence", {
    format: sequenceFormat, duration: fmt(frames(totalFrames, rate)), tcStart: "0s", tcFormat: dropFrame ? "DF" : "NDF",
    audioLayout: project.settings.audioChannels === 1 ? "mono" : "stereo", audioRate: AUDIO_RATES[project.settings.sampleRate] ?? "48k",
  }, [el("spine", {}, spine.map(s => s.node))]);
  const doc = el("fcpxml", { version: "1.10" }, [
    resources,
    el("library", {}, [el("event", { name: project.name }, [el("project", { name: `${project.name} — ${timeline.name}` }, [sequence])])]),
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n\n${doc.render()}\n`;
}

/** Scarlet's easing as Final Cut's keyframe interpolation. A hold has no equivalent and moves evenly. */
function ease(k: TransformKeyframe): { interp?: string; curve?: string } {
  switch (k.ease) {
    case "easeIn": return { interp: "easeIn", curve: "smooth" };
    case "easeOut": return { interp: "easeOut", curve: "smooth" };
    case "easeInOut": return { interp: "ease", curve: "smooth" };
    default: return { interp: "linear", curve: "linear" };
  }
}

