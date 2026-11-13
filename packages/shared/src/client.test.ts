import { afterEach, describe, expect, it, vi } from "vitest";
import { apiPathId, ScarletApiError, ScarletClient } from "./client.js";

interface Call { method: string; url: string; path: string; headers: Record<string, string>; body: unknown }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const engineError = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);

/** A client whose engine is `reply`. Every request it makes is kept in `calls`. */
function engine(reply: (call: Call) => Response = () => json({}), token: string | (() => string | undefined) | null = "secret") {
  const calls: Call[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const text = String(url);
    const call: Call = { method: init.method ?? "GET", url: text, path: text.replace("http://127.0.0.1:4000/api", ""),
      headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, client: new ScarletClient({ baseUrl: "http://127.0.0.1:4000//", token: token ?? undefined, fetch: fetchImpl }) };
}
const failure = async (request: Promise<unknown>) => request.then(() => { throw new Error("expected the request to fail"); }, (e: unknown) => e as ScarletApiError);

afterEach(() => vi.restoreAllMocks());

describe("a request", () => {
  it("refuses cleartext or ambiguous credential destinations before any network request", async () => {
    const fetch = vi.fn();
    for (const baseUrl of ["http://engine.example", "http://localhost.example", "http://127.0.0.1.example", "https://user@engine.example", "ftp://localhost"]) {
      expect(() => new ScarletClient({ baseUrl, token: () => "fixture", fetch })).toThrow(/HTTPS/);
    }
    for (const baseUrl of ["https://engine.example", "http://127.0.0.2:4000", "http://[::1]:4000", "http://localhost:4000"]) {
      expect(new ScarletClient({ baseUrl, token: "fixture", fetch }).fileUrl("/video")).toContain("token=fixture");
    }
    const open = new ScarletClient({ baseUrl: "http://engine.example", fetch });
    await expect(open.request("GET", "/settings", undefined, { headers: { authorization: "Bearer fixture" } })).rejects.toThrow(/HTTPS/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("carries the token and a JSON body, and reads the JSON reply", async () => {
    const { client, calls } = engine(() => json({ project: { id: "p1" } }));
    expect(await client.createProject({ name: "Interview" })).toEqual({ project: { id: "p1" } });
    expect(calls).toEqual([{ method: "POST", url: "http://127.0.0.1:4000/api/projects", path: "/projects",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, body: { name: "Interview" } }]);
  });

  it("sends no Authorization without a token, and asks a token function each time", async () => {
    const anonymous = engine(undefined, null);
    await anonymous.client.projects();
    expect(anonymous.calls[0]!.headers).toEqual({});
    let current: string | undefined;
    const rotating = engine(undefined, () => current);
    await rotating.client.projects();
    current = "later";
    await rotating.client.projects();
    expect(rotating.calls.map(c => c.headers.Authorization)).toEqual([undefined, "Bearer later"]);
  });

  it("leaves a form's content type to fetch, and names a recording by what was recorded", async () => {
    const { client, calls } = engine();
    const names = [];
    for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/mpeg", ""]) {
      await client.speechToText(new Blob(["x"], { type }));
      names.push(((calls.at(-1)!.body as FormData).get("audio") as File).name);
    }
    expect(names).toEqual(["speech.webm", "speech.m4a", "speech.m4a", "speech.ogg", "speech.wav", "speech.mp3", "speech.webm"]);
    expect(calls[0]!.headers).toEqual({ Authorization: "Bearer secret" });
    await client.createVoiceNote("p1", new Blob(["x"], { type: "audio/mp4" }), { time: 12.5, end: 14, clipIds: ["c1"], changeId: "chg_1" });
    const form = calls.at(-1)!.body as FormData;
    expect((form.get("audio") as File).name).toBe("note.m4a");
    const fields: Record<string, unknown> = {};
    form.forEach((value, key) => { if (key !== "audio") fields[key] = value; });
    expect(fields).toEqual({ time: "12.5", end: "14", clipIds: '["c1"]', changeId: "chg_1" });
  });

  it("returns nothing for a reply with no content", async () => {
    expect(await engine(() => new Response(null, { status: 204 })).client.releaseRender("r1", "window")).toBeUndefined();
    expect(await engine(() => new Response("", { status: 200 })).client.deleteProject("p1")).toBeUndefined();
  });

  it("warns once when a successful reply isn't JSON, naming the route without its query or the reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = engine(() => new Response("<html>Sign in to the network</html>", { status: 200 }));
    expect(await client.renders("p1", { kind: "full", version: "v_secret" })).toBeUndefined();
    expect(warn.mock.calls).toEqual([["[scarlet] [api] GET /projects/p1/renders: 200 reply was not JSON"]]);
    // Replies with no content, JSON replies and failures are not this.
    warn.mockClear();
    await engine(() => new Response("", { status: 200 })).client.projects();
    await engine(() => json({ projects: [] })).client.projects();
    await failure(engine(() => new Response("Bad Gateway", { status: 502 })).client.projects());
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails with the engine's code, reason and details", async () => {
    const { client } = engine(() => engineError(409, "stale_head", "The cut moved on.", { head: "v2" }));
    const err = await failure(client.checkout("p1", "v1"));
    expect(err).toBeInstanceOf(ScarletApiError);
    expect(err).toMatchObject({ name: "ScarletApiError", status: 409, code: "stale_head", message: "The cut moved on.", details: { head: "v2" } });
  });

  it("fails with the reply's own text when it isn't the engine's JSON, and the status text when it is empty", async () => {
    const proxy = await failure(engine(() => new Response("<html>Bad Gateway</html>", { status: 502 })).client.projects());
    expect(proxy).toMatchObject({ status: 502, code: "http_error", message: "<html>Bad Gateway</html>", details: undefined });
    const empty = await failure(engine(() => new Response("", { status: 503, statusText: "Service Unavailable" })).client.projects());
    expect(empty).toMatchObject({ status: 503, code: "http_error", message: "Service Unavailable" });
    // JSON that isn't the engine's error shape still fails, with the body as the reason.
    const other = await failure(engine(() => json({ detail: "nope" }, 400)).client.projects());
    expect(other).toMatchObject({ status: 400, code: "http_error", message: '{"detail":"nope"}' });
  });

  it("refuses a question the engine didn't acknowledge", async () => {
    const { client, calls } = engine(() => json({ waiting: true }));
    expect(await client.postTaskQuestion("t1", "2026-01-01T00:00:00Z", "Keep the intro?", undefined, { sessionId: null })).toEqual({ waiting: true });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/tasks/t1/question", body: { startedAt: "2026-01-01T00:00:00Z", text: "Keep the intro?", sessionId: null } });
    await expect(engine(() => json({})).client.postTaskQuestion("t1", undefined, "?")).rejects.toThrow("did not acknowledge");
    await expect(engine(() => json(null)).client.postTaskQuestion("t1", undefined, "?")).rejects.toThrow("did not acknowledge");
  });
});

describe("a resource ID in a path", () => {
  it("is one opaque segment: separators, dot segments, escapes and control characters are refused", () => {
    for (const id of ["", ".", "..", "a/b", "a\\b", "a?b", "a#b", "a%2Fb", "a\nb", "a\u0000b", "a\u007fb"]) {
      expect(() => apiPathId(id), JSON.stringify(id)).toThrow("Invalid resource ID");
    }
    expect(apiPathId("chg_0a1b-2.c")).toBe("chg_0a1b-2.c");
    expect(apiPathId("take 1 & 2")).toBe("take%201%20%26%202");
    expect(apiPathId("...")).toBe("...");
  });

  it("is refused before anything is sent", async () => {
    const { client, calls } = engine();
    await expect(client.change("../projects")).rejects.toThrow("Invalid resource ID");
    expect(() => client.forProject("a/b")).toThrow("Invalid resource ID");
    expect(() => client.projectUsage("p?x")).toThrow("Invalid resource ID");
    expect(() => client.diff("p1", "v1/checkout", "v2")).toThrow("Invalid resource ID");
    expect(() => client.diff("p1", "v1", "v2?x=1")).toThrow("Invalid resource ID");
    expect(calls).toEqual([]);
  });
});

describe("a project's own resources", () => {
  const missingRoute = (call: Call) => engineError(404, "not_found", `no route for ${call.method} /api${call.path}`);

  it("are asked for by ID alone without a project, and under the project with one", async () => {
    const plain = engine(() => json({ note: { id: "n1" } }));
    await plain.client.replyNote("n1", "Done.");
    expect(plain.calls.map(c => [c.method, c.path])).toEqual([["POST", "/notes/n1/reply"]]);
    const scoped = engine(() => json({ note: { id: "n1" } }));
    await scoped.client.forProject("p 1").replyNote("n1", "Done.", { type: "agent", name: "Scarlet" });
    expect(scoped.calls.map(c => [c.method, c.path, c.headers.Authorization])).toEqual([["POST", "/projects/p%201/notes/n1/reply", "Bearer secret"]]);
    expect(scoped.calls[0]!.body).toEqual({ text: "Done.", author: { type: "agent", name: "Scarlet" } });
  });

  it("fall back to an older engine's route only after the project lists the resource", async () => {
    const { client, calls } = engine(call => {
      if (call.path.startsWith("/projects/p1/changes/")) return missingRoute(call);
      if (call.path === "/projects/p1/changes") return json({ changes: [{ id: "chg_1" }] });
      return json({ change: { id: "chg_1" }, diff: {} });
    });
    expect(await client.forProject("p1").change("chg_1")).toEqual({ change: { id: "chg_1" }, diff: {} });
    expect(calls.map(c => c.path)).toEqual(["/projects/p1/changes/chg_1", "/projects/p1/changes", "/changes/chg_1"]);
  });

  it("refuse a resource the project doesn't list, without asking the older route for it", async () => {
    const { client, calls } = engine(call => call.path === "/projects/p1/changes" ? json({ changes: [{ id: "other" }] }) : missingRoute(call));
    const err = await failure(client.forProject("p1").change("chg_1"));
    expect(err).toMatchObject({ status: 404, code: "project_resource_missing" });
    expect(calls.map(c => c.path)).toEqual(["/projects/p1/changes/chg_1", "/projects/p1/changes"]);
  });

  it("report any other failure as it is: a missing resource, or a missing route for something else", async () => {
    for (const reply of [
      () => engineError(404, "not_found", "change chg_1 not found"),
      () => engineError(404, "not_found", "no route for DELETE /api/projects/p1/changes/chg_1"),
      () => engineError(404, "not_found", "no route for GET /api/projects/other/changes/chg_1"),
      () => engineError(500, "internal_error", "no route for GET /api/projects/p1/changes/chg_1"),
    ]) {
      const { client, calls } = engine(reply);
      const err = await failure(client.forProject("p1").change("chg_1"));
      expect(err.code).toBe(reply().status === 500 ? "internal_error" : "not_found");
      expect(calls).toHaveLength(1);
    }
  });
});

describe("a transcript search", () => {
  it("asks the engine for the phrase, and for the whole transcript when the phrase won't fit a URL", async () => {
    const { client, calls } = engine();
    await client.searchTranscript("m1", "so what I'm saying & more", 4);
    expect(calls[0]!.path).toBe("/media/m1/transcript?search=so+what+I%27m+saying+%26+more&contextWords=4");
    await client.searchTranscript("m1", "word ".repeat(1000), 4);
    expect(calls[1]!.path).toBe("/media/m1/transcript");
    // The limit is on the encoded query: 4,096 characters still go to the engine.
    const longest = "a".repeat(4096 - "search=&contextWords=4".length);
    await client.searchTranscript("m1", longest, 4);
    expect(calls[2]!.path).toBe(`/media/m1/transcript?search=${longest}&contextWords=4`);
    await client.searchTranscript("m1", longest + "a", 4);
    expect(calls[3]!.path).toBe("/media/m1/transcript");
  });
});

describe("a query", () => {
  const paths = async (run: (client: ScarletClient) => unknown) => {
    const { client, calls } = engine();
    await run(client);
    return calls.map(c => c.path);
  };

  it("leaves out what wasn't given", async () => {
    expect(await paths(c => c.transcript("m1"))).toEqual(["/media/m1/transcript"]);
    expect(await paths(c => c.transcript("m1", { from: 0, to: 12.5, granularity: "segment", audioSources: true })))
      .toEqual(["/media/m1/transcript?from=0&to=12.5&granularity=segment&audioSources=1"]);
    expect(await paths(c => c.renders("p1"))).toEqual(["/projects/p1/renders"]);
    expect(await paths(c => c.renders("p1", { kind: "full", version: undefined }))).toEqual(["/projects/p1/renders?kind=full"]);
    expect(await paths(c => c.renders("p1", { version: "v 2", currentDelivery: true }))).toEqual(["/projects/p1/renders?version=v+2&currentDelivery=true"]);
    expect(await paths(c => c.skills())).toEqual(["/skills"]);
    expect(await paths(c => c.skills({ projectId: "p1", view: "assistant", taskId: undefined }))).toEqual(["/skills?projectId=p1&view=assistant"]);
    expect(await paths(c => c.activity("p1", { before: undefined, limit: 0, type: "edit" }))).toEqual(["/projects/p1/activity?limit=0&type=edit"]);
    expect(await paths(c => c.serverActivity())).toEqual(["/activity"]);
    expect(await paths(c => c.taskPrompt("t1"))).toEqual(["/tasks/t1/prompt"]);
    expect(await paths(c => c.taskPrompt("t1", { workDir: "/tmp/run 1", fresh: true }))).toEqual(["/tasks/t1/prompt?workDir=%2Ftmp%2Frun+1&fresh=1"]);
    // A run with a time cap asks for a prompt that names it.
    expect(await paths(c => c.taskPrompt("t1", { workDir: "/w", fresh: true, timeLimitMinutes: 45 }))).toEqual(["/tasks/t1/prompt?workDir=%2Fw&fresh=1&timeLimit=45"]);
    expect(await paths(c => c.taskPrompt("t1", { timeLimitMinutes: 1440 }))).toEqual(["/tasks/t1/prompt?timeLimit=1440"]);
    expect(await paths(c => c.claimTask("h1"))).toEqual(["/hosts/h1/claim"]);
    expect(await paths(c => c.claimTask("h1", { wait: 25, agents: ["claude"] }))).toEqual(["/hosts/h1/claim?wait=25"]);
    expect(await paths(c => c.changes("p1"))).toEqual(["/projects/p1/changes"]);
    expect(await paths(c => c.changes("p1", "ready"))).toEqual(["/projects/p1/changes?state=ready"]);
    expect(await paths(c => c.task("t1", "conversation"))).toEqual(["/tasks/t1?events=conversation"]);
    expect(await paths(c => c.waveform("m1", 0, 10))).toEqual(["/media/m1/waveform?from=0&to=10&points=1000"]);
    expect(await paths(c => c.waveform("m1", 0, 10, 200, true, true))).toEqual(["/media/m1/waveform?from=0&to=10&points=200&cachedOnly=1&speechActivity=1"]);
  });

  it("encodes a version it puts in the path or the query", async () => {
    expect(await paths(c => c.timeline("p1"))).toEqual(["/projects/p1/timeline?version=head"]);
    expect(await paths(c => c.timeline("p1", "v&x=1"))).toEqual(["/projects/p1/timeline?version=v%26x%3D1"]);
    expect(await paths(c => c.diff("p1", "v1", "head"))).toEqual(["/projects/p1/versions/v1/diff/head"]);
    expect(await paths(c => c.diff("p1", "draft 1", "v2"))).toEqual(["/projects/p1/versions/draft%201/diff/v2"]);
  });

  it("opens the prepared review MP4 using the returned timeline boundaries", async () => {
    const { client, calls } = engine(() => json({ renderId: "r1", start: 4, end: 8 }));
    expect(await client.cutPlaybackFile("p1", "draft 1", { start: 4.01, end: 7.99 }, new AbortController().signal))
      .toEqual({ url: "http://127.0.0.1:4000/api/renders/r1/file?token=secret", start: 4, end: 8 });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/projects/p1/versions/draft%201/cut-playback-file", body: { start: 4.01, end: 7.99 } });
    const completed = engine(() => json({ renderId: "full", start: 0, end: 48, full: true }));
    expect(await completed.client.cutPlaybackFile("p1", "draft 1", { start: 4, end: 8 }, new AbortController().signal))
      .toEqual({ url: "http://127.0.0.1:4000/api/renders/full/file?token=secret", start: 0, end: 48, full: true });
  });

  it("puts the token on a file's address, after any query the address already has", () => {
    const { client } = engine();
    expect(client.fileUrl("/media/m1/file")).toBe("http://127.0.0.1:4000/api/media/m1/file?token=secret");
    expect(client.frameUrl("m1", 2.5)).toBe("http://127.0.0.1:4000/api/media/m1/frame?token=secret&t=2.5&w=640");
    expect(client.renderFileUrl("r1")).toBe("http://127.0.0.1:4000/api/renders/r1/file?token=secret");
    expect(client.renderFileUrl("r1", true)).toBe("http://127.0.0.1:4000/api/renders/r1/file?token=secret&wait=1");
    expect(client.sourceCacheUrl("m1", "k 1")).toBe("http://127.0.0.1:4000/api/media/m1/playback-cache/file?token=secret&fileKey=k+1");
    expect(client.wsUrl()).toBe("ws://127.0.0.1:4000/ws?token=secret");
    const open = engine(undefined, null).client;
    expect(open.fileUrl("/media/m1/file")).toBe("http://127.0.0.1:4000/api/media/m1/file");
    expect(open.frameUrl("m1", 2.5, 320)).toBe("http://127.0.0.1:4000/api/media/m1/frame?t=2.5&w=320");
    expect(open.wsUrl()).toBe("ws://127.0.0.1:4000/ws");
    const secure = new ScarletClient({ baseUrl: "https://scarlet.test/", token: "a b", previewFrames: true, fetch });
    expect(secure.wsUrl()).toBe("wss://scarlet.test/ws?token=a%20b");
    expect(secure.frameUrl("m1", 1)).toBe("https://scarlet.test/api/media/m1/frame?token=a%20b&t=1&w=640&preview=1");
    // A client bound to a project keeps the same engine, token and preview setting.
    expect(secure.forProject("p1").frameUrl("m1", 1)).toBe(secure.frameUrl("m1", 1));
  });
});
