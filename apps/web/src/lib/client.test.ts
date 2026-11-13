// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ScarletApiError } from "@scarlet/shared";
import { api, errorMessage } from "./client";

afterEach(() => { vi.restoreAllMocks(); });

/** What an action that failed shows the editor: the words of the error it threw, as the window shows any of them. */
const shown = (call: Promise<unknown>) => call.then(() => "no failure", (error: unknown) => [errorMessage(error), error instanceof Error ? error.message : String(error)]);
const ENGINE_AWAY = "Scarlet can’t reach its engine right now.";

it.each(["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."])(
  "says Scarlet can't reach its engine, not the webview's %j, when a request never gets an answer", async words => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(words));
    expect(await shown(api.projects())).toEqual([ENGINE_AWAY, ENGINE_AWAY]);
    // A failed fetch that didn't go through the engine's client reads the same.
    expect(errorMessage(new TypeError(words))).toBe(ENGINE_AWAY);
  });

it("says Scarlet can't reach its engine, not \"Service Unavailable\", when the engine turns a request away as it shuts down", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503, statusText: "Service Unavailable" }));
  expect((await shown(api.projects()))[0]).toBe(ENGINE_AWAY);
});

it("keeps the engine's own reasons, a request the editor called off and the window's own faults as they are", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: { code: "busy", message: "Scarlet is applying another edit." } }, { status: 503 }));
  expect(await shown(api.projects())).toEqual(["Scarlet is applying another edit.", "Scarlet is applying another edit."]);
  vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
  expect((await shown(api.projects()))[1]).toBe("Aborted");
  expect(errorMessage(new TypeError("project.media is undefined"))).toBe("project.media is undefined");
  expect(errorMessage(new ScarletApiError(409, "stale_head", "The cut moved on."))).toBe("The cut moved on.");
});
