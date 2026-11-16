// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { timelineFromKeepRanges } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditPassage } from "../review/CutTranscript";
import { api } from "../../lib/client";
import { player } from "../../lib/player";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { useUiStore } from "../../stores/ui";
import { findWords, TranscriptPane } from "./TranscriptPane";

const duration = 60;
const db = buildDb();
const project = db.projects.find(p => p.id === PRJ)!;
const source = {...project.media[0]!, duration, transcriptId:"test-transcript"};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "settings").mockResolvedValue({settings:db.settings,transcriptionAvailable:true});
  vi.spyOn(api, "transcript").mockImplementation(async (_id, q) => {
    const from = q?.from ?? 0;
    return {id:"test-transcript",mediaId:source.id,segments:[{id:"segment-"+from,start:from,end:from+60,text:"Spoken words",
      words:Array.from({length:60},(_,i)=>({text:"word"+(from+i),start:from+i,end:from+i+1}))}]};
  });
  usePlayerStore.setState({time:0,duration,playing:false});
  useProjectStore.setState({status:"ready",current:{id:PRJ,project,timeline:null,media:[source],
    changes:[],notes:[],tasks:[],renders:[],taskEvents:{}}});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => root.render(<MemoryRouter><TranscriptPane source={source} onAsk={() => {}} /></MemoryRouter>));
}
const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
async function search(text: string) {
  const field = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("shows the replacement in an open transcript and cut card when an older page finishes late", async () => {
  const short = { ...source, duration: 12 };
  const timeline = timelineFromKeepRanges(PRJ, short.id, [{ start: 0, end: 12 }]);
  useProjectStore.setState({ current: { ...useProjectStore.getState().current!, media: [short], timeline } });
  let releaseOld!: () => void;
  const pending = new Promise<void>(resolve => { releaseOld = resolve; });
  let savedId = short.transcriptId;
  vi.mocked(api.transcript).mockImplementation(async () => {
    const id = savedId;
    const text = id === short.transcriptId ? "original" : "replacement";
    if (id === short.transcriptId) await pending;
    return { id, mediaId: short.id, segments: [{ id: "s", start: 3, end: 4, text, words: [{ start: 3, end: 4, text }] }] };
  });
  function OpenPassages() {
    const media = useProjectStore(s => s.current!.media);
    return <><TranscriptPane source={media[0]} onAsk={() => {}} />
      <EditPassage timeline={timeline} media={media} range={{ start: 2, end: 5 }} length="0:03" /></>;
  }
  await act(async () => root.render(<MemoryRouter><OpenPassages /></MemoryRouter>));
  expect(api.transcript).toHaveBeenCalledTimes(2);
  savedId = "new-transcript";
  await act(async () => useProjectStore.getState().applyEvent({ type: "media.updated", projectId: PRJ, media: { ...short, transcriptId: savedId } }));
  const shown = () => [container.querySelector("[data-w]")?.textContent, container.querySelector(".edit-passage .review-removed")?.textContent];
  expect(shown()).toEqual(["replacement", "replacement"]);
  await act(async () => releaseOld());
  expect(shown()).toEqual(["replacement", "replacement"]);
});

it("keeps word activation, range selection and timestamp buttons working with delegated input", async () => {
  await mount();
  await act(async () => at(4).dispatchEvent(new KeyboardEvent("keydown", {bubbles:true, key:"Enter"})));
  expect(usePlayerStore.getState().time).toBe(4);
  await act(async () => at(4).dispatchEvent(new KeyboardEvent("keydown", {bubbles:true, key:"ArrowRight", shiftKey:true})));
  expect(at(4).classList.contains("bg-hi-dim")).toBe(true);
  expect(at(5).classList.contains("bg-hi-dim")).toBe(true);
  expect(at(5)).toBe(document.activeElement);
  // Where the selection, a word and a turn are reads on the clock, as a position does everywhere: no frames after a dot.
  expect(container.querySelector(".transcript-chosen span")?.textContent).toBe("0:04 – 0:06");
  const turn = container.querySelector<HTMLButtonElement>(".reading-time")!;
  expect([turn.textContent, turn.getAttribute("aria-label")]).toEqual(["0:00", "Seek to 0:00"]);
  await act(async () => at(8).dispatchEvent(new MouseEvent("dblclick", {bubbles:true})));
  expect(at(8).classList.contains("bg-hi-dim")).toBe(true);
  expect(at(4).classList.contains("bg-hi-dim")).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>(".reading-time")!.click());
  expect(usePlayerStore.getState().time).toBe(0);
});

it("places the playhead on a clicked word without playing, and says so on hover rather than offering to play", async () => {
  await mount();
  const play = vi.spyOn(player, "play");
  await act(async () => at(7).click());
  expect(usePlayerStore.getState().time).toBe(7);
  expect(play).not.toHaveBeenCalled();
  // Neither the words nor the list say a click plays: it doesn't.
  expect(at(7).title).toBe("0:07");
  const list = container.querySelector<HTMLElement>(".reading-scroll")!;
  expect(list.title).toMatch(/^Click a word to place the playhead there/);
  expect([at(7).title, list.title].join(" ")).not.toMatch(/\bplay\b|play from/i);
});

it("underlines only the searched words when the search holds a mark that is no word", async () => {
  // "a -": the dash is no word, so each match is the one word, not that word and the one after it.
  expect(findWords([{ word: { text: "a" } }, { word: { text: "-" } }], "a -")).toEqual([0]);
  await mount();
  await search("word4 -");
  expect(at(4).hasAttribute("data-match")).toBe(true);
  expect(at(5).hasAttribute("data-match")).toBe(false);
  expect(container.querySelector(".transcript-search-count")?.textContent).toBe("1 of 11");
  // Two words are each underlined, the match being the pair.
  await search("word4 word5");
  expect([at(4), at(5), at(6)].map(w => w.hasAttribute("data-match"))).toEqual([true, true, false]);
});

it("gives a selection inside one second its tenths, so its two ends don't read as the same time", async () => {
  // Words of 0.4 s: a word, or two short ones, often sits inside a single second.
  vi.mocked(api.transcript).mockImplementation(async (_id, q) => {
    const from = q?.from ?? 0;
    return { id: "test-transcript", mediaId: source.id, segments: [{ id: "segment-" + from, start: from, end: from + 60, text: "Spoken words",
      words: Array.from({ length: 150 }, (_, i) => ({ text: "word" + i, start: from + i * 0.4 + 0.2, end: from + i * 0.4 + 0.6 })) }] };
  });
  await mount();
  const selection = () => container.querySelector(".transcript-chosen span")?.textContent;
  await act(async () => at(10).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(selection()).toBe("0:04.2 – 0:04.6");
  // Stretched into the next second, it reads on the clock again, as every position does.
  await act(async () => at(10).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  expect(selection()).toBe("0:04 – 0:05");
});

it("says how a recording without words stands after the words, plainly, instead of a blank column", async () => {
  // A screen capture with no sound: there is no transcript to have.
  const silent = { ...source, id: "silent", hasAudio: false, transcriptId: undefined };
  await act(async () => root.render(<MemoryRouter><TranscriptPane source={silent} onAsk={() => {}} /></MemoryRouter>));
  expect(container.querySelector(".transcript-missing")).toBeNull();
  expect(api.transcript).not.toHaveBeenCalled();
  const line = () => container.querySelector(".transcript-missing")?.textContent;
  // Still being added.
  const checking = { ...silent, hasAudio: true, status: "ingesting" as const };
  await act(async () => root.render(<MemoryRouter><TranscriptPane key="sound" source={checking} onAsk={() => {}} /></MemoryRouter>));
  expect(line()).toBe(`${source.name}Adding`);
  // Added with no transcript: the column says so after the words, with nothing to press for it.
  const added = { ...silent, hasAudio: true };
  await act(async () => root.render(<MemoryRouter><TranscriptPane key="sound" source={added} onAsk={() => {}} /></MemoryRouter>));
  expect(line()).toBe(`${source.name}No transcript`);
  expect(container.querySelector(".reading-scroll .transcript-missing")).not.toBeNull();
  expect(container.querySelector(".transcript-missing button, .transcript-missing a")).toBeNull();
  expect(container.textContent).not.toContain("No spoken words here.");
  // Being transcribed: how far along it is.
  const running: Task = { ...db.tasks[0]!, id: "transcribing", projectId: PRJ, kind: "transcribe", agent: "api", context: { mediaId: added.id },
    state: "running", instruction: `Transcribe ${added.name}`, progress: { stage: "transcribing", fraction: 0.4 } };
  await act(async () => useProjectStore.setState({ current: { ...useProjectStore.getState().current!, media: [added], tasks: [running] } }));
  expect(line()).toBe(`${source.name}Transcribing 40%`);
});

it("aims the message box at the words selected in a clip, by the clip and their time, and lets go of the selection", async () => {
  const ui = useUiStore.getState();
  useUiStore.setState({ agentContext: null, composerFocus: 0, notePopover: null });
  const onAsk = vi.fn();
  await act(async () => root.render(<MemoryRouter><TranscriptPane source={source} onAsk={onAsk} /></MemoryRouter>));
  // Nothing is selected, so there is nothing to ask about.
  expect(button("Ask about this")).toBeUndefined();
  await act(async () => at(4).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  // The column offers no note: the chat holds those.
  expect(button("Note")).toBeUndefined();
  await act(async () => button("Ask about this")!.click());
  expect(onAsk).toHaveBeenCalledTimes(1);
  expect(useUiStore.getState().agentContext).toEqual({ version: project.head, time: 4, end: 6, clipIds: [], mediaId: source.id, label: "“word4 word5”" });
  expect(useUiStore.getState().composerFocus).toBe(1);
  expect(button("Ask about this")).toBeUndefined();
  expect(at(4).classList.contains("bg-hi-dim")).toBe(false);
  // A long passage is named by how it starts.
  await act(async () => at(10).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End", shiftKey: true })));
  await act(async () => button("Ask about this")!.click());
  const asked = useUiStore.getState().agentContext;
  expect(asked).toMatchObject({ time: 10, end: 60, label: "“word10 word11 word12 word13 word14 wo…”" });
  // Clear puts a selection away without asking anything.
  await act(async () => at(2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await act(async () => button("Clear")!.click());
  expect(button("Ask about this")).toBeUndefined();
  expect(useUiStore.getState().agentContext).toBe(asked);
  expect(onAsk).toHaveBeenCalledTimes(2);
  useUiStore.setState(ui, true);
});

it("asks about words in the edit by the clips they play from", async () => {
  const ui = useUiStore.getState();
  useUiStore.setState({ agentContext: null, composerFocus: 0, notePopover: null });
  // The edit plays the clip from its tenth second: the words' times are the edit's, ten seconds earlier.
  const edited = { ...timelineFromKeepRanges(PRJ, source.id, [{ start: 10, end: 60 }]), version: "after" };
  useProjectStore.setState({ current: { ...useProjectStore.getState().current!, timeline: edited, project: { ...project, head: edited.version } } });
  const onAsk = vi.fn();
  await act(async () => root.render(<MemoryRouter><TranscriptPane onAsk={onAsk} /></MemoryRouter>));
  expect(at(0).textContent).toBe("word10");
  await act(async () => at(0).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  expect(button("Note")).toBeUndefined();
  await act(async () => button("Ask about this")!.click());
  const clip = edited.tracks.flatMap(t => t.clips)[0]!;
  expect(useUiStore.getState().agentContext).toEqual({ version: "after", time: 0, end: 2, clipIds: [clip.id], label: "“word10 word11”" });
  expect(onAsk).toHaveBeenCalledTimes(1);
  useUiStore.setState(ui, true);
});

it("lets Shift+Tab leave the words, and still takes a Tab in from outside, or a press between the words, to a word", async () => {
  await mount();
  const list = container.querySelector<HTMLElement>(".reading-scroll")!;
  const byKeyboard = vi.spyOn(list, "matches").mockImplementation(selector => selector === ":focus-visible");
  const outside = document.body.appendChild(document.createElement("button"));
  try {
    // Tab from the control before the transcript lands on the list, which hands the keyboard to a word.
    outside.focus();
    await act(async () => list.focus());
    const word = document.activeElement as HTMLElement;
    expect(word.dataset.w).toBeDefined();
    // Shift+Tab from a word lands on the list too. It stays there, so the next Shift+Tab is out of the transcript:
    // sent back to a word, the keyboard went round between the word and the list for good.
    at(4).focus();
    await act(async () => list.focus());
    expect(document.activeElement).toBe(list);
    // A press on the space between the words, with a word in focus, still goes to a word: the arrows work from there.
    byKeyboard.mockReturnValue(false);
    at(4).focus();
    await act(async () => list.focus());
    expect((document.activeElement as HTMLElement).dataset.w).toBe(word.dataset.w);
  } finally {
    outside.remove();
  }
});

it("leaves alone an arrow the page has already taken, and moves between words on one it hasn't", async () => {
  await mount();
  const down = () => act(async () => { at(4).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })); });
  at(4).focus();
  // The page steps edits with ↑ and ↓ from a listener that runs first and prevents the key's default.
  const page = (e: KeyboardEvent) => { if (e.key === "ArrowDown") e.preventDefault(); };
  window.addEventListener("keydown", page, true);
  try {
    await down();
    expect(document.activeElement).toBe(at(4));
  } finally {
    window.removeEventListener("keydown", page, true);
  }
  await down();
  expect(document.activeElement).toBe(at(5));
});
