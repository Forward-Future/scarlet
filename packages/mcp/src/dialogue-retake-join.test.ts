import { describe, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { acousticRepeatedTakes } from "./dialogue-retakes.js";
import { acousticRetakeContinuations, acousticRetakeJoin } from "./dialogue-retake-join.js";

const words = "one more block one more block away".split(" ").map((text, i) => ({ text, start: 10 + i * .4, end: 10.2 + i * .4 }));
const fromWords = (runs: typeof words[]) => acousticRetakeContinuations(runs, acousticRepeatedTakes(runs, 0));
const page = { mediaId: "voice", takes: fromWords([words]) };
const project = createProject("Retake continuity");
project.media = [{ id: "voice", kind: "audio", name: "voice", path: "voice.wav", duration: 30, hasAudio: true }];

describe("acoustic retake continuity", () => {
  it("requires a new word in the same measured run, near the immediate restart", () => {
    expect(fromWords([words.slice(0, -1), words.slice(-1)])).toEqual([]);
    expect(fromWords([words.map((w, i) => i === 6 ? { ...w, start: 22, end: 22.2 } : w)])).toEqual([]);
    expect(fromWords([words.map((w, i) => i === 6 ? { ...w, text: "one" } : w)])).toEqual([]);
  });

  it("maps through the active audible clip at its new timeline position and playback speed", () => {
    const tl = emptyTimeline(project.id);
    const clip = makeMediaClip("voice", 9, 14, 2, { speed: 2 });
    tl.tracks[0]!.clips = [clip];
    const range = { start: 2.48, end: 3.09 };
    const read = () => acousticRetakeJoin(tl, project, range, [page, page]);
    expect(read()).toMatchObject([{ retainedOccurrence: "second", followingWord: { text: "away" } }]);
    expect(acousticRetakeJoin(tl, project, { start: 3.08, end: 3.71 }, [page])).toMatchObject([{
      removedOccurrence: "second", cutTouchesFollowingWordByMs: 20,
    }]);
    expect(acousticRetakeJoin(tl, project, { start: 3.08, end: 3.76 }, [page])).toEqual([]);
    expect(acousticRetakeJoin(tl, project, range, [{ ...page, audioStream: 0 }])).toEqual([]);
    Object.assign(clip, { audioStream: 1 });
    expect(read()).toEqual([]);
    expect(acousticRetakeJoin(tl, project, range, [{ ...page, audioStream: 1 }])).toMatchObject([{ audioStream: 1, retainedOccurrence: "second" }]);
    Object.assign(clip, { audioStream: undefined });
    tl.tracks[0]!.muted = true;
    expect(read()).toEqual([]);
    tl.tracks[0]!.muted = false;
    clip.sourceOut = 11.1;
    tl.tracks[0]!.clips.push(makeMediaClip("voice", 11.18, 14, 3.05, { speed: 2 }));
    expect(read()).toEqual([]);
  });
});
