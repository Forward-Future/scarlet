import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackAdapter } from "../render/adapter.js";
import * as ffmpeg from "../render/ffmpeg.js";
import { OpenAIProvider, toSegments } from "./openai.js";
import type { TranscribeResult } from "./index.js";

it("applies the chunk offset once to a transcript containing only words", () => {
  const [segment] = toSegments({ text: "Hello", words: [{ word: "Hello", start: 2, end: 3 }] }, 600);
  expect(segment).toMatchObject({ start: 602, end: 603, words: [{ start: 602, end: 603 }] });
});

it("gives each segment the words said before it ends, and the last segment any that are left", () => {
  const words = [["So", 0.2, 0.5], [" here", 0.5, 1], ["we", 1.2, 1.5], ["go.", 1.9995, 2.4], ["Late", 2.6, 3]]
    .map(([word, start, end]) => ({ word: word as string, start: start as number, end: end as number }));
  const segments = toSegments({ segments: [{ start: 0, end: 1.1, text: " So here " }, { start: 1.1, end: 2, text: "we go." }], words }, 10);
  expect(segments.map(s => [s.start, s.end, s.text, s.words.map(w => w.text)])).toEqual([
    [10, 11.1, "So here", ["So", "here"]],
    // A word that starts within a millisecond of the segment's end belongs to what follows, and the segment
    // runs on to the end of the last word it holds.
    [11.1, 13, "we go.", ["we", "go.", "Late"]],
  ]);
  expect(segments[1]!.words[0]).toEqual({ text: "we", start: 11.2, end: 11.5 });
  expect(segments[1]!.words.slice(1)).toEqual([{ text: "go.", start: 11.9995, end: 12.4 }, { text: "Late", start: 12.6, end: 13 }]);
  // Times before the recording starts are held at its start, and a segment never ends before it begins.
  const [early] = toSegments({ segments: [{ start: 5, end: 4, text: "x" }], words: [{ word: "x", start: -2, end: -1 }] }, 1);
  expect(early).toMatchObject({ start: 0, end: 6, words: [{ text: "x", start: 0, end: 0 }] });
  expect(toSegments({}, 0)).toMatchObject([{ start: 0, end: 0, text: "", words: [] }]);
});

it("starts a segment at the first word it holds when that word came before the segment's own start", () => {
  // As OpenAI timed a Spanish recording: the first segment's last word has no length and ends with it, so it
  // starts at that segment's end and goes to the next segment, which began after a pause.
  const segments = toSegments({ language: "spanish", segments: [{ start: 0, end: 8.22, text: "piso 8, nació" }, { start: 8.6, end: 10.2, text: "en 1987" }],
    words: [{ word: "piso", start: 7.02, end: 7.02 }, { word: "8", start: 7.02, end: 7.48 }, { word: "nació", start: 8.22, end: 8.22 },
      { word: "en", start: 8.6, end: 9.16 }, { word: "1987", start: 9.16, end: 9.72 }] }, 0);
  expect(segments.map(s => [s.start, s.end, s.words.map(w => [w.text, w.start, w.end])])).toEqual([
    [0, 8.22, [["piso", 7.02, 7.02], ["8", 7.02, 7.48]]],
    [8.22, 10.2, [["nació", 8.22, 8.22], ["en", 8.6, 9.16], ["1987", 9.16, 9.72]]],
  ]);
});

describe("OpenAI transcription", () => {
  let dir: string;
  /** What each upload held: its form fields, and the seconds of audio in its file. */
  let uploads: Array<{ url: string; key: string | null; fields: Record<string, string[]>; file: string; bytes: number }>;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-openai-")); uploads = []; });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

  const provider = (opts: { language?: string; baseUrl?: string; log?: (line: string) => void } = {}) => new OpenAIProvider({ apiKey: "key-for-tests", model: "whisper-1", ...opts });
  /** The API as these tests need it: it answers each upload in turn, and rejects audio under a tenth of a second. */
  function api(...answers: Array<object | Response>) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const fields: Record<string, string[]> = {};
      for (const [name, value] of form.entries()) if (typeof value === "string") (fields[name] ??= []).push(value);
      uploads.push({ url, key: new Headers(init.headers).get("authorization"), fields, file: file.name, bytes: file.size });
      if (file.size < 78 + 3200) return new Response(JSON.stringify({ error: { message: "Audio file is too short. Minimum audio length is 0.1 seconds." } }), { status: 400 });
      const answer = answers[uploads.length - 1] ?? {};
      return answer instanceof Response ? answer : Response.json(answer);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  /** Decodes stand in for FFmpeg: each chunk gets as much audio as the recording has from its start, up to ten minutes. */
  function decodes(audioSeconds: number) {
    return vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_input, output, opts = {}) => {
      const seconds = Math.max(0, Math.min(opts.duration ?? Infinity, audioSeconds - (opts.start ?? 0)));
      // A 78-byte header as FFmpeg writes it, then silence. A minute here is a few bytes, enough to tell chunks apart.
      const decoded = Buffer.alloc(78 + (seconds >= 0.1 ? 3200 + Math.round(seconds) : Math.round(seconds * 32000)));
      decoded.write("RIFF", 0, "ascii");
      await writeFile(output, decoded);
    });
  }

  it("uploads a long recording's audio in ten-minute chunks and puts every word at its time in the recording", async () => {
    const decode = decodes(1300);
    const fetchMock = api(
      { language: "english", segments: [{ start: 0, end: 4, text: " First." }], words: [{ word: "First.", start: 1, end: 2 }] },
      { language: "spanish", segments: [{ start: 3, end: 5, text: "Second." }], words: [{ word: "Second.", start: 3, end: 4 }] },
      { text: "Third.", words: [{ word: "Third.", start: 50, end: 51 }] });
    const progress: number[] = [];
    const beforeUpload = vi.fn(() => { expect(fetchMock).toHaveBeenCalledTimes(beforeUpload.mock.calls.length - 1); });
    const result = await provider({ language: "en", baseUrl: "http://127.0.0.1:9/v1" })
      .transcribe({ path: "talk.mov", duration: 1300, tmpDir: dir, beforeUpload, onProgress: fraction => progress.push(fraction) });
    expect(decode.mock.calls.map(([input, , opts]) => [input, opts?.start, opts?.duration])).toEqual([["talk.mov", 0, 600], ["talk.mov", 600, 600], ["talk.mov", 1200, 600]]);
    expect(result.language).toBe("english");
    expect(result.segments.map(s => [s.start, s.end, s.text, s.words])).toEqual([
      [0, 4, "First.", [{ text: "First.", start: 1, end: 2 }]],
      [603, 605, "Second.", [{ text: "Second.", start: 603, end: 604 }]],
      [1250, 1251, "Third.", [{ text: "Third.", start: 1250, end: 1251 }]],
    ]);
    expect(progress).toEqual([600 / 1300, 1200 / 1300, 1]);
    expect(beforeUpload).toHaveBeenCalledTimes(3);
    expect(uploads.map(u => u.bytes)).toEqual([78 + 3200 + 600, 78 + 3200 + 600, 78 + 3200 + 100]);
    expect(uploads[0]).toMatchObject({ url: "http://127.0.0.1:9/v1/audio/transcriptions", key: "Bearer key-for-tests",
      fields: { model: ["whisper-1"], response_format: ["verbose_json"], "timestamp_granularities[]": ["word", "segment"], language: ["en"] } });
    expect(uploads[0]!.fields.prompt).toBeUndefined();
    // Each chunk's audio is deleted once it is answered.
    expect(await readdir(dir)).toEqual([]);
  });

  it("reads the length from the file when it isn't given, and sends a short recording as one chunk", async () => {
    decodes(42);
    api({ language: "en", text: "Hi.", words: [{ word: "Hi.", start: 1, end: 2 }] });
    const probe = vi.spyOn(fallbackAdapter, "probeMedia").mockResolvedValue({ duration: 42 } as never);
    const progress: number[] = [];
    const result = await provider().transcribe({ path: "memo.m4a", tmpDir: dir, language: "de", onProgress: fraction => progress.push(fraction) });
    expect(probe).toHaveBeenCalledWith("memo.m4a");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ url: "https://api.openai.com/v1/audio/transcriptions", fields: { language: ["de"] } });
    expect(result.segments).toMatchObject([{ start: 1, end: 2, text: "Hi." }]);
    expect(progress).toEqual([1]);
  });

  it("skips a chunk that starts where the audio has already ended", async () => {
    // The video runs 20 s past its audio, which ends just short of the ten-minute mark.
    decodes(599.98);
    api({ language: "en", segments: [{ start: 0, end: 4, text: "All of it." }], words: [{ word: "All", start: 1, end: 2 }] });
    const progress: number[] = [];
    const result = await provider().transcribe({ path: "talk.mov", duration: 620, tmpDir: dir, onProgress: fraction => progress.push(fraction) });
    expect(result.segments.map(s => s.text)).toEqual(["All of it."]);
    expect(uploads).toHaveLength(1);
    expect(progress.at(-1)).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("says why OpenAI turned it down in plain words, logs OpenAI's own answer without the key, and leaves no audio behind", async () => {
    decodes(30);
    const answer = JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-abc1********************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.", type: "invalid_request_error", code: "invalid_api_key" } });
    api(new Response(answer, { status: 401 }));
    const logged: string[] = [];
    const failure = await provider({ log: line => logged.push(line) }).transcribe({ path: "talk.mov", duration: 30, tmpDir: dir }).then(() => undefined, (error: Error) => error.message);
    expect(failure).toBe("OpenAI didn’t accept the API key: check OPENAI_API_KEY, or choose local transcription in Settings.");
    expect(logged).toEqual([`[transcribe] OpenAI answered 401: ${answer.replace(/sk-proj-[\w*]+/, "sk-…")}`]);
    expect(logged.join()).not.toContain("abc1");
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    [429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } },
      "Your OpenAI account is out of credit: add credit with OpenAI, or choose local transcription in Settings."],
    [429, { error: { message: "Rate limit reached for whisper-1.", type: "requests", code: "rate_limit_exceeded" } },
      "OpenAI is getting too many requests from this key: try again in a minute."],
    [413, "<html>413 Request Entity Too Large</html>", "This audio is too large for OpenAI to transcribe: choose local transcription in Settings."],
    [400, { error: { message: "Maximum content size limit (26214400) exceeded (26500000 bytes read)", type: "server_error" } },
      "This audio is too large for OpenAI to transcribe: choose local transcription in Settings."],
    [404, { error: { message: "The model `whisper-1` does not exist or you do not have access to it.", code: "model_not_found" } },
      "OpenAI doesn’t offer the model “whisper-1” to this key: change the OpenAI model in Settings → Advanced."],
    [503, "upstream connect error", "OpenAI’s transcription service isn’t working right now: try again in a few minutes."],
    [400, { error: { message: "Invalid language 'xx'. Language parameter must be specified in ISO-639-1 format.", type: "invalid_request_error" } },
      "OpenAI couldn’t transcribe this audio and said “Invalid language 'xx'. Language parameter must be specified in ISO-639-1 format.”"],
    [400, { error: { message: "Unsupported audio format" } }, "OpenAI couldn’t transcribe this audio and said “Unsupported audio format.”"],
    [400, "", "OpenAI couldn’t transcribe this audio (error 400): try again in a minute."],
  ] as const)("says what an answer of %i means for the editor", async (status, body, said) => {
    decodes(30);
    api(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    await expect(provider().transcribe({ path: "talk.mov", duration: 30, tmpDir: dir })).rejects.toMatchObject({ message: said });
  });

  it("says Scarlet couldn't reach OpenAI when the request never got there", async () => {
    decodes(30);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.openai.com") })));
    const logged: string[] = [];
    await expect(provider({ log: line => logged.push(line) }).transcribe({ path: "talk.mov", duration: 30, tmpDir: dir }))
      .rejects.toThrow("Scarlet couldn’t reach OpenAI: check your internet connection, then try again.");
    expect(logged).toEqual(["[transcribe] couldn’t reach OpenAI: TypeError: fetch failed (Error: getaddrinfo ENOTFOUND api.openai.com)"]);
  });

  it("stops before the next chunk once the transcription is cancelled", async () => {
    const decode = decodes(1300);
    const stop = new AbortController();
    api({ words: [{ word: "First.", start: 1, end: 2 }] });
    const onProgress = () => stop.abort(new Error("cancelled"));
    await expect(provider().transcribe({ path: "talk.mov", duration: 1300, tmpDir: dir, signal: stop.signal, onProgress })).rejects.toThrow("cancelled");
    expect(decode).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
  });

  it("resumes after the last saved upload, including a later window with no audio", async () => {
    const decode = decodes(1180); // The video continues to 1300 s.
    api({ language: "english", text: "First", words: [{ word: "First", start: 1, end: 2 }] },
      { text: "Next", words: [{ word: "Next", start: 3, end: 4 }] });
    const saved: Array<{ through: number; chunk: TranscribeResult; fraction?: number }> = [];
    const stop = new AbortController();
    const save = (through: number, chunk: TranscribeResult, fraction?: number) => saved.push({ through, chunk, fraction });
    const input = { path: "interview.mov", duration: 1300, tmpDir: dir };
    await expect(provider().transcribe({ ...input, signal: stop.signal,
      checkpoint: { through: 0, result: { segments: [] }, save }, onProgress: () => stop.abort(new Error("quit")) })).rejects.toThrow("quit");
    expect(saved).toHaveLength(1);
    const { through, chunk: result } = saved[0]!;
    const resumed = await provider().transcribe({ ...input, checkpoint: { through, result, save } });
    expect(saved.map(s => s.through)).toEqual([600, 1200, 1300]);
    expect(saved.map(s => s.fraction)).toEqual([600 / 1300, 1200 / 1300, 1]);
    expect(saved[2]!.chunk.segments).toEqual([]);
    expect(decode.mock.calls.map(([, , opts]) => opts?.start)).toEqual([0, 600, 1200]);
    expect(uploads).toHaveLength(2);
    expect(resumed.language).toBe("english");
    expect(resumed.segments).toEqual([result.segments[0], saved[1]!.chunk.segments[0]]);
    expect(resumed.segments[1]!.words).toEqual([{ text: "Next", start: 603, end: 604 }]);
    expect(await provider().transcribe({ ...input, checkpoint: { through: 1300, result: resumed, save } })).toEqual(resumed);
    expect(decode).toHaveBeenCalledTimes(3);
  });

  describe("of a dialogue window", () => {
    const window = async () => {
      const file = join(dir, "window.wav");
      await writeFile(file, Buffer.alloc(78 + 3200 + 58));
      return file;
    };

    it("sends the caller's audio as it is, with the prompt, and returns its words", async () => {
      const decode = decodes(58);
      api({ language: "en", segments: [{ start: 0, end: 3, text: "Um, so." }], words: [{ word: "Um,", start: 0.5, end: 0.9 }, { word: "so.", start: 1, end: 1.4 }] });
      const path = await window();
      const result = await provider().transcribe({ path, tmpDir: dir, dialogueWindow: { prompt: "Um, uh, like." } });
      expect(decode).not.toHaveBeenCalled();
      expect(uploads).toMatchObject([{ file: "window.wav", bytes: 78 + 3200 + 58, fields: { prompt: ["Um, uh, like."] } }]);
      expect(result).toMatchObject({ language: "en", segments: [{ text: "Um, so.", words: [{ text: "Um,", start: 0.5, end: 0.9 }, { text: "so.", start: 1, end: 1.4 }] }] });
    });

    it("takes a transcript with no speech as silence, and refuses one with speech and no word times", async () => {
      const path = await window();
      api({ language: "en", text: "  ", segments: [] }, { text: "" }, { language: "en", text: "Um, so." }, { segments: [{ start: 0, end: 2, text: "So." }] }, {});
      const scan = () => provider().transcribe({ path, tmpDir: dir, dialogueWindow: {} });
      expect(await scan()).toEqual({ language: "en", segments: [] });
      expect(await scan()).toEqual({ language: undefined, segments: [] });
      await expect(scan()).rejects.toThrow("First-cut scans require an OpenAI model that returns word timestamps.");
      await expect(scan()).rejects.toThrow("First-cut scans require an OpenAI model that returns word timestamps.");
      // An answer with no transcript in it at all isn't silence.
      await expect(scan()).rejects.toThrow("First-cut scans require an OpenAI model that returns word timestamps.");
      expect(uploads.every(u => u.fields.prompt === undefined)).toBe(true);
    });
  });
});
