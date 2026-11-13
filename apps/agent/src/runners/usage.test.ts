import { describe, expect, it } from "vitest";
import { claudeRunUsage, newClaudeState, parseClaudeLine } from "./claude.js";
import { newCodexState, parseCodexLine } from "./codex.js";
import { newGeminiState, parseGeminiLine } from "./gemini.js";
import { addUsage, claudeUsage, codexUsage, geminiUsage, tokenCount } from "./usage.js";

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

  it("reads Gemini stats with or without the uncached input field", () => {
    const st = newGeminiState();
    parseGeminiLine('{"type":"init","model":"gemini-3-pro"}', st);
    parseGeminiLine('{"type":"result","status":"success","stats":{"total_tokens":1500,"input_tokens":1200,"output_tokens":300,"cached":1000,"input":200}}', st);
    expect(st.usage).toEqual({ ...zero, model: "gemini-3-pro", inputTokens: 200, outputTokens: 300, cacheReadTokens: 1000 });
    expect(geminiUsage({ input_tokens: 1200, output_tokens: 300, cached: 1000 })).toMatchObject({ inputTokens: 200, cacheReadTokens: 1000 });
  });

  it("ignores negative, fractional and non-numeric counts", () => {
    expect([tokenCount(-5), tokenCount(2.7), tokenCount("9"), tokenCount(Number.NaN)]).toEqual([0, 2, 0, 0]);
    expect(addUsage({ ...zero, inputTokens: 1 }, { ...zero, inputTokens: 2 })).toEqual({ ...zero, inputTokens: 3 });
  });
});
