import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCapabilities } from "./capabilities.js";

afterEach(() => vi.restoreAllMocks());

describe("agentCapabilities", () => {
  it("gives each known harness what it delivers, and an unknown one the conservative set", () => {
    // No harness's to-do tool is on: the chat shows no plan. Gemini's runner reads none.
    expect(agentCapabilities("claude")).toEqual({ images: true, audio: false, files: false, plan: false, toolPrefix: "mcp__scarlet__" });
    expect(agentCapabilities("codex")).toEqual({ images: true, audio: false, files: true, plan: false });
    expect(agentCapabilities("gemini")).toEqual({ images: true, audio: false, files: false, plan: false });
    for (const agent of [undefined, "", "api", "toString", "Claude"]) expect(agentCapabilities(agent), String(agent)).toEqual({ images: true, audio: false, files: false, plan: false });
  });

  it("applies an override given as an object or as SCARLET_AGENT_CAPS JSON, taking only its true/false capabilities", () => {
    expect(agentCapabilities("claude", { audio: true })).toEqual({ images: true, audio: true, files: false, plan: false, toolPrefix: "mcp__scarlet__" });
    expect(agentCapabilities("claude", '{"plan":true}').plan).toBe(true);
    expect(agentCapabilities("codex", '{"plan":true}').plan).toBe(true);
    expect(agentCapabilities("codex", '{"audio":true,"files":false}')).toEqual({ images: true, audio: true, files: false, plan: false });
    expect(agentCapabilities("claude", ' {"images": false, "audio": "yes", "files": 1, "shell": true} ')).toEqual({ images: false, audio: false, files: false, plan: false, toolPrefix: "mcp__scarlet__" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const unset of [undefined, "", "   "]) expect(agentCapabilities("codex", unset)).toEqual({ images: true, audio: false, files: true, plan: false });
    expect(agentCapabilities("codex", "{}")).toEqual({ images: true, audio: false, files: true, plan: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores a SCARLET_AGENT_CAPS that isn't a JSON object, and says so without repeating its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["files=true", "{files:true}", '{"files":true', "null", '["files"]', '"files"', "17"]) {
      warn.mockClear();
      expect(agentCapabilities("codex", bad), bad).toEqual({ images: true, audio: false, files: true, plan: false });
      expect(warn, bad).toHaveBeenCalledTimes(1);
      // One fixed line: the variable's name and what it should hold, never what it held.
      expect(warn.mock.calls[0]).toEqual(['[scarlet] SCARLET_AGENT_CAPS ignored: it must be a JSON object such as {"audio":true}']);
      expect(warn.mock.calls[0]![0]).not.toContain(bad);
    }
  });
});
