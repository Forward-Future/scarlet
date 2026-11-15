import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Note, type Project } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { createNote } from "../services/notes.js";
import { storeVersion } from "../services/timeline.js";
import { OpenAIProvider } from "../transcribe/openai.js";
import { voiceForm } from "./notes.js";

let dataDir: string;
let app: ScarletApp;
let project: Project;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-notes-"));
  app = createApp({ dataDir, env: {}, log: () => {} });
  project = app.ctx.repos.projects.insert(createProject("Voice fixture"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

type Sent = { note?: Note; task?: Task; error?: { code: string; message: string } };

/** Send a recording as a voice note: to an agent as a request when `assignTo` is given, otherwise kept as a note. */
async function voice(assignTo?: string, clipIds?: string, signal?: AbortSignal): Promise<{ status: number; body: Sent }> {
  const form = new FormData();
  form.append("audio", new Blob(["testing"], { type: "audio/wav" }), "voice.wav");
  form.append("time", "1");
  if (assignTo) form.append("assignTo", assignTo);
  if (clipIds !== undefined) form.append("clipIds", clipIds);
  const res = await app.app.request(`/api/projects/${project.id}/notes/voice`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(app.ctx)}` }, body: form, signal,
  });
  return { status: res.status, body: await res.json() as Sent };
}

const recordings = () => readdir(app.ctx.paths.notes(project.id));
const saved = () => ({ notes: app.ctx.repos.notes.select().length, tasks: app.ctx.repos.tasks.select("kind != 'learning_check'").length });

it("bounds streamed recordings and metadata before storing a note and keeps both supported clip ID formats", async () => {
  const form = new FormData();
  form.append("audio", new Blob(["fixture audio"]), "test.wav");
  const encoded = new Response(form);
  const raw = new Request("http://localhost/speech", { method: "POST", body: await encoded.arrayBuffer(),
    headers: { "content-type": encoded.headers.get("content-type")!, "content-length": "1" } });
  await expect(voiceForm(raw, 8)).rejects.toMatchObject({ status: 413 });
  expect((await voice(undefined, "x".repeat(65537))).status).toBe(413);
  expect((await voice(undefined, "[1]")).status).toBe(400);
  expect(saved()).toEqual({ notes: 0, tasks: 0 });
  for (const clipIds of ['["one","two"]', "one,two"]) {
    expect((await voice(undefined, clipIds)).body.note?.clipIds).toEqual(["one", "two"]);
  }
});

it("refuses a voice request it has no words for, and still keeps a voice note that isn't sent to an agent", async () => {
  // Transcription is off: there is nothing to send Scarlet, and the recording isn't left behind.
  const off = await voice("claude");
  expect(off.status).toBe(400);
  expect(off.body.error).toMatchObject({ code: "transcription_not_configured", message: expect.stringMatching(/Settings/) });
  expect(saved()).toEqual({ notes: 0, tasks: 0 });
  expect(await recordings()).toEqual([]);

  // A note the editor keeps for themselves has its recording, so the placeholder stands in for the words.
  const kept = await voice();
  expect(kept.status).toBe(201);
  expect(kept.body.note).toMatchObject({ text: "[voice note — transcription not configured]", state: "open" });
  expect(kept.body.task).toBeUndefined();
  expect(await recordings()).toEqual([kept.body.note!.audioPath]);

  // Transcription is on but fails: the same, with the reason.
  app.ctx.env.openaiKey = "unused-fixture";
  app.ctx.repos.settings.update({ transcription: { provider: "openai" } });
  const transcribe = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockRejectedValue(new Error("upstream said no"));
  const failed = await voice("claude");
  expect(failed.status).toBe(400);
  // The provider's own sentence, not wrapped in another.
  expect(failed.body.error).toMatchObject({ code: "transcription_failed", message: "upstream said no" });
  expect(saved()).toEqual({ notes: 1, tasks: 0 });
  expect(await recordings()).toHaveLength(1);
  const keptFailed = await voice();
  expect(keptFailed.status).toBe(201);
  expect(keptFailed.body.note?.text).toBe("[voice note — transcription failed: upstream said no]");
  expect(keptFailed.body.task).toBeUndefined();

  // With words, the request goes to the agent as what was said.
  transcribe.mockResolvedValue({ segments: [{ start: 0, end: 1, text: "Trim the intro" }] });
  const heard = await voice("claude");
  expect(heard.status).toBe(201);
  expect(heard.body.task).toMatchObject({ kind: "note", agent: "claude", instruction: "Trim the intro" });
  expect(saved()).toEqual({ notes: 3, tasks: 1 });
});

it.each(["dictated", "recorded"] as const)("stops cleaning up a %s note once its request is cancelled, and keeps the note as spoken", async kind => {
  const spoken = "um, trim the, uh, intro";
  app.ctx.env.anthropicKey = "unused-fixture";
  app.ctx.env.openaiKey = "unused-fixture";
  app.ctx.repos.settings.update({ transcription: { provider: "openai" }, noteCleanup: { enabled: true, provider: "anthropic" } });
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [{ start: 0, end: 1, text: spoken }] });
  // The cleanup provider takes the request and never answers.
  const asked: Array<AbortSignal | undefined> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    asked.push(init?.signal ?? undefined);
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const request = new AbortController();
  const sent = kind === "recorded" ? voice(undefined, undefined, request.signal) : app.app.request(`/api/projects/${project.id}/notes`, {
    method: "POST", signal: request.signal, body: JSON.stringify({ time: 1, text: spoken, voiceTranscript: spoken }),
    headers: { Authorization: `Bearer ${accessToken(app.ctx)}`, "content-type": "application/json" },
  }).then(async res => ({ status: res.status, body: await res.json() as Sent }));
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  request.abort("Client connection prematurely closed.");
  const answered = await Promise.race([sent, new Promise<string>(resolve => setTimeout(() => resolve("still waiting"), 100))]);
  expect(answered).toMatchObject({ status: 201, body: { note: { text: spoken, voiceTranscript: spoken } } });
  expect(asked[0]?.aborted).toBe(true);
});

/** Cleanup takes each request and waits until the test ends it, with cleaned words or failing. */
function holdCleanup(): Array<{ answer: (text: string) => void; fail: () => void }> {
  app.ctx.env.anthropicKey = "unused-fixture";
  app.ctx.env.openaiKey = "unused-fixture";
  app.ctx.repos.settings.update({ transcription: { provider: "openai" }, noteCleanup: { enabled: true, provider: "anthropic" } });
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [{ start: 0, end: 1, text: spoken }] });
  const asked: Array<{ answer: (text: string) => void; fail: () => void }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    asked.push({ answer: text => resolve(Response.json({ content: [{ type: "text", text }] })), fail: () => reject(new Error("fetch failed")) });
  }));
  return asked;
}

const send = (engine: ScarletApp, method: string, path: string, body?: object) => engine.app.request(`/api${path}`, {
  method, body: body && JSON.stringify(body), headers: { Authorization: `Bearer ${accessToken(engine.ctx)}`, "content-type": "application/json" },
});
const spoken = "um, trim the, uh, intro";
/** A note to Scarlet, dictated or recorded, as the composer sends it. */
const ask = (kind: "dictated" | "recorded", version?: string) => kind === "recorded" ? voice("claude")
  : send(app, "POST", `/projects/${project.id}/notes`, { time: 1, text: spoken, voiceTranscript: spoken, assignTo: "claude", version })
    .then(async res => ({ status: res.status, body: await res.json() as Sent }));
const trash = async (engine = app) => expect((await send(engine, "DELETE", `/projects/${project.id}`)).status).toBe(200);
const removeForGood = async (engine = app) => {
  await trash(engine);
  const { deletedAt } = engine.ctx.repos.projects.listDeleted().find(({ id }) => id === project.id)!;
  expect((await send(engine, "POST", "/storage/cleanup", { kind: "trash", projects: [{ id: project.id, deletedAt }] })).status).toBe(200);
};
/** What the project has in the database, the trash's own entries aside. */
const left = () => {
  const count = (sql: string) => (app.ctx.db.prepare(sql).get(project.id) as { n: number }).n;
  return {
    notes: count("SELECT count(*) AS n FROM notes WHERE project_id = ?"),
    tasks: count("SELECT count(*) AS n FROM tasks WHERE project_id = ?"),
    taskEvents: count("SELECT count(*) AS n FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)"),
    noteActivity: count("SELECT count(*) AS n FROM activity WHERE project_id = ? AND type = 'note.added'"),
  };
};
const nothing = { notes: 0, tasks: 0, taskEvents: 0, noteActivity: 0 };
/** A dictated note has no recording, and a project removed for good has no folder. */
const recordingsLeft = async () => existsSync(app.ctx.paths.notes(project.id)) ? await recordings() : [];

it.each([
  ["dictated", "answers with cleaned words"], ["dictated", "fails"], ["recorded", "answers with cleaned words"], ["recorded", "fails"],
] as const)("refuses a %s note whose project was removed for good while its cleanup ran, as cleanup %s", async (kind, ending) => {
  const asked = holdCleanup();
  const announced: string[] = [];
  app.ctx.bus.on("ws", event => { if (event.type === "note.updated") announced.push(event.note.id); });
  const sent = ask(kind);
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  await removeForGood();
  if (ending === "fails") asked[0]!.fail();
  else asked[0]!.answer("Trim the intro.");
  expect(await sent).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  expect(app.ctx.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(project.id)).toBeUndefined();
  expect(left()).toEqual(nothing);
  expect(announced).toEqual([]);
  // No recording is left behind.
  expect(await recordingsLeft()).toEqual([]);
});

it.each(["dictated", "recorded"] as const)("refuses a %s note whose project went to the Trash while its cleanup ran", async kind => {
  const asked = holdCleanup();
  const sent = ask(kind);
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  await trash();
  asked[0]!.answer("Trim the intro.");
  expect(await sent).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  // As a request sent after the trash would be: nothing waits there for Restore.
  expect(left()).toEqual(nothing);
  expect(await recordingsLeft()).toEqual([]);
});

it.each([
  ["on the version the video was on", false], ["on the earlier version it names", true],
] as const)("keeps a note whose project was trashed and restored while its cleanup ran, %s", async (_, named) => {
  const asked = holdCleanup();
  const store = (end: number) => storeVersion(app.ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end }]), { parent: null }).version;
  const earlier = store(4);
  const sent = ask("dictated", named ? earlier : undefined);
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  const sentOn = named ? earlier : app.ctx.repos.projects.get(project.id)!.head;
  // The video moves on to another version while the note waits.
  const moved = store(2);
  expect((await send(app, "POST", `/projects/${project.id}/versions/${moved}/checkout`)).status).toBe(200);
  await trash();
  expect((await send(app, "POST", `/projects/${project.id}/restore`)).status).toBe(200);
  asked[0]!.answer("Trim the intro.");
  const { status, body } = await sent;
  expect(status).toBe(201);
  expect(body.note).toMatchObject({ text: "Trim the intro.", voiceTranscript: spoken, time: 1, version: sentOn });
  expect(body.task).toMatchObject({ kind: "note", state: "queued", instruction: "Trim the intro.", context: { version: sentOn } });
  expect(app.ctx.repos.projects.get(project.id)!.head).toBe(moved);
  expect(left()).toMatchObject({ notes: 1, noteActivity: 1 });
});

it("refuses every note still waiting on cleanup when another engine instance's connection removes the project for good", async () => {
  const asked = holdCleanup();
  const peer = createApp({ dataDir, env: {}, log: () => {} });
  try {
    const sent = [ask("dictated"), ask("dictated")];
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    // A second engine instance on the same data folder, with its own database connection, empties the Trash.
    await removeForGood(peer);
    asked[0]!.answer("Trim the intro.");
    asked[1]!.fail();
    for (const answered of await Promise.all(sent)) expect(answered).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(left()).toEqual(nothing);
  } finally {
    await peer.ctx.close();
  }
});

it.each([
  ["off", {}], ["set to no provider", { enabled: true, provider: "none" }], ["without a key", { enabled: true, provider: "anthropic" }],
] as const)("refuses a spoken note whose project went to the Trash as it was saved, with cleanup %s", async (_, noteCleanup) => {
  app.ctx.repos.settings.update({ noteCleanup });
  // No provider is asked, but the note still waits a turn for cleanup before it is written.
  const sent = createNote(app.ctx, localUser(app.ctx), project.id, { time: 1, text: spoken, voiceTranscript: spoken, assignTo: "claude" });
  app.ctx.repos.projects.softDelete(project.id);
  await expect(sent).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(left()).toEqual(nothing);
});

it("keeps a reply beside the note, under the name of the agent that gave it", async () => {
  const headers = { Authorization: `Bearer ${accessToken(app.ctx)}`, "content-type": "application/json" };
  const created = await app.app.request(`/api/projects/${project.id}/notes`, { method: "POST", headers,
    body: JSON.stringify({ time: 1, text: "Cut a bit more, the breath is still there." }) });
  const { note } = await created.json() as { note: Note };
  // The agent works through the editor's own sign-in, and says who it is.
  const reply = (body: object) => app.app.request(`/api/notes/${note.id}/reply`, { method: "POST", headers, body: JSON.stringify(body) });
  const agent = { type: "agent", id: "claude", name: "claude", model: "opus" };
  const replied = await (await reply({ text: "Extended this cut by 0.6 s.", author: agent })).json() as { note: Note };
  // The note's text is still the editor's words alone: it is what the request it was sent as is matched by.
  expect(replied.note.text).toBe("Cut a bit more, the breath is still there.");
  expect(replied.note.replies).toMatchObject([{ text: "Extended this cut by 0.6 s.", author: agent }]);
  // A reply with no author named is the signed-in person's own.
  const own = await (await reply({ text: "Leave it there." })).json() as { note: Note };
  expect(own.note.replies?.map(r => [r.author.type, r.text])).toEqual([["agent", "Extended this cut by 0.6 s."], ["human", "Leave it there."]]);
});
