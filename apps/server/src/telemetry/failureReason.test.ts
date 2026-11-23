import type { FailureReason, Task } from "@scarlet/shared";
import { FAILURE_REASONS } from "@scarlet/shared";
import { describe, expect, it } from "vitest";
import { renderFailureReason, taskFailureReason } from "./failureReason.js";

const agentTask = (error: string | undefined, extra: Partial<Task> = {}) =>
  taskFailureReason({ kind: "edit", error, ...extra });
const transcription = (error: string | undefined, extra: Partial<Task> = {}) =>
  taskFailureReason({ kind: "transcribe", error, ...extra });

describe("a failed request's reason", () => {
  // The words the desktop host, the agent CLIs and the engine leave on a task that fails, most within seconds of starting.
  it.each<[string, FailureReason]>([
    ["claude CLI not found on PATH", "agent_not_installed"],
    ["codex CLI not found on PATH", "agent_not_installed"],
    ["spawn /Users/me/Library/Application Support/npm/bin/claude", "agent_not_installed"],
    ["spawn claude ENOENT", "agent_not_installed"],
    ["C:\\npm\\codex.cmd runs no copy of @openai/codex Scarlet can find; use a native or npm agent CLI instead of a batch launcher", "agent_not_installed"],
    ["Invalid API key · Please run /login", "agent_not_signed_in"],
    ["claude exited with code 1: Not logged in · Please run /login", "agent_not_signed_in"],
    ["OAuth token has expired. Please obtain a new token or refresh your existing token.", "agent_not_signed_in"],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "agent_not_signed_in"],
    ["Authentication required. Run agy login.", "agent_not_signed_in"],
    ["Claude AI usage limit reached|1763928000", "rate_limited"],
    ["You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", "rate_limited"],
    ["5-hour limit reached ∙ resets 3pm", "rate_limited"],
    ["rate limited", "rate_limited"],
    ["Gemini session/prompt failed: [429] RESOURCE_EXHAUSTED: Quota exceeded for quota metric", "rate_limited"],
    ["Credit balance is too low", "rate_limited"],
    ["There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it.", "model_unavailable"],
    ["The 'gpt-9-codex' model is not supported when using Codex with a ChatGPT account.", "model_unavailable"],
    ["Gemini session/new failed: models/gemini-9 is not found for API version v1beta", "model_unavailable"],
    ["Scarlet's MCP server failed to start, so Claude Code had no editing tools.", "tools_unavailable"],
    ["API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", "provider_error"],
    ["unexpected status 500 Internal Server Error", "provider_error"],
    ["stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)", "network"],
    ["API Error: Connection error.", "network"],
    ["getaddrinfo ENOTFOUND api.anthropic.com", "network"],
    ["timed out after 45 minutes, the limit for one agent run", "timeout"],
    ["stalled: the agent wrote nothing for 10 minutes", "timeout"],
    ["claude exited with code 137", "crashed"],
    ["codex exited with code null: thread 'main' panicked at core/src/lib.rs", "crashed"],
    ["Codex App Server stopped taking input", "crashed"],
    ["Gemini ended with stopReason refusal", "crashed"],
    ["agent failed", "crashed"],
    ["Error: ENOSPC: no space left on device, write", "out_of_disk"],
    ["Could not deliver the editor question: engine returned 409", "other"],
    ["The requested skill was not saved. Request it again from the approved change.", "other"],
    ["Scarlet could not finish the cut using your answer. Your answer is saved.", "other"],
  ])("%s → %s", (error, reason) => {
    expect(agentTask(error)).toBe(reason);
  });

  it("is other when nothing was said", () => {
    expect(agentTask(undefined)).toBe("other");
    expect(agentTask("")).toBe("other");
  });

  it("is interrupted when the host or the engine stopped the run, and crashed when its worker went missing", () => {
    expect(agentTask("The editing request was interrupted before a result was saved.", { interrupted: true })).toBe("interrupted");
    expect(agentTask("The agent was interrupted after saving changes.", { interrupted: true, lostWorker: true })).toBe("crashed");
    // A run the host stopped at its limit is interrupted too, and says why.
    expect(agentTask("timed out after 45 minutes, the limit for one agent run", { interrupted: true })).toBe("timeout");
  });

  it.each<[string, FailureReason]>([
    ["transcription provider \"whispercpp\" is not configured", "transcription_model_missing"],
    ["no openai", "transcription_model_missing"],
    ["Could not download the local model ggml-base.bin: fetch failed. Retry transcription to try again.", "transcription_model_missing"],
    ["The installed Scarlet engine is missing its Uhm runtime.", "transcription_model_missing"],
    ["spawn ENOENT", "transcription_model_missing"],
    ["whisper-cli exited with code 11: error: failed to read audio file 'a.wav'", "media_unreadable"],
    ["No complete PCM audio in the analysis window.", "media_unreadable"],
    ["recording unavailable", "media_unreadable"],
    ["Scarlet couldn’t reach OpenAI: check your internet connection, then try again.", "network"],
    ["HTTP 429", "rate_limited"],
    ["whisper-cli was killed", "crashed"],
    ["ggml_vulkan: device lost", "crashed"],
    ["Transcription was turned off.", "other"],
  ])("transcription: %s → %s", (error, reason) => {
    expect(transcription(error)).toBe(reason);
  });

  it("an interrupted transcription is interrupted", () => {
    expect(transcription("Transcription was interrupted.", { interrupted: true })).toBe("interrupted");
    expect(transcription("Transcription was interrupted.")).toBe("interrupted");
  });

  it("only ever names a listed reason", () => {
    for (const error of ["", "anything at all", "/Users/me/Secret film.mov", "claude exited with code 1"]) {
      expect(FAILURE_REASONS).toContain(agentTask(error));
      expect(FAILURE_REASONS).toContain(transcription(error));
      expect(FAILURE_REASONS).toContain(renderFailureReason({ error }));
    }
  });
});

describe("a failed export's reason", () => {
  it.each<[{ error?: string; errorDetail?: string }, FailureReason]>([
    [{ error: "There isn’t enough free disk space to render this: free some space, then try again." }, "out_of_disk"],
    [{ error: "Interrupted render has no saved settings. Request a new render." }, "interrupted"],
    [{ error: "Scarlet can’t find “Interview.mov” in this project’s files: export the logs from Settings → Advanced to report it." }, "media_unreadable"],
    [{ error: "Scarlet can’t read “Interview.mov” in this project’s files: export the logs from Settings → Advanced to report it." }, "media_unreadable"],
    [{ error: "Scarlet couldn’t render the video: try once more, or export the logs from Settings → Advanced to report it.",
      errorDetail: "ffmpeg exited with code 1" }, "crashed"],
    [{ error: "render produced an empty file" }, "crashed"],
    [{ error: "A source changed during the render. Request a new render." }, "other"],
    [{}, "other"],
  ])("%j → %s", (render, reason) => {
    expect(renderFailureReason(render)).toBe(reason);
  });
});
