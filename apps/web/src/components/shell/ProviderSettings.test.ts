// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { AgentAvailability } from "@scarlet/shared";
import type { ProviderSettingsView } from "../../lib/desktop";
import { providerStatus } from "./ProviderSettings";

const settings: ProviderSettingsView = { ollama: { url: null, disabled: false }, lmstudio: { url: null, disabled: true }, openrouter: { hasKey: false, keyFromEnv: false, disabled: false } };
const claude: AgentAvailability = { id: "claude", installed: true, loggedIn: true };

it("says in a few words where each provider stands", () => {
  expect(providerStatus("ollama", { id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b", "gpt-oss:20b"] }, claude, settings)).toBe("2 models ready");
  expect(providerStatus("ollama", { id: "ollama", installed: false }, claude, settings)).toBe("Not running. Start Ollama on this computer.");
  const remote = { ...settings, ollama: { url: "http://gpu:11434", disabled: false } };
  expect(providerStatus("ollama", { id: "ollama", installed: false }, claude, remote)).toBe("Couldn’t reach Ollama at http://gpu:11434.");
  expect(providerStatus("ollama", { id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b"] }, claude, remote)).toBe("1 model ready · http://gpu:11434");
  expect(providerStatus("ollama", { id: "ollama", installed: true, loggedIn: true, models: [] }, claude, settings)).toMatch(/none of its models can use tools/);
  expect(providerStatus("lmstudio", undefined, claude, settings)).toBe("Off");
  expect(providerStatus("openrouter", { id: "openrouter", installed: false }, claude, settings)).toBe("Add your OpenRouter key to use its models.");
  const keyed = { ...settings, openrouter: { hasKey: true, keyFromEnv: false, disabled: false } };
  expect(providerStatus("openrouter", { id: "openrouter", installed: true, loggedIn: false }, claude, keyed)).toBe("OpenRouter didn’t accept this key.");
  expect(providerStatus("openrouter", { id: "openrouter", installed: true, loggedIn: true, models: ["a/b", "c/d", "e/f"] }, claude, keyed)).toMatch(/^3 models\. Turn on/);
  // Claude Code runs the edit, so without it nothing here can.
  expect(providerStatus("ollama", { id: "ollama", installed: false }, { id: "claude", installed: false }, settings)).toMatch(/^Needs Claude Code/);
});
