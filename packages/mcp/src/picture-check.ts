/**
 * What the closing check of a pass lists about the picture, beside the dialogue:
 * - `brief`: the video switches picture and back within a moment
 * - `offPicture`: a recording laid over the main picture is off it while it still shows what it showed
 * - `moveAcrossCut`: a gliding zoom or pan runs across a moment where the screen changes to a new page, tab or demo
 * - `clippedText`: the frame's edge cuts through lines of text (or leaves out text the speaker reads aloud)
 * - `underCover`: a picture laid over the screen (such as the camera inset) sits on text, read-aloud words or content
 * - `smallText`: text in the framed screen is smaller than the readability bar at the video's size
 * - `blankScreen`: the framed screen shows almost nothing (a blank canvas or loading placeholder)
 *
 * Each was either already in a save's report (`briefPictures`, `framed`) or directly measured by screen perception,
 * and passes read past them (project 88 on 2026-11-21; project 444 on 2026-11-24 left 12 sliding zooms across demo
 * changes, cut-off text, covered pricing/chat text, unreadable small text, and a 2 s "Loading scene…" hold). The
 * closing check lists them beside the repeats and silences, each to be fixed or kept with a reason. Like those it is
 * evidence: a pass that says it is done is done, and nothing sends it back for a finding it left (`docs/AI-AGENTS.md`
 * rule 4). Whether each framing choice is right is the model's call; the skill says what the editor likes.
 */
import { clipEnd, type MediaClip, type Timeline } from "@scarlet/timeline";
import { round2 } from "./analysis.js";
import type { BriefPicture } from "./brief-pictures.js";
import type { Corner } from "./framing.js";
import type { FramedStretch } from "./framing-report.js";

// A type, not an interface: it travels as the check's passthrough findings.
export type PictureFinding = {
  /** Stays the same while the same footage plays there: a keep given by it holds across later saves elsewhere. */
  id: string;
  /**
   * `brief`: a picture on screen for under a second between two others.
   * `offPicture`: a recording laid over the main picture elsewhere is off picture here while it still shows what it showed beside it.
   * `moveAcrossCut`: a gliding zoom or pan runs across a switch to a new screen, page or demo.
   * `clippedText`: the frame's edge slices through lines of text or leaves out a passage being read aloud.
   * `underCover`: a picture laid over the recording (such as the camera inset) sits on text or visual content.
   * `smallText`: text on screen is smaller than the readability bar at the video's size.
   * `blankScreen`: the framed screen shows almost nothing (blank or loading screen).
   */
  kind: "brief" | "offPicture" | "moveAcrossCut" | "clippedText" | "underCover" | "smallText" | "blankScreen" | "playerControls";
  /** Timeline seconds. */
  from: number; to: number;
  /** For `brief`: the clips on screen through it, and the ones before and after it, top first. */
  shows?: string[]; before?: string[]; after?: string[];
  /** For `brief`: ends of it that are cuts in the recording itself, as `briefPictures` gives them. */
  recordingCuts?: BriefPicture["recordingCuts"];
  /** Recording whose picture the finding is about. */
  mediaId?: string;
  /** For `offPicture` and `blankScreen`: lines of text shown there. */
  showing?: string[]; unchanged?: true; said?: string;
  reads?: Array<{ from: number; to: number; said: string; outsideFrame?: number; underCover?: number }>;
  /** Current framed area of the source picture, in percent. */
  frame?: number[];
  /** For `moveAcrossCut`: timeline second where the screen changed, and the frame moved from and to. */
  screenChangeAt?: number; fromFrame?: number[]; toFrame?: number[];
  /** For `clippedText`: edges of the frame cutting through text. */
  sides?: Array<"left" | "right" | "top" | "bottom">;
  /** For `clippedText` and `underCover`: lines of text affected, up to four, and how many more. */
  lines?: string[]; more?: number;
  /** For `underCover`: corners clear of text, non-text visual areas hidden, and detail share by corner. */
  cornersClearOfText?: Corner[];
  coverHides?: Array<{ box: number[]; hidden: number }>;
  detailInCorners?: Partial<Record<Corner, number>>;
  action?: Array<{ from: number; to: number; box: number[]; underCover?: number }>;
  /** For `smallText`: usual line height in percent and pixels of the video height, line count, sample lines, and any read-aloud match. */
  heightPct?: number; heightPx?: number; videoHeight?: number; lineCount?: number; sample?: string[];
  readHeightPct?: number; readSaid?: string;
  /** For `blankScreen`: percent of the frame containing any visual detail. */
  detailPct?: number;
};

/** A word heard on the version: which recording and transcript index it is, where it plays. */
interface HeardWord { mediaId: string; index: number; start: number; end: number }

const r2 = round2;
const KIND_ORDER: Record<PictureFinding["kind"], number> = {
  brief: 0, offPicture: 1, moveAcrossCut: 2, blankScreen: 3, playerControls: 4, underCover: 5, clippedText: 6, smallText: 7,
};

/**
 * The picture findings on a version: its brief pictures, off-picture stretches where the recording still shows what it
 * showed, and framing problems across every framed or stand-in stretch (glides across screen changes, clipped text,
 * content under an inset, small unreadable text, and blank/loading screens).
 */
export function pictureFindings(tl: Timeline, brief: readonly BriefPicture[], framed: readonly FramedStretch[], words: readonly HeardWord[]): PictureFinding[] {
  const mediaClips = tl.tracks.flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media").map(c => ({ trackId: t.id, clip: c })));
  const clips = new Map(mediaClips.map(({ clip }) => [clip.id, clip] as const));
  const usedIds = new Set<string>();
  const uniqueId = (base: string) => {
    if (!usedIds.has(base)) { usedIds.add(base); return base; }
    for (let n = 2; ; n++) {
      const id = `${base}:${n}`;
      if (!usedIds.has(id)) { usedIds.add(id); return id; }
    }
  };
  /** Stable key on the recording's own clock at timeline second `at`, so a keep holds when earlier cuts shift the timeline. */
  const sourceKey = (stretch: Pick<FramedStretch, "mediaId" | "trackId">, at: number) => {
    const match = (sameTrack: boolean) => mediaClips.find(({ trackId, clip }) =>
      (!sameTrack || trackId === stretch.trackId) && clip.mediaId === stretch.mediaId && clip.enabled !== false &&
      clip.timelineIn <= at + 0.02 && at <= clipEnd(clip) + 0.02)?.clip;
    const clip = match(true) ?? match(false);
    if (!clip) return `${stretch.mediaId}@t${at.toFixed(1)}`;
    const src = clip.sourceIn + Math.max(0, Math.min(at, clipEnd(clip)) - clip.timelineIn) * (clip.speed ?? 1);
    return `${stretch.mediaId}@${src.toFixed(1)}`;
  };

  const out: PictureFinding[] = [];
  for (const b of brief) {
    // Named by what plays: the picture on screen through it, at its source second there.
    const clip = clips.get(b.shows[0] ?? "");
    const at = (b.from + b.to) / 2;
    const key = clip && at >= clip.timelineIn && at <= clipEnd(clip)
      ? `${clip.mediaId}@${(clip.sourceIn + (at - clip.timelineIn) * (clip.speed ?? 1)).toFixed(1)}` : `${b.from.toFixed(1)}`;
    out.push({ id: uniqueId(`picture-brief:${key}`), kind: "brief", from: b.from, to: b.to, shows: b.shows, before: b.before, after: b.after,
      ...(b.recordingCuts?.length && { recordingCuts: b.recordingCuts }) });
  }

  const off: PictureFinding[] = [];
  for (const stretch of framed) for (const beside of [stretch.shownBefore, stretch.shownAfter]) {
    if (!beside) continue;
    const same = off.find(f => f.mediaId === stretch.mediaId && f.from < beside.to && beside.from < f.to);
    if (same) {
      // One gap seen from both sides: the wider reach, and the readings of both.
      same.from = Math.min(same.from, beside.from);
      same.to = Math.max(same.to, beside.to);
      if (beside.showing) same.showing = [...new Set([...same.showing ?? [], ...beside.showing])].slice(0, 3);
      if (beside.unchanged) same.unchanged = true;
      if (beside.said && (beside.said.length > (same.said?.length ?? 0))) same.said = beside.said;
      const reads = [...same.reads ?? [], ...beside.reads ?? []];
      if (reads.length) same.reads = [...new Map(reads.map(r => [`${r.from}-${r.to}`, r])).values()].sort((a, b) => a.from - b.from).slice(0, 5);
      continue;
    }
    off.push({ id: "", kind: "offPicture", from: beside.from, to: beside.to, mediaId: stretch.mediaId,
      ...(beside.showing && { showing: beside.showing }), ...(beside.unchanged && { unchanged: true as const }),
      ...(beside.said && { said: beside.said }), ...(beside.reads && { reads: beside.reads }) });
  }
  for (const f of off) {
    // Named by the first word heard there, in its transcript: it stays while the same words play beside the same recording.
    const first = words.find(w => w.start >= f.from - 0.05 && w.start < f.to);
    f.id = uniqueId(`picture-off:${f.mediaId}:${first ? `${first.mediaId}:${first.index}` : f.from.toFixed(1)}`);
    f.from = r2(f.from);
    f.to = r2(f.to);
  }
  out.push(...off);

  for (const stretch of framed) {
    // 1. Gliding zooms or pans across a screen change.
    for (const move of stretch.moves) {
      if (!move.screenChanged) continue;
      const at = move.screenChangeAt ?? move.from;
      out.push({
        id: uniqueId(`picture-move:${sourceKey(stretch, at)}`), kind: "moveAcrossCut",
        from: move.from, to: move.to, mediaId: stretch.mediaId,
        ...(move.screenChangeAt !== undefined && { screenChangeAt: move.screenChangeAt }),
        fromFrame: move.fromFrame, toFrame: move.toFrame,
      });
    }

    for (const hold of stretch.holds) {
      if (!hold.frame.length) continue;
      const dur = hold.to - hold.from;
      const holdReads = (stretch.readsHidden ?? []).filter(r => r.to > hold.from && r.from < hold.to);
      const holdAction = (stretch.actionHidden ?? []).filter(a => a.to > hold.from && a.from < hold.to);

      // 2. Blank or loading screen stretches.
      for (const b of hold.blank ?? []) {
        out.push({
          id: uniqueId(`picture-blank:${sourceKey(stretch, b.from)}`), kind: "blankScreen",
          from: b.from, to: b.to, mediaId: stretch.mediaId, detailPct: b.detailPct,
          ...(b.showing?.length && { showing: b.showing }),
        });
      }

      // 2b. Embedded video player timestamp controls left visible inside the framed picture.
      if (hold.playerControls?.length && dur >= 1) {
        out.push({
          id: uniqueId(`picture-controls:${sourceKey(stretch, hold.from)}`), kind: "playerControls",
          from: hold.from, to: hold.to, mediaId: stretch.mediaId, frame: hold.frame,
          showing: hold.playerControls.slice(0, 3),
        });
      }

      // 3. Text sliced by the frame's edge, or read-aloud text left outside the frame.
      const outsideReads = holdReads.filter(r => (r.outsideFrame ?? 0) > 0)
        .map(r => ({ from: r.from, to: r.to, said: r.said, outsideFrame: r.outsideFrame }));
      if (hold.clippedText || outsideReads.length) {
        const lines = hold.clippedText?.lines.slice(0, 4);
        const extra = (hold.clippedText?.more ?? 0) + Math.max(0, (hold.clippedText?.lines.length ?? 0) - 4);
        out.push({
          id: uniqueId(`picture-clipped:${sourceKey(stretch, hold.from)}`), kind: "clippedText",
          from: hold.from, to: hold.to, mediaId: stretch.mediaId, frame: hold.frame,
          ...(hold.clippedText && { sides: hold.clippedText.sides, lines, ...(extra > 0 && { more: extra }) }),
          ...(outsideReads.length && { reads: outsideReads.slice(0, 3) }),
        });
      }

      // 4. Text, read-aloud words, or substantial visual content hidden under a cover (such as the camera inset).
      const coverReads = holdReads.filter(r => (r.underCover ?? 0) > 0)
        .map(r => ({ from: r.from, to: r.to, said: r.said, underCover: r.underCover }));
      const coverAction = holdAction.filter(a => (a.underCover ?? 0) > 0)
        .map(a => ({ from: a.from, to: a.to, box: a.box, underCover: a.underCover }));
      const realLines = (hold.underCover ?? []).filter(l => l.trim().length >= 3);
      const bigHides = (hold.coverHides ?? []).filter(h => h.hidden >= 25);
      if (coverReads.length || coverAction.length || (dur >= 1 && (realLines.length || bigHides.length))) {
        const lines = realLines.length ? realLines.slice(0, 4) : undefined;
        const extra = (hold.underCoverMore ?? 0) + Math.max(0, realLines.length - 4);
        out.push({
          id: uniqueId(`picture-cover:${sourceKey(stretch, hold.from)}`), kind: "underCover",
          from: hold.from, to: hold.to, mediaId: stretch.mediaId, frame: hold.frame,
          ...(lines && { lines, ...(extra > 0 && { more: extra }), ...(hold.cornersClearOfText && { cornersClearOfText: hold.cornersClearOfText }) }),
          ...(bigHides.length && { coverHides: bigHides.slice(0, 3), ...(hold.detailInCorners && { detailInCorners: hold.detailInCorners }) }),
          ...(coverReads.length && { reads: coverReads.slice(0, 3) }),
          ...(coverAction.length && { action: coverAction.slice(0, 2) }),
        });
      }

      // 5. Text too small to read at the video's size.
      if (hold.smallText) {
        out.push({
          id: uniqueId(`picture-small-text:${sourceKey(stretch, hold.from)}`), kind: "smallText",
          from: hold.from, to: hold.to, mediaId: stretch.mediaId, frame: hold.frame,
          heightPct: hold.smallText.heightPct, heightPx: hold.smallText.heightPx, videoHeight: hold.smallText.videoHeight,
          lineCount: hold.smallText.lines, sample: hold.smallText.sample.slice(0, 3),
          ...(hold.smallText.readSaid && { readHeightPct: hold.smallText.readHeightPct, readSaid: hold.smallText.readSaid }),
        });
      }
    }
  }

  return out.sort((a, b) => a.from - b.from || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}
