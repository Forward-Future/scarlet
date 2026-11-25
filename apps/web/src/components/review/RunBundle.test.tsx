// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Task, TaskEvent, UsageResponse, UsageTotals } from "@scarlet/shared";
import { api } from "../../lib/client";
import { tokenBreakdown, tokenLabel } from "../../lib/format";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import type { MediaAsset } from "@scarlet/timeline";
import { TranscriptLine } from "../media/TranscriptionAction";
import { UsageSettings } from "../shell/UsageSettings";
import { RequestMetrics, RunBundle, runEnded } from "./RunBundle";

const task: Task = {
  id: "tsk_1", projectId: "prj_1", kind: "edit", agent: "claude", model: "opus", instruction: "Tighten the intro",
  context: {}, state: "done", createdBy: { type: "human", name: "Editor" }, hostId: null, changeIds: [],
  question: null, summary: "Tightened the intro.", startedAt: "2026-11-05T10:00:00.000Z", finishedAt: "2026-11-05T10:02:00.000Z",
};

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  runs: 1, inputTokens: 1200, outputTokens: 3000, cacheReadTokens: 44_000, cacheWriteTokens: 0, reasoningTokens: 0,
  totalTokens: 48_200, firstAt: "2026-11-05T10:02:00.000Z", lastAt: "2026-11-05T10:02:00.000Z", ...over,
});

let host: HTMLDivElement | undefined;
function render(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const rerender = (next: React.ReactNode) => act(() => root.render(<MemoryRouter>{next}</MemoryRouter>));
  rerender(node);
  return { host, rerender, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  host?.remove();
  host = undefined;
  act(() => useProjectStore.setState({ current: null }));
  useUiStore.getState().setShowRunTokens(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function openProject(taskUsage?: ProjectData["taskUsage"]) {
  useProjectStore.setState({ current: { id: "prj_1", taskUsage, tasks: [task], taskEvents: {} } as unknown as ProjectData });
}

it("labels token counts at a glance and breaks them down without cost", () => {
  expect([1, 850, 999, 1000, 48_234, 312_400, 999_400, 999_600, 1_234_567].map(tokenLabel)).toEqual([
    "1 token", "850 tokens", "999 tokens", "1K tokens", "48.2K tokens", "312K tokens", "999K tokens", "1M tokens", "1.2M tokens",
  ]);
  expect(tokenBreakdown(totals({ runs: 2, cacheWriteTokens: 5 }))).toBe(
    `${(1200).toLocaleString()} input · ${(3000).toLocaleString()} output · ${(44_000).toLocaleString()} cache read · 5 cache write · 2 runs`);
});

it("shows tokens in the chat until the editor turns them off", () => {
  act(() => useUiStore.getState().setShowRunTokens(false));
  openProject({ [task.id]: totals() });
  const view = render(<RunBundle task={task} events={[]} changes={[]} />);
  // One row: what the run amounts to. A finished request has no time on it and no steps to open.
  expect(view.host.querySelector(".run-summary")?.textContent).toBe("Tightened the intro");
  expect(view.host.querySelector(".req-time, .req-steps, .run-chevron")).toBeNull();
  expect(view.host.querySelector(".run-tokens")).toBeNull();

  act(() => useUiStore.getState().setShowRunTokens(true));
  expect(view.host.querySelector(".run-tokens")?.textContent).toBe("48.2K tokens");
  act(() => useUiStore.getState().setShowRunTokens(false));
  expect(view.host.querySelector(".run-tokens")).toBeNull();
  view.unmount();
});

it("adds no row that repeats what Scarlet's own words already say, unless it opens an edit the request made", () => {
  openProject();
  const reply = <p className="req-say">Tightened the intro by two seconds.</p>;
  // Scarlet's reply says what the request came to: there is no second line under it saying so again, cut short.
  const view = render(<RunBundle task={task} events={[]} changes={[]} say={reply} told />);
  expect(view.host.querySelector(".req-say")?.textContent).toBe("Tightened the intro by two seconds.");
  expect(view.host.querySelector(".req-result")).toBeNull();
  // Nor when the request changed nothing and there is a cut it could open: the row would be the reply's first words again.
  view.rerender(<RunBundle task={task} events={[]} changes={[]} say={reply} told onOpen={() => {}} />);
  expect(view.host.querySelector(".req-result")).toBeNull();
  // A row that opens the edit the request made stays.
  const made = { id: "chg_1", state: "approved", description: "Tightened the intro.", cutReasons: [], ranges: [] } as unknown as Parameters<typeof RunBundle>[0]["finalChange"];
  view.rerender(<RunBundle task={task} events={[]} changes={[]} finalChange={made} say={reply} told onOpen={() => {}} />);
  expect(view.host.querySelector("button.req-summary")?.textContent).toBe("Tightened the intro");
  // A run that stopped early says so, and Scarlet's words stand for what it left: no cut-off copy of them under it.
  // With no words from Scarlet, the row says what the run saved.
  view.rerender(<RunBundle task={{ ...task, state: "cancelled" }} events={[]} changes={[]} say={reply} told />);
  expect([view.host.querySelector(".req-state")?.textContent, !!view.host.querySelector(".req-result")]).toEqual(["Stopped", false]);
  view.rerender(<RunBundle task={{ ...task, state: "cancelled", summary: null }} events={[]} changes={[]} />);
  expect([view.host.querySelector(".req-state")?.textContent, view.host.querySelector(".req-result")?.textContent]).toEqual(["Stopped", "Nothing saved"]);
  // Words that don't say the result, such as an answered question, leave the row in place.
  view.rerender(<RunBundle task={task} events={[]} changes={[]} say={reply} />);
  expect(view.host.querySelector(".run-summary")?.textContent).toBe("Tightened the intro");
  view.unmount();
});

it("adds the request's tokens to its finished run line, and updates live", () => {
  useUiStore.getState().setShowRunTokens(true);
  openProject();
  const view = render(<RunBundle task={task} events={[]} changes={[]} />);
  // One row: what the run amounts to. A finished request has no time on it and no steps to open.
  expect(view.host.querySelector(".run-summary")?.textContent).toBe("Tightened the intro");
  expect(view.host.querySelector(".req-time, .req-steps, .run-chevron")).toBeNull();
  expect(view.host.textContent).not.toContain("tokens");

  act(() => useProjectStore.getState().applyEvent({
    type: "task.usage", projectId: "prj_1", taskId: task.id, usage: totals({ runs: 2, reasoningTokens: 100, estimatedApiCostUsd: 0.009 }),
  }));
  const tokens = view.host.querySelector(".run-tokens");
  const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  expect(tokens?.textContent).toBe("48.2K tokens");
  expect(tokens?.getAttribute("aria-label")).toContain("cache read");
  expect(tokens?.getAttribute("aria-label")).not.toContain("2 runs");
  // Hovering or focusing the count opens every part of it under the count; it closes again when the pointer leaves.
  act(() => (tokens as HTMLElement).focus());
  expect([...document.querySelectorAll(".tokens-tip > span")].map(row => row.textContent)).toEqual([
    `Input${(1200).toLocaleString()}`, `Output${(3000).toLocaleString()}`, `Cache read${(44_000).toLocaleString()}`,
    `Total${(48_200).toLocaleString()}`, `Est Cost<${usd.format(0.01)}`]);
  act(() => (tokens as HTMLElement).blur());
  expect(document.querySelector(".tokens-tip")).toBeNull();
  expect(view.host.textContent).not.toMatch(/\$|cost/i);

  // Another project's report never lands here.
  act(() => useProjectStore.getState().applyEvent({ type: "task.usage", projectId: "prj_2", taskId: task.id, usage: totals({ totalTokens: 1 }) }));
  expect(view.host.querySelector(".run-tokens")?.textContent).toBe("48.2K tokens");
  view.unmount();
});

it("shows tokens so far while waiting for an answer, and after a stop", () => {
  useUiStore.getState().setShowRunTokens(true);
  openProject({ [task.id]: totals({ totalTokens: 900 }) });
  const asking = render(<RunBundle task={{ ...task, state: "waiting_for_user", finishedAt: undefined }} events={[]} changes={[]} />);
  expect(asking.host.textContent).toContain("Needs your answer");
  expect(asking.host.querySelector(".run-tokens")?.textContent).toBe("900 tokens");
  asking.unmount();
  host?.remove();

  const working = render(<RunBundle task={{ ...task, state: "running", finishedAt: undefined }} events={[]} changes={[]} />);
  expect(working.host.querySelector(".run-tokens")).toBeNull();
  working.unmount();
  host?.remove();

  const stopped = render(<RunBundle task={{ ...task, state: "cancelled" }} events={[]} changes={[]} />);
  expect(stopped.host.querySelector(".req-state")?.textContent).toBe("Stopped");
  expect(stopped.host.querySelector(".run-tokens")?.textContent).toBe("900 tokens");
  stopped.unmount();
});

it("lists tokens by project, provider and model in Settings", async () => {
  const response = (by: UsageResponse["by"], groups: UsageResponse["groups"]): UsageResponse =>
    ({ by, total: totals({ runs: 3, totalTokens: 1_250_000 }), groups });
  vi.spyOn(api, "usage").mockImplementation(async by => by === "project"
    ? response("project", [{ key: "prj_1", ...totals() }, { key: "prj_gone", ...totals({ totalTokens: 10 }) }])
    : by === "agent" ? response("agent", [{ key: "claude", ...totals() }])
    : response("model", [{ key: null, ...totals() }]));
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [{ id: "prj_1", name: "Interview" }] } as Awaited<ReturnType<typeof api.projects>>);
  vi.spyOn(api, "trash").mockResolvedValue({ projects: [] });

  const view = render(<UsageSettings />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const text = () => view.host.textContent ?? "";
  expect(text()).toContain("1.3M tokens");
  expect(text()).toContain("3 runs since ");
  expect(text()).toContain("Interview");
  expect(text()).toContain("Deleted project");
  expect(text()).not.toMatch(/agent/i);
  expect(text()).not.toMatch(/\$|cost/i);

  const tabButton = (label: string) => [...view.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes(label))!;
  act(() => tabButton("Providers").click());
  expect(text()).toContain("Claude Code");
  expect(text()).not.toMatch(/agent/i);
  expect(text()).not.toMatch(/\$|cost/i);

  act(() => tabButton("Models").click());
  expect(text()).toContain("Default model");
  expect(text()).not.toMatch(/agent/i);
  expect(text()).not.toMatch(/\$|cost/i);

  // The switch reflects the editor's choice and remembers it.
  const toggle = view.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Show tokens in the chat"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  act(() => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(useUiStore.getState().showRunTokens).toBe(true);
  expect(localStorage.getItem("scarlet.runTokens")).toBeNull();
  act(() => toggle.click());
  expect(localStorage.getItem("scarlet.runTokens")).toBe("hidden");
  view.unmount();
});

/** Open the steps behind a question's line. */
const openDetails = (host: HTMLElement) => act(() => host.querySelector<HTMLElement>(".req-toggle")!.click());

it("keeps the ring of the work under way fading with motion reduced, the line under a header button while it works, a spinner and the reconnecting dot with it", async () => {
  // A test has no styles, so the rules are read from the stylesheets. One rule stills every animation for reduced
  // motion, with !important (studio.css): the fade of a mark that says work is going on has to carry it to get past.
  const { readFileSync } = await import("node:fs");
  const reduced = (sheet: string, mark: string) => [...readFileSync(`${import.meta.dirname}/../../${sheet}`, "utf8")
    .matchAll(/@media \(prefers-reduced-motion: reduce\) \{((?:[^{}]|\{[^{}]*\})*)\}/g)]
    .flatMap(block => [...block[1]!.matchAll(/([^{}]+)\{([^{}]*)\}/g)]).find(rule => rule[1]!.includes(mark))?.[2]?.trim();
  for (const [sheet, mark] of [["simple.css", '.req-mark[data-state="working"]'], ["simple.css", ".progress-line.is-unknown > span"], ["index.css", ".animate-spin"], ["index.css", ".pulse"]] as const)
    expect(reduced(sheet, mark), mark).toMatch(/(^|; )animation: .+ infinite !important;$/);
});

it("says what Scarlet is doing this moment on one line under its opening sentence, and nothing else while it works", () => {
  openProject();
  const running: Task = { ...task, state: "running", summary: null, finishedAt: undefined };
  const at = (seconds: number) => new Date(Date.parse(task.startedAt!) + seconds * 1000).toISOString();
  const said = (text: string, when: number) => ({ type: "log" as const, at: at(when), text });
  const tool = (name: string, when: number, input: object = {}) => ({ type: "tool" as const, at: at(when), text: name, data: { tool: `scarlet.${name}`, input } });
  const scanPage = (from: number, to: number) => ({ type: "log" as const, at: at(40), text: "Dialogue scan · a.mp4",
    data: { kind: "editor_progress", scanPage: { mediaId: "med_1", from, to, end: 2726 } } });
  const lead = (host: HTMLElement) => host.querySelector(".req-lead")?.textContent;
  const now = (host: HTMLElement) => host.querySelector(".req-now [role=status]")?.textContent;
  const AIM = "I’ll sync the recordings, tighten the takes, and flag cuts that need your ear.";
  const opened = [{ type: "log" as const, at: at(0), text: "Starting the editing agent." }, said(AIM, 2)];
  // Before its first call, the opening sentence is above and isn't said again on the line.
  const view = render(<RunBundle task={running} events={opened} changes={[]} banded />);
  expect([lead(view.host), now(view.host)]).toEqual([AIM, "Working on your edit"]);
  // The line is the latest call, in plain words, with a turning ring before it. Nothing else is under the sentence:
  // no stages, no plan, no percent, no list of what was done.
  const reading = [...opened, tool("project_get", 3), tool("audio_sync", 5), tool("dialogue_scan", 20, { mediaId: "med_1", from: 754 })];
  view.rerender(<RunBundle task={running} events={reading} changes={[]} banded />);
  const req = view.host.querySelector(".req")!;
  expect([...req.children].map(child => child.className)).toEqual(["req-said req-lead", "req-row req-now"]);
  expect(now(view.host)).toBe("Reading the dialogue at 12:34");
  expect(view.host.querySelector(".req-now .req-mark")!.getAttribute("data-state")).toBe("working");
  expect(view.host.querySelector(".req-now [role=status]")!.className).toContain("working-text");
  expect(view.host.querySelector(".req-stages, .req-steps, .req-toggle")).toBeNull();
  expect(view.host.textContent).not.toMatch(/%/);
  // Counts the engine keeps in the background are not what Scarlet is doing.
  const counting = [...reading, scanPage(754, 812), { type: "log" as const, at: at(41), text: "", data: { kind: "join_progress", mediaId: "med_1", through: 90 } }];
  view.rerender(<RunBundle task={running} events={counting} changes={[]} banded />);
  expect(now(view.host)).toBe("Reading the dialogue at 12:34");
  // Each call takes the line as it comes, and so does Scarlet's own sentence when it comes after.
  const joins = [...counting, tool("dialogue_check_join", 50, { cuts: [{}, {}, {}, {}] })];
  view.rerender(<RunBundle task={running} events={joins} changes={[]} banded />);
  expect(now(view.host)).toBe("Checking how 4 joins sound");
  const spoken = [...joins, said("The opening is saved, and I’ve found the retake of the letter.", 60)];
  view.rerender(<RunBundle task={running} events={spoken} changes={[]} banded />);
  expect(now(view.host)).toBe("The opening is saved, and I’ve found the retake of the letter.");
  // A cut Scarlet asked about is named by its time, never by a number. One it hasn't asked about is a flagged cut.
  const asked = [{ id: "chg", cutReasons: [{ start: 10, end: 11 }, { start: 167, end: 168 }, { start: 200, end: 201 }, { start: 300, end: 301 }],
    cutAssessments: [{ index: 1, verdict: "ask", askOrder: 1 }, { index: 7, verdict: "ask", askOrder: 0 }] }] as never;
  view.rerender(<RunBundle task={running} events={[...spoken, tool("dialogue_review_inspect", 70, { changeId: "chg", index: 1, count: 1 })]} changes={asked} banded />);
  expect(now(view.host)).toBe("Listening to the cut at 2:47");
  view.rerender(<RunBundle task={running} events={[...spoken, tool("dialogue_review_inspect", 70, { changeId: "chg", index: 3, count: 1 })]} changes={asked} banded />);
  expect(now(view.host)).toBe("Listening to a flagged cut");
  // Under a heading that carries Stop, the line has none. With no heading, Stop ends the line.
  expect(view.host.querySelector(".run-stop")).toBeNull();
  view.unmount();
  const bare = render(<RunBundle task={running} events={reading} changes={[]} onStop={() => {}} />);
  expect(bare.host.querySelector(".req-now .run-stop")?.textContent).toBe("Stop");
  // A run not yet started says so; done, the sentence and the line go.
  bare.rerender(<RunBundle task={{ ...running, state: "claimed" }} events={[]} changes={[]} onStop={() => {}} />);
  expect(now(bare.host)).toBe("Getting started");
  // A run that carries on after Scarlet closed or restarted says so until its first call, which then takes the line.
  const again: Task = { ...running, id: "tsk_again", resumeRootId: running.id };
  for (const state of ["claimed", "running"] as const) {
    bare.rerender(<RunBundle task={{ ...again, state }} events={[]} changes={[]} onStop={() => {}} />);
    expect(now(bare.host)).toBe("Picking up where it left off");
  }
  bare.rerender(<RunBundle task={again} events={[{ type: "log", at: at(1), text: "Claude Code session started", data: { kind: "init" } }]} changes={[]} onStop={() => {}} />);
  expect(now(bare.host)).toBe("Picking up where it left off");
  bare.rerender(<RunBundle task={again} events={reading} changes={[]} onStop={() => {}} />);
  expect(now(bare.host)).toBe("Reading the dialogue at 12:34");
  bare.rerender(<RunBundle task={{ ...task, summary: "Cut the dialogue." }} events={spoken} changes={[]} banded />);
  expect(bare.host.querySelector(".req-lead, .req-now")).toBeNull();
  bare.unmount();
});

it("keeps saying a request is picking up where it left off until its first call, on a model that thinks first", () => {
  openProject();
  const again: Task = { ...task, id: "tsk_again", state: "running", summary: null, finishedAt: undefined, resumeRootId: task.id };
  const started: TaskEvent[] = [{ type: "log", at: "2026-11-05T10:00:01.000Z", text: "Codex session started", data: { kind: "init" } },
    { type: "log", at: "2026-11-05T10:00:02.000Z", text: "(thinking) Where was I.", data: { kind: "reasoning" } }];
  const view = render(<RunBundle task={again} events={started} changes={[]} banded />);
  const now = () => view.host.querySelector(".req-now [role=status]")?.textContent;
  expect(now()).toBe("Picking up where it left off");
  // Its first call takes the line, and thinking after that reads as it does on any request.
  const called: TaskEvent[] = [...started, { type: "tool", at: "2026-11-05T10:00:05.000Z", text: "timeline_get", data: { tool: "scarlet.timeline_get", input: {} } }];
  view.rerender(<RunBundle task={again} events={called} changes={[]} banded />);
  expect(now()).toBe("Looking at the timeline");
  view.rerender(<RunBundle task={again} events={[...called, { ...started[1]!, at: "2026-11-05T10:00:09.000Z" }]} changes={[]} banded />);
  expect(now()).toBe("Thinking");
  view.unmount();
});

it("says how far the transcripts it waits on are, and keeps file progress in Media", () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-05T10:00:10.000Z"), toFake: ["Date", "setInterval", "clearInterval"] });
  const running: Task = { ...task, state: "running", summary: null, finishedAt: undefined };
  const asset = { id: "cam", name: "interview.mp4", duration: 3380, status: "ready" } as MediaAsset;
  const transcribing: Task = { ...running, id: "tsk_cam", kind: "transcribe", agent: "api", context: { mediaId: asset.id },
    progress: { stage: "transcribing", fraction: 0.1, remainingSeconds: 3858, words: { fraction: 0.30, remainingSeconds: 1000 } } };
  useProjectStore.setState({ current: { project: { id: "prj_1" }, tasks: [running, transcribing], media: [asset],
    taskEvents: {} } as ProjectData });
  const wait: TaskEvent = { type: "log", at: "2026-11-05T10:00:10.000Z", text: "Waiting for the transcript",
    data: { kind: "media_wait", wait: "transcript", mediaId: asset.id } };
  const answer: TaskEvent = { type: "answer", at: "2026-11-05T10:00:40.000Z", text: "Keep the intro" };
  const run = (events: TaskEvent[]) => <>
    <div data-media><TranscriptLine asset={asset} available /></div>
    <RunBundle task={running} events={events} changes={[]} />
  </>;
  const view = render(run([wait]));
  const activity = () => view.host.querySelector(".req-now [role=status]")?.textContent;
  // While the run waits on the transcript, the line says so with how far along it is: the words the run reads.
  expect(activity()).toBe("Transcribing the recordings · 30%");
  act(() => vi.advanceTimersByTime(30_000));
  view.rerender(run([wait, answer]));
  expect(view.host.querySelector("[data-media]")?.textContent).toBe("Transcribing10%");
  expect(activity()).toBe("Reading your answer");

  // A fresh transcript request can block the edit again.
  view.rerender(run([wait, answer, { ...wait, at: "2026-11-05T10:00:45.000Z" }]));
  expect(activity()).toBe("Transcribing the recordings · 30%");
  // Waiting its turn behind other audio work, there is no figure yet.
  act(() => useProjectStore.setState(s => ({ current: { ...s.current!, tasks: [running, { ...transcribing, progress: { stage: "queued", fraction: 0 } }] } })));
  expect(activity()).toBe("Waiting for the transcript");
  const ready: TaskEvent = { ...wait, at: "2026-11-05T10:00:50.000Z", text: "Ready: the transcript",
    data: { ...wait.data, done: true } };
  view.rerender(run([wait, answer, ready]));
  expect(activity()).toBe("Reading your answer");
  view.unmount();
});

it("says a run that ended without its transcripts needs them, not that it is paused, and offers to finish it once they're ready", () => {
  const paused: Task = { ...task, needsTranscripts: ["cam"], finishedAt: "2026-11-05T11:04:00.000Z" };
  const transcribing: Task = { ...task, id: "tsk_cam", kind: "transcribe", agent: "api", instruction: "Transcribe cam", context: { mediaId: "cam" },
    state: "running", summary: null, finishedAt: undefined, progress: { stage: "aligning", fraction: 0.18, remainingSeconds: 13_689 } };
  const media = (transcriptId?: string) => [{ id: "cam", duration: 3300, ...(transcriptId && { transcriptId }) }];
  const project = (tasks: Task[], transcriptId?: string) => act(() => useProjectStore.setState({
    current: { id: "prj_1", tasks, media: media(transcriptId), taskEvents: {} } as unknown as ProjectData }));
  const onWait = vi.fn(), onResume = vi.fn();
  project([paused, transcribing]);
  const view = render(<RunBundle task={paused} events={[]} changes={[]} onResume={onResume} onWaitForTranscripts={onWait} />);
  const line = () => [view.host.querySelector(".run-summary")?.textContent, view.host.querySelector(".run-wait")?.textContent];
  // How far along it is, as a percent: no guess at how long is left.
  expect(line()).toEqual(["Needs transcript", "Transcript 18%Finish when ready"]);
  act(() => view.host.querySelector<HTMLButtonElement>(".run-wait button")!.click());
  expect(onWait).toHaveBeenCalledWith(true);
  view.unmount();

  // Under a heading that says Paused, a run that saved nothing has that one row: none says "Nothing saved" under it.
  const banded = render(<RunBundle task={paused} events={[]} changes={[]} banded onResume={onResume} onWaitForTranscripts={onWait} />);
  expect([...banded.host.querySelectorAll(".req-row")].map(row => row.textContent)).toEqual(["Transcript 18%Finish when ready"]);
  banded.unmount();
  // The tokens the run used, when those show, are in the heading: they don't end its row or bring back one that says "Nothing saved".
  act(() => useUiStore.getState().setShowRunTokens(true));
  act(() => useProjectStore.setState(s => ({ current: { ...s.current!, taskUsage: { [paused.id]: totals() } } })));
  const counted = render(<RunBundle task={paused} events={[]} changes={[]} banded onResume={onResume} onWaitForTranscripts={onWait} />);
  expect([...counted.host.querySelectorAll(".req-row")].map(row => row.textContent)).toEqual(["Transcript 18%Finish when ready"]);
  counted.unmount();
  // With no heading, they end its one row.
  const unheaded = render(<RunBundle task={paused} events={[]} changes={[]} onResume={onResume} onWaitForTranscripts={onWait} />);
  expect(unheaded.host.querySelector(".run-wait .req-right .run-tokens")?.getAttribute("data-breakdown")).toBe(tokenBreakdown(totals()));
  unheaded.unmount();
  act(() => useUiStore.getState().setShowRunTokens(false));

  // The transcript stopped: nothing is being made to wait for, so the action is the one that starts it again, as on
  // its Media row. The engine starts it when the run is asked to finish once it's ready.
  project([paused, { ...transcribing, state: "failed", error: "Transcription failed.", progress: undefined }]);
  const stopped = render(<RunBundle task={paused} events={[]} changes={[]} banded onResume={onResume} onWaitForTranscripts={onWait} />);
  expect([...stopped.host.querySelectorAll(".req-row")].map(row => row.textContent)).toEqual(["Transcript stoppedRetry"]);
  onWait.mockClear();
  act(() => stopped.host.querySelector<HTMLButtonElement>(".run-wait button")!.click());
  expect(onWait).toHaveBeenCalledWith(true);
  stopped.unmount();
  // No transcript was ever started for it: the same action, named as Media names it.
  project([paused]);
  const none = render(<RunBundle task={paused} events={[]} changes={[]} banded onResume={onResume} onWaitForTranscripts={onWait} />);
  expect(none.host.querySelector(".run-wait")?.textContent).toBe("No transcriptTranscribe");
  none.unmount();

  // Asked to finish: it says so, and the editor can stop waiting.
  const armed = { ...paused, continueWhenReady: true };
  project([armed, transcribing]);
  const waiting = render(<RunBundle task={armed} events={[]} changes={[]} onResume={onResume} onWaitForTranscripts={onWait} />);
  expect(waiting.host.querySelector(".run-wait")?.textContent).toBe("Finishes when ready · 18%Don’t wait");
  act(() => waiting.host.querySelector<HTMLButtonElement>(".run-wait button")!.click());
  expect(onWait).toHaveBeenLastCalledWith(false);
  waiting.unmount();

  // Its transcript saved: finish now.
  project([paused, { ...transcribing, state: "done", progress: undefined }], "tr_cam");
  const ready = render(<RunBundle task={paused} events={[]} changes={[]} onResume={onResume} onWaitForTranscripts={onWait} />);
  expect(ready.host.querySelector(".run-wait")?.textContent).toBe("Transcript readyFinish edit");
  act(() => ready.host.querySelector<HTMLButtonElement>(".run-wait button")!.click());
  expect(onResume).toHaveBeenCalledOnce();
  ready.unmount();

  // A run that waited on two recordings names both, also once neither is still pending.
  const two: Task = { ...paused, needsTranscripts: ["cam", "mic"] };
  act(() => useProjectStore.setState({ current: { id: "prj_1", tasks: [two], taskEvents: {},
    media: [{ id: "cam", duration: 3300, transcriptId: "tr_cam" }, { id: "mic", duration: 3300, transcriptId: "tr_mic" }] } as unknown as ProjectData }));
  const both = render(<RunBundle task={two} events={[]} changes={[]} onResume={onResume} onWaitForTranscripts={onWait} />);
  expect(both.host.querySelector(".run-wait")?.textContent).toBe("Transcripts readyFinish edit");
  both.unmount();

  // Once resumed, the earlier run reads as an ordinary finished one.
  project([{ ...paused, retryTaskId: "tsk_2" }]);
  const resumed = render(<RunBundle task={{ ...paused, retryTaskId: "tsk_2" }} events={[]} changes={[]} />);
  expect(resumed.host.querySelector(".run-summary")?.textContent).toBe("Tightened the intro");
  expect(resumed.host.querySelector(".run-wait")).toBeNull();
  resumed.unmount();
});

it("keeps the figure of a paused run's transcripts going on when one of them is saved, rather than starting it again", () => {
  const paused: Task = { ...task, needsTranscripts: ["cam", "mic"], finishedAt: "2026-11-05T11:04:00.000Z" };
  const transcribe = (mediaId: string, over: Partial<Task>): Task => ({ ...task, id: `tsk_${mediaId}`, kind: "transcribe", agent: "api",
    instruction: `Transcribe ${mediaId}`, context: { mediaId }, startedAt: undefined, finishedAt: undefined, summary: null, ...over });
  // A transcription with this share of its words in. Whisper is a third of the whole job.
  const words = (fraction: number, remainingSeconds: number) => ({ state: "running" as const,
    progress: { stage: "transcribing" as const, fraction: fraction / 3, remainingSeconds: remainingSeconds * 3, words: { fraction, remainingSeconds } } });
  const project = (tasks: Task[], saved: string[] = []) => act(() => useProjectStore.setState({ current: { id: "prj_1", tasks: [paused, ...tasks], taskEvents: {},
    media: [{ id: "cam", duration: 3000 }, { id: "mic", duration: 1000 }].map(m => saved.includes(m.id) ? { ...m, transcriptId: `trs_${m.id}` } : m) } as unknown as ProjectData }));
  // The camera's transcript waits its turn behind the mic's, which has 90% of its words: 23% of the two.
  project([transcribe("cam", { state: "running", progress: { stage: "queued", fraction: 0 } }), transcribe("mic", words(0.9, 20))]);
  const view = render(<RunBundle task={paused} events={[]} changes={[]} onWaitForTranscripts={() => {}} />);
  // The row's figure alone. The test above checks its words.
  const percent = () => /(\d+)%/.exec(view.host.querySelector(".run-wait")!.textContent!)?.[1];
  expect(percent()).toBe("23");
  // The mic's transcript is saved while the camera's still waits its turn: the row has no figure that would sit still.
  project([transcribe("cam", { state: "running", progress: { stage: "queued", fraction: 0 } }), transcribe("mic", { state: "done" })], ["mic"]);
  expect(percent()).toBeUndefined();
  // The camera's begins, with 3% of its words in. The mic's share stays counted, so the figure goes on from 23%.
  // Counted over the camera alone, it started again at 3%.
  project([transcribe("cam", words(0.03, 480)), transcribe("mic", { state: "done" })], ["mic"]);
  expect(percent()).toBe("27");
  view.unmount();
});

it("keeps the figure of a working run's transcripts going on when one of them is saved, rather than starting it again", () => {
  const running: Task = { ...task, state: "running", summary: null, finishedAt: undefined };
  const transcribe = (mediaId: string, over: Partial<Task>): Task => ({ ...task, id: `tsk_${mediaId}`, kind: "transcribe", agent: "api",
    instruction: `Transcribe ${mediaId}`, context: { mediaId }, startedAt: undefined, finishedAt: undefined, summary: null, ...over });
  const words = (fraction: number, remainingSeconds: number) => ({ state: "running" as const,
    progress: { stage: "transcribing" as const, fraction: fraction / 3, remainingSeconds: remainingSeconds * 3, words: { fraction, remainingSeconds } } });
  const project = (tasks: Task[], saved: string[] = []) => act(() => useProjectStore.setState({ current: { id: "prj_1", tasks: [running, ...tasks], taskEvents: {},
    media: [{ id: "cam", duration: 3000 }, { id: "mic", duration: 1000 }].map(m => saved.includes(m.id) ? { ...m, transcriptId: `trs_${m.id}` } : m) } as unknown as ProjectData }));
  const wait = (mediaId: string, over: object = {}): TaskEvent => ({ type: "log", at: "2026-11-05T10:00:10.000Z", text: "Waiting for the transcript",
    data: { kind: "media_wait", wait: "transcript", mediaId, ...over } });
  // The run waits on both. The camera's transcript waits its turn behind the mic's, which has 90% of its words: 23% of the two.
  project([transcribe("cam", { state: "running", progress: { stage: "queued", fraction: 0 } }), transcribe("mic", words(0.9, 20))]);
  const view = render(<RunBundle task={running} events={[wait("cam"), wait("mic")]} changes={[]} banded />);
  const line = () => view.host.querySelector(".req-now [role=status]")?.textContent;
  expect(line()).toBe("Transcribing the recordings · 23%");
  // The mic's is saved and the camera's begins, with 3% of its words in. The mic's share stays counted, so the figure
  // goes on from 23%. Counted over the camera alone, it dropped back to 3%.
  project([transcribe("cam", words(0.03, 480)), transcribe("mic", { state: "done" })], ["mic"]);
  view.rerender(<RunBundle task={running} events={[wait("cam"), wait("mic"), wait("mic", { done: true })]} changes={[]} banded />);
  expect(line()).toBe("Transcribing the recordings · 27%");
  // A recording whose transcript couldn't be made is no longer waited for, and has no share in the figure.
  view.rerender(<RunBundle task={running} events={[wait("cam"), wait("mic"), wait("mic", { done: true, failed: true })]} changes={[]} banded />);
  project([transcribe("cam", words(0.03, 480)), transcribe("mic", { state: "failed" })]);
  expect(line()).toBe("Transcribing the recordings · 3%");
  view.unmount();
});

it("leaves a question under a heading to the heading, opens the steps before it from its line with none, and says what Scarlet does with the answer", () => {
  openProject();
  const running: Task = { ...task, state: "running", summary: null, finishedAt: undefined };
  const asking: Task = { ...running, state: "waiting_for_user" };
  const at = (seconds: number) => new Date(Date.parse(task.startedAt!) + seconds * 1000).toISOString();
  const began = { type: "tool" as const, at: at(5), text: "project_get", data: { tool: "project_get", input: {} } };
  const said = [began, ...["One.", "Two.", "Three."].map((text, i) => ({ type: "log" as const, at: at(10 + i * 10), text }))];
  const asked = [...said, { type: "question" as const, at: at(80), text: "Purple or white?" }];
  const question = <p className="req-say">Purple or white?</p>;
  const rows = (host: HTMLElement) => [...host.querySelectorAll(".req-step.is-note .simple-row-text")].map(row => row.textContent);
  // Under a heading the block is the question alone.
  const view = render(<RunBundle task={asking} events={asked} changes={[]} banded say={question} />);
  expect(view.host.querySelector(".req")!.textContent).toBe("Purple or white?");
  // Answered, the line says what Scarlet is doing with it.
  view.rerender(<RunBundle task={running} events={[...asked, { type: "answer" as const, at: at(90), text: "White" }]} changes={[]} banded />);
  expect(view.host.querySelector(".req-now [role=status]")?.textContent).toBe("Reading your answer");
  view.unmount();
  // With no heading the line says it needs an answer and opens the steps before the question.
  const bare = render(<RunBundle task={asking} events={asked} changes={[]} say={question} />);
  expect(bare.host.querySelector(".req-status [role=status]")?.textContent).toBe("Needs your answer");
  expect(rows(bare.host)).toEqual([]);
  openDetails(bare.host);
  expect(rows(bare.host)).toEqual(["One.", "Two.", "Three."]);
  bare.unmount();
});

it("says what a request in line again waits for when that is the editor, with the way to start it before their calls", () => {
  openProject();
  const queued: Task = { ...task, state: "queued", summary: null, finishedAt: undefined };
  // The row's words, whether they are amber as a question's are, and the tray's play mark at the row's right.
  const row = (host: HTMLElement) => {
    const status = host.querySelector<HTMLElement>(".req-status [role=status]");
    return [status?.textContent, status?.classList.contains("req-ask"), !!host.querySelector(".req-status .req-right > button.queue-start")];
  };
  const mark = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".req-status .req-right > button.queue-start")!;
  // Nothing of the editor's holds it: Queued, the word its cut's card and the tray use, and nothing to press.
  const view = render(<RunBundle task={queued} events={[]} changes={[]} banded />);
  expect(row(view.host)).toEqual(["Queued", false, false]);
  // The calls of a pass hold it: the tray's own words, in amber, and its play mark, which starts it without them.
  const startNow = vi.fn();
  const calls = { words: "Waits for your calls", startNow };
  view.rerender(<RunBundle task={queued} events={[]} changes={[]} banded held={calls} />);
  expect(row(view.host)).toEqual(["Waits for your calls", true, true]);
  expect([mark(view.host).title, mark(view.host).getAttribute("aria-label"), mark(view.host).textContent]).toEqual(["Start now, before your calls", "Start now", ""]);
  expect(startNow).not.toHaveBeenCalled();
  act(() => mark(view.host).click());
  expect(startNow).toHaveBeenCalledOnce();
  // Scarlet's question holds it: the words, and no mark, since an answer isn't theirs to waive.
  view.rerender(<RunBundle task={queued} events={[]} changes={[]} banded held={{ words: "Waits for your answer" }} />);
  expect(row(view.host)).toEqual(["Waits for your answer", true, false]);
  view.unmount();
  // With editing paused nothing starts until Resume, whatever else holds the request: it says Paused, and has no mark.
  const paused = render(<RunBundle task={queued} events={[]} changes={[]} paused held={calls} />);
  expect(row(paused.host)).toEqual(["Paused", false, false]);
  expect(paused.host.querySelector<HTMLElement>(".req-status [role=status]")?.title).toBe("Editing is paused. Resume picks this up where it left off.");
  // Under a heading, which says Paused itself, the row goes with its mark.
  paused.rerender(<RunBundle task={queued} events={[]} changes={[]} banded paused held={calls} />);
  expect(paused.host.querySelector(".req-status, .queue-start")).toBeNull();
  paused.unmount();
  // The words are a queued request's alone: a question Scarlet asks keeps its own row.
  const asking = render(<RunBundle task={{ ...queued, state: "waiting_for_user" }} events={[]} changes={[]} held={calls} />);
  expect(row(asking.host)).toEqual(["Needs your answer", true, false]);
  asking.unmount();
  expect(startNow).toHaveBeenCalledOnce();
});

it("leaves a question's tokens to its heading, and has a row for them with no heading", () => {
  useUiStore.getState().setShowRunTokens(true);
  openProject({ [task.id]: totals({ totalTokens: 900 }) });
  const asking = render(<RunBundle task={{ ...task, state: "waiting_for_user", finishedAt: undefined }} events={[]} changes={[]} banded />);
  expect(asking.host.querySelector(".run-tokens")).toBeNull();
  asking.unmount();
  const bare = render(<RunBundle task={{ ...task, state: "waiting_for_user", finishedAt: undefined }} events={[]} changes={[]} />);
  expect(bare.host.querySelector(".req-status .req-right > .run-tokens")?.textContent).toBe("900 tokens");
  bare.unmount();
});

it("leaves a finished request's tokens to its heading, and has them on its row with no heading", () => {
  useUiStore.getState().setShowRunTokens(true);
  openProject({ [task.id]: totals() });
  const banded = render(<RunBundle task={task} events={[]} changes={[]} banded />);
  expect(banded.host.querySelector(".run-tokens")).toBeNull();
  banded.unmount();
  const bare = render(<RunBundle task={task} events={[]} changes={[]} />);
  expect(bare.host.querySelector(".req-result .req-right > .run-tokens")?.textContent).toBe("48.2K tokens");
  bare.unmount();
  useUiStore.getState().setShowRunTokens(false);
});

it("ticks active time, updates reported tokens, and carries both metrics across claims and attempts", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startedAt = Date.parse(task.startedAt!);
  vi.setSystemTime(startedAt + 4000);
  const working = { ...task, effort: "high", state: "running" as const, finishedAt: undefined, workedMs: 0 };
  useUiStore.getState().setShowRunTokens(false);
  openProject();
  const view = render(<RequestMetrics attempts={[working]} events={{}} />);
  const time = () => view.host.querySelector(".run-work-time")?.textContent;
  const tokens = () => view.host.querySelector<HTMLButtonElement>("button.unit-tokens");
  expect(time()).toBe("4s");
  act(() => vi.advanceTimersByTime(2000));
  expect(time()).toBe("6s");
  expect(tokens()).toBeNull();
  act(() => useUiStore.getState().setShowRunTokens(true));
  expect(tokens()).toBeNull();
  const report = (taskId: string, usage: UsageTotals) => act(() => useProjectStore.getState().applyEvent({
    type: "task.usage", projectId: task.projectId, taskId, usage,
  }));
  report(task.id, totals());
  expect(tokens()?.textContent).toBe("6s · 48.2K tokens");
  expect(tokens()?.getAttribute("aria-label")).toContain("Model: opus, Thinking effort: High");
  expect(tokens()?.getAttribute("aria-label")).toContain("Estimated API cost: Unavailable");
  const more = totals({ totalTokens: 1_310_000, cacheReadTokens: 1_305_800, models: ["claude-opus-5-5"], estimatedApiCostUsd: 0.33 });
  report(task.id, more);
  expect([tokens()?.textContent, tokens()?.dataset.breakdown]).toEqual(["6s · 1.3M tokens", tokenBreakdown({ ...more, runs: undefined })]);
  act(() => tokens()!.click());
  expect([...document.querySelectorAll(".tokens-tip > span")].slice(0, 3).map(row => row.textContent))
    .toEqual(["Active time6s", "ModelClaude Opus 5.5", "Thinking effortHigh"]);
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector(".tokens-tip")).toBeNull();

  for (const state of ["waiting_for_user", "queued"] as const) {
    view.rerender(<RequestMetrics attempts={[{ ...working, state, workedMs: 6000 }]} events={{}} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(time()).toBe("6s");
  }
  const claimed = { ...working, startedAt: new Date().toISOString(), workedMs: 6000 };
  view.rerender(<RequestMetrics attempts={[claimed]} events={{}} />);
  act(() => vi.advanceTimersByTime(3000));
  expect(time()).toBe("9s");
  const previous = { ...claimed, state: "cancelled" as const, workedMs: 9000, finishedAt: new Date().toISOString() };
  const resumed = { ...working, id: "tsk_2", effort: undefined, startedAt: new Date().toISOString() };
  const resumedUsage = totals({ totalTokens: 112_000, cacheReadTokens: 107_800, models: ["claude-fable-5-2"], estimatedApiCostUsd: 0.15 });
  report(resumed.id, resumedUsage);
  view.rerender(<RequestMetrics attempts={[previous, resumed]} events={{}} />);
  act(() => vi.advanceTimersByTime(3000));
  expect(tokens()?.textContent).toBe("12s · 1.4M tokens");
  const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  expect(tokens()?.getAttribute("aria-label")).toContain(`Models: Claude Opus 5.5, Claude Fable 5.2, Thinking effort: High, Provider default, Estimated API cost: ${usd.format(0.48)}`);
  report(resumed.id, { ...resumedUsage, models: ["unpriced-model"], estimatedApiCostUsd: null });
  expect(tokens()?.getAttribute("aria-label")).toContain("Estimated API cost: Unavailable");
  expect(tokens()?.getAttribute("aria-description")).toBe("API pricing is unavailable for some or all of the reported usage.");
  report(resumed.id, { ...resumedUsage, models: ["gpt-9-sol"], estimatedApiCostUsd: null, unpricedModels: ["gpt-9-sol at Fast speed"] });
  expect(tokens()?.getAttribute("aria-description")).toBe("No price for gpt-9-sol at Fast speed yet.");
  view.rerender(<RequestMetrics attempts={[previous, { ...resumed, state: "done", workedMs: 3000, finishedAt: new Date().toISOString() }]} events={{}} />);
  act(() => vi.advanceTimersByTime(10_000));
  expect(tokens()?.textContent).toBe("12s · 1.4M tokens");
  act(() => useUiStore.getState().setShowRunTokens(false));
  expect(tokens()).toBeNull();
  expect(time()).toBe("12s");
  view.unmount();
});

it("leaves the word for how a run ended to its heading when the block has one, with the one action on the line that says what the run saved", () => {
  openProject();
  const resume = vi.fn();
  const stopped: Task = { ...task, state: "cancelled" };
  const view = render(<RunBundle task={stopped} events={[]} changes={[]} recovery={{ label: "Resume", run: resume }} banded />);
  expect(runEnded(stopped)).toBe("Stopped");
  expect(view.host.querySelector(".req-state, .req-status")).toBeNull();
  // What the run saved is one line, and its one action follows on that line.
  expect([...view.host.querySelector(".req")!.children].map(row => row.className)).toEqual(["req-row req-result"]);
  expect(view.host.querySelector(".req-result")!.textContent).toBe("Nothing savedResume");
  act(() => view.host.querySelector<HTMLButtonElement>(".req-result > .req-recover")!.click());
  expect(resume).toHaveBeenCalledTimes(1);
  // Under Scarlet's own words, which can run to several lines, the action has the line after them.
  view.rerender(<RunBundle task={stopped} events={[]} changes={[]} recovery={{ label: "Resume", run: resume }} banded told
    say={<p className="req-say">I stopped before placing the second clip.</p>} />);
  expect([...view.host.querySelector(".req")!.children].map(row => row.className)).toEqual(["req-say", "req-row req-act"]);
  act(() => view.host.querySelector<HTMLButtonElement>(".req-act button")!.click());
  expect(resume).toHaveBeenCalledTimes(2);
  // With no heading to say it, the row says it, with the action beside it.
  view.rerender(<RunBundle task={stopped} events={[]} changes={[]} recovery={{ label: "Resume", run: resume }} />);
  expect([view.host.querySelector(".req-status .req-state")?.textContent, view.host.querySelector(".req-status .req-right")?.textContent]).toEqual(["Stopped", "Resume"]);
  expect(view.host.querySelector(".req-act")).toBeNull();
  // A run that finished has no word, and one that failed says so.
  expect([runEnded(task), runEnded({ ...task, state: "failed" })]).toEqual([undefined, "Couldn’t finish"]);
  // One that waits on a transcript says so. "Paused" is for editing the editor paused, which Resume picks up.
  expect([runEnded({ ...task, needsTranscripts: ["cam"] }), runEnded({ ...task, needsTranscripts: ["cam", "mic"] })]).toEqual(["Needs transcript", "Needs transcripts"]);
  view.unmount();
});

it("says on a paused request's line that Resume picks it up, as its heading's hover does", () => {
  const view = render(<RunBundle task={{ ...task, state: "queued", summary: null, finishedAt: undefined }} events={[]} changes={[]} paused />);
  const line = view.host.querySelector("[role=status]");
  // There is no Continue above the message box: Resume, at the request's right, is what picks it up.
  expect([line?.textContent, line?.getAttribute("title")]).toEqual(["Paused", "Editing is paused. Resume picks this up where it left off."]);
});

it("says Nothing changed for a finished request whose closing words were commands or its own request said back, never their first words", () => {
  openProject();
  const row = (summary: string) => {
    const view = render(<RunBundle task={{ ...task, summary }} events={[]} changes={[]} banded />);
    const text = view.host.querySelector(".run-summary")?.textContent;
    view.unmount();
    return text;
  };
  // Nothing of such a reply is shown as Scarlet's words, so the request's one row doesn't start with them either.
  expect(row("Ran `pnpm test` && checked the JSON output.")).toBe("Nothing changed");
  expect(row("Tighten the intro.")).toBe("Nothing changed");
  // The words that are Scarlet's own still say what the request came to.
  expect(row("Ran `git status`. Both pauses are under a second, so I left them in.")).toBe("Both pauses are under a second…");
  expect(row("Tightened the intro.")).toBe("Tightened the intro");
});

it("says what a stopped run saved in words, and opens the timeline from them only when it saved something", () => {
  openProject();
  const stopped: Task = { ...task, state: "cancelled", summary: null };
  const resume = { label: "Resume", run: () => {} };
  // Nothing saved: one row of words with the action after them, though the request is about a cut that could be opened.
  const view = render(<RunBundle task={stopped} events={[]} changes={[]} banded recovery={resume} onOpen={() => {}} />);
  expect([...view.host.querySelectorAll(".req-row")].map(row => [row.className, row.textContent])).toEqual([["req-row req-result", "Nothing savedResume"]]);
  expect(view.host.querySelector("button.req-summary")).toBeNull();
  // With an edit saved before it stopped, the row is the way to that edit, and the action has the line after it.
  const made = { id: "chg_1", state: "approved", description: "Trimmed the pause before the answer.", cutReasons: [], ranges: [] } as unknown as Parameters<typeof RunBundle>[0]["finalChange"];
  view.rerender(<RunBundle task={stopped} events={[]} changes={[]} finalChange={made} banded recovery={resume} onOpen={() => {}} />);
  expect(view.host.querySelector("button.req-summary")?.textContent).toBe("Trimmed the pause before the answer");
  expect(view.host.querySelector(".req-act")?.textContent).toBe("Resume");
  view.unmount();
});

it("lets go of the focus when the line that opens what a run made is clicked, so Space plays instead of pressing it again", () => {
  openProject();
  const made = { id: "chg_1", state: "approved", description: "Trimmed the pause before the answer.", cutReasons: [], ranges: [] } as unknown as Parameters<typeof RunBundle>[0]["finalChange"];
  const onOpen = vi.fn();
  const view = render(<RunBundle task={task} events={[]} changes={[]} finalChange={made} banded onOpen={onOpen} />);
  const line = view.host.querySelector<HTMLButtonElement>("button.req-summary")!;
  // A press with the mouse carries a click count, and in WebView2 it leaves the button focused. The line stays on
  // screen, so Space would press it again.
  line.focus();
  act(() => { line.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
  expect(onOpen).toHaveBeenCalledOnce();
  expect(document.activeElement).not.toBe(line);
  // Pressed with the keyboard it keeps the focus, so Tab goes on from there.
  line.focus();
  act(() => { line.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); });
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(line);
  view.unmount();
});

it("names a pass's final check for what it is, and says what it is doing now, not what it did on its first run", () => {
  openProject();
  const at = (seconds: number) => new Date(Date.parse(task.startedAt!) + seconds * 1000).toISOString();
  const FIRST = "I’ll sync both recordings, tighten the takes, and check playback for repeats.";
  const AGAIN = "I’ll check playback, fix clipped words and keep deliberate repeats.";
  const events = [
    { type: "log" as const, at: at(0), text: "Starting the editing agent." }, { type: "log" as const, at: at(3), text: FIRST },
    { type: "tool" as const, at: at(5), text: "audio_sync", data: { tool: "scarlet.audio_sync", input: {} } },
    // Its calls went in an hour later, and the engine sent the pass back to check the finished cut (2026-11-14).
    { type: "log" as const, at: at(4000), text: "Starting the editing agent." }, { type: "log" as const, at: at(4003), text: AGAIN },
    { type: "tool" as const, at: at(4010), text: "dialogue_check_repeats", data: { tool: "scarlet.dialogue_check_repeats", input: {} } },
  ];
  const again: Task = { ...task, state: "running", summary: null, finishedAt: undefined, startedAt: at(4000), repeatAudit: { version: "v2", returns: 1 } };
  const view = render(<RunBundle task={again} events={events} changes={[]} banded />);
  expect(view.host.querySelector(".req-lead")?.textContent).toBe("Closing check for repeats");
  expect(view.host.textContent).not.toContain(FIRST);
  expect(view.host.querySelector(".req-now [role=status]")?.textContent).toBe("Checking the video for repeats");
});

it("keeps a finished request's time and tokens out of its heading, and shows them when the pointer rests on it", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const done = { ...task, state: "done" as const, workedMs: 12_000, finishedAt: new Date().toISOString() };
  useUiStore.getState().setShowRunTokens(true);
  openProject({ [task.id]: totals() });
  const view = render(<div className="unit-msg"><p>Trim the pause</p><RequestMetrics attempts={[done]} events={{}} quiet /></div>);
  const heading = view.host.querySelector<HTMLElement>(".unit-msg")!;
  const tokens = () => view.host.querySelector<HTMLButtonElement>("button.unit-tokens")!;
  // The figures stay in the page for the note to hang from and for a screen reader; they just aren't drawn.
  expect([tokens().classList.contains("is-quiet"), tokens().textContent]).toEqual([true, "12s · 48.2K tokens"]);
  expect(document.querySelector(".tokens-tip")).toBeNull();
  // The pointer has to rest: one that only crosses the heading opens nothing.
  act(() => { heading.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })); vi.advanceTimersByTime(100); });
  act(() => { heading.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" })); vi.advanceTimersByTime(1000); });
  expect(document.querySelector(".tokens-tip")).toBeNull();
  act(() => { heading.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })); vi.advanceTimersByTime(400); });
  expect([...document.querySelectorAll(".tokens-tip > span")][0]?.textContent).toBe("Active time12s");
  expect(document.querySelector(".tokens-tip .tokens-tip-total")?.textContent).toBe("Total48,200");
  act(() => { heading.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" })); });
  expect(document.querySelector(".tokens-tip")).toBeNull();
  // With tokens off, the hover still says how long it took.
  act(() => useUiStore.getState().setShowRunTokens(false));
  expect([tokens().classList.contains("is-quiet"), tokens().textContent]).toEqual([true, "12s"]);
  act(() => { heading.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })); vi.advanceTimersByTime(400); });
  expect([...document.querySelectorAll(".tokens-tip > span")].map(row => row.textContent)).toEqual(["Active time12s"]);
  // The request Scarlet is on keeps them in view.
  view.rerender(<div className="unit-msg"><RequestMetrics attempts={[{ ...task, state: "running" as const, finishedAt: undefined, workedMs: 0 }]} events={{}} /></div>);
  expect(view.host.querySelector(".is-quiet")).toBeNull();
  view.unmount();
  vi.useRealTimers();
});

it("leaves Scarlet's opening sentence out of a request under a row: the row says what it is", () => {
  const working: Task = { ...task, state: "running", summary: null, finishedAt: undefined };
  const at = (seconds: number) => new Date(Date.parse(task.startedAt!) + seconds * 1000).toISOString();
  const events = [{ type: "log" as const, at: at(0), text: "Starting the editing agent." }, { type: "log" as const, at: at(2), text: "I’ll trim the pause to a beat." }];
  openProject();
  const own = render(<RunBundle task={working} events={events} changes={[]} banded />);
  const under = render(<RunBundle task={working} events={events} changes={[]} banded under />);
  expect([!!own.host.querySelector(".req-lead"), !!own.host.querySelector(".req-now")]).toEqual([true, true]);
  expect([!!under.host.querySelector(".req-lead"), !!under.host.querySelector(".req-now")]).toEqual([false, true]);
  own.unmount(); under.unmount();
});
