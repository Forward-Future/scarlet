import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { VOICE_MODEL_GZIP_BASE64, VOICE_MODEL_SHA256 } from "./voiceModelData.js";

let written: string | undefined;

/** The voice cleanup model's text, checked against the hash it was published with. */
export function voiceModelText(): Buffer {
  const text = gunzipSync(Buffer.from(VOICE_MODEL_GZIP_BASE64, "base64"));
  if (createHash("sha256").update(text).digest("hex") !== VOICE_MODEL_SHA256) throw new Error("The voice cleanup model is damaged.");
  return text;
}

/**
 * The voice cleanup model as a file FFmpeg can read, written once per engine to `dir` (the system's temporary folder by
 * default) under a name that carries its hash, and again if something deleted it since.
 */
export function voiceModelFile(dir = os.tmpdir()): string {
  const file = path.join(dir, `scarlet-voice-${VOICE_MODEL_SHA256.slice(0, 16)}.rnnn`);
  if (written === file && existsSync(file)) return file;
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const staged = `${file}.${process.pid}.part`;
    writeFileSync(staged, voiceModelText());
    renameSync(staged, file);
  }
  written = file;
  return file;
}
