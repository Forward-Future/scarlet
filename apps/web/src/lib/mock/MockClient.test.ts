import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WsEvent } from "@scarlet/shared";
import { MockClient } from "./MockClient";
import { PRJ } from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("asks for a token before a call reaches the demo's state", async () => {
  const api = new MockClient(() => undefined);
  await expect(api.createNote(PRJ, { time: 1, text: "Tighten this up." })).rejects.toMatchObject({ status: 401 });
  await expect(api.cutReview("chg_missing")).rejects.toMatchObject({ status: 401 });
  await expect(api.releaseRender("rnd_missing", "owner")).rejects.toMatchObject({ status: 401 });
});

it("answers a note after the demo's pretend latency, and sends its events through the client's emitter", async () => {
  const api = new MockClient(() => "mock");
  const events: WsEvent[] = [];
  api.events.on(e => events.push(e));
  let settled = false;
  const call = api.createNote(PRJ, { time: 1, text: "Tighten this up." }).then(r => (settled = true, r));
  await vi.advanceTimersByTimeAsync(199);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await call).note).toMatchObject({ projectId: PRJ, text: "Tighten this up.", state: "open" });

  const { project } = await Promise.all([api.updateProject(PRJ, { name: "Renamed" }), vi.advanceTimersByTimeAsync(120)]).then(([r]) => r);
  expect(project.name).toBe("Renamed");
  expect(events.some(e => e.type === "project.updated" && e.project.name === "Renamed")).toBe(true);
});

it("hands back the media an import already made rather than importing it twice", async () => {
  const api = new MockClient(() => "mock");
  const first = api.importMedia(PRJ, { url: "https://example.com/take.mp4", importId: "imp_1" });
  await vi.advanceTimersByTimeAsync(400);
  const { media } = await first;
  expect(media).toMatchObject({ importId: "imp_1", name: "take.mp4", status: "ingesting" });
  const again = await api.importMedia(PRJ, { url: "https://example.com/take.mp4", importId: "imp_1" });
  expect(again.media.id).toBe(media.id);
  expect((await Promise.all([api.media(PRJ), vi.advanceTimersByTimeAsync(120)]))[0].media.filter(m => m.importId === "imp_1")).toHaveLength(1);
});
