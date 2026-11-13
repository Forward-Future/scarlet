import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anonymousId, installId } from "./identity.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scarlet-telemetry-id-"));
  file = join(dir, "telemetry-id");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("anonymousId", () => {
  it("makes a random id once and keeps it", () => {
    const first = anonymousId(file);
    expect(first).toMatch(UUID);
    expect(readFileSync(file, "utf8")).toBe(`${first}\n`);
    expect(anonymousId(file)).toBe(first);
  });

  it("makes a different id for each library", () => {
    expect(anonymousId(file)).not.toBe(anonymousId(join(dir, "other-id")));
  });

  it.skipIf(process.platform === "win32")("keeps the file private to the user", () => {
    anonymousId(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a damaged file", () => {
    writeFileSync(file, "not an id");
    const id = anonymousId(file);
    expect(id).toMatch(UUID);
    expect(readFileSync(file, "utf8")).toBe(`${id}\n`);
  });

  it("leaves nothing else behind", () => {
    anonymousId(file);
    anonymousId(file);
    expect(readdirSync(dir)).toEqual(["telemetry-id"]);
  });

  it("returns nothing when the file can't be written", () => {
    expect(anonymousId(join(dir, "missing", "telemetry-id"))).toBeUndefined();
  });
});

describe("installId", () => {
  it("is a hash of the id, not the id", () => {
    const id = anonymousId(file)!;
    const install = installId(id);
    expect(install).toMatch(/^[0-9a-f]{64}$/);
    expect(install).not.toContain(id);
    expect(installId(id)).toBe(install);
    expect(installId(anonymousId(join(dir, "other-id"))!)).not.toBe(install);
  });
});
