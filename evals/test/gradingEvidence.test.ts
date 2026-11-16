import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadCase, type CaseFile } from "../src/case.ts";
import { scoreEntrances } from "../src/entrances.ts";
import { publishedGradingInputs } from "../src/gradingEvidence.ts";
import { reportPublishedWords } from "../src/run.ts";
import { cut } from "./fixtures.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scarlet-grade-"));
  vi.stubEnv("SCARLET_EVAL_DATA", root);
  mkdirSync(join(root, "cases/show/evidence"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const source = "a".repeat(64);
const candidate = "cases/show/evidence/med_cam.json", fixed = "cases/show/grading-evidence.json";
const manifest = "cases/show/case.json", reference = "reference-audio.json";
const identity = { mediaId: "med_cam", sourceSha256: source, audioStream: 1 };
const words = { ...identity, duration: 5, words: [{ text: "begin", start: 1.10, end: 1.30 }] };
const predicted = { ...words, words: [{ text: "begin", start: 3.10, end: 3.30 }] };
const digest = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
const put = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));
const get = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

function build({ declared = true, grade = words, map = identity, observed = predicted } = {}) {
  put(candidate, observed);
  if (declared) put(fixed, grade);
  const file: CaseFile = { schema: 1, id: "show", suite: "capability", createdAt: "", fps: 30, projectId: "prj_test",
    media: [{ id: "med_cam", kind: "video", hash: source, audioStream: 1 }], sourceVersion: "start", dialogueMedia: ["med_cam"],
    request: { instruction: "", skillIds: [], skillNames: [] },
    ...(declared && { gradingEvidence: { ...identity, sha256: digest(fixed) } }) };
  put(manifest, file);
  put(reference, { schema: 1, inputs: map, rawDuration: 5, finalDuration: 2, frameRate: 30, mappedFraction: 1,
    segments: [{rawStart: 0, rawEnd: 2, finalStart: 0, finalEnd: 2}], joins: [], keptSource: [[0,2]],
    unmappedFinal: [], removedSource: [[2,5]] });
  const names = [reference, manifest, candidate, ...(declared ? [fixed] : [])];
  put("episode.lock.json", { schema: 1, case: "show", files: Object.fromEntries(names.map(n => [n, digest(n)])) });
  return loadCase("show");
}

it("grades the applied timeline against the frozen words when candidate timing changes eligibility", () => {
  const loaded = build();
  const inputs = publishedGradingInputs(loaded)!;
  const headline: Record<string, number | null> = {};
  const timeline = cut("applied", "med_cam", [[0, 2]]);
  timeline.tracks = timeline.tracks.filter(t => t.id === "cam");
  reportPublishedWords(inputs, loaded, timeline, join(root, "trial"), headline);
  const result = JSON.parse(readFileSync(join(root, "trial/published-words.json"), "utf8"));
  expect(result.gradingEvidenceSha256).toBe(digest(fixed));
  expect(headline.verifiedPublishedWords).toBe(1);
  expect(headline.missingVerifiedWords).toBe(0);
});

it("uses the candidate source evidence on an original case", () => {
  const loaded = build({ declared: false });
  expect(publishedGradingInputs(loaded)?.evidenceSha256).toBe(digest(candidate));
});

it("rejects a missing grading file or declaration, and changed bytes before calling a model", () => {
  const loaded = build();
  put(fixed, predicted);
  expect(() => publishedGradingInputs(loaded)).toThrow(/digest/);
  rmSync(join(root, fixed));
  expect(() => publishedGradingInputs(loaded)).toThrow(/Missing/);
  build();
  delete loaded.file.gradingEvidence;
  put(manifest, loaded.file);
  expect(() => publishedGradingInputs(loaded)).toThrow(/undeclared/);
});

it("rejects same-duration recordings or alternate streams even when the substituted files were re-inventoried", () => {
  for (const change of [{ sourceSha256: "b".repeat(64) }, { audioStream: 0 }, { mediaId: "other" }]) {
    expect(() => publishedGradingInputs(build({grade: { ...words, ...change }}))).toThrow(/recording or audio stream/);
    expect(() => publishedGradingInputs(build({observed: { ...predicted, ...change }}))).toThrow(/recording or audio stream/);
  }
  for (const change of [{sourceSha256: "b".repeat(64)}, { audioStream: 0 }]) {
    expect(() => publishedGradingInputs(build({map: { ...identity, ...change }}))).toThrow(/reference/);
  }
});

it("requires the frozen picture observations and the same editor export for both grading clocks", async () => {
  const loaded = build({ declared: false });
  const timeline = cut("applied", "med_cam", [[0, 2]]);
  const editor = "e".repeat(64), pictures = "pictures.json", lockFile = "episode.lock.json";
  const lock = get(lockFile), map = get(reference);
  put(pictures, { sourceId: source, publishedSha256: editor, publishedFrames: 50, observations: [] });
  expect(() => publishedGradingInputs(loaded)).toThrow(/undeclared picture/);
  lock.files[pictures] = digest(pictures);
  lock.files["media/published.mp4"] = editor;
  put(lockFile, lock);

  const freezeMap = (inputs?: unknown) => {
    put(reference, { ...map, inputs });
    lock.files[reference] = digest(reference);
    put(lockFile, lock);
  };
  freezeMap({ ...identity, editorSha256: "f".repeat(64) });
  expect(() => publishedGradingInputs(loaded)).toThrow(/different edits/);
  freezeMap({ ...identity, editorSha256: editor });
  expect((await scoreEntrances(loaded, timeline))?.summary.verifiedPictures).toBe(0);

  // Original maps had no recording identities. Their frozen episode already pins both inputs.
  freezeMap();
  expect((await scoreEntrances(loaded, timeline))?.summary.verifiedPictures).toBe(0);
  rmSync(join(root, pictures));
  expect(() => publishedGradingInputs(loaded)).toThrow(/Missing or undeclared picture/);
  await expect(scoreEntrances(loaded, timeline)).rejects.toThrow(/Missing or undeclared picture/);
  delete lock.files[pictures];
  put(lockFile, lock);
  expect(await scoreEntrances(loaded, timeline)).toBeUndefined();
});
