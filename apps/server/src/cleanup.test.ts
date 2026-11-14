import { afterEach, expect, it, vi } from "vitest";
import type { Ctx } from "./context.js";
import { cleanupNote } from "./cleanup.js";

afterEach(() => vi.restoreAllMocks());

type Cleanup = { enabled: boolean; provider: "none" | "anthropic" | "openai"; model?: string };
function engine(noteCleanup: Cleanup, keys: Ctx["env"] = {}, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const ctx = { settings: () => ({ noteCleanup }), env: keys, options: { env }, log: (line: string) => lines.push(line) } as unknown as Ctx;
  return { ctx, lines };
}
/** What the provider would answer, and what Scarlet sent it. */
function provider(answer: unknown, status = 200) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
    return typeof answer === "string" ? new Response(answer, { status }) : Response.json(answer, { status });
  });
  return sent;
}
const spoken = "um so like at the start, cut the, uh, the bit where I cough";

it("leaves the note as spoken when cleanup is off, or when there is no key for a provider", async () => {
  const sent = provider({});
  expect(await cleanupNote(engine({ enabled: false, provider: "anthropic" }, { anthropicKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  expect(await cleanupNote(engine({ enabled: true, provider: "none" }, { anthropicKey: "k", openaiKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  // A provider chosen in Settings whose key isn't there is not swapped for the other one.
  expect(await cleanupNote(engine({ enabled: true, provider: "anthropic" }, { openaiKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  expect(await cleanupNote(engine({ enabled: true, provider: "openai" }, { anthropicKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  expect(sent).toEqual([]);
});

it("asks Anthropic when its key is there, with the playhead, the range and the clips the note is about", async () => {
  const sent = provider({ stop_reason: "end_turn", content: [{ type: "thinking", text: "hm" }, { type: "text", text: " Cut the cough " }, { type: "text", text: "at 12.50s. " }] });
  const { ctx } = engine({ enabled: true, provider: "anthropic" }, { anthropicKey: "sk-ant-fixture", openaiKey: "sk-fixture" });
  expect(await cleanupNote(ctx, spoken, { time: 12.5, end: 14, clipIds: ["clp_a", "clp_b"] })).toBe("Cut the cough at 12.50s.");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-fixture");
  expect(sent[0]!.body.messages).toEqual([{ role: "user", content: `Playhead at 12.50s to 14.00s on clip(s) clp_a, clp_b.\n\nSpoken note:\n"""${spoken}"""` }]);
  expect(sent[0]!.body.system).toContain("Keep every timestamp");
});

it("uses the selected OpenAI provider with or without an Anthropic key", async () => {
  const sent = provider({ choices: [{ message: { content: "  Cut the cough at the start.\n" } }] });
  const only = engine({ enabled: true, provider: "openai" }, { openaiKey: "sk-fixture" });
  expect(await cleanupNote(only.ctx, spoken, { time: 0 })).toBe("Cut the cough at the start.");
  const chosen = engine({ enabled: true, provider: "openai" }, { anthropicKey: "sk-ant-fixture", openaiKey: "sk-fixture" });
  expect(await cleanupNote(chosen.ctx, spoken, { time: 0 })).toBe("Cut the cough at the start.");
  expect(sent.map(s => s.url)).toEqual(Array(2).fill("https://api.openai.com/v1/chat/completions"));
  expect(sent[0]!.headers.authorization).toBe("Bearer sk-fixture");
  expect(sent[0]!.body.messages[1]).toEqual({ role: "user", content: `Playhead at 0.00s.\n\nSpoken note:\n"""${spoken}"""` });
});

it("uses the model from Settings, then the environment's, then its own default", async () => {
  const sent = provider({ choices: [{ message: { content: "ok" } }], content: [{ type: "text", text: "ok" }] });
  const keys = { anthropicKey: "a", openaiKey: "o" };
  const env = { SCARLET_CLEANUP_ANTHROPIC_MODEL: "env-anthropic", SCARLET_CLEANUP_OPENAI_MODEL: "env-openai" };
  await cleanupNote(engine({ enabled: true, provider: "openai", model: "from-settings" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "openai" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "anthropic" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "openai" }, keys).ctx, spoken, { time: 0 });
  expect(sent.map(s => s.body.model)).toEqual(["from-settings", "env-openai", "env-anthropic", "gpt-4o-mini"]);
});

it("leaves the note as spoken when the model refuses or answers with nothing", async () => {
  const { ctx, lines } = engine({ enabled: true, provider: "anthropic" }, { anthropicKey: "a" });
  provider({ stop_reason: "refusal", content: [{ type: "text", text: "I can't help with that." }] });
  expect(await cleanupNote(ctx, spoken, { time: 0 })).toBeNull();
  provider({ stop_reason: "end_turn", content: [] });
  expect(await cleanupNote(ctx, spoken, { time: 0 })).toBeNull();
  const open = engine({ enabled: true, provider: "openai" }, { openaiKey: "o" });
  provider({ choices: [{ message: { content: "   " } }] });
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  provider({});
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  // None of these is a failure: nothing is logged.
  expect([...lines, ...open.lines]).toEqual([]);
});

it("leaves the note as spoken and logs the provider's reason when the request fails, without the note or the key", async () => {
  const anthropic = engine({ enabled: true, provider: "anthropic" }, { anthropicKey: "sk-ant-fixture" });
  provider(`{"error":{"type":"overloaded_error","message":"Overloaded"}}${"x".repeat(400)}`, 529);
  expect(await cleanupNote(anthropic.ctx, spoken, { time: 0 })).toBeNull();
  expect(anthropic.lines).toHaveLength(1);
  expect(anthropic.lines[0]).toMatch(/^\[cleanup\] failed: anthropic 529: \{"error":\{"type":"overloaded_error","message":"Overloaded"\}\}x+$/);
  // The provider's answer is cut to 300 characters.
  expect(anthropic.lines[0]!.length).toBe("[cleanup] failed: anthropic 529: ".length + 300);

  const open = engine({ enabled: true, provider: "openai" }, { openaiKey: "sk-fixture" });
  provider("Incorrect API key provided", 401);
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  expect(open.lines).toEqual(["[cleanup] failed: openai 401: Incorrect API key provided", "[cleanup] failed: fetch failed"]);
  for (const line of [...anthropic.lines, ...open.lines]) {
    expect(line).not.toContain("cough");
    expect(line).not.toMatch(/sk-(ant-)?fixture/);
  }
});

/** A provider that takes the request and never answers: its call ends only when its signal aborts. */
function silentProvider() {
  const signals: Array<AbortSignal | undefined> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    signals.push(init?.signal ?? undefined);
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  return signals;
}
/** What the call has come to a moment after its signal aborted, or that it is still waiting. */
const settled = (pending: Promise<string | null>) =>
  Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve("still waiting"), 100))]);
const engines = {
  anthropic: () => engine({ enabled: true, provider: "anthropic" }, { anthropicKey: "sk-ant-fixture" }),
  openai: () => engine({ enabled: true, provider: "openai" }, { openaiKey: "sk-fixture" }),
};

it.each(["anthropic", "openai"] as const)("leaves the note as spoken when %s doesn't answer within 30 seconds", async name => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  const signals = silentProvider();
  const { ctx, lines } = engines[name]();
  const pending = cleanupNote(ctx, spoken, { time: 0 });
  deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  expect(await settled(pending)).toBeNull();
  expect(timeout).toHaveBeenCalledWith(30_000);
  expect(signals).toHaveLength(1);
  expect(lines).toEqual(["[cleanup] failed: The operation was aborted due to timeout"]);
});

it.each(["anthropic", "openai"] as const)("stops asking %s once the request for the note is cancelled", async name => {
  const request = new AbortController();
  const signals = silentProvider();
  const { ctx, lines } = engines[name]();
  const pending = cleanupNote(ctx, spoken, { time: 0 }, request.signal);
  request.abort("Client connection prematurely closed.");
  expect(await settled(pending)).toBeNull();
  expect(signals[0]?.aborted).toBe(true);
  expect(lines).toEqual(["[cleanup] failed: Client connection prematurely closed."]);
});
