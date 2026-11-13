import { describe, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip, type MediaClip } from "@scarlet/timeline";
import { removesRecordedFootage } from "./dialogueRemoval.js";

describe("classifying source time removed by an agent proposal", () => {
  const project = createProject("Synchronized recordings");
  project.media.push(
    { id: "screen", name: "Screen", kind: "video", path: "screen.mp4", duration: 20, hasAudio: false },
    { id: "mic", name: "Mic", kind: "audio", path: "mic.wav", duration: 24, hasAudio: true },
  );
  const screen = makeMediaClip("screen", 0, 20, 0);
  const mic = (start: number, end: number, at = 0) => makeMediaClip("mic", start, end, at);
  function timeline(...clips: MediaClip[]) {
    const tl = emptyTimeline(project.id);
    for (const clip of clips) tl.tracks[clip.mediaId === "screen" ? 0 : 1]!.clips.push(clip);
    return tl;
  }

  it("allows a full source, a selected source passage, and a secondary track clipped only to synchronized overlap", () => {
    const empty = timeline();
    expect(removesRecordedFootage(empty, timeline(mic(0, 24)), project)).toBe(false);
    expect(removesRecordedFootage(empty, timeline(mic(2, 22)), project)).toBe(true);
    expect(removesRecordedFootage(empty, timeline(mic(2, 22)), project, { mediaId: "mic", time: 2, end: 22 })).toBe(false);
    expect(removesRecordedFootage(empty, timeline(screen, mic(2, 22)), project)).toBe(false);
    expect(removesRecordedFootage(empty, timeline(screen, mic(0, 17, 3)), project)).toBe(false);
    expect(removesRecordedFootage(empty, timeline(screen, mic(2, 10, 3)), project)).toBe(true);
  });

  it("detects omitted dialogue in one assembly or across successive additions while preserving older cuts", () => {
    const assembled = timeline(screen, mic(0, 6), mic(10, 24, 6));
    expect(removesRecordedFootage(timeline(), assembled, project)).toBe(true);
    expect(removesRecordedFootage(timeline(screen), assembled, project)).toBe(true);
    expect(removesRecordedFootage(timeline(screen, mic(0, 6)), assembled, project)).toBe(true);
    expect(removesRecordedFootage(assembled, structuredClone(assembled), project)).toBe(false);
    const muted = { ...mic(0, 24), volume: 0 };
    expect(removesRecordedFootage(timeline(muted), timeline(muted, mic(0, 6), mic(10, 24, 6)), project)).toBe(true);
    expect(removesRecordedFootage(timeline(muted), timeline(muted, mic(4, 8, 4)), project)).toBe(true);
  });

  it("counts a repeated performance and distinguishes a muted duplicate or a mix adjustment", () => {
    const playing = mic(0, 24), second = mic(0, 24, 24);
    expect(removesRecordedFootage(timeline(playing, second), timeline(playing), project)).toBe(true);
    expect(removesRecordedFootage(timeline(playing, { ...second, volume: 0 }), timeline(playing), project)).toBe(false);
    expect(removesRecordedFootage(timeline(playing), timeline({ ...playing, volume: 0 }), project)).toBe(false);
    expect(removesRecordedFootage(timeline(playing, { ...second, volume: 0 }), timeline({ ...second, volume: 0 }), project)).toBe(true);
  });
});
