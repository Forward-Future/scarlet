import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ScarletClient } from "@scarlet/shared";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../app.js";
import { accessToken } from "../auth.js";
import { Db, migrate, openDb } from "../db.js";
import { createRepos } from "../repo/index.js";
import { toSegments } from "../transcribe/openai.js";
import { createTask, saveTask } from "./tasks.js";
import { transcriptReader } from "./transcriptReader.js";

it("installs read indexes on a populated library and keeps cached words current across rollback and id reuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-transcript-index-"));
  const db = new Db(join(dir, "scarlet.db"));
  migrate(db);
  const version = db.pragma("user_version", { simple: true });
  const repos = createRepos(db);
  repos.projects.insert({ ...createProject("Legacy transcript"), id: "p" });
  repos.tasks.put({ id: "task", projectId: "p", kind: "edit", agent: "codex", state: "done", context: {}, changeIds: [],
    instruction: "First cut", createdBy: { type: "human", name: "Editor" }, question: null, summary: null, hostId: null });
  const document = (text: string) => ({ id: "t", mediaId: "mic", projectId: "p", segments: [{ id: "s", start: 0, end: 1, text, words: [] }] });
  repos.transcripts.put(document("original"));
  const question = repos.taskEvents.append({ type: "question", id: "q", taskId: "task", at: "2026-01-01T00:00:00.000Z", text: "Keep it?" });
  db.close();

  const { ctx } = createApp({ dataDir: dir, env: {}, log() {} });
  try {
    expect(ctx.db.pragma("user_version", { simple: true })).toBe(version);
    expect(ctx.repos.taskEvents.list("task", "questionsAndAnswers")).toEqual([question]);
    const media = { id: "mic", name: "Mic", path: "mic.wav", kind: "audio" as const, status: "ready" as const, projectId: "p" };
    const reader = transcriptReader(ctx);
    const words = () => reader.read(media, null, null, false)?.segments[0]?.text;
    expect(words()).toBe("original");
    expect(() => ctx.db.transaction(() => {
      ctx.repos.transcripts.put(document("tentative"));
      expect(words()).toBe("tentative");
      throw new Error("roll back");
    })()).toThrow("roll back");
    expect(words()).toBe("original");
    ctx.repos.transcripts.remove("t");
    ctx.repos.transcripts.put(document("replacement"));
    expect(words()).toBe("replacement");
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});

it("searches across segment boundaries with inherited speaker roles and refreshes same-id writes from another engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-search-"));
  const { ctx, app } = createApp({ dataDir: dir, env: {}, log() {} });
  const peer = openDb(ctx.paths.db);
  try {
    const project = ctx.repos.projects.insert(createProject("Search"));
    const media = ctx.repos.projects.putMedia(project.id, { id: "mic", path: "mic.wav", kind: "audio", name: "Mic",
      transcriptId: "t", voiceRoles: { me: 2, other: 3 } }, "ready");
    const transcript = { id: "t", mediaId: media.id, projectId: project.id, segments: [
      // Keep storage order for the transcript, but match its words in time order.
      { id: "second", start: 2, end: 4, text: "next line", words: [] },
      { id: "first", start: 0, end: 2, text: "Here’s", words: [
        { text: "Here’s", start: 1, end: 2, voiceRoleInput: 2, detectedSpeaker: 1 },
      ] },
    ] };
    ctx.repos.transcripts.put(transcript);
    const client = new ScarletClient({ baseUrl: "https://search.local", token: accessToken(ctx), fetch: (url, init) => app.request(url, init) });
    const find = () => client.searchTranscript(media.id, "HERES, next", 1);
    const expected = { segmentCount: 2, wordCount: 3, matches: [{ start: 1, end: 3, speaker: "me", wordIndex: 0,
      text: "Here’s next", context: "[ Here’s next ] line" }] };
    expect(await find()).toEqual(expected);
    expect(await find()).toEqual(expected);
    expect((await client.transcript(media.id, { from: 2, to: 3 })).segments.map(s => s.id)).toEqual(["second"]);
    ctx.repos.projects.putMedia(project.id, { ...media, voiceRoles: { me: 3, other: 2 } }, "ready");
    expect(await find()).toMatchObject({ matches: [{ speaker: "other voices · Speaker 1" }] });
    peer.prepare("UPDATE transcripts SET json = json_set(json, '$.segments[1].words[0].text', 'There') WHERE id = ?").run("t");
    expect(await find()).toEqual({ segmentCount: 2, wordCount: 3, matches: [] });
    expect((await client.transcript(media.id, { from: 0, to: 2 })).segments[0]!.words[0]!.text).toBe("There");
    // A completed rerun links a new transcript while the old document can still be stored.
    ctx.repos.transcripts.put({ ...transcript, id: "replacement" });
    ctx.repos.projects.putMedia(project.id, { ...media, transcriptId: "replacement" }, "ready");
    expect(await find()).toEqual(expected);
    expect((await client.transcript(media.id, { from: 0, to: 2 })).id).toBe("replacement");
    peer.prepare("DELETE FROM transcripts WHERE id = ?").run("replacement");
    await expect(find()).rejects.toMatchObject({ status: 404 });
  } finally { peer.close(); await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});

it("returns an OpenAI word in a range read that covers only where that word falls outside the provider's segments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-openai-range-"));
  const { ctx, app } = createApp({ dataDir: dir, env: {}, log() {} });
  try {
    const project = ctx.repos.projects.insert(createProject("Range"));
    const media = ctx.repos.projects.putMedia(project.id, { id: "mic", path: "mic.wav", kind: "audio", name: "Mic" }, "ready");
    // Spanish isn't word-aligned after transcription, so these are the segments saved. "nació" has no length and
    // starts where the first segment ends, so it goes to the second, which began after a pause; "Lima" comes
    // after the last segment's end.
    const segments = toSegments({ language: "spanish",
      segments: [{ start: 0, end: 8.22, text: "piso 8, nació" }, { start: 8.6, end: 10.2, text: "en 1987" }],
      words: [{ word: "piso", start: 7.02, end: 7.02 }, { word: "8", start: 7.02, end: 7.48 }, { word: "nació", start: 8.22, end: 8.22 },
        { word: "en", start: 8.6, end: 9.16 }, { word: "1987", start: 9.16, end: 9.72 }, { word: "Lima", start: 10.3, end: 10.6 }] }, 0);
    ctx.repos.transcripts.put({ id: "t", mediaId: media.id, projectId: project.id, language: "spanish", segments });
    const client = new ScarletClient({ baseUrl: "https://range.local", token: accessToken(ctx), fetch: (url, init) => app.request(url, init) });
    const read = async (from: number, to: number) =>
      (await client.transcript(media.id, { from, to })).segments.flatMap(s => s.words.map(w => [w.text, w.start, w.end]));
    expect(await read(8.22, 8.6)).toContainEqual(["nació", 8.22, 8.22]);
    expect(await read(10.3, 10.6)).toContainEqual(["Lima", 10.3, 10.6]);
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});

it("releases an event-based status wait on cancellation and reads peer-owned work without waiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-transcribe-wait-"));
  const { ctx, app } = createApp({ dataDir: dir, env: {}, log() {} });
  try {
    const project = ctx.repos.projects.insert(createProject("Wait"));
    const task = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: "Transcribe",
      state: "running", context: { mediaId: "mic" }, createdBy: { type: "scarlet", name: "Scarlet" } });
    const client = new ScarletClient({ baseUrl: "https://status.local", token: accessToken(ctx), fetch: (url, init) => app.request(url, init) });
    expect(await client.waitForTranscription(task.id)).toMatchObject({ task: { state: "running" } });
    ctx.transcriptions.set(task.id, { controller: new AbortController(), done: Promise.resolve(null) });
    const before = ctx.bus.listenerCount("ws");
    const waiting = client.waitForTranscription(task.id);
    await vi.waitFor(() => expect(ctx.bus.listenerCount("ws")).toBe(before + 1));
    saveTask(ctx, { ...task, state: "cancelled" });
    expect(await waiting).toMatchObject({ task: { state: "cancelled" }, waited: true });
    expect(ctx.bus.listenerCount("ws")).toBe(before);
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});
