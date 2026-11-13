import type { DialogueVoiceRoles } from "@scarlet/timeline";
import type { measureSources } from "./transcriptSources.js";

/** Bound candidate turns acoustically. Do not treat a desktop audio input as a person. */
export function otherVoiceTurns(energy: ReturnType<typeof measureSources>["energy"], roles: DialogueVoiceRoles, origin: number, end: number) {
  const turns: Array<{ start: number; end: number; meAlsoActive: boolean }> = [];
  let first = -1, last = -1, active = 0;
  function finish() {
    if (active >= 4) {
      // Include the gaps and boundary handles, where a short presenter reply
      // could otherwise disappear inside what looks like one coaching turn.
      const nearby = energy.slice(Math.max(0, first - 9), last + 10);
      let consecutive = 0;
      const meAlsoActive = nearby.some(frame => {
        const me = frame[roles.me - 1]!, other = frame[roles.other - 1]!;
        // A few low-level taps or a trace of call audio leaking into the mic are common.
        consecutive = me > 54000 && me > other / 4 ? consecutive + 1 : 0;
        return consecutive >= 4;
      });
      turns.push({ start: origin + first * .02, end: Math.min(end, origin + (last + 1) * .02), meAlsoActive });
    }
    first = -1; last = -1; active = 0;
  }
  for (const [i, frame] of energy.entries()) {
    if (last >= 0 && i - last > 36) finish();
    const other = frame[roles.other - 1]!;
    if (other < 14000) continue;
    if (first < 0) first = i;
    last = i;
    active++;
  }
  finish();
  return turns;
}
