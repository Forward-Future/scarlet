import { expect, it } from "vitest";
import type { LoadedCase } from "../src/case.ts";
import type { TaskRecord } from "../src/engine.ts";
import type { EventLike } from "../src/metrics.ts";
import { partsMarkdown, replayCase, replayParts } from "../src/replay.ts";
import { cut, media } from "./fixtures.ts";

const source = cut("source", "mic", [[0, 8]]);
const current = cut("current", "mic", [[2, 8]]);
for (const version of [source, current]) version.tracks = version.tracks.filter(track => track.id === "cam");

function stored(instruction: string, context: TaskRecord["context"], events: EventLike[]): LoadedCase {
  const task = { id: "task", projectId: source.projectId, kind: "edit", state: "done", changeIds: [], instruction, context: { version: "current", ...context } };
  return {
    file: { schema: 1, id: "scope", suite: "regression", createdAt: "", projectId: source.projectId, fps: 30, sourceVersion: "source",
      media: [media("mic", 8)], dialogueMedia: ["mic"], request: { instruction, skillIds: [], skillNames: [] } },
    dir: "", timeline: v => v === "current" ? current : v === "source" ? source : undefined, evidence: new Map(),
    origin: () => ({ task, events, changes: [] }),
    scans: () => ({ scans: [{ mediaId: "mic", fingerprint: "test", source: "engine", coverage: 1, audioStream: 0, pages: [] }], waveforms: {} }),
  };
}

function replay(instruction: string, context: TaskRecord["context"], answers: string[] = [], kind = "retake", start = 1) {
  return replayCase(stored(instruction, context, answers.map(text => ({ type: "answer", text }))), { plan: { version: "current", cuts: [{ kind, start, end: start + .25, decision: "keep", reason: "Keep the pause." }] } });
}

it("replays the recorded operation and uses the editor's last command in legacy cases", async () => {
  expect((await replay("A house skill /tighten-pauses-here", { dialogueOperation: "none" }, ["/tighten-pauses-here"])).outcome).toBe("preserved");
  expect((await replay("Please edit", { dialogueOperation: "local-pauses" })).error).toContain("only pauses");
  expect((await replay("/first-cut-dialogue", {}, ["Please /tighten-pauses-here instead"])).error).toContain("only pauses");
  expect((await replay("Please /tighten-pauses-here", {}, ["/first-cut-dialogue"])).outcome).toBe("preserved");
});

it("maps the recorded local passage onto the version the replay edits", async () => {
  const context = { dialogueOperation: "local-pauses" as const, dialogueRange: { version: "source", start: 4, end: 5 } };
  const inside = await replay("Tighten", context, [], "pause", 2.5);
  expect(inside.outcome, inside.error).toBe("preserved");
  expect((await replay("Tighten", context, [], "pause", 4.5)).error).toContain("outside the range 2–3");
});

it("replays the last plan on each version of a pass saved in parts, and names the parts it has no timeline for", async () => {
  const submit = (version: string, start: number): EventLike => ({ type: "tool", text: "", data: { tool: "scarlet.dialogue_apply_cuts",
    input: { version, cuts: [{ kind: "retake", start, end: start + .25, decision: "keep", reason: "Keep it." }] } } });
  const result = await replayParts(stored("/dialogue-pass", {}, [submit("source", 1), submit("source", 3), submit("current", 2.5), submit("gone", 1)]));
  expect(result.parts.map(p => [p.planVersion, p.outcome])).toEqual([["source", "preserved"], ["current", "preserved"]]);
  expect(result.skipped).toEqual([{ version: "gone", cuts: 1 }]);
  expect(partsMarkdown(result, result)).toContain("No submitted range changed.");
});
