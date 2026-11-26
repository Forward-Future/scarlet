import { afterEach, expect, it, vi } from "vitest";
import type { Ctx } from "./context.js";
import { cleanupNote } from "./cleanup.js";

afterEach(() => vi.restoreAllMocks());

type Cleanup = { enabled: boolean; provider: "none" | "anthropic" | "openai" | "gemini"; model?: string };
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
/** A failure's line without its provider, model and time, which vary. */
const reason = (lines: string[]) => lines.map(line => line.replace(/^\[cleanup\] \S+ \S+ failed after \S+( \(timed out\))?: /, "[cleanup] failed: "));
const spoken = "um so like at the start, cut the, uh, the bit where I cough";

it("leaves the note as spoken when cleanup is off, or when there is no key for a provider", async () => {
  const sent = provider({});
  expect(await cleanupNote(engine({ enabled: false, provider: "anthropic" }, { anthropicKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  expect(await cleanupNote(engine({ enabled: true, provider: "none" }, { anthropicKey: "k", openaiKey: "k", geminiKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  // A provider chosen in Settings whose key isn't there is not swapped for another one.
  expect(await cleanupNote(engine({ enabled: true, provider: "anthropic" }, { openaiKey: "k", geminiKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  expect(await cleanupNote(engine({ enabled: true, provider: "openai" }, { anthropicKey: "k", geminiKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
  expect(await cleanupNote(engine({ enabled: true, provider: "gemini" }, { anthropicKey: "k", openaiKey: "k" }).ctx, spoken, { time: 1 })).toBeNull();
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

it("asks Gemini via x-goog-api-key header with systemInstruction and ignores thought parts", async () => {
  const sent = provider({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ thought: true, text: "thinking" }, { text: " Cut the cough " }, { text: "at the start. " }] },
    }],
  });
  const { ctx } = engine({ enabled: true, provider: "gemini" }, { geminiKey: "AIza-fixture" });
  expect(await cleanupNote(ctx, spoken, { time: 0 })).toBe("Cut the cough at the start.");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  expect(sent[0]!.headers["x-goog-api-key"]).toBe("AIza-fixture");
  expect(sent[0]!.url).not.toContain("AIza-fixture");
  expect(sent[0]!.body.systemInstruction.parts[0].text).toContain("Keep every timestamp");
  expect(sent[0]!.body.contents[0].parts[0].text).toBe(`Playhead at 0.00s.\n\nSpoken note:\n"""${spoken}"""`);
});

it("uses the model from Settings, then the environment's, then its own default", async () => {
  const sent = provider({
    choices: [{ message: { content: "ok" } }],
    content: [{ type: "text", text: "ok" }],
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
  });
  const keys = { anthropicKey: "a", openaiKey: "o", geminiKey: "g" };
  const env = {
    SCARLET_CLEANUP_ANTHROPIC_MODEL: "env-anthropic",
    SCARLET_CLEANUP_OPENAI_MODEL: "env-openai",
    SCARLET_CLEANUP_GEMINI_MODEL: "env-gemini",
  };
  await cleanupNote(engine({ enabled: true, provider: "openai", model: "from-settings" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "openai" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "anthropic" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "openai" }, keys).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "gemini", model: "gemini-settings" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "gemini" }, keys, env).ctx, spoken, { time: 0 });
  await cleanupNote(engine({ enabled: true, provider: "gemini" }, keys).ctx, spoken, { time: 0 });
  expect(sent.slice(0, 4).map(s => s.body.model)).toEqual(["from-settings", "env-openai", "env-anthropic", "gpt-4o-mini"]);
  expect(sent.slice(4).map(s => s.url)).toEqual([
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-settings:generateContent",
    "https://generativelanguage.googleapis.com/v1beta/models/env-gemini:generateContent",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  ]);
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
  const gem = engine({ enabled: true, provider: "gemini" }, { geminiKey: "g" });
  provider({ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "blocked" }] } }] });
  expect(await cleanupNote(gem.ctx, spoken, { time: 0 })).toBeNull();
  provider({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "   " }] } }] });
  expect(await cleanupNote(gem.ctx, spoken, { time: 0 })).toBeNull();
  // None of these is a failure: each is one line saying why the note kept the editor's words, never what the model said.
  const all = [...lines, ...open.lines, ...gem.lines];
  expect(all.map(line => line.replace(/ in \d+ms$/, ""))).toEqual([
    "[cleanup] anthropic claude-opus-5-5 kept the spoken note (stopped: refusal)",
    "[cleanup] anthropic claude-opus-5-5 kept the spoken note (empty reply)",
    "[cleanup] openai gpt-4o-mini kept the spoken note (empty reply)",
    "[cleanup] openai gpt-4o-mini kept the spoken note (empty reply)",
    "[cleanup] gemini gemini-2.5-flash kept the spoken note (stopped: SAFETY)",
    "[cleanup] gemini gemini-2.5-flash kept the spoken note (empty reply)",
  ]);
  for (const line of all) expect(line).not.toMatch(/failed|help with|blocked/);
});

it("leaves the note as spoken when the rewrite was cut off at its length limit", async () => {
  // Half an instruction would be sent to the agent in place of everything the editor said.
  const { ctx } = engine({ enabled: true, provider: "anthropic" }, { anthropicKey: "a" });
  provider({ stop_reason: "max_tokens", content: [{ type: "text", text: "Cut the cough at the start, then tighten the" }] });
  expect(await cleanupNote(ctx, spoken, { time: 0 })).toBeNull();
  const open = engine({ enabled: true, provider: "openai" }, { openaiKey: "o" });
  provider({ choices: [{ finish_reason: "length", message: { content: "Cut the cough at the start, then tighten the" } }] });
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  const gem = engine({ enabled: true, provider: "gemini" }, { geminiKey: "g" });
  provider({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "Cut the cough at the start, then tighten the" }] } }] });
  expect(await cleanupNote(gem.ctx, spoken, { time: 0 })).toBeNull();
});

it("leaves the note as spoken and logs the provider's reason when the request fails, without the note or the key", async () => {
  const anthropic = engine({ enabled: true, provider: "anthropic" }, { anthropicKey: "sk-ant-fixture" });
  provider(`{"error":{"type":"overloaded_error","message":"Overloaded"}}${"x".repeat(400)}`, 529);
  expect(await cleanupNote(anthropic.ctx, spoken, { time: 0 })).toBeNull();
  expect(anthropic.lines).toHaveLength(1);
  expect(anthropic.lines[0]).toMatch(/^\[cleanup\] anthropic claude-opus-5-5 failed after \d+ms: /);
  expect(reason(anthropic.lines)[0]).toMatch(/^\[cleanup\] failed: anthropic 529: \{"error":\{"type":"overloaded_error","message":"Overloaded"\}\}x+$/);
  // The provider's answer is cut to 300 characters.
  expect(reason(anthropic.lines)[0]!.length).toBe("[cleanup] failed: anthropic 529: ".length + 300);

  const open = engine({ enabled: true, provider: "openai" }, { openaiKey: "sk-fixture" });
  provider("Incorrect API key provided", 401);
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  expect(await cleanupNote(open.ctx, spoken, { time: 0 })).toBeNull();
  expect(reason(open.lines)).toEqual(["[cleanup] failed: openai 401: Incorrect API key provided", "[cleanup] failed: fetch failed"]);

  const gem = engine({ enabled: true, provider: "gemini" }, { geminiKey: "AIza-fixture" });
  provider("API key not valid", 400);
  expect(await cleanupNote(gem.ctx, spoken, { time: 0 })).toBeNull();
  expect(reason(gem.lines)).toEqual(["[cleanup] failed: gemini 400: API key not valid"]);

  for (const line of [...anthropic.lines, ...open.lines, ...gem.lines]) {
    expect(line).not.toContain("cough");
    expect(line).not.toMatch(/sk-(ant-)?fixture|AIza-fixture/);
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
  gemini: () => engine({ enabled: true, provider: "gemini" }, { geminiKey: "AIza-fixture" }),
};

it.each(["anthropic", "openai", "gemini"] as const)("leaves the note as spoken when %s doesn't answer within 30 seconds", async name => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  const signals = silentProvider();
  const { ctx, lines } = engines[name]();
  const pending = cleanupNote(ctx, spoken, { time: 0 });
  deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  expect(await settled(pending)).toBeNull();
  expect(timeout).toHaveBeenCalledWith(30_000);
  expect(signals).toHaveLength(1);
  expect(reason(lines)).toEqual(["[cleanup] failed: The operation was aborted due to timeout"]);
  expect(lines[0]).toContain("(timed out)");
});

it.each(["anthropic", "openai", "gemini"] as const)("stops asking %s once the request for the note is cancelled", async name => {
  const request = new AbortController();
  const signals = silentProvider();
  const { ctx, lines } = engines[name]();
  const pending = cleanupNote(ctx, spoken, { time: 0 }, request.signal);
  request.abort("Client connection prematurely closed.");
  expect(await settled(pending)).toBeNull();
  expect(signals[0]?.aborted).toBe(true);
  expect(reason(lines)).toEqual(["[cleanup] failed: Client connection prematurely closed."]);
});

it("logs each cleanup's outcome with its provider and model, never the note or the rewrite", async () => {
  const kept = engine({ enabled: true, provider: "anthropic" }, {});
  await cleanupNote(kept.ctx, spoken, { time: 0 });
  provider({ choices: [{ message: { content: "Cut the cough at the start." } }] });
  const rewrote = engine({ enabled: true, provider: "openai", model: "gpt-fixture" }, { openaiKey: "sk-fixture" });
  await cleanupNote(rewrote.ctx, spoken, { time: 0 });
  expect(kept.lines).toEqual([expect.stringMatching(/^\[cleanup\] anthropic claude-opus-5-5 kept the spoken note \(no Anthropic key\) in \d+ms$/)]);
  expect(rewrote.lines).toEqual([expect.stringMatching(/^\[cleanup\] openai gpt-fixture rewrote the note in \d+ms$/)]);
  for (const line of [...kept.lines, ...rewrote.lines]) expect(line).not.toMatch(/cough|sk-fixture/);
});
