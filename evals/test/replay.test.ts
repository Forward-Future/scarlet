import { expect, it } from "vitest";
import type { LoadedCase } from "../src/case.ts";
import type { TaskRecord } from "../src/engine.ts";
import { replayCase } from "../src/replay.ts";
import { cut, media } from "./fixtures.ts";

const source = cut("source", "mic", [[0, 8]]);
const current = cut("current", "mic", [[2, 8]]);
for (const version of [source, current]) version.tracks = version.tracks.filter(track => track.id === "cam");

function replay(instruction: string, context: TaskRecord["context"], answers: string[] = [], kind = "retake", start = 1) {
  const task = { id: "task", projectId: source.projectId, kind: "edit", state: "done", changeIds: [], instruction, context: { version: "current", ...context } };
  const loaded: LoadedCase = {
    file: { schema: 1, id: "scope", suite: "regression", createdAt: "", projectId: source.projectId, fps: 30, sourceVersion: "source",
      media: [media("mic", 8)], dialogueMedia: ["mic"], request: { instruction, skillIds: [], skillNames: [] } },
    dir: "", timeline: v => v === "current" ? current : v === "source" ? source : undefined, evidence: new Map(),
    origin: () => ({ task, events: answers.map(text => ({ type: "answer", text })), changes: [] }),
    scans: () => ({ scans: [{ mediaId: "mic", fingerprint: "test", source: "engine", coverage: 1, audioStream: 0, pages: [] }], waveforms: {} }),
  };
  return replayCase(loaded, { plan: { version: "current", cuts: [{ kind, start, end: start + .25, decision: "keep", reason: "Keep the pause." }] } });
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
