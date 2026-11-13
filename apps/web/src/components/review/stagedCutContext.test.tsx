// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyTimeline, makeMediaClip, type MediaAsset, type Timeline, type Transcript } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { EditPassage, StruckExcerpt } from "./CutTranscript";
import { OtherTakes } from "./OtherTakes";
import { cutSource, otherTakes } from "./retakeLookup";

const mic: MediaAsset = { id: "mic", name: "Mic", path: "mic.wav", kind: "audio", hasAudio: true, duration: 120, transcriptId: "tr_mic" };

/** The recording plays 0–40 s, then 60–120 s. Its 40–60 s were cut earlier. */
function timeline(): Timeline {
  const tl = emptyTimeline("prj");
  tl.version = "v1";
  tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 40, 0), makeMediaClip("mic", 60, 120, 40)];
  return tl;
}

function spoken(text: string, start: number, step = .4) {
  const words = text.split(" ").map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + .3 }));
  return { id: `s${start}`, text, start, end: words.at(-1)!.end, words };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

it("strikes through the words a staged cut removes between a few kept words either side", async () => {
  // “so the next thing we um we did was open the project file today”: the cut removes “um we”.
  const transcript: Transcript = { id: "tr_mic", mediaId: "mic", segments: [spoken("so the next thing we um we did was open the project file today", 10)] };
  vi.spyOn(api, "transcript").mockResolvedValue(transcript);
  // Word 5 (“um”) starts at 12.0 s, word 6 (“we”) ends at 12.7 s.
  await act(async () => root.render(<StruckExcerpt timeline={timeline()} media={[mic]} range={{ start: 11.95, end: 12.75 }} />));
  await settle();
  const group = container.querySelector('[aria-label="Words this cut removes"]')!;
  expect(group).not.toBeNull();
  expect(group.querySelector("del")?.textContent).toBe("um we");
  const [before, after] = [...group.querySelectorAll(".review-kept")].map(n => n.textContent);
  // Four kept words either side, no more.
  expect(before).toBe("… the next thing we");
  expect(after).toBe("did was open the …");
  expect(group.textContent).not.toContain("so the");
});

it("reads an edit card's cut as the words either side of one mark, which opens a long cut's words, with no speaker tags", async () => {
  const segment = spoken("It broke last week. click the problem is still building on my computer okay test the new model from Deepseek flew under the radar.", 10);
  // Two speakers each hold the floor, which used to tag the passage with their names.
  segment.words = segment.words.map((w, i) => ({ ...w, speaker: i < 9 ? "Speaker 1" : "Speaker 2" }));
  vi.spyOn(api, "transcript").mockResolvedValue({ id: "tr_mic", mediaId: "mic", segments: [segment] } as Transcript);
  // “click” starts at 11.6 s and “test” ends at 15.9 s: eleven words, more than the mark shows.
  await act(async () => root.render(<EditPassage timeline={timeline()} media={[mic]} range={{ start: 11.55, end: 15.95 }} length="4.4 s" />));
  await settle();
  const group = () => container.querySelector('[aria-label="Words this cut removes"]')!;
  const mark = () => group().querySelector<HTMLButtonElement>("button.edit-passage-cut")!;
  expect(group().textContent).toBe("… It broke last week. 4.4 s the new model from Deepseek flew under the radar.");
  expect(group().querySelector(".review-voice")).toBeNull();
  expect(mark().getAttribute("aria-expanded")).toBe("false");
  await act(async () => mark().click());
  expect(mark().getAttribute("aria-expanded")).toBe("true");
  expect(group().querySelector("del.review-removed")?.textContent).toBe("click the problem is still building on my computer okay test");
  await act(async () => mark().click());
  expect(group().querySelector("del")).toBeNull();

  // A short cut shows its words struck in the mark, with its length on hover.
  await act(async () => root.render(<EditPassage key="short" timeline={timeline()} media={[mic]} range={{ start: 11.55, end: 12.35 }} length="0.8 s" />));
  await settle();
  const short = group().querySelector(".edit-passage-cut")!;
  expect(short.matches(".is-words")).toBe(true);
  expect(short.getAttribute("title")).toBe("0.8 s");
  expect(short.querySelector("del")?.textContent).toBe("click the");
});

it("finds the other attempts at the line a cut removes and where each plays", () => {
  const tl = timeline();
  const groups = [{ score: .9, takes: [
    { start: 5, end: 8, text: "So today we are going to edit." },
    { start: 12, end: 15, text: "So today we're going to edit." },
    { start: 45, end: 48, text: "So today we are editing a video." },
    { start: 70, end: 73, text: "Today we are going to edit a video." },
  ] }];
  // The cut removes the first attempt, played at 5–8 s on the timeline.
  const source = cutSource(tl, [mic], { start: 4.9, end: 8.1 })!;
  expect(source).toMatchObject({ mediaId: "mic", start: 4.9, end: expect.closeTo(8.1) });
  expect(otherTakes(groups, source, tl)).toEqual([
    { start: 12, end: 15, text: "So today we're going to edit.", at: 12 },
    // An earlier cut already removed this take.
    { start: 45, end: 48, text: "So today we are editing a video." },
    { start: 70, end: 73, text: "Today we are going to edit a video.", at: 50 },
  ]);
  // A filler inside a take is not a take of its own.
  expect(otherTakes(groups, cutSource(tl, [mic], { start: 6, end: 6.3 })!, tl)).toEqual([]);
  // Media without a transcript has no retakes to look up.
  expect(cutSource(tl, [{ ...mic, transcriptId: undefined }], { start: 5, end: 8 })).toBeUndefined();
});

it("lists other takes with timeline times from the engine's retake route", async () => {
  const retakes = vi.spyOn(api, "retakes").mockResolvedValue({ mediaId: "mic", groups: [{ score: .9, takes: [
    { start: 5, end: 8, text: "So today we are going to edit." },
    { start: 45, end: 48, text: "So today we are editing." },
    { start: 70, end: 73, text: "Today we are going to edit." },
  ] }] });
  const play = vi.fn();
  await act(async () => root.render(<OtherTakes projectId="prj" timeline={timeline()} media={[mic]} range={{ start: 5, end: 8 }} onPlay={play} />));
  await settle();
  expect(retakes).toHaveBeenCalledWith("prj", "mic", 5, 8);
  const list = container.querySelector('[aria-label="Other takes"]')!;
  expect(list.querySelector(".other-takes-head")?.textContent).toBe("Other takes · 2");
  expect([...list.querySelectorAll("li")].map(li => li.textContent)).toEqual(["CutSo today we are editing.", "0:50Today we are going to edit."]);
  await act(async () => { list.querySelector("button")!.click(); });
  expect(play).toHaveBeenCalledWith(expect.objectContaining({ at: 50, start: 70 }));
});

it("shows nothing when the line has no other takes", async () => {
  vi.spyOn(api, "retakes").mockResolvedValue({ mediaId: "mic", groups: [] });
  await act(async () => root.render(<OtherTakes projectId="prj" timeline={timeline()} media={[mic]} range={{ start: 5, end: 8 }} />));
  await settle();
  expect(container.innerHTML).toBe("");
});
