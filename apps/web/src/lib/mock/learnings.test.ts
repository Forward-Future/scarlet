import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WsEvent } from "@scarlet/shared";
import { MockClient } from "./MockClient";
import { PRJ } from "./fixtures";

let api: MockClient;
beforeEach(() => {
  vi.useFakeTimers();
  api = new MockClient(() => "mock");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
/** A call's answer, past the demo's pretend latency. */
async function answer<T>(call: Promise<T>, ms = 300): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return call;
}

it("keeps the sample's rules until the editor approves or declines them, and saves an approved one into its skill", async () => {
  const { learnings } = await answer(api.learnings(PRJ));
  expect(learnings.map(l => l.state)).toEqual(["suggested", "suggested"]);
  const [first, second] = learnings;
  // The demo hands out its own skill objects, so the version is read now.
  const before = (await answer(api.skills())).skills.find(s => s.id === first!.skillId)!.version;
  const events: WsEvent[] = [];
  api.events.on(e => events.push(e));

  // Approving says Saving at once. The skill gets the rule as a new version a moment later, in place of what the
  // sample's rule replaces.
  expect(first!.replaces).toHaveLength(1);
  expect((await answer(api.skills())).skills.find(s => s.id === first!.skillId)!.content).toContain(first!.replaces![0]);
  expect((await answer(api.approveLearning(PRJ, first!.id))).learning.state).toBe("saving");
  await expect(api.approveLearning(PRJ, first!.id)).rejects.toMatchObject({ status: 409 });
  await vi.advanceTimersByTimeAsync(2000);
  const saved = (await answer(api.skills())).skills.find(s => s.id === first!.skillId)!;
  expect(saved.version).toBe(before + 1);
  expect(saved.content).toContain(first!.rule);
  expect(saved.content).not.toContain(first!.replaces![0]);
  expect(events.flatMap(e => e.type === "learning.updated" ? [e.learning.state] : [])).toEqual(["saving", "saved"]);

  // The editor can reword one that waits; the skill gets it as they wrote it.
  const reworded = (await answer(api.reviseLearning(PRJ, second!.id, { rule: "Keep a laugh in." }))).learning;
  expect(reworded).toMatchObject({ rule: "Keep a laugh in.", said: second!.said, state: "suggested" });
  await expect(api.reviseLearning(PRJ, second!.id, { rule: "Two\nlines" })).rejects.toMatchObject({ status: 400 });
  await expect(api.reviseLearning(PRJ, first!.id, { rule: "Too late." })).rejects.toMatchObject({ status: 409 });

  // A declined one changes no skill. Neither is listed any more.
  expect((await answer(api.declineLearning(PRJ, second!.id))).learning.state).toBe("declined");
  expect((await answer(api.learnings(PRJ))).learnings).toEqual([]);
  expect((await answer(api.skills())).skills.find(s => s.id === first!.skillId)!.version).toBe(before + 1);
});
