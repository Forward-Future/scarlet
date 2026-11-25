// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "zustand";
import { startAppLog, stopAppLog } from "./appLog";
import { aimKind, failure, ownerFields, requestLog, startRequestLog, stopRequestLog } from "./requestLog";

interface Box { agentDraft: string; draftOwner: string | null; savedDrafts: Record<string, { agentDraft: string }> }
const box = create<Box>(() => ({ agentDraft: "", draftOwner: JSON.stringify(["prj_1", null]), savedDrafts: {} }));

let lines: string[], levels: string[];
const written = () => { vi.advanceTimersByTime(300); return lines; };
beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  levels = [];
  box.setState({ agentDraft: "", draftOwner: JSON.stringify(["prj_1", null]), savedDrafts: {} });
  startAppLog((batch, level) => { lines.push(...batch); levels.push(level); });
  startRequestLog(box);
});
afterEach(() => {
  stopRequestLog();
  stopAppLog();
  vi.useRealTimers();
});

it("logs a draft starting and emptying by its length, never its words", () => {
  box.setState({ agentDraft: "C" });
  box.setState({ agentDraft: "Cut the long pause" });
  box.setState({ agentDraft: "" });
  expect(written()).toEqual([
    expect.stringMatching(/^\[request\] .* draft-started chars=1 project=prj_1$/),
    expect.stringMatching(/^\[request\] .* draft-emptied chars=18 project=prj_1$/),
  ]);
  expect(lines.join("\n")).not.toContain("pause");
});

it("logs a draft put aside for another request's box, and the one that comes back", () => {
  box.setState({ agentDraft: "Tighten it" });
  box.setState({ agentDraft: "Answer", draftOwner: JSON.stringify(["prj_1", "tsk_2"]) });
  expect(written().slice(1)).toEqual([
    expect.stringMatching(/ draft-put-aside chars=10 project=prj_1$/),
    expect.stringMatching(/ draft-restored chars=6 project=prj_1 thread=tsk_2$/),
  ]);
});

it("says a draft was still unsent when the window closed", () => {
  box.setState({ agentDraft: "Make it shorter", savedDrafts: { other: { agentDraft: "x" } } });
  window.dispatchEvent(new Event("pagehide"));
  expect(written().at(-1)).toMatch(/ draft-unsent-at-close chars=15 project=prj_1 otherDrafts=1$/);
});

it("writes failures at once as warnings, without addresses", () => {
  requestLog("send-failed", { how: "typed", ...failure(new TypeError("Couldn't reach http://127.0.0.1:4000/api?token=abc")) }, "warn");
  expect(lines).toEqual([expect.stringMatching(/^\[request\] .* send-failed how=typed name=TypeError error="Couldn't reach …"$/)]);
  expect(levels).toEqual(["warn"]);
});

it("names what a message was aimed at by kind", () => {
  expect(aimKind(null)).toBe("whole");
  expect(aimKind({ changeId: "chg" })).toBe("edit");
  expect(aimKind({ end: 3 })).toBe("range");
  expect(aimKind({ mediaId: "med" })).toBe("source");
  expect(aimKind({ fromMessage: true })).toBe("typed-time");
  expect(aimKind({})).toBe("point");
  expect(ownerFields("not json")).toEqual({});
});
