import type { Transcript, TranscriptWord } from "@scarlet/timeline";

export const speakerTurnCacheVersion = 3;
export const speakerAnalysisVersion = 3;
export interface SpeakerTurn { start: number; end: number; speaker: number }

/** Zero marks an unconfirmed cluster. Its turns still block attribution on overlaps. */
export function numberSpeakers(raw: SpeakerTurn[]): SpeakerTurn[] {
  const sorted = raw.filter(t => Number.isFinite(t.start) && Number.isFinite(t.end) && t.start >= 0 && t.end > t.start && Number.isInteger(t.speaker) && t.speaker >= -1)
    .sort((a, b) => a.start - b.start || a.speaker - b.speaker);
  const cleanTime = new Map<number, number>();
  let first = 0;
  for (const t of sorted) {
    while (sorted[first]!.end <= t.start) first++;
    let coveredUntil = t.start, overlap = 0;
    for (let i = first; i < sorted.length && sorted[i]!.start < t.end; i++) {
      const other = sorted[i]!;
      if (other.speaker === t.speaker) continue;
      const end = Math.min(t.end, other.end);
      overlap += Math.max(0, end - Math.max(coveredUntil, other.start));
      coveredUntil = Math.max(coveredUntil, end);
    }
    const duration = t.end - t.start;
    if (overlap <= duration * .15) cleanTime.set(t.speaker, (cleanTime.get(t.speaker) ?? 0) + duration - overlap);
  }
  // A breath or a voice heard only under another voice cannot establish a new person.
  const ids = new Map<number, number>();
  return sorted.map(t => {
    if (t.speaker < 0 || (cleanTime.get(t.speaker) ?? 0) < .9) return { ...t, speaker: 0 };
    if (!ids.has(t.speaker)) ids.set(t.speaker, ids.size + 1);
    return { ...t, speaker: ids.get(t.speaker)! };
  });
}

function dominant(turns: SpeakerTurn[], start: number, end: number): number | undefined {
  if (end <= start) return;
  const durations = new Map<number, number>();
  for (const t of turns) {
    const covered = Math.min(t.end, end) - Math.max(t.start, start);
    if (covered > 0) durations.set(t.speaker, (durations.get(t.speaker) ?? 0) + covered);
  }
  const [first, second] = [...durations].sort((a, b) => b[1] - a[1]);
  const duration = end - start;
  if (first && first[0] > 0 && first[1] >= duration * .68 && (!second || second[1] < duration * .12)) return first[0];
}

export function labelTranscript(t: Transcript, turns: SpeakerTurn[]): Transcript {
  if (t.speakerAnalysis) {
    // Reclassification replaces earlier automatic labels, including any wording
    // left on a segment. An editor's name or an isolated-input role wins.
    const generated = (label?: string) => label === "me" || /^(?:other voices · )?Speaker \d+$/.test(label ?? "");
    t = { ...t, segments: t.segments.map(s => {
      const words = s.words.map(w => {
        if (w.detectedSpeaker === undefined) return w;
        const { detectedSpeaker: _old, speaker, ...rest } = w;
        if (w.voiceRoleInput && speaker?.startsWith("other voices")) return { ...rest, speaker: "other voices" };
        if (w.voiceRoleInput || !generated(speaker)) return { ...rest, speaker };
        return rest;
      });
      const inferred = generated(s.speaker) && (!s.words.length || s.words.some(w => w.detectedSpeaker !== undefined));
      return { ...s, speaker: inferred ? undefined : s.speaker, words };
    }) };
  }
  const count = new Set(turns.map(s => s.speaker).filter(id => id > 0)).size;
  // Assign by time once, independent of ASR segment boundaries or transcript paging.
  const words = t.segments.flatMap(s => s.words).sort((a, b) => a.start - b.start);
  const assigned = new Map<TranscriptWord, number>();
  const roleTime = new Map<number, { me: number; other: number }>();
  let next = 0;
  let active: SpeakerTurn[] = [];
  for (const w of words) {
    active = active.filter(s => s.end > w.start);
    while (next < turns.length && turns[next]!.start < w.end) active.push(turns[next++]!);
    const id = dominant(active, w.start, w.end);
    if (id === undefined) continue;
    assigned.set(w, id);
    // Only a previously confirmed recording role can anchor "me".
    if (!w.voiceRoleInput || (w.speaker !== "me" && w.speaker !== "other voices")) continue;
    const evidence = roleTime.get(id) ?? { me: 0, other: 0 };
    evidence[w.speaker === "me" ? "me" : "other"] += Math.min(1, w.end - w.start);
    roleTime.set(id, evidence);
  }
  const meTotal = [...roleTime.values()].reduce((n, r) => n + r.me, 0);
  const host = [...roleTime].find(([, r]) => r.me >= 3 && r.me > .65 * meTotal && r.me > 9 * r.other)?.[0];
  const label = (id: number) => id === host ? "me" : `Speaker ${id}`;
  return { ...t, speakerAnalysis: { version: speakerAnalysisVersion, count }, segments: t.segments.map(s => {
    const annotated = s.words.map(w => {
      const id = assigned.get(w);
      if (id === undefined) return w;
      const sourceRole = w.voiceRoleInput && w.speaker;
      // An isolated microphone is stronger evidence than a conflicting voice match.
      if (host !== undefined && (sourceRole === "other voices" && id === host || sourceRole === "me" && id !== host)) return w;
      const evidence = roleTime.get(id);
      if (sourceRole === "other voices" && evidence && evidence.me > 0 && evidence.other < 4 * evidence.me) return w;
      const existing = w.speaker || s.speaker;
      const speaker = sourceRole === "other voices" ? `other voices · Speaker ${id}` : existing || label(id);
      return { ...w, speaker, detectedSpeaker: id };
    });
    let speaker = s.speaker;
    if (!speaker && annotated.length && annotated[0]!.speaker && annotated.every(w => w.speaker === annotated[0]!.speaker)) speaker = annotated[0]!.speaker;
    if (!speaker && !annotated.length) {
      const id = dominant(turns.filter(t => t.end > s.start && t.start < s.end), s.start, s.end);
      if (id !== undefined) speaker = label(id);
    }
    return { ...s, ...(speaker ? { speaker } : {}), words: annotated };
  }) };
}
