import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import type { AgentHost } from "@scarlet/shared";
import { createApp } from "../app.js";
import { claimTask, createTask } from "./tasks.js";

it("claims tuned tasks only on hosts that advertise that model and both options", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "scarlet-routing-"));
  const { ctx } = createApp({ dataDir, env: {}, log: () => {} });
  try {
    const host: AgentHost = {
      id: "host", name: "Test", userId: "user", platform: "test", online: true,
      agents: [{ id: "codex", installed: true, models: ["sample"], modelOptions: {
        sample: { efforts: [{ id: "ultra" }], speeds: [] },
      } }],
    };
    // Separate projects: within one project the untuned request would wait its turn behind the tuned one.
    const input = (name: string) => ({ projectId: ctx.repos.projects.insert(createProject(name)).id, kind: "edit", agent: "codex", model: "sample",
      instruction: "Edit", createdBy: { type: "scarlet", name: "Scarlet" } }) as const;
    const tuned = createTask(ctx, { ...input("Tuned"), effort: "ultra", serviceTier: "priority" });
    const untuned = createTask(ctx, input("Untuned"));
    expect(() => claimTask(ctx, host, tuned.id)).toThrow();
    expect(claimTask(ctx, host)?.id).toBe(untuned.id);
    host.agents[0]!.modelOptions!.sample!.speeds.push({ id: "priority" });
    expect(claimTask(ctx, host)).toMatchObject({ id: tuned.id, effort: "ultra", serviceTier: "priority" });
  } finally {
    await ctx.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
