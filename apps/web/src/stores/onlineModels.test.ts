// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { AgentHost } from "@scarlet/shared";
import { buildDb } from "../lib/mock/fixtures";
import { onlineAgents } from "./hosts";
import { modelChoices, selectVisibleModel } from "./modelPicker";

it("lists every model each CLI offers, older releases and early-access ones included", () => {
  const host = buildDb().hosts[0]!;
  const agents = onlineAgents([{ ...host, online: true, agents: [
    { id: "codex", installed: true, model: "gpt-6-sol", models: ["gpt-5.6-terra", "gpt-6-sol", "gpt-6.1-sol", "aurora-alpha"] },
    { id: "gemini", installed: true, models: ["auto", "gemini-4-argon"] },
    { id: "claude", installed: true, models: ["opus", "claude-haiku-4-5-20251001"], modelLabels: { opus: "Opus 5.5" } },
  ] }, { ...host, online: true, id: "older-cli", agents: [
    { id: "claude", installed: true, models: ["opus", "sonnet"], modelLabels: { opus: "Opus 5" } },
  ] }]);
  const choices = modelChoices(agents);
  expect(choices.map(m => [m.agent, m.model, m.label])).toEqual([
    ["codex", "gpt-5.6-terra", "gpt-5.6-terra"], ["codex", "gpt-6-sol", "gpt-6-sol"], ["codex", "gpt-6.1-sol", "gpt-6.1-sol"], ["codex", "aurora-alpha", "aurora-alpha"],
    ["gemini", "auto", "auto"], ["gemini", "gemini-4-argon", "gemini-4-argon"],
    ["claude", "opus", "Opus 5.5"], ["claude", "claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"], ["claude", "sonnet", "sonnet"],
  ]);
  expect(selectVisibleModel(choices, { agent: "codex", model: "aurora-alpha" }, agents)?.model).toBe("aurora-alpha");
  expect(selectVisibleModel(choices, { agent: "codex", model: "gone" }, agents)?.model).toBe("gpt-6-sol");
  expect(selectVisibleModel([], { agent: "codex", model: "gpt-6-sol" }, agents)).toBeUndefined();
});

it("offers Claude's default settings when it advertises just its default", () => {
  const options = { efforts: [{ id: "high" }], speeds: [{ id: "fast" }] };
  const host: AgentHost = { ...buildDb().hosts[0]!, online: true, agents: [
    { id: "claude", installed: true, models: [],
      modelLabels: { "": "Default" }, modelOptions: { "": options } },
  ] };
  const choices = modelChoices(onlineAgents([host]));
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({ key: "claude:", agent: "claude", model: undefined, label: "Default", profiles: [options] });
  const secondHost = { ...host, id: "other-default", agents: [{ ...host.agents[0]!, modelLabels: { "": "Default (Opus)" } }] };
  expect(modelChoices(onlineAgents([host, secondHost]))[0]?.label).toBe("Provider default");
});

it("uses named Claude models across hosts and offers no default from offline or signed-out hosts", () => {
  const claude = { id: "claude" as const, installed: true, loggedIn: true, auth: "subscription" as const };
  const host = { ...buildDb().hosts[0]!, online: true, agents: [claude] };
  expect(modelChoices(onlineAgents([
    { ...host, online: false }, { ...host, id: "signed-out", agents: [{ ...claude, loggedIn: false }] },
  ]))).toEqual([]);
  const agents = onlineAgents([host, { ...host, id: "with-models", agents: [{ ...claude, models: ["sonnet"] }] }]);
  expect(modelChoices(agents).map(choice => choice.model)).toEqual(["sonnet"]);
});

it("respects the host's model override when resolving the default's label and capabilities", () => {
  const host: AgentHost = { ...buildDb().hosts[0]!, online: true, agents: [
    { id: "claude", installed: true, loggedIn: true, model: "sonnet", models: [],
      modelLabels: { "": "Default (recommended)" }, modelOptions: { "": { efforts: [{ id: "high" }], speeds: [] } } },
  ] };
  expect(modelChoices(onlineAgents([host]))[0]).toMatchObject({ model: undefined, label: "Provider default", profiles: [] });
});

it("marks models from this install's own lists as Custom, for the CLI they belong to", () => {
  const host = buildDb().hosts[0]!;
  const hosts: AgentHost[] = [{ ...host, online: true, agents: [
    { id: "codex", installed: true, models: ["local-test", "gpt-6.1-sol"], modelLabels: { "local-test": "Local Test" } },
    { id: "claude", installed: true, models: ["sonnet", "local-test"], modelLabels: { sonnet: "Sonnet 5.5" } },
  ] }];
  expect(modelChoices(onlineAgents(hosts)).map(m => m.label)).toEqual(["Local Test", "gpt-6.1-sol", "Sonnet 5.5", "local-test"]);
  expect(modelChoices(onlineAgents(hosts, ["local-test", "unavailable"])).map(m => [m.agent, m.model, m.label])).toEqual([
    ["codex", "local-test", "Local Test · Custom"], ["codex", "gpt-6.1-sol", "gpt-6.1-sol"], ["claude", "sonnet", "Sonnet 5.5"], ["claude", "local-test", "local-test"],
  ]);
  expect(modelChoices(onlineAgents(hosts, [], ["local-test"])).filter(m => m.agent === "claude").map(m => m.label)).toEqual(["Sonnet 5.5", "local-test · Custom"]);
});
