import { expect, it } from "vitest";
import type { TaskEvent } from "@scarlet/shared";
import { runProgress } from "./runProgress";

const page = (from: number, to: number | undefined, end = 3467.6, mediaId = "med_1"): TaskEvent =>
  ({ type: "log", text: "Dialogue scan · a.mp4", data: { kind: "editor_progress", scanPage: { mediaId, from, end, ...(to !== undefined && { to }) } } });
const cuts = (changeId: string, checked: number, total: number): TaskEvent =>
  ({ type: "log", text: "", data: { kind: "cut_progress", changeId, checked, total } });

it("counts the dialogue read against what the scan covers, without double-counting re-reads", () => {
  expect(runProgress([])).toEqual({});
  // Opening the scan names its range before any page is read.
  expect(runProgress([page(0, undefined)]).read).toEqual({ seconds: 0, total: 3467.6 });
  const events = [page(0, undefined), page(0, 60), page(58, 118), page(58, 118), page(116, 176)];
  expect(runProgress(events).read).toEqual({ seconds: 176, total: 3467.6 });
  // The last page can stop a hair short of the end.
  expect(runProgress([page(0, undefined, 120), page(0, 60, 120), page(58, 119.7, 120)]).read).toEqual({ seconds: 119.7, total: 120 });
});

it("adds up separate recordings", () => {
  const read = runProgress([page(0, 60, 100, "med_1"), page(0, 30, 200, "med_2")]).read;
  expect(read).toEqual({ seconds: 90, total: 300 });
});

it("counts a recording once when part of it is read again over a shorter range", () => {
  // The whole recording, then two stretches of it again, each asked for with its own end.
  const read = runProgress([page(0, 60, 600), page(58, 118, 600), page(30, 90, 100), page(200, 232, 232)]).read;
  expect(read).toEqual({ seconds: 150, total: 600 });
});

it("names the recordings whose transcripts come before the read", () => {
  const wait: TaskEvent = { type: "log", text: "Waiting for the transcript", data: { kind: "media_wait", wait: "transcript", mediaId: "med_3" } };
  const sound: TaskEvent = { type: "log", text: "Waiting for the sound analysis", data: { kind: "media_wait", wait: "sound", mediaId: "med_4" } };
  expect(runProgress([page(0, undefined, 100, "med_1"), page(0, 60, 200, "med_2"), page(60, 120, 200, "med_2"), wait, sound]).recordings)
    .toEqual(["med_1", "med_2", "med_3"]);
});

it("follows the latest review of a pass saved in parts, and never takes back a recommendation", () => {
  expect(runProgress([cuts("chg_1", 0, 20)]).cuts).toMatchObject({ checked: 0, total: 20 });
  expect(runProgress([cuts("chg_1", 0, 20), cuts("chg_1", 8, 20)]).cuts).toMatchObject({ checked: 8, total: 20 });
  // A save that lands before the staging notice keeps its count.
  expect(runProgress([cuts("chg_1", 8, 20), cuts("chg_1", 0, 20)]).cuts).toMatchObject({ checked: 8, total: 20 });
  // The next part carries the 20 into a review of 35.
  expect(runProgress([cuts("chg_1", 20, 20), cuts("chg_2", 20, 35), cuts("chg_2", 24, 35)]).cuts).toMatchObject({ checked: 24, total: 35 });
  // A malformed or empty review shows nothing.
  expect(runProgress([cuts("chg_1", 0, 0)]).cuts).toBeUndefined();
  expect(runProgress([{ type: "log", text: "", data: { kind: "cut_progress", changeId: "chg_1", checked: -1, total: 4 } }]).cuts).toBeUndefined();
});

it("moves the cut on with the joins checked ahead of a save, and keeps the saved parts apart", () => {
  const read = [page(0, undefined, 600), page(0, 600, 600)];
  const saved = (through: number): TaskEvent => ({ type: "log", text: "", data: { kind: "pass_progress", mediaId: "med_1", through } });
  const checked = (through: number, at?: string): TaskEvent => ({ type: "log", at, text: "", data: { kind: "join_progress", mediaId: "med_1", through } });
  // The agent checks a part's joins minutes before it saves the part. The cut counts from the first of them, with no
  // part saved yet.
  expect(runProgress([...read, checked(90, "2026-11-05T10:05:00.000Z")])).toMatchObject({ cut: { seconds: 90, total: 600 }, at: { cut: Date.parse("2026-11-05T10:05:00.000Z") } });
  expect(runProgress([...read, checked(90)]).cut!.saved).toBeUndefined();
  // Ahead of the saved part the joins lead; behind it they change nothing, and neither ever moves the figure back.
  expect(runProgress([...read, saved(150), checked(240)]).cut).toEqual({ seconds: 240, total: 600, saved: 150 });
  expect(runProgress([...read, checked(240), saved(300), checked(200)]).cut).toEqual({ seconds: 300, total: 600, saved: 300 });
  // Only saved parts have staged their cuts, so the checking is scaled by them alone.
  expect(runProgress([...read, saved(300), checked(600), cuts("chg_1", 4, 4)]).cuts?.share).toBe(0.5);
  // A join in a recording that was never scanned, such as the screen under the camera, has nothing to be measured against.
  expect(runProgress([...read, { type: "log", text: "", data: { kind: "join_progress", mediaId: "med_screen", through: 90 } }]).cut).toBeUndefined();
});

it("measures the cut from how far the saved parts reach, and never moves it back", () => {
  const saved = (through: number, at?: string): TaskEvent => ({ type: "log", at, text: "", data: { kind: "pass_progress", mediaId: "med_1", through } });
  const read = [page(0, undefined, 600), page(0, 600, 600)];
  // Until a join is checked or a part is saved there's nothing to measure.
  expect(runProgress(read).cut).toBeUndefined();
  expect(runProgress([...read, saved(150)]).cut).toEqual({ seconds: 150, total: 600, saved: 150 });
  expect(runProgress([...read, saved(300), saved(150)]).cut).toEqual({ seconds: 300, total: 600, saved: 300 });
  // Two recordings add up, each against its own scan.
  const both = runProgress([page(0, 100, 100, "med_1"), page(0, 200, 200, "med_2"), saved(50),
    { type: "log", text: "", data: { kind: "pass_progress", mediaId: "med_2", through: 200 } }]);
  expect(both.cut).toEqual({ seconds: 250, total: 300, saved: 250 });
  // A recording that was scanned but that no saved part reaches, such as a second angle of the same take, isn't being
  // cut. Counted, the cut could never finish.
  const angle = [page(0, 600, 600, "med_1"), page(0, 600, 600, "med_2")];
  expect(runProgress(angle).read).toEqual({ seconds: 1200, total: 1200 });
  expect(runProgress([...angle, saved(300)]).cut).toEqual({ seconds: 300, total: 600, saved: 300 });
  expect(runProgress([...angle, saved(600)]).cut).toEqual({ seconds: 600, total: 600, saved: 600 });
  // Its flagged cuts are all checked once the cut reaches the end, not at half.
  expect(runProgress([...angle, saved(600), cuts("chg_1", 4, 4)]).cuts?.share).toBe(1);
  // The times of the first and latest part say how long a part takes.
  const timed = runProgress([...read, saved(150, "2026-11-05T10:00:00.000Z"), saved(300, "2026-11-05T10:04:00.000Z")]);
  expect([timed.since?.cut, timed.at?.cut]).toEqual([Date.parse("2026-11-05T10:00:00.000Z"), Date.parse("2026-11-05T10:04:00.000Z")]);
});

it("counts a flagged cut from the moment the agent looks at it, since recommendations are often saved in one batch", () => {
  const looked = (checked: number, n: number): TaskEvent => ({ type: "log", text: "", data: { kind: "cut_progress", changeId: "chg_1", checked, total: 12, looked: n } });
  expect(runProgress([cuts("chg_1", 0, 12), looked(0, 4), looked(0, 8)]).cuts).toMatchObject({ checked: 8, total: 12 });
  // The batch save that follows never takes the count back.
  expect(runProgress([looked(0, 8), cuts("chg_1", 3, 12)]).cuts).toMatchObject({ checked: 8, total: 12 });
  expect(runProgress([looked(0, 8), cuts("chg_1", 12, 12)]).cuts).toMatchObject({ checked: 12, total: 12 });
});

it("counts a saved part's flagged cuts when its own review reports, and holds what was checked until that count passes it", () => {
  const read = [page(0, undefined, 600), page(0, 600, 600)];
  const saved = (through: number): TaskEvent => ({ type: "log", text: "", data: { kind: "pass_progress", mediaId: "med_1", through } });
  // The first half is saved and its four flagged cuts are checked: half the checking.
  const half = [...read, saved(300), cuts("chg_1", 0, 4), cuts("chg_1", 4, 4)];
  expect(runProgress(half).cuts?.share).toBe(0.5);
  // The second half is saved. The review on hand is still the first half's and says nothing of the cuts this part
  // flagged: counted against the whole recording, its four of four read as all the checking done, and the figure went.
  expect(runProgress([...half, saved(600)]).cuts).toEqual({ checked: 4, total: 4, share: 0.5 });
  // The part's own review carries the four into twelve. A third of them is less than the half already shown, so the
  // figure holds there, moves on once the count passes it, and is complete only with the last cut.
  const whole = (checked: number) => runProgress([...half, saved(600), cuts("chg_2", 4, 12), cuts("chg_2", checked, 12)]).cuts!;
  expect(whole(4)).toEqual({ checked: 4, total: 12, share: 0.5 });
  expect(Math.floor(whole(8).share * 100)).toBe(66);
  expect(whole(11).share).toBeLessThan(1);
  expect(whole(12).share).toBe(1);
  // What is held is the count itself, to the last digit: 17 of 20 is 85% whatever the recording's length, never 84%.
  expect(Math.floor(runProgress([page(0, 305.2, 305.2), saved(305.2), cuts("chg_1", 17, 20)]).cuts!.share * 100)).toBe(85);
});

it("makes what was checked a share of the longer job when another recording joins the cut", () => {
  const log = (kind: string, mediaId: string, through: number): TaskEvent => ({ type: "log", text: "", data: { kind, mediaId, through } });
  // The first recording is cut to its end and all four of its flagged cuts are checked.
  const first = [page(0, 600, 600, "med_1"), log("pass_progress", "med_1", 600), cuts("chg_1", 4, 4)];
  expect(runProgress(first).cuts?.share).toBe(1);
  // The second is read and nothing of it is cut yet: it is no part of the cut, and nothing changes.
  const second = [...first, page(0, 600, 600, "med_2")];
  expect(runProgress(second).cuts?.share).toBe(1);
  // Its first checked join makes the cut twice as long. The four checked cuts are half the checking now: held as all of
  // it, they left the stage with no figure while the second recording's cuts were checked.
  const joined = [...second, log("join_progress", "med_2", 60)];
  expect(runProgress(joined)).toMatchObject({ cut: { seconds: 660, total: 1200, saved: 600 }, cuts: { checked: 4, total: 4, share: 0.5 } });
  // Its saved part carries the four into a review of twelve.
  const part = [...joined, log("pass_progress", "med_2", 600), cuts("chg_2", 4, 12)];
  expect(runProgress(part).cuts?.share).toBe(0.5);
  expect(runProgress([...part, cuts("chg_2", 6, 12)]).cuts?.share).toBe(0.5);
  expect(runProgress([...part, cuts("chg_2", 10, 12)]).cuts?.share).toBe(10 / 12);
  expect(runProgress([...part, cuts("chg_2", 12, 12)]).cuts?.share).toBe(1);
  // A recording that was under the cuts all along, such as the screen under the camera, is saved as far as the camera
  // is. Scanned only later, it makes the cut twice as long and what is saved of it too, and takes nothing back.
  const under = [page(0, 600, 600, "med_1"), log("pass_progress", "med_1", 300), log("pass_progress", "med_screen", 300), cuts("chg_1", 4, 4)];
  expect(runProgress(under).cuts?.share).toBe(0.5);
  expect(runProgress([...under, page(0, undefined, 600, "med_screen")])).toMatchObject({ cut: { seconds: 600, total: 1200, saved: 600 }, cuts: { share: 0.5 } });
});
