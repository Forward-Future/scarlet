import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { configPath, loadConfig, requireConfig, sameServer, saveConfig, scarletHome, workRoot } from "./config.js";
import { main } from "./cli.js";

afterEach(() => vi.unstubAllEnvs());

it("replaces old broad permissions and drops credentials on a destination change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-config-"));
  const env = { SCARLET_HOME: dir };
  try {
    await writeFile(configPath(env), "{}", { mode: 0o644 });
    if (process.platform !== "win32") await chmod(dir, 0o755);
    await saveConfig({ server: "http://localhost:4000", token: "test-key", hostId: "h1" }, env);
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
    }
    expect(await loadConfig({ ...env, SCARLET_SERVER: "http://localhost:4000/" })).toMatchObject({ token: "test-key" });
    expect(await loadConfig({ ...env, SCARLET_SERVER: "http://localhost:4001" })).toMatchObject({ token: undefined, hostId: undefined });
    await writeFile(join(dir, "access-token"), "dummy-unrelated-token");
    vi.stubEnv("SCARLET_HOME", dir);
    vi.stubEnv("SCARLET_TOKEN", "another-destination-only");
    vi.stubEnv("SCARLET_SERVER", "");
    const network = vi.spyOn(globalThis, "fetch");
    try {
      await expect(main(["connect", "--server", "http://localhost:4001", "--data", dir])).rejects.toThrow("--token");
      if (!process.stdin.isTTY) await expect(main(["connect", "--server", "http://localhost:4001"])).rejects.toThrow("--token");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("config", () => {
  async function home(): Promise<NodeJS.ProcessEnv> {
    const dir = await mkdtemp(join(tmpdir(), "scarlet-config-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return { SCARLET_HOME: dir };
  }

  it("sameServer compares engines by address, not by how the URL was typed", () => {
    expect(sameServer("http://localhost:4000", "http://LOCALHOST:4000///")).toBe(true);
    expect(sameServer("http://example.com:80/", "http://example.com")).toBe(true);
    expect(sameServer("http://localhost:4000", "http://localhost:4001")).toBe(false);
    expect(sameServer("http://localhost:4000", "https://localhost:4000")).toBe(false);
    expect(sameServer("http://localhost:4000/team-a", "http://localhost:4000/team-b")).toBe(false);
    expect(sameServer(undefined, "http://localhost:4000")).toBe(false);
    expect(sameServer("http://localhost:4000", "")).toBe(false);
  });

  it("keeps everything under SCARLET_HOME, or ~/.scarlet without it", () => {
    expect(scarletHome({})).toBe(join(homedir(), ".scarlet"));
    expect(configPath({ SCARLET_HOME: "/srv/scarlet" })).toBe(join("/srv/scarlet", "agent.json"));
    expect(workRoot({ SCARLET_HOME: "/srv/scarlet" })).toBe(join("/srv/scarlet", "work"));
  });

  it("requireConfig says which of server and token is missing, and names the host after the machine", () => {
    expect(() => requireConfig({})).toThrow("No server configured. Run `scarlet-agent connect --server URL` or set SCARLET_SERVER.");
    expect(() => requireConfig({ server: "http://localhost:4000" })).toThrow("No token configured. Run `scarlet-agent connect` or set SCARLET_TOKEN.");
    expect(requireConfig({ server: "http://localhost:4000", token: "t", maxParallel: 2 })).toEqual({ server: "http://localhost:4000", token: "t", maxParallel: 2, name: hostname() });
    expect(requireConfig({ server: "http://localhost:4000", token: "t", name: "edit-bay" }).name).toBe("edit-bay");
  });

  it("loads from the environment alone when there is no file, and lets the environment's token win over the file's", async () => {
    const env = await home();
    expect(await loadConfig(env)).toEqual({});
    expect(await loadConfig({ ...env, SCARLET_SERVER: "http://localhost:4000", SCARLET_TOKEN: "env-token" })).toEqual({ server: "http://localhost:4000", token: "env-token", hostId: undefined });
    await saveConfig({ server: "http://localhost:4000", token: "file-token", hostId: "h1", stallMinutes: 5 }, env);
    expect(await loadConfig(env)).toEqual({ server: "http://localhost:4000", token: "file-token", hostId: "h1", stallMinutes: 5 });
    expect(await loadConfig({ ...env, SCARLET_TOKEN: "env-token" })).toMatchObject({ token: "env-token", hostId: "h1" });
  });

  it.skipIf(process.platform === "win32")("closes a config file others could read as it loads it", async () => {
    const env = await home();
    await writeFile(configPath(env), JSON.stringify({ server: "http://localhost:4000", token: "t" }), { mode: 0o644 });
    await chmod(configPath(env), 0o644);
    expect(await loadConfig(env)).toMatchObject({ token: "t" });
    expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("refuses a config that is a link or has a second name, so the token is never read from or shared with another file", async () => {
    const real = await home();
    await saveConfig({ server: "http://localhost:4000", token: "t" }, real);

    const linked = await home();
    await symlink(configPath(real), configPath(linked));
    await expect(loadConfig(linked)).rejects.toThrow(/ELOOP|EMLINK/);

    await link(configPath(real), join(real.SCARLET_HOME!, "copy.json"));
    await expect(loadConfig(real)).rejects.toThrow("Expected a private agent config file");
    await rm(join(real.SCARLET_HOME!, "copy.json"));
    expect(await loadConfig(real)).toMatchObject({ token: "t" });
  });
});
