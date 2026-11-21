import { describe, expect, it } from "vitest";
import { claudeRunUsage, newClaudeState, parseClaudeLine } from "./claude.js";
import { newCodexState, parseCodexLine } from "./codex.js";
import { newGeminiState, parseGeminiLine } from "./gemini.js";
import { addUsage, claudeUsage, codexUsage, geminiTranscriptStepUsage, geminiUsage, tokenCount } from "./usage.js";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

describe("token usage", () => {
  it("takes Claude's result totals and session model", () => {
    const st = newClaudeState();
    for (const line of [
      '{"type":"system","subtype":"init","model":"claude-opus-5-5","mcp_servers":[{"name":"scarlet","status":"connected"}]}',
      '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":3,"output_tokens":1}}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Done","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":200,"cache_read_input_tokens":3000,"cache_creation_input_tokens":400}}',
    ]) parseClaudeLine(line, st);
    expect(claudeRunUsage(st)).toEqual({ model: "claude-opus-5-5", inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400, reasoningTokens: 0 });
  });

  it("sums Claude's per-message usage when the run stops before its result", () => {
    const st = newClaudeState();
    for (const line of [
      // One API message split across lines: only its last count is kept.
      '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":100}}}',
      '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"t1","name":"mcp__scarlet__task_question","input":{"text":"Keep?"}}],"usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":100}}}',
      '{"type":"assistant","message":{"id":"msg_2","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":50}}}',
    ]) parseClaudeLine(line, st);
    expect(claudeRunUsage(st, "opus")).toEqual({ ...zero, model: "opus", inputTokens: 7, outputTokens: 13, cacheReadTokens: 100, cacheWriteTokens: 50 });
  });

  it("reports nothing when a CLI gave no counts", () => {
    expect(claudeRunUsage(newClaudeState())).toBeUndefined();
    expect(claudeUsage({ service_tier: "standard" })).toBeUndefined();
    expect(codexUsage(undefined)).toBeUndefined();
    expect(geminiUsage({ total_tokens: 100 })).toBeUndefined();
  });

  it("separates Codex cached input and sums turns", () => {
    const st = newCodexState();
    parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50,"reasoning_output_tokens":20}}', st);
    parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}', st);
    expect(st.usage).toEqual({ ...zero, inputTokens: 210, outputTokens: 55, cacheReadTokens: 800, reasoningTokens: 20 });
  });

  it("reads Gemini ACP usage updates, transcript steps, and both camelCase and snake_case stats", () => {
    const st = newGeminiState();
    st.model = "gemini-4-neon";
    parseGeminiLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "usage_update",
          usage: { inputTokens: 2151, outputTokens: 18, cachedReadTokens: 7634, thoughtTokens: 15, totalTokens: 9803 },
        },
      },
    }), st);
    expect(st.usage).toEqual({ ...zero, model: "gemini-4-neon", inputTokens: 2151, outputTokens: 18, cacheReadTokens: 7634, reasoningTokens: 15 });
    expect(geminiUsage({ inputTokens: 1500, outputTokens: 250, cachedReadTokens: 900, cachedWriteTokens: 100, thoughtTokens: 80, totalTokens: 1750 }, "gemini-3.1-pro"))
      .toEqual({ model: "gemini-3.1-pro", inputTokens: 500, outputTokens: 250, cacheReadTokens: 900, cacheWriteTokens: 100, reasoningTokens: 80 });
    expect(geminiTranscriptStepUsage({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 2151, cache_read_tokens: 7634, output_tokens: 18 }, "gemini-4-neon"))
      .toEqual({ ...zero, model: "gemini-4-neon", inputTokens: 2151, outputTokens: 18, cacheReadTokens: 7634 });
    expect(geminiTranscriptStepUsage({ type: "GENERIC", input_tokens: 10 })).toBeUndefined();
    expect(geminiUsage({ input_tokens: 1200, output_tokens: 300, cached: 1000 })).toMatchObject({ inputTokens: 200, cacheReadTokens: 1000 });
    expect(geminiUsage({ input_tokens: 1200, output_tokens: 300, cached: 1000, input: 200 })).toMatchObject({ inputTokens: 200, cacheReadTokens: 1000 });
  });

  it("counts Gemini's thoughts as output where they are reported apart from it", () => {
    // agy's own counts add up to the total without the thoughts: its output holds them already.
    expect(geminiUsage({ inputTokens: 2151, outputTokens: 18, cachedReadTokens: 7634, thoughtTokens: 15, totalTokens: 9803 })).toMatchObject({ outputTokens: 18, reasoningTokens: 15 });
    // A total that counts them on top of the output, or an output smaller than they are, reports them apart.
    expect(geminiUsage({ inputTokens: 100, outputTokens: 20, thoughtTokens: 50, totalTokens: 170 })).toMatchObject({ inputTokens: 100, outputTokens: 70, reasoningTokens: 50 });
    expect(geminiUsage({ inputTokens: 100, outputTokens: 10, thoughtTokens: 50 })).toMatchObject({ outputTokens: 60, reasoningTokens: 50 });
    expect(geminiUsage({ inputTokens: 100, outputTokens: 60, thoughtTokens: 50 })).toMatchObject({ outputTokens: 60, reasoningTokens: 50 });
  });

  it("ignores negative, fractional and non-numeric counts", () => {
    expect([tokenCount(-5), tokenCount(2.7), tokenCount("9"), tokenCount(Number.NaN)]).toEqual([0, 2, 0, 0]);
    expect(addUsage({ ...zero, inputTokens: 1 }, { ...zero, inputTokens: 2 })).toEqual({ ...zero, inputTokens: 3 });
  });
});
