import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCapabilities, canHear, chooseListener, hearingModels, listenerAmong, modelHearsAudioFiles, toolWait, workspaceCapabilities } from "./capabilities.js";

afterEach(() => vi.restoreAllMocks());

describe("agentCapabilities", () => {
  it("gives each known harness what it delivers, and an unknown one the conservative set", () => {
    // No harness's to-do tool is on: the chat shows no plan. Gemini's runner reads none.
    expect(agentCapabilities("claude")).toEqual({ images: true, audio: false, files: false, plan: false, resultChars: 40_000, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 });
    expect(agentCapabilities("codex")).toEqual({ images: true, audio: false, files: true, plan: false, resultChars: 40_000, toolWaitSeconds: 240 });
    expect(agentCapabilities("gemini")).toEqual({ images: true, audio: false, audioFiles: true, files: false, plan: false, briefTools: true, resultChars: 9_000, toolWaitSeconds: 120 });
    for (const agent of [undefined, "", "api", "toString", "Claude"]) expect(agentCapabilities(agent), String(agent)).toEqual({ images: true, audio: false, files: false, plan: false, resultChars: 40_000 });
  });

  it("treats only Gemini models on agy as hearing WAV files, not third-party models hosted there", () => {
    for (const model of [undefined, "gemini-4-neon", "gemini-3.8-flash", "models/gemini-2.5-pro"]) {
      const caps = agentCapabilities("gemini", undefined, model);
      expect(caps.audioFiles, String(model)).toBe(true);
      expect(canHear(caps), String(model)).toBe(true);
      expect(modelHearsAudioFiles("gemini", model), String(model)).toBe(true);
    }
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b-medium"]) {
      const caps = agentCapabilities("gemini", undefined, model);
      expect(caps, model).toEqual({ images: true, audio: false, audioFiles: false, files: false, plan: false, briefTools: true, resultChars: 9_000, toolWaitSeconds: 120 });
      expect(canHear(caps), model).toBe(false);
      expect(modelHearsAudioFiles("gemini", model), model).toBe(false);
    }
    // An explicit override still wins.
    expect(agentCapabilities("gemini", { audioFiles: true }, "claude-opus-5-5").audioFiles).toBe(true);
  });

  it("applies an override given as an object or as SCARLET_AGENT_CAPS JSON, taking its supported capabilities", () => {
    expect(agentCapabilities("claude", { audio: true })).toEqual({ images: true, audio: true, files: false, plan: false, resultChars: 40_000, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 });
    expect(agentCapabilities("claude", '{"plan":true}').plan).toBe(true);
    expect(agentCapabilities("codex", '{"plan":true}').plan).toBe(true);
    expect(agentCapabilities("codex", '{"audio":true,"files":false}')).toEqual({ images: true, audio: true, files: false, plan: false, resultChars: 40_000, toolWaitSeconds: 240 });
    expect(agentCapabilities("claude", ' {"images": false, "audio": "yes", "files": 1, "shell": "yes"} ')).toEqual({ images: false, audio: false, files: false, plan: false, resultChars: 40_000, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 });
    expect(agentCapabilities("codex", '{"resultChars":8000}').resultChars).toBe(8_000);
    expect(agentCapabilities("gemini", '{"resultChars":20000}').resultChars).toBe(20_000);
    // A tool wait and brief listing are set the same way, for a harness whose deadline or tool budget differs.
    expect(agentCapabilities("codex", '{"toolWaitSeconds":90,"briefTools":true}')).toMatchObject({ toolWaitSeconds: 90, briefTools: true });
    expect(agentCapabilities("gemini", '{"briefTools":false}').briefTools).toBe(false);
    for (const bad of ['{"toolWaitSeconds":0}', '{"toolWaitSeconds":-5}', '{"toolWaitSeconds":"90"}', '{"briefTools":"yes"}'])
      expect(agentCapabilities("claude", bad), bad).toMatchObject({ toolWaitSeconds: 240 });
    expect(agentCapabilities("claude", '{"briefTools":"yes"}').briefTools).toBeUndefined();
    expect(agentCapabilities("codex", { resultChars: 200 }).resultChars).toBe(40_000);
    expect(agentCapabilities("gemini", { resultChars: 200 }).resultChars).toBe(9_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const unset of [undefined, "", "   "]) expect(agentCapabilities("codex", unset)).toEqual({ images: true, audio: false, files: true, plan: false, resultChars: 40_000, toolWaitSeconds: 240 });
    expect(agentCapabilities("codex", "{}")).toEqual({ images: true, audio: false, files: true, plan: false, resultChars: 40_000, toolWaitSeconds: 240 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores a SCARLET_AGENT_CAPS that isn't a JSON object, and says so without repeating its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["files=true", "{files:true}", '{"files":true', "null", '["files"]', '"files"', "17"]) {
      warn.mockClear();
      expect(agentCapabilities("codex", bad), bad).toEqual({ images: true, audio: false, files: true, plan: false, resultChars: 40_000, toolWaitSeconds: 240 });
      expect(warn, bad).toHaveBeenCalledTimes(1);
      // One fixed line: the variable's name and what it should hold, never what it held.
      expect(warn.mock.calls[0]).toEqual(['[scarlet] SCARLET_AGENT_CAPS ignored: it must be a JSON object such as {"audio":true}']);
      expect(warn.mock.calls[0]![0]).not.toContain(bad);
    }
  });
});

describe("listening model selection", () => {
  it("excludes third-party models exposed by agy from hearingModels, listenerAmong, and chooseListener", () => {
    const mixed = [{ id: "gemini", installed: true, model: "claude-opus-5-5", models: ["claude-opus-5-5", "gpt-oss-120b-medium", "gemini-4-neon"] }];
    expect(hearingModels(mixed)).toEqual([{ agent: "gemini", model: "gemini-4-neon" }]);
    expect(listenerAmong(mixed)).toEqual({ agent: "gemini", model: "gemini-4-neon" });
    expect(chooseListener(mixed, "gemini:claude-opus-5-5")).toBeUndefined();
    expect(chooseListener(mixed, "gemini:gemini-4-neon")).toEqual({ agent: "gemini", model: "gemini-4-neon" });

    // If agy lists only non-Gemini models, it cannot listen and falls through to another hearing agent.
    const noGeminiModels = [
      { id: "gemini", installed: true, models: ["claude-opus-5-5", "gpt-oss-120b-medium"] },
      { id: "codex", installed: true, models: ["gpt-6.2-sol", "gpt-6-astra-audio"] },
    ];
    expect(hearingModels(noGeminiModels)).toEqual([{ agent: "codex", model: "gpt-6-astra-audio" }]);
    expect(listenerAmong(noGeminiModels)).toEqual({ agent: "codex", model: "gpt-6-astra-audio" });
  });
});

describe("toolWait", () => {
  it("waits a margin under the harness's tool deadline, and as before for a client Scarlet didn't launch", () => {
    // Claude Code and Codex are launched with a 300 s tool deadline, so one call can wait for a whole batch of pictures.
    expect(toolWait(agentCapabilities("claude"), 20)).toBe(220);
    expect(toolWait(agentCapabilities("codex"), 30)).toBe(210);
    // agy ends a tool call at 180 s: Gemini waits a minute under it, as Claude Code and Codex do under their 300 s.
    expect(toolWait(agentCapabilities("gemini"), 20)).toBe(100);
    expect(toolWait(agentCapabilities("gemini"), 30)).toBe(90);
    // Unknown deadline: the common 60 s one, which leaves the 25 s a picture batch always waited.
    expect(toolWait(agentCapabilities(undefined), 20)).toBe(25);
    // Never under five seconds, never over the four minutes a launched harness allows.
    expect(toolWait({ toolWaitSeconds: 10 }, 20)).toBe(5);
    expect(toolWait({ toolWaitSeconds: 900 }, 20)).toBe(240);
  });
});

describe("a run launched with its harness's own tools", () => {
  it("has files, a shell and the web on every harness, as every request is launched, and a side check has no shell or web", () => {
    for (const agent of ["claude", "codex", "gemini"]) {
      const request = agentCapabilities(agent);
      expect([request.shell, request.web], agent).toEqual([undefined, undefined]);
      expect(workspaceCapabilities(request), agent).toEqual({ ...request, files: true, shell: true, web: true });
    }
  });
});
