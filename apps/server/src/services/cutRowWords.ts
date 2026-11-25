import { cutKindOfRow, type MediaClip, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { flattenWords, LEFT_OUT, type ThreadEdit } from "@scarlet/shared";
import type { Ctx } from "../context.js";

/** How far either side of a cut its row looks for the words it names it by, in seconds of the version before it. */
const REACH = 8;
/** At most this many words are quoted, from inside the cut or beside it. */
const QUOTED = 5;

/** Rows already named, by edit and version: a cut's footage and its version never change, so neither does its name. */
const named = new Map<string, string>();
const NAMED_KEEP = 20_000;
/** Each transcript's words, read once for each revision of it. */
const transcriptWords = new Map<string, TranscriptWord[]>();
const TRANSCRIPTS_KEEP = 64;

const quote = (words: readonly { text: string }[], more = false) => `“${words.map(w => w.text.trim()).join(" ").replace(/[.,!?;:]+$/, "")}${more ? "…" : ""}”`;

/** The transcript's words on a version, in its clock, around `range`. */
function wordsAround(timeline: Timeline, words: (mediaId: string) => TranscriptWord[] | undefined, start: number, end: number) {
  const out: { text: string; start: number; end: number }[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "caption") continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || !clip.enabled) continue;
      const media = clip as MediaClip;
      const speed = media.speed ?? 1;
      const clipEnd = media.timelineIn + (media.sourceOut - media.sourceIn) / speed;
      if (clipEnd < start || media.timelineIn > end) continue;
      const list = words(media.mediaId);
      if (!list) continue;
      for (const w of list) {
        // A word belongs to the clip that keeps its midpoint, as captions go.
        const mid = (w.start + w.end) / 2;
        if (mid < media.sourceIn || mid >= media.sourceOut) continue;
        const at = media.timelineIn + (mid - media.sourceIn) / speed;
        if (at < start || at > end || !w.text.trim()) continue;
        out.push({ text: w.text, start: at, end: at });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  // Two mics of one voice read each word twice.
  return out.filter((w, i) => !(i && Math.abs(out[i - 1]!.start - w.start) < 0.03 && out[i - 1]!.text.trim().toLowerCase() === w.text.trim().toLowerCase()));
}

/**
 * How a row saved without words of its own is named: by its cut's kind, or as footage a video built from the pieces to
 * keep left out, which Scarlet named nothing for. A first cut's 104 rows all read "Cut" (2026-11-23).
 */
const rowKind = (label: string) => label === LEFT_OUT ? "left out" as const : cutKindOfRow(label);

/**
 * A cut saved without a summary reads by its kind in the list ("Shortened a pause"), so a pass's rows all read the same.
 * Each is named by the words beside it instead, as the transcript has them: "Shortened the pause after “okay”",
 * "Cut a false start: “so the model”". This only names what the cut took out and where; it decides nothing.
 */
export function nameCutRowsByWords(ctx: Ctx, projectId: string, edits: ThreadEdit[], read: (version: string) => Timeline | undefined): ThreadEdit[] {
  if (!edits.some(e => !e.summary && e.beforeCut && rowKind(e.label))) return edits;
  const media = new Map(ctx.repos.projects.listMedia(projectId).map(m => [m.id, m.transcriptId]));
  // A transcript is rewritten in place while its words are placed (each turn of alignment, a spelling fixed meanwhile),
  // so it is read, and its rows named, by its revision as well as its id.
  const ids = [...new Set([...media.values()].filter((id): id is string => !!id))];
  const revisions = new Map((ctx.db.prepare("SELECT transcript_id AS id, revision FROM transcript_revisions WHERE transcript_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as { id: string; revision: string }[]).map(r => [r.id, r.revision]));
  const revisionOf = (id: string) => `${id}@${revisions.get(id) ?? ""}`;
  const words = (mediaId: string) => {
    const id = media.get(mediaId);
    if (!id) return undefined;
    let list = transcriptWords.get(revisionOf(id));
    if (!list) {
      const transcript = ctx.repos.transcripts.get(id);
      if (!transcript) return undefined;
      list = flattenWords(transcript);
      if (transcriptWords.size >= TRANSCRIPTS_KEEP) transcriptWords.delete(transcriptWords.keys().next().value!);
      transcriptWords.set(revisionOf(id), list);
    }
    return list;
  };
  // A transcript read again (a realignment) is a new one, and names the cuts afresh.
  const transcripts = [...media.values()].map(id => id && revisionOf(id)).join(",");
  const versions = new Map<string, Timeline | undefined>();
  return edits.map(edit => {
    const kind = !edit.summary && edit.beforeCut ? rowKind(edit.label) : undefined;
    if (!kind || !edit.beforeCut) return edit;
    const { version, removed } = edit.beforeCut;
    const key = JSON.stringify([projectId, transcripts, edit.changeId, edit.spot, version, removed.start, removed.end, kind]);
    let label = named.get(key);
    if (label === undefined) {
      if (!versions.has(version)) versions.set(version, read(version));
      const timeline = versions.get(version);
      const near = timeline ? wordsAround(timeline, words, removed.start - REACH, removed.end + REACH) : [];
      const before = near.filter(w => w.start <= removed.start), after = near.filter(w => w.start >= removed.end);
      const inside = near.filter(w => w.start > removed.start && w.start < removed.end);
      const lead = before.slice(-2), next = after.slice(0, 2);
      if (kind === "pause") {
        label = lead.length ? `Shortened the pause after ${quote(lead)}` : next.length ? `Shortened the pause before ${quote(next)}` : edit.label;
      } else if (kind === "left out") {
        label = inside.length ? `Cut ${quote(inside.slice(0, QUOTED), inside.length > QUOTED)}`
          : lead.length ? `Cut after ${quote(lead)}` : next.length ? `Cut before ${quote(next)}` : edit.label;
      } else {
        const what = kind === "retake" ? "a false start" : kind === "filler" ? "a filler word" : "a note to the crew";
        label = inside.length ? `Cut ${what}: ${quote(inside.slice(0, QUOTED), inside.length > QUOTED)}`
          : lead.length ? `Cut ${what} after ${quote(lead)}` : next.length ? `Cut ${what} before ${quote(next)}` : edit.label;
      }
      if (named.size >= NAMED_KEEP) named.delete(named.keys().next().value!);
      named.set(key, label);
    }
    return label === edit.label ? edit : { ...edit, label };
  });
}
