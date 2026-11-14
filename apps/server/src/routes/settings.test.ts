import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ServerSettings } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { importTranscriptionPolicy } from "../transcribe/index.js";

let dataDir: string;
let app: ScarletApp;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-settings-"));
  app = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
});
afterEach(async () => {
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Save settings as the Settings page does: the patch goes over the wire as JSON. */
async function save(patch: unknown): Promise<{ status: number; settings: ServerSettings }> {
  const res = await app.app.request("/api/settings", {
    method: "PATCH", headers: { Authorization: `Bearer ${accessToken(app.ctx)}`, "content-type": "application/json" }, body: JSON.stringify(patch),
  });
  return { status: res.status, settings: (await res.json() as { settings: ServerSettings }).settings };
}

const status = async () => (await app.app.request("/api/settings/local-model", { headers: { Authorization: `Bearer ${accessToken(app.ctx)}` } })).json();

it("clears a field sent as null, and keeps one the patch leaves out", async () => {
  await save({ transcription: { provider: "openai", language: "fr" }, noteCleanup: { enabled: true, provider: "anthropic", model: "claude-haiku-4-5" } });
  // JSON leaves an undefined field out of the patch, so nothing says to change it.
  const kept = await save({ transcription: { openaiModel: "whisper-1", language: undefined } });
  expect(kept.settings.transcription.language).toBe("fr");

  const cleared = await save({ transcription: { language: null }, noteCleanup: { model: null } });
  expect(cleared.status).toBe(200);
  expect(cleared.settings.transcription).toEqual({ provider: "openai", openaiModel: "whisper-1" });
  expect(cleared.settings.noteCleanup).toEqual({ enabled: true, provider: "anthropic" });
  // Cleared in what is stored too: transcription reads it from there, and so does the next launch.
  expect(app.ctx.settings().transcription.language).toBeUndefined();
  const stored = JSON.parse((app.ctx.db.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string }).json);
  expect(stored.transcription).not.toHaveProperty("language");
  expect(stored.noteCleanup).not.toHaveProperty("model");
});

it("says whether the speech model the editor pointed to is there, and otherwise where Scarlet's own stands", async () => {
  expect(await status()).toEqual({ selected: "crisperwhisper", state: "missing", fallback: false, reason: expect.stringContaining("unavailable") });
  app.ctx.whisperCli = process.execPath;
  expect(await status()).toEqual({ ...await app.ctx.whisperModel.status(), selected: "crisperwhisper", active: "whispercpp",
    fallback: true, reason: expect.stringContaining("bundled Whisper") });

  const model = join(dataDir, "ggml-custom.bin");
  await save({ transcription: { whisperModelPath: model } });
  const missing = { state: "missing", selected: "custom", fallback: false, reason: expect.stringContaining("model file") };
  expect(await status()).toEqual(missing);
  // A file that was created and never filled is as good as missing, and so is a folder of that name.
  await writeFile(model, "");
  expect(await status()).toEqual(missing);
  await save({ transcription: { whisperModelPath: dataDir } });
  expect(await status()).toEqual(missing);
  await writeFile(model, "weights");
  await save({ transcription: { whisperModelPath: model } });
  expect(await status()).toEqual({ state: "ready", selected: "custom", active: "custom", fallback: false });
  await save({ transcription: { provider: "whispercpp", whisperCppPath: join(dataDir, "missing-cli") } });
  expect(await status()).toEqual({ state: "missing", selected: "custom", fallback: false, reason: expect.stringContaining("executable") });
  expect(await (await app.app.request("/api/settings", { headers: { Authorization: `Bearer ${accessToken(app.ctx)}` } })).json())
    .toMatchObject({ transcriptionAvailable: false, transcriptionIssue: expect.stringContaining("executable") });
  await save({ transcription: { localModel: "custom", whisperCppPath: null, whisperModelPath: null } });
  expect(await status()).toEqual({ state: "missing", selected: "custom", fallback: false, reason: expect.stringContaining("Choose") });
  await save({ transcription: { whisperCppPath: process.execPath } });
  expect(await status()).toEqual({ state: "ready", selected: "custom", active: "custom", fallback: false });
  await save({ transcription: { localModel: null } });
  await save({ render: { concurrency: 3 } });
  expect(app.ctx.settings().transcription.localModel).toBeUndefined();
  expect(await status()).toEqual({ state: "missing", selected: "custom", active: "custom", fallback: false });
});

it("waits for a CrisperWhisper runtime under repair and discovers it when setup finishes", async () => {
  const base = join(dataDir, "models", "crisperwhisper");
  const python = join(base, "venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
  const model = join(base, "model", "model.safetensors");
  for (const file of [python, join(base, "crisper_cli.py"), model]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "fixture", { mode: 0o700 });
  }
  const building = join(base, ".building-venv");
  await writeFile(building, "");
  await app.ctx.close();
  app = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
  expect(app.ctx.settings().transcription.provider).toBe("none");
  expect(await status()).toMatchObject({ state: "missing", fallback: false, reason: expect.stringContaining("setup is in progress") });
  expect((await importTranscriptionPolicy(app.ctx)).provider).toBeUndefined();
  await rm(building);
  expect(app.ctx.settings().transcription.provider).toBe("whispercpp");
  expect((await importTranscriptionPolicy(app.ctx)).provider).toBe("whispercpp");
  expect(await status()).toEqual({ state: "ready", selected: "crisperwhisper", active: "crisperwhisper", fallback: false });
  await save({ transcription: { whisperCppPath: join(base, process.platform === "win32" ? "crisper-cli.exe" : "crisper-cli"), whisperModelPath: model } });
  expect(await status()).toMatchObject({ selected: "crisperwhisper", active: "crisperwhisper" });
  app.ctx.whisperCli = process.execPath;
  await writeFile(building, "");
  expect(await status()).toMatchObject({ active: "whispercpp", fallback: true, reason: expect.stringContaining("setup is in progress") });
  await rm(building);
  expect(await status()).toMatchObject({ active: "crisperwhisper", fallback: false });
  await save({ transcription: { localModel: "custom" } });
  expect(await status()).toMatchObject({ state: "missing", selected: "custom" });
});

it("revokes queued local work after the model changes, including changes made by another engine", async () => {
  const peer = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
  try {
    await save({ transcription: { provider: "whispercpp" } });
    const initial = app.ctx.repos.settings.transcriptionPolicy();
    peer.ctx.repos.settings.update({ transcription: { localModel: "custom", whisperModelPath: "one.bin" } });
    peer.ctx.repos.settings.update({ transcription: { whisperModelPath: "two.bin" } });
    peer.ctx.repos.settings.update({ transcription: { whisperModelPath: "one.bin" } });
    const updated = app.ctx.repos.settings.transcriptionPolicy();
    expect(updated.revision).toBe(initial.revision + 3);
    expect(initial.signal.aborted).toBe(true);
    expect(updated.signal.aborted).toBe(false);
    await save({ render: { concurrency: 3 } });
    expect(app.ctx.repos.settings.transcriptionPolicy().signal).toBe(updated.signal);
  } finally { await peer.ctx.close(); }
});

it("says why nothing can transcribe, so Media can offer the fix", async () => {
  const settings = async () => (await app.app.request("/api/settings", { headers: { Authorization: `Bearer ${accessToken(app.ctx)}` } })).json();
  // A library first opened where no local runtime was found starts off, and says what is missing.
  const missing = "CrisperWhisper is not installed. The bundled Whisper runtime is unavailable.";
  expect(await settings()).toMatchObject({ transcriptionAvailable: false, transcriptionIssue: missing });
  await save({ transcription: { provider: "whispercpp" } });
  expect(await settings()).toMatchObject({ transcriptionAvailable: false, transcriptionIssue: "CrisperWhisper is not installed. The bundled Whisper runtime is unavailable." });
  await save({ transcription: { provider: "openai" } });
  expect(await settings()).toMatchObject({ transcriptionAvailable: false, transcriptionIssue: "OpenAI transcription needs an API key." });
  await save({ transcription: { provider: "whispercpp" } });
  app.ctx.whisperCli = process.execPath;
  const ready = await settings();
  expect(ready).toMatchObject({ transcriptionAvailable: true });
  expect(ready).not.toHaveProperty("transcriptionIssue");
});
