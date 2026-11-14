import { timelineFromKeepRanges, type MediaAsset } from "@scarlet/timeline";
import { dialogueAudioStream } from "./dialogue-join.js";
import { NoPauseToTrim, planDialogueCuts, SETTLED_MARGIN, type DialoguePlanSources } from "./dialogue-plan.js";
import { measureQuietKeptWords } from "./quiet-kept-word.js";

export interface FirstCutKeep {
  start?: number;
  end?: number;
  fromWord?: number;
  toWord?: number;
  label?: string;
}

/** Place the missing source handles. The same recording can occur more than once, in any playback order. */
export async function firstCutRanges(keep: FirstCutKeep[], projectId: string, audio: MediaAsset, sources: DialoguePlanSources) {
  const rows = keep.map(r => ({ ...r }));
  const indexed = rows.some(r => r.fromWord !== undefined);
  const evidence: string[] = [];
  const ranges = () => rows.map(r => ({ start: r.start!, end: r.end!, label: r.label }));
  if (!indexed) return { ranges: ranges(), evidence };

  const duration = audio.duration;
  if (!duration || audio.kind === "image" || audio.hasAudio === false || (dialogueAudioStream(audio) ?? 0) !== 0)
    throw new Error(`Indexed keeps need a timed recording with dialogue on its first audio stream. Give source seconds for ${audio.id}.`);
  const ref = await sources.words(audio.id);
  if (!ref?.length) throw new Error(`No transcript words for ${audio.id}. Use source seconds.`);
  let furthest = 0;
  for (const [i, r] of rows.entries()) {
    if (r.fromWord === undefined) continue;
    if (r.toWord! < r.fromWord || r.toWord! >= ref.length)
      throw new Error(`keep[${i}] needs an inclusive word range in ${audio.id}, #0–#${ref.length - 1}.`);
    furthest = Math.max(furthest, r.toWord!);
  }
  const words = await sources.words(audio.id, (ref[furthest + 1] ?? ref[furthest]!).end + SETTLED_MARGIN);
  if (!words || words.length !== ref.length) throw new Error(`The transcript of ${audio.id} changed. Read transcript_get and resubmit the word ranges.`);
  const midpoint = words.map(w => (w.start + w.end) / 2);
  const source = timelineFromKeepRanges(projectId, audio.id, [{ start: 0, end: duration }]);
  // Assembly clips meet at their source edges. Even optional clip fades stay inside each kept range.
  const assemblySources = { ...sources, crossfadeFrames: 0 };
  const issues: string[] = [];
  // One boundary between successive pieces, with a one-sided boundary at the head and tail.
  for (let i = 0; i <= rows.length; i++) {
    const left = rows[i - 1], right = rows[i];
    const handles = [left && left.end === undefined && `keep[${i - 1}].end`, right && right.start === undefined && `keep[${i}].start`].filter(Boolean).join(" and ");
    const l = left ? left.toWord : -1, h = right ? right.fromWord : words.length;
    if (l === undefined || h === undefined || h <= l) {
      if (handles) issues.push(`${handles}: give exact source seconds where the order repeats, moves backward, or meets a seconds-only piece.`);
      continue;
    }
    if (!handles) continue;
    const set = (end: number, start: number, why?: string) => {
      if (left) left.end ??= end;
      if (right) right.start ??= start;
      if (left && right && left.end! > right.start!)
        issues.push(`${handles}: the measured placement and supplied source handle overlap. Inspect the pause and give both handles in seconds.`);
      if (why) evidence.push(`${handles}: ${why}`);
    };
    if (l === -1 && h === 0) { set(0, 0); continue; }
    if (h === words.length && l === h - 1) { set(duration, duration); continue; }

    const adjacent = h === l + 1;
    const kind: "pause" | "retake" = adjacent ? "pause" : "retake";
    // When the pause already fits, keep the recording playing continuously across the two pieces.
    const continuous = (reason: string) => {
      const split = left?.end ?? right?.start ?? (midpoint[l]! + midpoint[h]!) / 2;
      set(split, split, reason);
    };
    const cut = { mediaId: audio.id, ...(adjacent ? { afterWord: l } : { fromWord: l + 1, toWord: h - 1 }),
      kind, decision: "cut" as const, reason: "Place the edges of the selected words." };
    try {
      const plan = await planDialogueCuts({ tl: source, cuts: [cut], only: kind, localPauses: false,
        repeatHint: "Revise the kept word indices to keep one occurrence. If both belong, inspect the source and supply these handles in exact source seconds." }, assemblySources);
      if (plan.outcome === "ready") {
        if (plan.decisions.length !== 1) {
          issues.push(`${handles}: placement produced additional or missing removals. Inspect the source and supply exact seconds for these handles.`);
          continue;
        }
        const decision = plan.decisions[0]!;
        const note = plan.removals[0]?.notes?.join(" ");
        if (decision.review || note) {
          issues.push(`${handles}: ${note || decision.reason} Inspect the source and supply exact seconds for these handles.`);
        } else {
          const detail = plan.gate.get(0)?.evidence;
          set(decision.start, decision.end, typeof detail === "string" ? detail : undefined);
        }
      } else {
        const why = plan.outcome === "needsRevision" ? plan.disputedEdges.map(e => e.reason).join(" ")
          : "The removal was preserved. Inspect the source and supply exact seconds for these handles.";
        issues.push(`${handles}: ${why}`);
      }
    } catch (err) {
      if (!(err instanceof NoPauseToTrim)) throw err;
      continuous(err.message);
    }
  }
  if (issues.length) throw new Error(`First cut needs revision:\n${issues.join("\n")}`);
  const placed = ranges();
  for (const [i, r] of rows.entries()) {
    if (r.fromWord === undefined) continue;
    const { start, end } = placed[i]!;
    if (start < 0 || end <= start || end > duration || midpoint.some((t, n) =>
      (t >= start && t < end) !== (n >= r.fromWord! && n <= r.toWord!)))
      throw new Error(`keep[${i}] at ${start}–${end} s does not play exactly #${r.fromWord}–#${r.toWord} of ${audio.id}. Inspect the source and correct its handles or word range.`);
  }
  // A word-indexed keep promises that the word plays. A seconds-only keep can deliberately hold on the picture.
  const isolated = placed.flatMap((r, i) => {
    const before = placed[i - 1], after = placed[i + 1];
    if (rows[i]!.fromWord === undefined || !before || !after ||
      Math.abs(r.start - before.end) < 1e-6 || Math.abs(after.start - r.end) < 1e-6) return [];
    return [{ mediaId: audio.id, start: r.start, end: r.end }];
  });
  const conflicts = await measureQuietKeptWords(isolated, sources);
  if (conflicts.length) throw new Error(`First cut needs revision:\n${conflicts.map(c => c.reason).join("\n")}\nUse corrected source handles, or a seconds-only keep for an intentional hold.`);
  evidence.unshift(`Resolved ${rows.filter(r => r.fromWord !== undefined).length} indexed keep(s) against ${audio.id}.`);
  return { ranges: placed, evidence };
}
