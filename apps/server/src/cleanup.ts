/**
 * Optional "note cleanup": turn a rambling voice transcript into a precise
 * editing instruction, keeping timestamps. Plain HTTP calls, no SDKs.
 * The editor enables cleanup and selects its provider in Settings.
 * Model: settings.noteCleanup.model, else SCARLET_CLEANUP_ANTHROPIC_MODEL /
 * SCARLET_CLEANUP_OPENAI_MODEL, else the defaults below.
 */
import type { Ctx } from "./context.js";

const DEFAULT_MODEL = { anthropic: "claude-opus-5-5", openai: "gpt-4o-mini" };
// The note waits for its cleanup, so a provider that stops answering must not hold it for the HTTP client's five minutes.
const CLEANUP_TIMEOUT_MS = 30_000;

const SYSTEM = `You rewrite spoken video-editing feedback into one precise, imperative instruction for an editing agent.
Keep every timestamp, clip reference, and number exactly as given. Remove filler, hedging and repetition.
Do not invent details. Reply with the instruction only, no preamble.`;

export async function cleanupNote(
  ctx: Ctx,
  transcript: string,
  context: { time: number; end?: number; clipIds?: string[] },
  signal?: AbortSignal,
): Promise<string | null> {
  const cfg = ctx.settings().noteCleanup;
  const provider = cfg.provider;
  if (!cfg.enabled || provider === "none") return null;
  const env = ctx.options.env ?? process.env;
  const model = cfg.model || (provider === "anthropic" ? env.SCARLET_CLEANUP_ANTHROPIC_MODEL : env.SCARLET_CLEANUP_OPENAI_MODEL) || DEFAULT_MODEL[provider];
  const where = `at ${context.time.toFixed(2)}s${context.end !== undefined ? ` to ${context.end.toFixed(2)}s` : ""}` +
    (context.clipIds?.length ? ` on clip(s) ${context.clipIds.join(", ")}` : "");
  const user = `Playhead ${where}.\n\nSpoken note:\n"""${transcript}"""`;
  const deadline = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  const stop = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    if (provider === "anthropic") {
      if (!ctx.env.anthropicKey) return null;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ctx.env.anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          output_config: { effort: "low" },
          fallbacks: "default",
          system: SYSTEM,
          messages: [{ role: "user", content: user }],
        }),
        signal: stop,
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as {
        stop_reason?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      if (json.stop_reason === "refusal") return null;
      const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
      return text || null;
    }
    if (!ctx.env.openaiKey) return null;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.env.openaiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        max_tokens: 1024,
      }),
      signal: stop,
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    // A request cancelled by the client can abort with a plain string as its reason.
    ctx.log(`[cleanup] failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
