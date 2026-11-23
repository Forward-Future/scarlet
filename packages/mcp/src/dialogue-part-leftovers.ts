/**
 * What a part saved by dialogue_apply_cuts still plays and leaves undecided: silences, pauses, doubled words and quiet
 * phrases, placed on the version the pass continues on, each listed once per pass.
 */
import type { ScarletClient } from "@scarlet/shared";
import {
  clipEnd,
  makeTimeMap,
  rangesOverlap,
  sourceToTimeline as clipSourceToTimeline,
  timelineToSource,
  type MediaClip,
  type TimeRange,
  type Timeline,
  type TranscriptWord,
} from "@scarlet/timeline";
import { audibleMediaClips, round3 } from "./analysis.js";
import { dialogueAudioStream } from "./dialogue-join.js";
import { PAUSE_FLOOR_SECONDS, partLeftovers } from "./dialogue-leftovers.js";
import type { QuietPhrase } from "./gap-sound.js";
import type { MediaSession } from "./media-session.js";
import type { SessionErrorHelpers } from "./media-state.js";
import { keptSilences } from "./silences.js";
import { sourceToTimeline, timelineWords } from "./timeline-perception.js";

export interface DialoguePartLeftoversDeps {
  client: ScarletClient;
  projectId: string;
  session: MediaSession;
  errors: SessionErrorHelpers;
  /** The silence length the model last asked the closing check for. */
  silencesAsked(): number | undefined;
}

export function createDialoguePartLeftovers(deps: DialoguePartLeftoversDeps) {
  const { client, projectId, session, errors, silencesAsked } = deps;
  const { transcriptWords, showWords, readQuietPhrases } = session;
  const { without, withoutOnce } = errors;

  /** Silences of two seconds or more inside this part that none of its decisions covers, on the version it was planned on. */
  async function passedSilences(tl: Timeline, kept: Array<{ start: number; end: number }>,
    decisions: Array<{ start: number; end: number }>, range?: { start: number; end: number }) {
    const decided = [...decisions.map(d => ({ start: d.start, end: d.end })), ...kept];
    if (!decided.length) return [];
    // Without a range, the part reaches from its first decision to its last.
    const scope = range ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(audibleMediaClips(tl).map(c => c.mediaId))) {
      const words = await transcriptWords(id, false).catch(without(`failed to read the words of ${id} for the silences a part keeps`, null));
      if (words) transcripts.set(id, words);
    }
    // From the silence length the pass last asked the closing check for, so both list the same stretches.
    return keptSilences(tl, timelineWords(tl, transcripts, scope), decided, silencesAsked());
  }

  /**
   * What earlier saves of this pass already listed as still playing. A later part reaches back over the earlier ones,
   * and on one pass its last save listed 58 things of which a handful were new: a chime and a 1.7 s wait among them
   * went unread. Each save lists a thing once; a pause comes back only if it now plays a different length.
   */
  const listed = new Set<string>();
  const listing = (kind: string, mediaId: string, source: number, seconds?: number) =>
    `${kind}/${mediaId}/${source.toFixed(1)}${seconds === undefined ? "" : `/${seconds.toFixed(1)}`}`;
  const fresh = (...thing: Parameters<typeof listing>) => !listed.has(listing(...thing));
  /** Only what a save actually returns counts as listed: items trimmed to fit resultChars stay fresh for the next save. */
  const candidate = <T>(item: T, ...key: Parameters<typeof listing>) => ({ item, key: listing(...key) });

  /** Pauses and doubled words this part still plays once its cuts are out, on the version it was planned on. */
  async function passedLeftovers(tl: Timeline, kept: Array<{ start: number; end: number }>,
    decisions: Array<{ start: number; end: number; review: boolean }>, range?: { start: number; end: number }, pausesFrom?: number) {
    const decided = [...decisions, ...kept];
    if (!decided.length) return { pauses: [], repeats: [], gaps: [] };
    const scope = range ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(audibleMediaClips(tl).map(c => c.mediaId))) {
      const words = await transcriptWords(id, false).catch(without(`failed to read the words of ${id} for what a part still plays`, null));
      // keptPauses and repeatedWords name their words by these indices.
      showWords(id, words);
      if (words) transcripts.set(id, words);
    }
    // A range staged for review still plays until the editor approves it.
    return partLeftovers(timelineWords(tl, transcripts, scope), decisions.filter(d => !d.review), kept, transcripts, pausesFrom ?? PAUSE_FLOOR_SECONDS);
  }

  /** The version a part continues on, read once however many lists are placed on it. */
  const continued = new Map<string, Promise<Timeline>>();
  const timelineAt = (version: string, planned: Timeline) => {
    if (version === planned.version) return Promise.resolve(planned);
    let read = continued.get(version);
    if (!read) { continued.clear(); continued.set(version, read = client.timeline(projectId, version).then(r => r.timeline)); read.catch(() => continued.delete(version)); }
    return read;
  };

  /** Where those silences sit on the version the pass continues on, longest thirty at most, in playback order. */
  async function placeSilences(found: Awaited<ReturnType<typeof passedSilences>>, version: string, planned: Timeline) {
    if (!found.length) return [];
    const after = await timelineAt(version, planned);
    return found.flatMap(k => {
      const at = sourceToTimeline(after, k.mediaId, k.source.start).find(p => p.audible)?.time;
      return at === undefined ? [] : [{ at, seconds: k.seconds, after: k.after, before: k.before, ...(k.afterWord !== undefined && { afterWord: k.afterWord }) }];
    }).sort((a, b) => b.seconds - a.seconds).slice(0, 30).sort((a, b) => a.at - b.at);
  }

  /** Quiet words still playing in the submitted part. Compare levels on the recording the editor actually hears. */
  async function keptQuietPhrases(tl: Timeline, version: string, decided: TimeRange[], span: TimeRange) {
    const { media } = await client.media(projectId);
    const firstStream = (clip: MediaClip) => {
      const asset = media.find(m => m.id === clip.mediaId);
      return asset && asset.kind !== "image" && asset.hasAudio !== false && (dialogueAudioStream(clip) ?? dialogueAudioStream(asset) ?? 0) === 0;
    };
    const clips = audibleMediaClips(tl).filter(c => firstStream(c) && rangesOverlap(span, { start: c.timelineIn, end: clipEnd(c) }));
    const phrases = (await Promise.all(clips.map(async clip => {
      const from = timelineToSource(clip, Math.max(clip.timelineIn, span.start));
      const to = Math.min(clip.sourceOut, timelineToSource(clip, span.end));
      const found = await readQuietPhrases(clip.mediaId, from, to)
        .catch(withoutOnce(`failed to measure the quiet phrases in ${clip.mediaId}`, [] as QuietPhrase[]));
      return found.flatMap(p => {
        const placed = { start: clipSourceToTimeline(clip, p.start), end: clipSourceToTimeline(clip, p.end) };
        if (!fresh("quietPhrase", clip.mediaId, p.start) || decided.some(d => rangesOverlap(d, placed))) return [];
        return [{ mediaId: clip.mediaId, phrase: p, at: placed.start }];
      });
    }))).flat();
    if (!phrases.length) return [];
    const after = await timelineAt(version, tl);
    const map = makeTimeMap(tl, after);
    const audible = audibleMediaClips(after).filter(firstStream);
    const placed = phrases.flatMap(p => {
      const at = map(p.at, "right");
      // A still-visible picture can anchor this time even if a concurrent edit removed its dialogue.
      if (at === null || !audible.some(c => c.mediaId === p.mediaId && p.phrase.start >= c.sourceIn && p.phrase.end <= c.sourceOut &&
        Math.abs(clipSourceToTimeline(c, p.phrase.start) - at) <= .001)) return [];
      return [{ ...p, at: round3(at) }];
    }).sort((a, b) => a.at - b.at);
    const result = [];
    const seen = new Set<string>();
    for (const { at, mediaId, phrase } of placed) {
      const key = listing("quietPhrase", mediaId, phrase.start);
      if (fresh("quietPhrase", mediaId, phrase.start) && !seen.has(key)) {
        seen.add(key);
        result.push({ item: { at, mediaId, ...phrase }, key });
      }
      if (result.length === 30) break;
    }
    return result;
  }

  return { passedSilences, listed, fresh, candidate, passedLeftovers, timelineAt, placeSilences, keptQuietPhrases };
}
