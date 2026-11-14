// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { timelineFromKeepRanges } from "@scarlet/timeline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlayerTimeline } from "../review/TimelineScrubber";
import { EditPassage } from "../review/CutTranscript";
import { api } from "../../lib/client";
import { player, pauseForScrub } from "../../lib/player";
import { buildDb, PRJ } from "../../lib/mock/fixtures";
import { useProjectStore } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { useUiStore } from "../../stores/ui";
import { TranscriptPane } from "./TranscriptPane";

const duration = 3660;
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

const transcript = <TranscriptPane source={source} onAsk={() => {}} />;
it("places historical notes beside surviving speech after a ripple and skips removed footage", async () => {
  const original = { ...timelineFromKeepRanges(PRJ, source.id, [{ start: 0, end: 60 }]), version: "before" };
  const edited = { ...timelineFromKeepRanges(PRJ, source.id, [{ start: 10, end: 60 }]), version: "after" };
  const notes = [30, 4].map(time => ({ ...db.notes[0]!, id: String(time), version: original.version, time, text: "Note at " + time, state: "open" as const }));
  const read = vi.spyOn(api, "timeline").mockResolvedValue({ timeline: original });
  useProjectStore.setState({ current: { ...useProjectStore.getState().current!, timeline: edited, project: { ...project, head: edited.version }, notes } });
  const seek = vi.spyOn(player, "seek");
  await act(async () => root.render(<MemoryRouter><TranscriptPane onAsk={() => {}} /></MemoryRouter>));
  const note = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Note at 30"))!;
  expect(note.textContent).toContain("0:20");
  expect(container.textContent).not.toContain("Note at 4");
  await act(() => note.click());
  expect(seek).toHaveBeenCalledWith(20);
  expect(read).toHaveBeenCalledExactlyOnceWith(PRJ, original.version);
});

it("says a note Scarlet is working on is with Scarlet", async () => {
  const edited = { ...timelineFromKeepRanges(PRJ, source.id, [{ start: 0, end: 60 }]), version: "now" };
  const note = { ...db.notes[0]!, id: "working", version: edited.version, time: 5, text: "Tighten this pause", state: "in_progress" as const };
  useProjectStore.setState({ current: { ...useProjectStore.getState().current!, timeline: edited, project: { ...project, head: edited.version }, notes: [note] } });
  await act(async () => root.render(<MemoryRouter><TranscriptPane onAsk={() => {}} /></MemoryRouter>));
  const row = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Tighten this pause"))!;
  expect(row.lastElementChild?.textContent).toBe("With Scarlet");
});

async function mount() {
  await act(async () => root.render(<MemoryRouter>{transcript}
    <PlayerTimeline duration={duration} frameAt={() => undefined} onSeek={t => player.seek(t)} onScrubStart={pauseForScrub} />
  </MemoryRouter>));
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(new DOMRect(0,0,duration,80));
  Object.defineProperty(slider, "setPointerCapture", {value() {}});
  return (type: string, x: number) => slider.dispatchEvent(new PointerEvent(type, {
    bubbles:true,isPrimary:true,pointerId:1,pointerType:"mouse",button:0,clientX:x,
  }));
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

it("loads the selected transcript minute when a fast drag ends", async () => {
  const point = await mount();
  expect(container.textContent).toContain("word0");
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const reads = vi.mocked(api.transcript);
  reads.mockClear();
  await act(async () => point("pointerdown", 0));
  for (let minute = 1; minute < 60; minute++) await act(async () => {
    point("pointermove", 60 * minute + 1); vi.advanceTimersByTime(16);
  });
  await act(async () => point("pointerup", 3601));
  expect(container.textContent).toContain("word3601");
  expect(reads.mock.calls.map(([,q]) => q?.from)).toEqual([3600, 3540]);
});

it("follows a held drag and releases transcript following when the captured timeline unmounts", async () => {
  const point = await mount();
  vi.useFakeTimers();
  await act(async () => point("pointerdown", 181));
  expect(container.textContent).toContain("word0");
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(container.textContent).toContain("word181");
  await act(async () => root.render(<MemoryRouter>{transcript}</MemoryRouter>));
  expect(usePlayerStore.getState().scrubGesture).toBeUndefined();
  await act(async () => player.seek(361));
  expect(container.textContent).toContain("word361");
});

it("keeps word activation, range selection and timestamp buttons working with delegated input", async () => {
  await mount();
  const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
  await act(async () => at(4).dispatchEvent(new KeyboardEvent("keydown", {bubbles:true, key:"Enter"})));
  expect(usePlayerStore.getState().time).toBe(4);
  await act(async () => at(4).dispatchEvent(new KeyboardEvent("keydown", {bubbles:true, key:"ArrowRight", shiftKey:true})));
  expect(at(4).classList.contains("bg-hi-dim")).toBe(true);
  expect(at(5).classList.contains("bg-hi-dim")).toBe(true);
  expect(at(5)).toBe(document.activeElement);
  // Where the selection, a word and a turn are reads on the clock, as a position does everywhere: no frames after a dot.
  expect(container.querySelector(".font-mono.tnum")?.textContent).toBe("0:04 – 0:06");
  expect(at(4).title).toBe("Play from here · 0:04");
  const turn = container.querySelector<HTMLButtonElement>(".reading-time")!;
  expect([turn.textContent, turn.getAttribute("aria-label")]).toEqual(["0:00", "Seek to 0:00"]);
  await act(async () => at(8).dispatchEvent(new MouseEvent("dblclick", {bubbles:true})));
  expect(at(8).classList.contains("bg-hi-dim")).toBe(true);
  expect(at(4).classList.contains("bg-hi-dim")).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>(".reading-time")!.click());
  expect(usePlayerStore.getState().time).toBe(0);
});

it("gives a selection inside one second its tenths, so its two ends don't read as the same time", async () => {
  // Words of 0.4 s: a word, or two short ones, often sits inside a single second.
  vi.mocked(api.transcript).mockImplementation(async (_id, q) => {
    const from = q?.from ?? 0;
    return { id: "test-transcript", mediaId: source.id, segments: [{ id: "segment-" + from, start: from, end: from + 60, text: "Spoken words",
      words: Array.from({ length: 150 }, (_, i) => ({ text: "word" + i, start: from + i * 0.4 + 0.2, end: from + i * 0.4 + 0.6 })) }] };
  });
  await mount();
  const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
  const selection = () => container.querySelector(".font-mono.tnum")?.textContent;
  await act(async () => at(10).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(selection()).toBe("0:04.2 – 0:04.6");
  // Stretched into the next second, it reads on the clock again, as every position does.
  await act(async () => at(10).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  expect(selection()).toBe("0:04 – 0:05");
});

it("keeps the first visible word at the same height when loading earlier words", async () => {
  usePlayerStore.setState({ time: 121 });
  await mount();
  const list = container.querySelector<HTMLElement>(".reading-scroll")!;
  let measuredWords = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this.dataset.w === undefined) return new DOMRect(0, 100, 300, 80);
    measuredWords++;
    return new DOMRect(0, 90 + (Number(this.dataset.w) - 48) * 10, 20, 10);
  });
  const earlier = [...list.querySelectorAll("button")].find(b => b.textContent === "Load earlier words");
  await act(async () => earlier!.click());
  expect(list.querySelector('[data-w="108"]')?.textContent).toBe("word168");
  expect(list.scrollTop).toBe(600);
  expect(measuredWords).toBeLessThan(12);
});

it("counts a single word as one word", async () => {
  const short = { ...source, id: "short", duration: 30 };
  vi.mocked(api.transcript).mockResolvedValue({ id: "test-transcript", mediaId: short.id, segments: [
    { id: "only", start: 2, end: 3, text: "Hello", words: [{ text: "Hello", start: 2, end: 3 }] }] });
  usePlayerStore.setState({ time: 0, duration: 30, playing: false });
  await act(async () => root.render(<MemoryRouter><TranscriptPane source={short} onAsk={() => {}} /></MemoryRouter>));
  expect(container.querySelector(".reading-window")?.textContent).toBe("0:00–0:30 · 1 word");
});

it("offers transcription once a source with audio finishes preparing", async () => {
  // A screen capture with no sound: transcribing it could only fail.
  const silent = { ...source, id: "silent", hasAudio: false, transcriptId: undefined };
  await act(async () => root.render(<MemoryRouter><TranscriptPane source={silent} onAsk={() => {}} /></MemoryRouter>));
  await act(async () => {});
  expect([...container.querySelectorAll("button")].map(b => b.textContent)).not.toContain("Transcribe");
  expect(api.transcript).not.toHaveBeenCalled();
  const checking = { ...silent, hasAudio: true, status: "ingesting" as const };
  await act(async () => root.render(<MemoryRouter><TranscriptPane key="sound" source={checking} onAsk={() => {}} /></MemoryRouter>));
  expect([...container.querySelectorAll("button")].map(b => b.textContent)).not.toContain("Transcribe");
  await act(async () => root.render(<MemoryRouter><TranscriptPane key="sound" source={{ ...silent, hasAudio: true }} onAsk={() => {}} /></MemoryRouter>));
  await act(async () => {});
  expect([...container.querySelectorAll("button")].map(b => b.textContent)).toContain("Transcribe");
});

it("aims the message box at the words selected in a clip, by the clip and their time, and lets go of the selection", async () => {
  const ui = useUiStore.getState();
  useUiStore.setState({ agentContext: null, composerFocus: 0, notePopover: null });
  const onAsk = vi.fn();
  await act(async () => root.render(<MemoryRouter><TranscriptPane source={source} onAsk={onAsk} /></MemoryRouter>));
  const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  // Nothing is selected, so there is nothing to ask about.
  expect(button("Ask about this")).toBeUndefined();
  await act(async () => at(4).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  // A clip's own words can be asked about. A note belongs to the edit, so a clip's transcript offers none.
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
  // The × puts a selection away without asking anything.
  await act(async () => at(2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Clear selection"]')!.click());
  expect(button("Ask about this")).toBeUndefined();
  expect(useUiStore.getState().agentContext).toBe(asked);
  expect(onAsk).toHaveBeenCalledTimes(2);
  useUiStore.setState(ui, true);
});

it("asks about words in the edit by the clips they play from, and offers a note on them there", async () => {
  const ui = useUiStore.getState();
  useUiStore.setState({ agentContext: null, composerFocus: 0, notePopover: null });
  // The edit plays the clip from its tenth second: the words' times are the edit's, ten seconds earlier.
  const edited = { ...timelineFromKeepRanges(PRJ, source.id, [{ start: 10, end: 60 }]), version: "after" };
  useProjectStore.setState({ current: { ...useProjectStore.getState().current!, timeline: edited, project: { ...project, head: edited.version } } });
  const onAsk = vi.fn(), onChoose = vi.fn();
  await act(async () => root.render(<MemoryRouter><TranscriptPane onAsk={onAsk} onChoose={onChoose} /></MemoryRouter>));
  const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
  const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  expect(at(0).textContent).toBe("word10");
  await act(async () => at(0).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  await act(async () => button("Ask about this")!.click());
  const clip = edited.tracks.flatMap(t => t.clips)[0]!;
  expect(useUiStore.getState().agentContext).toEqual({ version: "after", time: 0, end: 2, clipIds: [clip.id], label: "“word10 word11”" });
  expect(onAsk).toHaveBeenCalledTimes(1);
  // Note opens the note box over the same stretch of the edit.
  await act(async () => at(3).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", shiftKey: true })));
  await act(async () => button("Note")!.click());
  expect(useUiStore.getState().notePopover).toEqual({ open: true, time: 3, end: 5 });
  expect(onChoose).toHaveBeenCalledTimes(1);
  expect(button("Ask about this")).toBeUndefined();
  useUiStore.setState(ui, true);
});

it("lets Shift+Tab leave the words, and still takes a Tab in from outside, or a press between the words, to a word", async () => {
  await mount();
  const list = container.querySelector<HTMLElement>(".reading-scroll")!;
  const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
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
  const at = (n: number) => container.querySelector<HTMLElement>(`[data-w="${n}"]`)!;
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
