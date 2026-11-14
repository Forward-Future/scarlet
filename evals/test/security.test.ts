import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadCase, timelinePath } from "../src/case.ts";
import { buildCase } from "../src/dataset.ts";
import { Engine } from "../src/engine.ts";
import { caseDir, fileComponent, writeChosenJson, writeJson, writeText } from "../src/paths.ts";
import { cut, media } from "./fixtures.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "scarlet-eval-test-"));
  vi.stubEnv("SCARLET_APP_SUPPORT", scratch);
  vi.stubEnv("SCARLET_EVAL_DATA", join(scratch, "evals"));
  vi.stubEnv("SCARLET_ENGINE_URL", "");
  vi.stubEnv("SCARLET_ACCESS_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

it("uses the desktop session pair and requires a separate credential for overrides", async () => {
  const data = join(scratch, "data");
  mkdirSync(data);
  const session = { port: 41000, token: "sct_" + "d".repeat(64) };
  writeFileSync(join(data, "desktop-session.json"), JSON.stringify(session), { mode: 0o600 });
  writeFileSync(join(data, "access-token"), "regular-workspace-fixture", { mode: 0o600 });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  await expect(Engine.connect({ url: "https://alternate.example" })).rejects.toThrow(/both/);
  await expect(Engine.connect({ token: "override" })).rejects.toThrow(/both/);
  await expect(Engine.connect({ url: "http://alternate.example", token: "override" })).rejects.toThrow(/HTTPS/);
  expect(fetch).not.toHaveBeenCalled();
  const desktop = await Engine.connect();
  await desktop.get("/settings");
  expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:41000/api/settings", expect.objectContaining({
    headers: { Authorization: "Bearer " + session.token }, redirect: "error",
  }));
  const alternate = await Engine.connect({ url: "https://alternate.example", token: "override" });
  await alternate.get("/settings");
  expect(fetch).toHaveBeenLastCalledWith("https://alternate.example/api/settings", expect.objectContaining({
    headers: { Authorization: "Bearer override" }, redirect: "error",
  }));
  vi.stubEnv("SCARLET_ENGINE_URL", "https://paired.example");
  vi.stubEnv("SCARLET_ACCESS_TOKEN", "paired");
  fetch.mockClear();
  await expect(Engine.connect({ url: "https://alternate.example" })).rejects.toThrow(/different engine/);
  expect(fetch).not.toHaveBeenCalled();
  expect((await Engine.connect({ url: "https://paired.example/" })).url).toBe("https://paired.example");
  vi.stubEnv("SCARLET_ENGINE_URL", "");
  vi.stubEnv("SCARLET_ACCESS_TOKEN", "");
  if (process.platform !== "win32") {
    chmodSync(join(data, "desktop-session.json"), 0o644);
    await expect(Engine.connect()).rejects.toThrow(/private/);
  }
});

it("keeps versions, manifest IDs and linked outputs inside the operator's selected directory", () => {
  for (const id of [".", "..", "other/case", "other\\case", "C:case", "NUL"]) {
    expect(() => fileComponent(id)).toThrow(/filename/);
  }
  const dir = caseDir("team interview");
  const manifest = join(dir, "case.json");
  writeJson(manifest, { id: "another", dialogueMedia: [] });
  expect(() => loadCase("team interview")).toThrow(/match/);
  writeJson(manifest, { id: "team interview", dialogueMedia: [] });
  writeJson(timelinePath(dir, "v1"), { time: 20 });
  expect(loadCase("team interview").timeline("v1")).toEqual({ time: 20 });
  const outside = join(scratch, "selected-output");
  mkdirSync(outside);
  expect(() => writeText(join(outside, "summary.md"), "report")).toThrow(/leaves/);
  writeText(join(outside, "summary.md"), "report", outside);
  const target = join(outside, "original");
  writeFileSync(target, "original");
  const linked = join(dir, "copy.json");
  linkSync(target, linked);
  writeJson(linked, {});
  expect(readFileSync(target, "utf8")).toBe("original");
  symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => writeJson(join(dir, "linked", "output.json"), {})).toThrow(/Linked/);
  expect(existsSync(join(outside, "output.json"))).toBe(false);
});

it("captures and reloads a published reference under the selected case directory", async () => {
  const recording = media("med_mic", 8);
  const timeline = cut("v1", recording.id, [[0, 8]]);
  const words = Array.from({ length: 8 }, (_, i) => ({ text: `word${i}`, start: i, end: i + 0.5 }));
  const routes = new Map<string, unknown>([
    ["/api/projects/prj_test", { project: { id: "prj_test", media: [recording], settings: { fps: 30 } } }],
    ["/api/skills", { skills: [] }],
    ["/api/projects/prj_test/timeline", { timeline }],
    ["/api/media/med_mic/transcript", { segments: [{ words }] }],
    ["/api/media/med_mic/waveform", { rms: [0] }],
  ]);
  vi.stubGlobal("fetch", async (address: string) => {
    const url = new URL(address);
    if (url.origin !== "https://capture.example" || !routes.has(url.pathname)) throw new Error(`Unexpected fixture route ${url.pathname}`);
    return Response.json(routes.get(url.pathname));
  });
  const engine = new Engine("https://capture.example", "fixture-token");
  const captured = await buildCase(engine, { projectId: "prj_test", sourceVersion: "v1", id: "published case", publishedWords: words });
  expect(captured.dir).toBe(caseDir("published case"));
  const saved = loadCase("published case");
  expect(saved.file.reference?.published?.matchedWords).toBe(words.length);
  expect(saved.timeline("v1")).toEqual(timeline);
  expect(saved.evidence.get(recording.id)?.words).toEqual(words);
});

it("writes a result to the file the operator named, outside the data directory, and still not through a link", () => {
  const chosen = join(scratch, "selected-output", "baseline.json");
  writeChosenJson(chosen, { rows: 1 }, chosen);
  expect(JSON.parse(readFileSync(chosen, "utf8"))).toEqual({ rows: 1 });
  // With no file named, the path is one of Scarlet's own and stays inside the data directory.
  expect(() => writeChosenJson(join(scratch, "elsewhere.json"), {}, undefined)).toThrow(/leaves/);
});
