// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { Task } from "@scarlet/shared";
import { workingModel } from "./workingModel";

const hosts = [{ online: true, agents: [
  { id: "gemini", modelLabels: { "gemini-3-pro": "Gemini 3 Pro" } },
  { id: "claude", modelLabels: { "claude-opus-4-5": "Claude Opus 4.5" } },
] }] as unknown as Parameters<typeof workingModel>[3];
const request = { id: "t1", agent: "claude", model: "claude-opus-4-5", state: "running" } as Task;
const handOff = (state: Task["state"]) => ({ agent: "gemini", model: "gemini-3-pro", state,
  context: { checksTaskId: "t1", handOff: { typeId: "b-roll", name: "B-roll", brief: "Find B-roll" } } }) as unknown as Task;

describe("workingModel", () => {
  it("names the Task models choice while a request has handed its work off", () => {
    expect(workingModel(request, [request], [handOff("running")], hosts)).toBe("B-roll · Gemini 3 Pro");
  });
  it("names the request's own model otherwise, and nothing while it isn't at work", () => {
    expect(workingModel(request, [request], [handOff("done")], hosts)).toBe("Claude Opus 4.5");
    expect(workingModel({ id: "t1", state: "queued" }, [request], [handOff("running")], hosts)).toBeUndefined();
  });
});
