/**
 * A dialogue_scan page as the model reads it: every range and measurement the reading holds, written compactly.
 * Two pages of a minute fit one result of a model whose results are cut near 9,000 characters (Gemini), so the save
 * rhythm of two pages a section is one read and one save. Gemini reads each digit as a token, and every result stays
 * in context for the rest of the pass, so times are given to the hundredth of a second, as the scan measures them,
 * and what a page shares with the call (the recording, its detectors) is said once.
 */

/** The fields a page states once a call: a later page leaves them out where they are the same. */
const PER_CALL = ["mediaId", "detectors", "voiceDetectionAvailable"] as const;

/**
 * Lists a page leaves out when it found nothing in them. passages stays, and so do acousticRepeatedTakes and
 * otherVoiceTurns, whose presence says the reading was made.
 */
const LEFT_OUT_EMPTY = new Set(["fillers", "fillerCandidates", "repeatedTakes", "unmatchedVoice", "pauses", "silences"]);

/** Seconds, levels and fractions to a hundredth; whole numbers (word indices, frames, dBFS) as they are. */
export function round(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => v === undefined ? [] : [[k, round(v)]]));
  }
  return value;
}

interface Pause {
  remove: { start: number; end: number };
  before?: string; after?: string; airBefore?: number; airAfter?: number; maxPeakDb?: number;
  evidence?: string; timingWarning?: string;
}

/**
 * A quiet interior between two words as `[start, end, before, after, airBefore, airAfter, maxPeakDb]`, a quiet run
 * found by low levels and no detected voice alone as `[start, end]`, and either with a last item "timing" where the
 * words' timing disagrees with the detected voice there.
 */
export function pauseRow(p: Pause): Array<number | string> {
  const row: Array<number | string> = [p.remove.start, p.remove.end];
  if (p.before !== undefined || p.after !== undefined) {
    row.push(p.before ?? "", p.after ?? "", p.airBefore ?? 0, p.airAfter ?? 0, p.maxPeakDb ?? -99);
  }
  if (p.timingWarning) row.push("timing");
  return row;
}

type Page = Record<string, unknown> & { mediaId: string };

/** One page's reading, compact. `shared` is the call's first page: what it already said is left out here. */
export function compactScanPage(page: Page, shared?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(page)) {
    if (value === undefined || (LEFT_OUT_EMPTY.has(key) && Array.isArray(value) && !value.length)) continue;
    if (shared && (PER_CALL as readonly string[]).includes(key) && JSON.stringify(shared[key]) === JSON.stringify(value)) continue;
    switch (key) {
      case "passages":
        // Word timing is the usual case; a passage timed by its segment alone still says so.
        out.passages = (value as Array<Record<string, unknown>>).map(({ timing, ...p }) => timing === "word" ? p : { ...p, timing });
        break;
      case "unmatchedVoice":
        out.unmatchedVoice = (value as Array<{ start: number; end: number }>).map(v => [v.start, v.end]);
        break;
      case "speakerTurns": {
        const turns = value as Array<{ speaker: number }>;
        const voices = [...new Set(turns.map(t => t.speaker))];
        // One voice on the page: its number is all the turns add to the passages, pauses and unmatchedVoice.
        if (voices.length > 1) out.speakerTurns = turns;
        else if (voices.length === 1) out.speaker = voices[0];
        break;
      }
      case "pauses":
        out.pauses = (value as Pause[]).map(pauseRow);
        break;
      case "silences":
        out.silences = (value as Array<Record<string, unknown> & { picture?: unknown }>).map(s => Array.isArray(s.picture)
          // The recording's own picture needs no name: only another video's carries its mediaId.
          ? { ...s, picture: (s.picture as Array<Record<string, unknown>>).map(({ mediaId, ...w }) => mediaId === page.mediaId ? w : { mediaId, ...w }) }
          : s);
        break;
      default:
        out[key] = value;
    }
  }
  return round(out) as Record<string, unknown>;
}
