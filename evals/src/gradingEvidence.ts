import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { evidencePath, type LoadedCase } from "./case.ts";
import { checkedPath, dataDir, readJson } from "./paths.ts";

interface EpisodeLock { schema: number; case: string; files: Record<string, string> }
interface EvidenceIdentity { mediaId: string; sourceSha256?: string; audioStream?: number }
interface ReferenceIdentity { sourceSha256: string; audioStream: number; editorSha256: string }

/** Resolve the independent grading input before inference. A declared fixture must never fall back to candidate words. */
export function publishedGradingInputs(loaded: Pick<LoadedCase, "file" | "dir">, root = dataDir()) {
  const { dir, file } = loaded;
  const fixed = checkedPath(root, join(dir, "grading-evidence.json"));
  const reference = checkedPath(root, join(root, "reference-audio.json"));
  const pictureFile = checkedPath(root, join(root, "pictures.json"));
  const pictures = existsSync(pictureFile) ? pictureFile : undefined;
  const lockPath = checkedPath(root, join(root, "episode.lock.json"));
  const declared = Object.hasOwn(file, "gradingEvidence");
  if (!declared && !pictures && !existsSync(fixed) && !existsSync(reference) && !existsSync(lockPath)) return;
  const lock = readJson<EpisodeLock>(lockPath);
  if (lock.schema !== 1 || lock.case !== file.id) throw new Error("The frozen episode belongs to a different case.");
  const key = (path: string) => relative(root, path).split(sep).join("/");
  const verify = (path: string, requirePin = true) => {
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    if ((requirePin || Object.hasOwn(lock.files, key(path))) && lock.files[key(path)] !== digest) {
      throw new Error("Input differs from its frozen digest: " + key(path));
    }
    return digest;
  };
  if (declared !== existsSync(fixed) || declared !== Object.hasOwn(lock.files, key(fixed))) {
    throw new Error("Missing or undeclared fixed grading evidence.");
  }
  if (existsSync(reference) !== Object.hasOwn(lock.files, key(reference))) throw new Error("Missing or undeclared audio reference.");
  if (!!pictures !== Object.hasOwn(lock.files, key(pictureFile))) throw new Error("Missing or undeclared picture observations.");
  if (pictures && !existsSync(reference)) throw new Error("Picture observations require their frozen audio reference.");
  const casePath = checkedPath(root, join(dir, "case.json"));
  if (declared || pictures || Object.hasOwn(lock.files, key(casePath))) verify(casePath);
  if (!declared && !existsSync(reference)) return;
  const [id] = file.dialogueMedia;
  if (file.dialogueMedia.length !== 1 || !id) throw new Error("Published word grading requires a single dialogue recording.");
  const candidate = evidencePath(dir, id);
  const evidence = declared ? fixed : candidate;
  const evidenceSha256 = verify(evidence, declared || !!pictures);
  const media = file.media.find(m => m.id === id);
  if (declared) {
    verify(candidate);
    const binding = file.gradingEvidence;
    if (!binding || !media || binding.mediaId !== id || binding.sha256 !== evidenceSha256 ||
        !/^[a-f0-9]{64}$/.test(binding.sourceSha256) || media.hash !== binding.sourceSha256 ||
        !Number.isSafeInteger(binding.audioStream) || binding.audioStream < 0 || (media.audioStream ?? 0) !== binding.audioStream ||
        (Object.hasOwn(lock.files, "media/presenter.mp4") && lock.files["media/presenter.mp4"] !== binding.sourceSha256)) {
      throw new Error("The grading declaration differs from its frozen recording or stream.");
    }
    for (const path of [candidate, evidence]) {
      const record = readJson<EvidenceIdentity>(path);
      if (record.mediaId !== id || ("sourceSha256" in record && record.sourceSha256 !== binding.sourceSha256) ||
          ("audioStream" in record && record.audioStream !== binding.audioStream)) {
        throw new Error("Transcript evidence identifies a different recording or audio stream.");
      }
    }
  }
  if (!existsSync(reference)) return;
  const referenceSha256 = verify(reference);
  if (declared || pictures) {
    const { inputs } = readJson<{ inputs?: ReferenceIdentity }>(reference);
    if ((declared || inputs !== undefined) && (!inputs || inputs.sourceSha256 !== media?.hash || inputs.audioStream !== (media?.audioStream ?? 0))) {
      throw new Error("The published reference identifies a different or unknown recording or stream.");
    }
    if (pictures) {
      verify(pictures);
      const { sourceId, publishedSha256 } = readJson<{ sourceId: string; publishedSha256: string }>(pictures);
      if (!sourceId || sourceId !== media?.hash || !publishedSha256 || publishedSha256 !== lock.files["media/published.mp4"])
        throw new Error("Picture verification does not identify the frozen recordings.");
      // Historical audio maps have no inputs block. The original episode lock pins that map and its pictures.
      if (inputs && inputs.editorSha256 !== publishedSha256) throw new Error("The published audio and picture references identify different edits.");
    }
  }
  return { reference, referenceSha256, evidence, evidenceSha256, pictures };
}
