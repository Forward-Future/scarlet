import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import type { AgentAvailability, AgentHost, Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import type { Ctx } from "../context.js";
import { listenerFor, listenFor } from "./listening.js";
import { taskPrompt } from "./taskPrompts.js";
import { cancelTask, completeTask, createTask } from "./tasks.js";
import { claimTask } from "./taskQueue.js";

let dataDir: string;
let workspace: ScarletApp;
let ctx: Ctx;
const by = { type: "human", name: "Editor" } as const;
const ask = { mediaId: "mic", from: 1074.5, to: 1089.75, question: "Where does the abandoned first try end?" };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-listening-"));
  workspace = createApp({ dataDir, env: {}, log: () => {} });
  ({ ctx } = workspace);
});
afterEach(async () => {
  await ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

function hostWith(agents: AgentAvailability[], seenAgo = 0): AgentHost {
  return ctx.repos.hosts.put({ id: `host_${agents.map(a => a.id).join("_")}`, name: "Mac", userId: "user", platform: "darwin", online: true, agents,
    lastSeenAt: new Date(Date.now() - seenAgo).toISOString() });
}
function request(agent: "claude" | "codex" | "gemini" = "claude", model?: string): Task {
  const project = ctx.repos.projects.insert(createProject("Interview"));
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 2000, hasAudio: true }, "ready");
  return createTask(ctx, { projectId: project.id, kind: "edit", agent, model, instruction: "Cut the dialogue", createdBy: by });
}

it("picks a model that can hear for a request whose model can't, Gemini first, and none for one that hears itself", () => {
  const claude = request("claude");
  expect(listenerFor(ctx, claude)).toBeUndefined();
  hostWith([{ id: "claude", installed: true }, { id: "codex", installed: true, models: ["gpt-6.2-sol", "gpt-6-astra-audio"] }]);
  expect(listenerFor(ctx, claude)).toEqual({ agent: "codex", model: "gpt-6-astra-audio" });
  hostWith([{ id: "gemini", installed: true }]);
  expect(listenerFor(ctx, claude)).toEqual({ agent: "gemini" });
  // A request on a model that hears plays the recording itself.
  expect(listenerFor(ctx, request("gemini"))).toBeUndefined();
  expect(listenerFor(ctx, request("codex", "gpt-6-astra-audio"))).toBeUndefined();
});

it("leaves out a model that isn't signed in or a host that has gone quiet", () => {
  const claude = request("claude");
  hostWith([{ id: "gemini", installed: true, loggedIn: false }]);
  expect(listenerFor(ctx, claude)).toBeUndefined();
  hostWith([{ id: "gemini", installed: true }, { id: "codex", installed: true }], 10 * 60_000);
  expect(listenerFor(ctx, claude)).toBeUndefined();
});

it("says plainly when no model can hear, and starts nothing", async () => {
  const claude = request("claude");
  expect(await listenFor(ctx, claude.id, ask, 0)).toEqual({ state: "unavailable", reason: "No model that can hear is signed in on this computer." });
  expect(ctx.repos.tasks.select("kind = 'listen_check'")).toHaveLength(0);
});

it("has the listener hear the passage beside the request, while it works, and gives the request its words", async () => {
  const host = hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true }]);
  const claude = request("claude");
  expect(claimTask(ctx, host, claude.id)?.state).toBe("claimed");
  expect(await listenFor(ctx, claude.id, ask, 0)).toEqual({ state: "listening", by: { agent: "gemini" } });
  const [check] = ctx.repos.tasks.select("kind = 'listen_check'");
  expect(check).toMatchObject({ agent: "gemini", context: { checksTaskId: claude.id, listenCheck: ask } });
  // Its prompt is about the passage, and it is launched with agy's file viewer, which is how Gemini hears.
  const prompt = taskPrompt(ctx, check!, { workDir: "/tmp/run" });
  expect(prompt.workspace).toBe(true);
  expect(prompt.systemPrompt).toMatch(/^# You are listening to one passage of a recording/);
  expect(prompt.systemPrompt).toContain("Where does the abandoned first try end?");
  expect(prompt.systemPrompt).toContain("Open that file with your own file viewer to hear it.");
  // A side check: it starts in a check slot while the request holds its own.
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])?.id).toBe(check!.id);
  completeTask(ctx, ctx.repos.tasks.get(check!.id)!, { state: "done", summary: "The first try ends at 1077.9 s on “pace”." });
  // Asked again for the same passage and question, the answer already given comes back, with no second listen.
  expect(await listenFor(ctx, claude.id, ask, 0)).toEqual({ state: "heard", answer: "The first try ends at 1077.9 s on “pace”.", by: { agent: "gemini" } });
  expect(await listenFor(ctx, claude.id, { ...ask, question: " Where does the abandoned first try end? " }, 0)).toMatchObject({ state: "heard" });
  expect(ctx.repos.tasks.select("kind = 'listen_check'")).toHaveLength(1);
  // A different question is a listen of its own.
  await listenFor(ctx, claude.id, { ...ask, question: "Is “which” said whole?" }, 0);
  expect(ctx.repos.tasks.select("kind = 'listen_check'")).toHaveLength(2);
});

it("starts a listen only while its request works, and stops it with the request", async () => {
  const host = hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true }]);
  const claude = request("claude");
  expect(claimTask(ctx, host, claude.id)?.state).toBe("claimed");
  await listenFor(ctx, claude.id, ask, 0);
  const [check] = ctx.repos.tasks.select("kind = 'listen_check'");
  cancelTask(ctx, ctx.repos.tasks.get(claude.id)!);
  expect(ctx.repos.tasks.get(check!.id)?.state).toBe("cancelled");
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])).toBeNull();
});

it("follows the editor's listening setting: one model they picked, or none when off, with no other swapped in", async () => {
  const claude = request("claude");
  hostWith([{ id: "claude", installed: true }, { id: "gemini", installed: true, models: ["gemini-4-neon"] },
    { id: "codex", installed: true, models: ["gpt-6.2-sol", "gpt-6-astra-audio"] }]);
  expect(listenerFor(ctx, claude)).toEqual({ agent: "gemini" });
  ctx.repos.settings.update({ listening: "codex:gpt-6-astra-audio" });
  expect(listenerFor(ctx, claude)).toEqual({ agent: "codex", model: "gpt-6-astra-audio" });
  ctx.repos.settings.update({ listening: "gemini:gemini-4-neon" });
  expect(listenerFor(ctx, claude)).toEqual({ agent: "gemini", model: "gemini-4-neon" });
  // A model that can't hear, or one not signed in, is never used.
  ctx.repos.settings.update({ listening: "codex:gpt-6.2-sol" });
  expect(listenerFor(ctx, claude)).toBeUndefined();
  ctx.repos.settings.update({ listening: "off" });
  expect(listenerFor(ctx, claude)).toBeUndefined();
  expect(await listenFor(ctx, claude.id, ask, 0)).toEqual({ state: "unavailable", reason: "The editor turned listening off." });
});
