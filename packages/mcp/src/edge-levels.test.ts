import { describe, expect, it } from "vitest";
import { ScarletApiError, type ScarletClient } from "@scarlet/shared";
import { DialogueEvidence } from "./dialogue-decisions.js";
import { createMediaSession } from "./media-session.js";
import { createSessionErrorHelpers } from "./media-state.js";

/**
 * The engine reads voice activity for up to a minute inside the recording and refuses any other window with
 * bad_speech_range. Thrown from an edge measurement, that refusal lost a whole dialogue_apply_cuts batch.
 */
function engine(duration: number) {
  const asked: Array<{ from: number; to: number }> = [];
  const client = {
    projectInfo: async () => ({ project: { id: "prj", media: [{ id: "m1", kind: "video", duration }] } }),
    waveform: async (mediaId: string, from: number, to: number, points: number, _cachedOnly: boolean, speech: boolean) => {
      asked.push({ from, to });
      if (speech && (from < 0 || to > duration + 1e-6 || to <= from || to > from + 60))
        throw new ScarletApiError(400, "bad_speech_range", "Choose up to 60 seconds within the source audio.");
      return { mediaId, from, to, peaks: Array(points).fill(0.1), rms: Array(points).fill(0.05), speechActivity: [{ start: from, end: Math.min(to, from + 1) }] };
    },
  } as unknown as ScarletClient;
  const session = createMediaSession({ client, projectId: "prj", evidence: new DialogueEvidence(), errors: createSessionErrorHelpers(),
    postEvent: async () => ({ posted: true }) });
  return { asked, session };
}

describe("reading levels for edge evidence", () => {
  it("reads a window longer than a minute a minute at a time, as one reading", async () => {
    const { asked, session } = engine(3291.755);
    const wf = await session.readLevels("m1", 3145, 3276);
    expect(asked).toEqual([{ from: 3145, to: 3205 }, { from: 3205, to: 3265 }, { from: 3265, to: 3276 }]);
    expect(wf).toMatchObject({ from: 3145, to: 3276 });
    expect(wf.rms).toHaveLength(6000 + 6000 + 1100);
    expect(wf.peaks).toHaveLength(wf.rms!.length);
    expect(wf.speechActivity).toEqual([{ start: 3145, end: 3146 }, { start: 3205, end: 3206 }, { start: 3265, end: 3266 }]);
  });

  it("keeps a window inside the recording, and reads nothing for one that has no seconds there", async () => {
    const { asked, session } = engine(3291.755);
    expect(await session.readLevels("m1", 3289, 3294)).toMatchObject({ from: 3289, to: 3291.755 });
    expect(await session.readLevels("m1", -2, 3)).toMatchObject({ from: 0, to: 3 });
    // Past the end, or reversed: no seconds to read, and no evidence rather than a refused read.
    expect(await session.readLevels("m1", 3293, 3296)).toEqual({ mediaId: "m1", from: 3293, to: 3293, peaks: [], rms: [], speechActivity: [] });
    expect(await session.readLevels("m1", 20, 18)).toMatchObject({ peaks: [], speechActivity: [] });
    expect(asked).toEqual([{ from: 3289, to: 3291.755 }, { from: 0, to: 3 }]);
  });
});
