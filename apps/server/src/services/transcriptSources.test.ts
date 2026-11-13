import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProject, type MediaAsset, type Transcript } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { ffmpeg } from "../render/ffmpeg.js";
import { measureSources, readSourceEnergy, savedVoiceLabels, sourceLabels, transcriptSourceReader, wordSource } from "./transcriptSources.js";

let directory: string;
let workspace: ScarletApp;
let projectId: string;
const lines: string[] = [];
const never = new AbortController().signal;
const tone = (hz: number, when: string) => `0.3*sin(2*PI*${hz}*t)*(${when})`;
// The host speaks for the first second, the guest for the second, and both in the third.
const host = tone(440, "lt(t\\,1)+gte(t\\,2)"), guest = tone(880, "gte(t\\,1)");

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-transcript-sources-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => lines.push(line) });
  projectId = workspace.ctx.repos.projects.insert(createProject("Podcast")).id;
  workspace.ctx.paths.ensureProject(projectId);
  const media = workspace.ctx.paths.media(projectId);
  const source = (expr: string) => ["-f", "lavfi", "-i", `aevalsrc=${expr}:d=3:s=8000`];
  // A recorder's file: each microphone on its own stream, and their mix between them.
  await ffmpeg([...source(host), ...source(`${host}+${guest}`), ...source(guest), "-map", "0:a", "-map", "1:a", "-map", "2:a", "-c:a", "pcm_s16le",
    "-metadata:s:a:0", "title=Host mic", "-metadata:s:a:2", "title=  Guest  ", "-y", join(media, "podcast.mka")]);
  await ffmpeg([...source(host), "-c:a", "pcm_s16le", "-y", join(media, "single.wav")]);
  writeFileSync(join(media, "broken.mka"), "this is not a recording");
});
afterAll(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

const recording = (extra: Partial<MediaAsset> = {}): MediaAsset => ({ id: "podcast", kind: "audio", name: "Podcast", path: "podcast.mka", duration: 3, ...extra });
const words = (...spans: Array<[number, number]>) => spans.map(([start, end], i) => ({ text: `w${i}`, start, end }));
const transcript = (...spans: Array<[number, number]>): Transcript => ({ id: "trn_1", mediaId: "podcast",
  segments: [{ id: "seg_1", start: 0, end: 3, text: "", words: words(...spans) }] });
const sourcesOf = (t: Transcript) => t.segments.flatMap(s => s.words.map(w => w.audioSource));

it("identifies a mix of independently active inputs and abstains on overlap, silence and duplicates", () => {
  const pcm = Buffer.alloc(6400 * 6);
  for (let i = 0; i < 6400; i++) {
    const a = i < 3200 && i >= 1600 ? 0 : i < 4800 ? Math.round(Math.sin(i / 3) * 8000) : 0;
    const b = i >= 1600 && i < 4800 ? Math.round(Math.cos(i / 5) * 8000) : 0;
    pcm.writeInt16LE(a, i * 6);
    pcm.writeInt16LE(a + b, i * 6 + 2);
    pcm.writeInt16LE(b, i * 6 + 4);
  }
  const { mix, energy } = measureSources(pcm);
  expect(mix).toBe(1);
  expect(wordSource(energy, 5, mix!, 5, 5.18)).toBe(0);
  expect(wordSource(energy, 5, mix!, 5.22, 5.38)).toBe(2);
  expect(wordSource(energy, 5, mix!, 5.42, 5.58)).toBeUndefined();
  expect(wordSource(energy, 5, mix!, 5.62, 5.79)).toBeUndefined();
  for (let i = 0; i < 6400; i++) { pcm.writeInt16LE(pcm.readInt16LE(i * 6), i * 6 + 2); pcm.writeInt16LE(0, i * 6 + 4); }
  expect(measureSources(pcm).mix).toBeUndefined();
});

it("names a recorder's three synchronized streams, and finds nothing to compare in any other file", async () => {
  const media = workspace.ctx.paths.media(projectId);
  // A stream with no title is named for its place. Titles lose their padding.
  expect(await sourceLabels(join(media, "podcast.mka"), never)).toEqual(["Host mic", "Track 2", "Guest"]);
  expect(await sourceLabels(join(media, "single.wav"), never)).toEqual([]);
  await expect(sourceLabels(join(media, "broken.mka"), never)).rejects.toThrow(/exited with code/);
});

it("finds which stream is the mix of the other two from the recording itself", async () => {
  const file = join(workspace.ctx.paths.media(projectId), "podcast.mka");
  const whole = await readSourceEnergy(file, 0, 3, never);
  expect(whole.mix).toBe(1);
  // 20 ms blocks: three seconds of them, less a few at the end that ffmpeg's join doesn't always give.
  expect(whole.energy.length).toBeGreaterThan(140);
  expect(whole.energy.length).toBeLessThanOrEqual(150);
  // Only the guest speaks in the second second, so nothing there shows which stream is a mix.
  expect((await readSourceEnergy(file, 1.2, 1.8, never)).mix).toBeUndefined();
});

it("marks each word of a transcript page with the microphone it came from, and leaves overlapping speech unmarked", async () => {
  const read = transcriptSourceReader(workspace.ctx);
  const page = transcript([0.2, 0.6], [1.2, 1.6], [2.2, 2.6], [5, 5.4]);
  const marked = await read(projectId, recording(), page, 0, 3);
  expect(sourcesOf(marked)).toEqual(["Host mic", "Guest", undefined, undefined]);
  expect(marked.segments[0]!.words[0]).toEqual({ text: "w0", start: 0.2, end: 0.6, audioSource: "Host mic" });
  // The page itself is not changed.
  expect(sourcesOf(page)).toEqual([undefined, undefined, undefined, undefined]);
  // Once the editor has said which input is theirs, the words say whose voice it is.
  const confirmed = await read(projectId, recording({ voiceRoles: { me: 3, other: 1 } }), page, 0, 3);
  expect(sourcesOf(confirmed)).toEqual(["other voices", "me", undefined, undefined]);
  // A page where only one of them speaks is read with the mix found on an earlier page of the same file.
  expect(sourcesOf(await read(projectId, recording(), transcript([1.2, 1.6]), 1.1, 1.9))).toEqual(["Guest"]);
  // A reader that has seen no such page falls back on the inputs the editor confirmed, and without them marks nothing.
  const fresh = transcriptSourceReader(workspace.ctx);
  expect(sourcesOf(await fresh(projectId, recording(), transcript([1.2, 1.6]), 1.1, 1.9))).toEqual([undefined]);
  expect(sourcesOf(await fresh(projectId, recording({ voiceRoles: { me: 3, other: 1 } }), transcript([1.2, 1.6]), 1.1, 1.9))).toEqual(["me"]);
});

it("returns the page as it was for a range it doesn't read, or a file with nothing to compare", async () => {
  const read = transcriptSourceReader(workspace.ctx);
  const page = transcript([0.2, 0.6]);
  expect(await read(projectId, recording(), page, -1, 2)).toBe(page);
  expect(await read(projectId, recording(), page, 2, 2)).toBe(page);
  // A page ends where the recording does, so one that starts past its end is empty.
  expect(await read(projectId, recording(), page, 3, 10)).toBe(page);
  expect(await read(projectId, recording({ duration: 600 }), page, 0, 61)).toBe(page);
  const silent = { ...page, segments: [] };
  expect(await read(projectId, recording(), silent, 0, 3)).toBe(silent);
  expect(await read(projectId, recording({ path: "single.wav" }), page, 0, 3)).toBe(page);
  expect(await read(projectId, recording({ path: "gone.mka" }), page, 0, 3)).toBe(page);
  expect(await read(projectId, recording({ path: "../../outside.mka" }), page, 0, 3)).toBe(page);
  expect(lines.filter(line => line.startsWith("[media]"))).toEqual([]);
});

it("returns the page as it was when the recording can't be read, and says why once", async () => {
  const read = transcriptSourceReader(workspace.ctx);
  const page = transcript([0.2, 0.6]);
  lines.length = 0;
  const broken = recording({ id: "broken", path: "broken.mka" });
  expect(await read(projectId, broken, page, 0, 3)).toBe(page);
  expect(await read(projectId, broken, page, 0, 2)).toBe(page);
  expect(lines).toEqual([expect.stringMatching(/^\[media\] broken couldn’t tell which input each word came from: .*exited with code/)]);
  // A page someone asked for is read while the project's media work is paused: a running edit reads these, and
  // pausing the caching doesn't stop it.
  lines.length = 0;
  workspace.ctx.repos.projects.update(projectId, { mediaPaused: true });
  try {
    expect(sourcesOf(await transcriptSourceReader(workspace.ctx)(projectId, recording(), page, 0, 3))).toEqual(["Host mic"]);
  } finally { workspace.ctx.repos.projects.update(projectId, { mediaPaused: false }); }
  // Work stopped because the project went to Trash is not a failure.
  workspace.ctx.repos.projects.softDelete(projectId);
  try {
    expect(await transcriptSourceReader(workspace.ctx)(projectId, recording(), page, 0, 3)).toBe(page);
  } finally { workspace.ctx.repos.projects.restore(projectId); }
  expect(lines).toEqual([]);
});

it("labels the words of a saved transcript by the inputs the editor confirmed", () => {
  const saved: Transcript = { id: "trn_1", mediaId: "podcast", segments: [{ id: "seg_1", start: 0, end: 3, text: "", words: [
    { text: "hi", start: 0, end: 0.2, voiceRoleInput: 1 },
    { text: "hello", start: 0.3, end: 0.5, voiceRoleInput: 3, detectedSpeaker: 2 },
    { text: "there", start: 0.6, end: 0.8, voiceRoleInput: 3 },
    { text: "both", start: 1, end: 1.2, voiceRoleInput: 2, speaker: "stale", audioSource: "stale" },
    { text: "plain", start: 1.3, end: 1.5, speaker: "Speaker 1" },
  ] }] };
  expect(savedVoiceLabels(saved)).toBe(saved);
  const labelled = savedVoiceLabels(saved, { me: 1, other: 3 }).segments[0]!.words;
  expect(labelled.map(w => [w.speaker, w.audioSource])).toEqual([
    ["me", "me"],
    ["other voices · Speaker 2", "other voices"],
    ["other voices", "other voices"],
    // The mix is nobody's input, so a label from an earlier choice is cleared.
    [undefined, undefined],
    ["Speaker 1", undefined],
  ]);
});
