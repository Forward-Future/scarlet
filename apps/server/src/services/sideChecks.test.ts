import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentHost as Host } from "@scarlet/agent";
import { createProject } from "@scarlet/timeline";
import { isSideCheck, ScarletClient, sideCheckSlots, type AgentHost, type Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import type { Ctx } from "../context.js";
import { claimTask, createTask } from "./tasks.js";

let dataDir: string;
let workspace: ScarletApp;
let ctx: Ctx;
const host: AgentHost = { id: "host", name: "Test", userId: "user", platform: "test", online: true, agents: [{ id: "gemini", installed: true }] };
const by = { type: "scarlet", name: "Scarlet" } as const;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-side-checks-"));
  workspace = createApp({ dataDir, env: {}, log: () => {} });
  ({ ctx } = workspace);
});
afterEach(async () => {
  await ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

const project = (name: string) => ctx.repos.projects.insert(createProject(name)).id;
const edit = (projectId: string) => createTask(ctx, { projectId, kind: "edit", agent: "gemini", instruction: "Cut the dialogue", createdBy: by });
const areaCheck = (asker: Task, at: number) => createTask(ctx, { projectId: asker.projectId, kind: "area_check", agent: "gemini",
  instruction: `What viewers may see at ${at} s`, context: { checksTaskId: asker.id, areaCheck: { mediaId: "med_screen", at } }, createdBy: by });
const learningCheck = (asker: Task) => createTask(ctx, { projectId: asker.projectId, kind: "learning_check", agent: "gemini",
  instruction: "Cut the dialogue", context: { checksTaskId: asker.id }, createdBy: by });

it("hands side checks only to check slots and requests only to request slots, for a host that sends both", () => {
  const running = edit(project("Screen demo"));
  expect(claimTask(ctx, host, running.id)?.state).toBe("claimed");
  const first = areaCheck(running, 155), second = areaCheck(running, 420);
  const waiting = edit(project("Interview"));
  // The edit holds the only request slot: its checks still start, in slots of their own.
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])?.id).toBe(first.id);
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])?.id).toBe(second.id);
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])).toBeNull();
  // A free request slot never takes a check, and a free check slot never takes a request.
  const third = areaCheck(running, 685);
  expect(claimTask(ctx, host, undefined, ["gemini"], undefined, [])?.id).toBe(waiting.id);
  expect(claimTask(ctx, host, undefined, ["gemini"], undefined, [])).toBeNull();
  expect(claimTask(ctx, host, undefined, ["gemini"], undefined, ["gemini"])?.id).toBe(third.id);
});

it("counts a learning check as a side check, and a skill edit as a request", () => {
  const asker = edit(project("Interview"));
  const check = learningCheck(asker);
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])?.id).toBe(check.id);
  // The asker itself is a request.
  expect(claimTask(ctx, host, undefined, [], undefined, ["gemini"])).toBeNull();
  expect(claimTask(ctx, host, undefined, ["gemini"], undefined, [])?.id).toBe(asker.id);
});

it("claims every kind from a host that sends no check slots, as before, with a running request's area checks first", () => {
  const older = edit(project("Interview"));
  const queuedAsker = edit(project("Podcast"));
  const idle = areaCheck(queuedAsker, 30);
  const running = edit(project("Screen demo"));
  expect(claimTask(ctx, host, running.id)?.state).toBe("claimed");
  const urgent = areaCheck(running, 155);
  // The running edit waits on `urgent`, so it goes ahead of older work; the rest keep their order.
  expect(claimTask(ctx, host)?.id).toBe(urgent.id);
  expect(claimTask(ctx, host)?.id).toBe(older.id);
  expect(claimTask(ctx, host)?.id).toBe(queuedAsker.id);
  expect(claimTask(ctx, host)?.id).toBe(idle.id);
  expect(claimTask(ctx, host)).toBeNull();
});

it("finds nothing for a host with no free slot of either kind", () => {
  const asker = edit(project("Interview"));
  areaCheck(asker, 10);
  expect(claimTask(ctx, host, undefined, [], undefined, [])).toBeNull();
  // A runtime the host doesn't have is no free slot.
  expect(claimTask(ctx, host, undefined, ["claude"], undefined, ["claude"])).toBeNull();
});

/**
 * The engine and a real agent host, with a runner that stands in for the CLI: an edit that waits for its area checks
 * before it finishes, as a save does, beside another project's edit. What ran at once is counted by kind.
 */
async function runOnHost(maxParallel: number, checks: number) {
  const screen = project("Screen demo");
  ctx.repos.projects.putMedia(screen, { id: "med_screen", name: "Screen", kind: "video", path: "screen.mov" }, "ready");
  const asker = edit(screen);
  const asked = Array.from({ length: checks }, (_, i) => areaCheck(asker, 30 + i * 200));
  const other = edit(project("Interview"));
  const done = new Set<string>();
  const now = { requests: 0, checks: 0 }, most = { requests: 0, checks: 0, together: 0 };
  const checksDone = Promise.withResolvers<void>();
  const client = new ScarletClient({ baseUrl: "http://127.0.0.1:4000", token: accessToken(ctx),
    fetch: (url, init) => workspace.app.fetch(new Request(url, init)) });
  const workRoot = await mkdtemp(join(tmpdir(), "scarlet-side-host-"));
  const host = new Host({
    client, workRoot, mcpCliPath: "fake-mcp.js", ws: false, heartbeatMs: 60_000, claimWaitSeconds: 1, idlePollMs: 10, log: () => {},
    config: { server: "http://127.0.0.1:4000", token: accessToken(ctx), name: "test-host", maxParallel },
    detect: async () => [{ id: "gemini", installed: true, loggedIn: true }],
    runner: async (opts) => {
      const id = opts.mcp.env.SCARLET_TASK!;
      const pool = isSideCheck(ctx.repos.tasks.get(id)!) ? "checks" : "requests";
      now[pool]++;
      most[pool] = Math.max(most[pool], now[pool]);
      most.together = Math.max(most.together, now.requests + now.checks);
      try {
        if (id === asker.id) await checksDone.promise;
        else await new Promise(resolve => setTimeout(resolve, pool === "checks" ? 60 : 20));
      } finally {
        now[pool]--;
      }
      done.add(id);
      if (asked.every(check => done.has(check.id))) checksDone.resolve();
      return { ok: true, summary: "" };
    },
  });
  const started = Date.now();
  const running = host.start();
  try {
    const all = [asker, ...asked, other].map(task => task.id);
    for (let waited = 0; !all.every(id => done.has(id)); waited += 25) {
      if (waited > 20_000) throw new Error(`stalled with ${all.filter(id => !done.has(id)).length} of ${all.length} runs left`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { most, ms: Date.now() - started };
  } finally {
    await host.stop();
    await running;
    await rm(workRoot, { recursive: true, force: true });
  }
}

it("runs an edit's checks beside it on a real host, never past either pool's limit, and finishes", { timeout: 30_000 }, async () => {
  const { most } = await runOnHost(3, 14);
  expect(most.checks).toBe(sideCheckSlots(3));
  expect(most.requests).toBeLessThanOrEqual(3);
  expect(most.together).toBeLessThanOrEqual(3 + sideCheckSlots(3));
});

it("still finishes when the edit holds its runtime's only request slot", { timeout: 30_000 }, async () => {
  // Sharing slots, the edit would wait for checks that could never start.
  const { most } = await runOnHost(1, 5);
  expect(most.requests).toBe(1);
  expect(most.checks).toBe(sideCheckSlots(1));
});
