import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type Note, type Project } from "@scarlet/timeline";
import type { Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
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
async function voice(assignTo?: string, clipIds?: string): Promise<{ status: number; body: Sent }> {
  const form = new FormData();
  form.append("audio", new Blob(["testing"], { type: "audio/wav" }), "voice.wav");
  form.append("time", "1");
  if (assignTo) form.append("assignTo", assignTo);
  if (clipIds !== undefined) form.append("clipIds", clipIds);
  const res = await app.app.request(`/api/projects/${project.id}/notes/voice`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(app.ctx)}` }, body: form,
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
