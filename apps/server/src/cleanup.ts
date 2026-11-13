/**
 * Optional "note cleanup": turn a rambling voice transcript into a precise
 * editing instruction, keeping timestamps. Plain HTTP calls, no SDKs.
 * The editor enables cleanup and selects its provider in Settings.
 * Model: settings.noteCleanup.model, else SCARLET_CLEANUP_ANTHROPIC_MODEL /
 * SCARLET_CLEANUP_OPENAI_MODEL, else the defaults below.
 */
import type { Ctx } from "./context.js";

const DEFAULT_MODEL = { anthropic: "claude-opus-5-5", openai: "gpt-4o-mini" };

const SYSTEM = `You rewrite spoken video-editing feedback into one precise, imperative instruction for an editing agent.
Keep every timestamp, clip reference, and number exactly as given. Remove filler, hedging and repetition.
Do not invent details. Reply with the instruction only, no preamble.`;

export async function cleanupNote(
  ctx: Ctx,
  transcript: string,
  context: { time: number; end?: number; clipIds?: string[] },
): Promise<string | null> {
  const cfg = ctx.settings().noteCleanup;
  const provider = cfg.provider;
  if (!cfg.enabled || provider === "none") return null;
  const env = ctx.options.env ?? process.env;
  const model = cfg.model || (provider === "anthropic" ? env.SCARLET_CLEANUP_ANTHROPIC_MODEL : env.SCARLET_CLEANUP_OPENAI_MODEL) || DEFAULT_MODEL[provider];
  const where = `at ${context.time.toFixed(2)}s${context.end !== undefined ? ` to ${context.end.toFixed(2)}s` : ""}` +
    (context.clipIds?.length ? ` on clip(s) ${context.clipIds.join(", ")}` : "");
  const user = `Playhead ${where}.\n\nSpoken note:\n"""${transcript}"""`;
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
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    ctx.log(`[cleanup] failed: ${(e as Error).message}`);
    return null;
  }
}
