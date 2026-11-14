import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { steadyCopy } from "./steadyCopy.js";

const dir = mkdtempSync(join(tmpdir(), "scarlet-copy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

it("copies a file byte for byte in chunks, flushing as it goes, and keeps its times", async () => {
  const source = join(dir, "recording.mp4"), destination = join(dir, "copy.mp4");
  // Not a whole number of chunks, and several flushes, with the sizes scaled down.
  writeFileSync(source, randomBytes(1_000_003));
  // A time with a fraction finer than a millisecond, as a recorder leaves.
  const recorded = Date.parse("2026-10-27T10:39:35Z") / 1000 + 0.2354752;
  utimesSync(source, recorded, recorded);
  await steadyCopy(source, destination, undefined, { chunk: 64 * 1024, flushEvery: 256 * 1024 });
  expect(statSync(destination).size).toBe(1_000_003);
  expect(digest(destination)).toBe(digest(source));
  const apart = statSync(destination, { bigint: true }).mtimeNs - statSync(source, { bigint: true }).mtimeNs;
  expect(Number(apart < 0n ? -apart : apart)).toBeLessThan(1000);
});

it("stops when the import is cancelled", async () => {
  const source = join(dir, "long.mp4"), destination = join(dir, "stopped.mp4");
  writeFileSync(source, randomBytes(400_000));
  const cancel = new AbortController();
  cancel.abort(new Error("cancelled"));
  await expect(steadyCopy(source, destination, cancel.signal, { chunk: 64 * 1024 })).rejects.toThrow("cancelled");
});
