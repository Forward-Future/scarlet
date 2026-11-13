import { describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "./cli.js";

describe("parseArgs", () => {
  const required = ["--server", "http://localhost:4000", "--project", "prj_1"];

  it("reads flags given as two arguments or as --flag=value", () => {
    expect(parseArgs(["--server", "http://localhost:4000", "--project=prj_1", "--task", "task_9",
      "--agent=codex", "--model", "gpt", "--workdir=/tmp/run"], { SCARLET_TOKEN: "abc" })).toEqual({
      server: "http://localhost:4000", token: "abc", project: "prj_1", task: "task_9", agent: "codex", model: "gpt", workDir: "/tmp/run" });
  });

  it("keeps everything after the first = of an inline value", () => {
    // Base64 padding and a URL's own query both carry more equals signs.
    const opts = parseArgs(["--server=http://localhost:4000/?a=b", "--project=prj_1"], { SCARLET_TOKEN: "dGVzdA==" });
    expect(opts.token).toBe("dGVzdA==");
    expect(opts.server).toBe("http://localhost:4000/?a=b");
    expect(parseArgs([...required, "--model="], {}).model).toBe("");
  });

  it("falls back to the environment, and a flag wins over it", () => {
    const env = { SCARLET_SERVER: "http://engine:4000", SCARLET_TOKEN: "env-token", SCARLET_PROJECT: "prj_env", SCARLET_TASK: "task_env",
      SCARLET_AGENT: "gemini", SCARLET_MODEL: "pro", SCARLET_WORKDIR: "/work" };
    expect(parseArgs([], env)).toEqual({ server: "http://engine:4000", token: "env-token", project: "prj_env", task: "task_env",
      agent: "gemini", model: "pro", workDir: "/work" });
    expect(parseArgs(["--project", "prj_flag", "--workDir", "/elsewhere"], env)).toMatchObject({ project: "prj_flag", workDir: "/elsewhere", token: "env-token" });
  });

  it("rejects workspace tokens on the command line before using them", () => {
    for (const args of [["--token", "fixture"], ["--token=fixture"]]) {
      expect(() => parseArgs([...required, ...args], {})).toThrow("--token-file");
    }
  });

  it("says which of server and project is missing", () => {
    expect(() => parseArgs(["--project", "prj_1"], {})).toThrow("missing --server (or SCARLET_SERVER)");
    expect(() => parseArgs(["--server", "http://localhost:4000"], {})).toThrow("missing --project (or SCARLET_PROJECT)");
  });

  it("treats a flag with no value as set, and never takes the next flag as its value", () => {
    // --task is followed by another flag, so it has no value of its own.
    const opts = parseArgs([...required, "--task", "--agent", "claude"], {});
    expect(opts.task).toBe("true");
    expect(opts.agent).toBe("claude");
    // Arguments that are not flags are ignored.
    expect(parseArgs(["stray", ...required], {})).toMatchObject({ server: "http://localhost:4000", project: "prj_1" });
  });
});

describe("main", () => {
  it("requires the engine to fence task writes and preserves the original launch claim on reconnect", async () => {
    const active = { id: "task", projectId: "project", state: "running", startedAt: "2026-11-01T00:00:00.000Z" };
    let current = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => Response.json(String(input).endsWith("/settings")
      ? { settings: {} } : { task: active, checksTaskAttempts: current }));
    vi.stubEnv("SCARLET_TASK_STARTED_AT", "2026-10-31T00:00:00.000Z");
    try {
      const args = ["--server", "http://localhost:4000", "--project", "project", "--task", "task"];
      await expect(main(args)).rejects.toThrow("Update the Scarlet engine");
      current = true;
      await expect(main(args)).rejects.toThrow("no longer active");
    } finally { fetch.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("prints usage to stderr for --help and connects to nothing", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      // --help wins even when the required flags are missing.
      await main(["--help"]);
      await main(["--server", "http://127.0.0.1:1", "-h"]);
      expect(stderr.mock.calls.map(args => args.join(" "))).toEqual(Array(2).fill(
        "usage: scarlet-mcp --server URL [--token-file PATH] --project ID [--task ID] [--agent claude|codex|gemini] [--model M] [--workdir DIR]"));
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      fetched.mockRestore();
    }
  });

  it("stops before any request when the project is not named", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const env = { server: process.env.SCARLET_SERVER, project: process.env.SCARLET_PROJECT };
    delete process.env.SCARLET_SERVER;
    delete process.env.SCARLET_PROJECT;
    try {
      await expect(main(["--server", "http://127.0.0.1:1"])).rejects.toThrow("missing --project (or SCARLET_PROJECT)");
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
      if (env.server !== undefined) process.env.SCARLET_SERVER = env.server;
      if (env.project !== undefined) process.env.SCARLET_PROJECT = env.project;
    }
  });
});
