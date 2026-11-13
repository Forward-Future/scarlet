// @vitest-environment happy-dom
import { Fragment, StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Task, UsageResponse, UsageTotals } from "@scarlet/shared";
import { api } from "../../lib/client";
import { tokenBreakdown, tokenLabel } from "../../lib/format";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { UsageSettings } from "../shell/UsageSettings";
import { RunBundle, runEnded, Said } from "./RunBundle";

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
  useProjectStore.setState({ current: null });
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

it("keeps tokens out of the chat until the editor turns them on", () => {
  expect(localStorage.getItem("scarlet.runTokens")).toBeNull();
  expect(useUiStore.getState().showRunTokens).toBe(false);
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

  act(() => useProjectStore.getState().applyEvent({ type: "task.usage", projectId: "prj_1", taskId: task.id, usage: totals() }));
  const tokens = view.host.querySelector(".run-tokens");
  expect(tokens?.textContent).toBe("48.2K tokens");
  expect(tokens?.getAttribute("title")).toContain("cache read");
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
  const text = view.host.textContent ?? "";
  expect(text).toContain("1.3M tokens");
  expect(text).toContain(". 3 runs since ");
  expect(text).toContain("Interview");
  expect(text).toContain("Deleted project");
  expect(text).toContain("Claude Code");
  expect(text).toContain("Default model");
  expect(text).not.toMatch(/agent/i);
  expect(text).not.toMatch(/\$|cost/i);

  // The switch is off by default and remembers the editor's choice.
  const toggle = view.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Show tokens in the chat"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  act(() => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(useUiStore.getState().showRunTokens).toBe(true);
  expect(localStorage.getItem("scarlet.runTokens")).toBe("shown");
  act(() => toggle.click());
  expect(localStorage.getItem("scarlet.runTokens")).toBeNull();
  view.unmount();
});

/** Open the steps behind a question's line. */
const openDetails = (host: HTMLElement) => act(() => host.querySelector<HTMLElement>(".req-toggle")!.click());

it("keeps the ring of the work under way fading with motion reduced, and the ring around the menu's button, a spinner and the reconnecting dot with it", async () => {
  // A test has no styles, so the rules are read from the stylesheets. One rule stills every animation for reduced
  // motion, with !important (studio.css): the fade of a mark that says work is going on has to carry it to get past.
  const { readFileSync } = await import("node:fs");
  const reduced = (sheet: string, mark: string) => [...readFileSync(`${import.meta.dirname}/../../${sheet}`, "utf8")
    .matchAll(/@media \(prefers-reduced-motion: reduce\) \{((?:[^{}]|\{[^{}]*\})*)\}/g)]
    .flatMap(block => [...block[1]!.matchAll(/([^{}]+)\{([^{}]*)\}/g)]).find(rule => rule[1]!.includes(mark))?.[2]?.trim();
  for (const [sheet, mark] of [["simple.css", '.req-mark[data-state="working"]'], ["simple.css", ".simple-more-ring.is-unknown"], ["index.css", ".animate-spin"], ["index.css", ".pulse"]] as const)
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
  const view = render(<RunBundle task={running} events={opened} changes={[]} stopAbove banded />);
  expect([lead(view.host), now(view.host)]).toEqual([AIM, "Working on your edit"]);
  // The line is the latest call, in plain words, with a turning ring before it. Nothing else is under the sentence:
  // no stages, no plan, no percent, no list of what was done.
  const reading = [...opened, tool("project_get", 3), tool("audio_sync", 5), tool("dialogue_scan", 20, { mediaId: "med_1", from: 754 })];
  view.rerender(<RunBundle task={running} events={reading} changes={[]} stopAbove banded />);
  const req = view.host.querySelector(".req")!;
  expect([...req.children].map(child => child.className)).toEqual(["req-said req-lead", "req-row req-now"]);
  expect(now(view.host)).toBe("Reading the dialogue at 12:34");
  expect(view.host.querySelector(".req-now .req-mark")!.getAttribute("data-state")).toBe("working");
  expect(view.host.querySelector(".req-now [role=status]")!.className).toContain("working-text");
  expect(view.host.querySelector(".req-stages, .req-steps, .req-toggle")).toBeNull();
  expect(view.host.textContent).not.toMatch(/%/);
  // Counts the engine keeps in the background are not what Scarlet is doing.
  const counting = [...reading, scanPage(754, 812), { type: "log" as const, at: at(41), text: "", data: { kind: "join_progress", mediaId: "med_1", through: 90 } }];
  view.rerender(<RunBundle task={running} events={counting} changes={[]} stopAbove banded />);
  expect(now(view.host)).toBe("Reading the dialogue at 12:34");
  // Each call takes the line as it comes, and so does Scarlet's own sentence when it comes after.
  const joins = [...counting, tool("dialogue_check_join", 50, { cuts: [{}, {}, {}, {}] })];
  view.rerender(<RunBundle task={running} events={joins} changes={[]} stopAbove banded />);
  expect(now(view.host)).toBe("Checking how 4 joins sound");
  const spoken = [...joins, said("The opening is saved, and I’ve found the retake of the letter.", 60)];
  view.rerender(<RunBundle task={running} events={spoken} changes={[]} stopAbove banded />);
  expect(now(view.host)).toBe("The opening is saved, and I’ve found the retake of the letter.");
  // A cut Scarlet asked about is named by its call's number, not by where it comes among the pass's cuts.
  const asked = [{ id: "chg", cutAssessments: [{ index: 1, verdict: "ask", askOrder: 1 }, { index: 7, verdict: "ask", askOrder: 0 }] }] as never;
  view.rerender(<RunBundle task={running} events={[...spoken, tool("dialogue_review_inspect", 70, { changeId: "chg", index: 1, count: 1 })]} changes={asked} stopAbove banded />);
  expect(now(view.host)).toBe("Listening to Cut 2");
  view.rerender(<RunBundle task={running} events={[...spoken, tool("dialogue_review_inspect", 70, { changeId: "chg", index: 3, count: 1 })]} changes={asked} stopAbove banded />);
  expect(now(view.host)).toBe("Listening to a flagged cut");
  // Under a heading that carries Stop, the line has none. With no heading, Stop ends the line.
  expect(view.host.querySelector(".run-stop")).toBeNull();
  view.unmount();
  const bare = render(<RunBundle task={running} events={reading} changes={[]} onStop={() => {}} />);
  expect(bare.host.querySelector(".req-now .run-stop")?.textContent).toBe("Stop");
  // A run not yet started says so; done, the sentence and the line go.
  bare.rerender(<RunBundle task={{ ...running, state: "claimed" }} events={[]} changes={[]} onStop={() => {}} />);
  expect(now(bare.host)).toBe("Getting started");
  bare.rerender(<RunBundle task={{ ...task, summary: "Cut the dialogue." }} events={spoken} changes={[]} banded />);
  expect(bare.host.querySelector(".req-lead, .req-now")).toBeNull();
  bare.unmount();
});

// Strict mode renders twice, as the app does in development, and the figure has to come out the same.
it.each([["once", Fragment], ["twice", StrictMode]] as const)("starts the transcripts' figure again when the run goes on to another recording, rendered %s", (_, Mode) => {
  vi.useFakeTimers({ now: Date.parse("2026-11-05T10:10:00.000Z"), toFake: ["Date", "setInterval", "clearInterval"] });
  const running: Task = { ...task, state: "running", summary: null, finishedAt: undefined };
  const transcribe = (mediaId: string, over: Partial<Task>): Task => ({ ...task, id: `tsk_${mediaId}`, kind: "transcribe", agent: "api",
    instruction: `Transcribe ${mediaId}`, context: { mediaId }, startedAt: undefined, finishedAt: undefined, summary: null, ...over });
  const at = (fraction: number, remainingSeconds: number) => ({ state: "running" as const, progress: { stage: "aligning" as const, fraction, remainingSeconds } });
  const done = { state: "done" as const, finishedAt: "2026-11-05T10:20:00.000Z" };
  const media = [{ id: "cam", duration: 3000 }, { id: "screen", duration: 3000 }];
  const project = (tasks: Task[]) => act(() => useProjectStore.setState({
    current: { id: "prj_1", tasks: [running, ...tasks], media, taskEvents: {} } as unknown as ProjectData }));
  const wait = (mediaId: string) => ({ type: "log" as const, at: "2026-11-05T10:00:10.000Z", text: "Waiting for the transcript",
    data: { kind: "media_wait", wait: "transcript", mediaId } });
  const run = (...recordings: string[]) => <Mode>
    <RunBundle task={running} events={recordings.map(wait)} changes={[]} />
  </Mode>;
  // How far the transcripts have got, as the line says it while the run waits on them.
  const figure = (view: { host: HTMLElement }) => /^Transcribing the recordings · (\d+%)$/.exec(view.host.querySelector(".req-now [role=status]")?.textContent ?? "")?.[1];
  /** The same, or nothing once the run no longer waits on a transcript. */
  const rows = (view: { host: HTMLElement }) => figure(view) ? [figure(view)] : [];
  // The run waits on the camera's transcript, half done with 10 minutes left.
  project([transcribe("cam", at(0.5, 600))]);
  const view = render(run("cam"));
  expect(figure(view)).toEqual("50%");
  // With its transcript in, the line goes back to what Scarlet is doing.
  project([transcribe("cam", done)]);
  expect(rows(view)).toEqual([]);

  // Then it asks for the screen recording, 10% in with 25 minutes left. The two make a longer job that is 55% done,
  // rather than a step back from the camera's 100%.
  project([transcribe("cam", done), transcribe("screen", at(0.1, 1500))]);
  view.rerender(run("cam", "screen"));
  expect(figure(view)).toEqual("55%");
  // The longer job keeps its own pace between reports.
  act(() => vi.advanceTimersByTime(120_000));
  expect(figure(view)).toEqual("58%");
  // A report a little behind what's shown holds the longer job's figure too.
  project([transcribe("cam", done), transcribe("screen", at(0.15, 1400))]);
  expect(figure(view)).toEqual("58%");
  // Both transcripts in: nothing is left to wait for.
  project([transcribe("cam", done), transcribe("screen", done)]);
  expect(rows(view)).toEqual([]);
  // A transcript made again during the run is a new task for the same recording: the same length of job, with most of it ahead again.
  project([transcribe("cam", done), transcribe("screen", done), transcribe("screen", { id: "tsk_screen_again", ...at(0.1, 1500) })]);
  expect(rows(view)).toEqual(["55%"]);
  view.unmount();

  // A recording that joins while the first is still being transcribed makes a longer job too. The camera's figure had
  // moved on to 95% since its last report; with the screen recording waiting its turn behind it, the two are 45% done.
  project([transcribe("cam", at(0.9, 120))]);
  const joined = render(run("cam"));
  act(() => vi.advanceTimersByTime(60_000));
  expect(rows(joined)).toEqual(["95%"]);
  project([transcribe("cam", at(0.9, 120)), transcribe("screen", { state: "running", progress: { stage: "queued", fraction: 0 } })]);
  joined.rerender(run("cam", "screen"));
  expect(rows(joined)).toEqual(["45%"]);
  joined.unmount();

  // A transcription that stops takes its figure with it, so a recording of the same length starts from its own.
  project([transcribe("cam", at(0.8, 240))]);
  const stopped = render(run("cam"));
  expect(rows(stopped)).toEqual(["80%"]);
  project([transcribe("cam", { state: "failed" })]);
  expect(rows(stopped)).toEqual([]);
  project([transcribe("cam", { state: "failed" }), transcribe("screen", at(0.1, 1500))]);
  stopped.rerender(run("cam", "screen"));
  expect(rows(stopped)).toEqual(["10%"]);
  stopped.unmount();

  // When the engine restarts, the transcription it interrupted and the task that starts it again arrive together.
  // The recording is the same length, but the new task has nearly all of it ahead, and shows its own figure.
  project([transcribe("cam", at(0.97, 60))]);
  const restarted = render(run("cam"));
  act(() => vi.advanceTimersByTime(60_000));
  expect(rows(restarted)).toEqual(["99%"]);
  project([transcribe("cam", { id: "tsk_cam_again", ...at(0.02, 1470) }), transcribe("cam", { state: "failed", interrupted: true })]);
  expect(rows(restarted)).toEqual(["2%"]);
  restarted.unmount();

  // A task that starts a transcription again can happen to report just what the interrupted one last did. Its pace starts from its own report.
  project([transcribe("cam", at(0.5, 600))]);
  const same = render(run("cam"));
  act(() => vi.advanceTimersByTime(120_000));
  expect(rows(same)).toEqual(["60%"]);
  project([transcribe("cam", { id: "tsk_cam_again", ...at(0.5, 600) }), transcribe("cam", { state: "failed", interrupted: true })]);
  expect(rows(same)).toEqual(["50%"]);
  same.unmount();
});

it("says a run that ended without its transcripts is paused, and offers to finish it once they're ready", () => {
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
  expect(line()).toEqual(["Paused · needs transcript", "Transcript 18%Finish when ready"]);
  act(() => view.host.querySelector<HTMLButtonElement>(".run-wait button")!.click());
  expect(onWait).toHaveBeenCalledWith(true);
  view.unmount();

  // Under a heading that says Paused, a run that saved nothing has that one row: none says "Nothing saved" under it.
  const banded = render(<RunBundle task={paused} events={[]} changes={[]} banded onResume={onResume} onWaitForTranscripts={onWait} />);
  expect([...banded.host.querySelectorAll(".req-row")].map(row => row.textContent)).toEqual(["Transcript 18%Finish when ready"]);
  banded.unmount();
  // The tokens the run used, when those show, end its one row. They don't bring back a second that says "Nothing saved".
  act(() => useUiStore.getState().setShowRunTokens(true));
  act(() => useProjectStore.setState(s => ({ current: { ...s.current!, taskUsage: { [paused.id]: totals() } } })));
  const counted = render(<RunBundle task={paused} events={[]} changes={[]} banded onResume={onResume} onWaitForTranscripts={onWait} />);
  expect([...counted.host.querySelectorAll(".req-row")].map(row => row.textContent)).toEqual([`Transcript 18%Finish when ready${tokenLabel(totals().totalTokens)}`]);
  expect(counted.host.querySelector(".run-wait .req-right .run-tokens")?.getAttribute("title")).toBe(tokenBreakdown(totals()));
  counted.unmount();
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
  const view = render(<RunBundle task={asking} events={asked} changes={[]} stopAbove banded say={question} />);
  expect(view.host.querySelector(".req")!.textContent).toBe("Purple or white?");
  // Answered, the line says what Scarlet is doing with it.
  view.rerender(<RunBundle task={running} events={[...asked, { type: "answer" as const, at: at(90), text: "White" }]} changes={[]} stopAbove banded />);
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

it("keeps the tokens a question has used when its heading leaves it no row of its own", () => {
  useUiStore.getState().setShowRunTokens(true);
  openProject({ [task.id]: totals({ totalTokens: 900 }) });
  const asking = render(<RunBundle task={{ ...task, state: "waiting_for_user", finishedAt: undefined }} events={[]} changes={[]} stopAbove banded />);
  expect(asking.host.querySelector(".req-status")).toBeNull();
  expect(asking.host.querySelector(".req-row > .req-right > .run-tokens")?.textContent).toBe("900 tokens");
  asking.unmount();
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
  view.unmount();
});

it("says Done for a finished request whose closing words were commands or its own request said back, never their first words", () => {
  openProject();
  const row = (summary: string) => {
    const view = render(<RunBundle task={{ ...task, summary }} events={[]} changes={[]} banded />);
    const text = view.host.querySelector(".run-summary")?.textContent;
    view.unmount();
    return text;
  };
  // Nothing of such a reply is shown as Scarlet's words, so the request's one row doesn't start with them either.
  expect(row("Ran `pnpm test` && checked the JSON output.")).toBe("Done");
  expect(row("Tighten the intro.")).toBe("Done");
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
