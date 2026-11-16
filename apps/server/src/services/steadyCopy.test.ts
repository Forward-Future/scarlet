import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cloneOrSteadyCopy, steadyCopy } from "./steadyCopy.js";

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
  // Within a microsecond: some file systems and Node builds keep a file's time no finer than that.
  expect(Number(apart < 0n ? -apart : apart)).toBeLessThanOrEqual(1000);
});

it("stops when the import is cancelled", async () => {
  const source = join(dir, "long.mp4"), destination = join(dir, "stopped.mp4");
  writeFileSync(source, randomBytes(400_000));
  const cancel = new AbortController();
  cancel.abort(new Error("cancelled"));
  await expect(steadyCopy(source, destination, cancel.signal, { chunk: 64 * 1024 })).rejects.toThrow("cancelled");
});

it("copies a large file steadily where the disk can't clone it, and clones it where it can", async () => {
  const source = join(dir, "camera.mp4");
  writeFileSync(source, randomBytes(300_000));
  const refused: string[] = [];
  await cloneOrSteadyCopy(source, join(dir, "steady.mp4"), undefined, { smallBytes: 1000, clone: async (_from, to) => (refused.push(to), false) });
  expect(refused).toEqual([join(dir, "steady.mp4")]);
  expect(digest(join(dir, "steady.mp4"))).toBe(digest(source));
  // The platform's own clone, or a steady copy when this disk has none.
  await cloneOrSteadyCopy(source, join(dir, "cloned.mp4"), undefined, { smallBytes: 1000 });
  expect(digest(join(dir, "cloned.mp4"))).toBe(digest(source));
  // A small file is copied as it is.
  await cloneOrSteadyCopy(source, join(dir, "small.mp4"));
  expect(digest(join(dir, "small.mp4"))).toBe(digest(source));
});

it("leaves nothing behind when a copy stops part-way", async () => {
  const source = join(dir, "stopping.mp4"), destination = join(dir, "partial.mp4");
  writeFileSync(source, randomBytes(300_000));
  const cancel = new AbortController();
  await expect(cloneOrSteadyCopy(source, destination, cancel.signal, { smallBytes: 1000, clone: async () => {
    writeFileSync(destination, "part");
    cancel.abort(new Error("cancelled"));
    return false;
  } })).rejects.toThrow("cancelled");
  expect(existsSync(destination)).toBe(false);
});
