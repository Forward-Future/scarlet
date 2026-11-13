import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function read(file: string): string | undefined {
  try {
    const id = readFileSync(file, "utf8").trim();
    return UUID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The random id this library reports under, made on first use. It is not derived from the machine, the account or
 * anything in the library. Returns nothing when the file can't be read or written, which leaves telemetry off.
 */
export function anonymousId(file: string): string | undefined {
  const existing = read(file);
  if (existing) return existing;
  try {
    rmSync(file, { force: true }); // A damaged file would block the link below.
    // Engines sharing a library link a complete file into place, and whichever is first wins.
    const tmp = `${file}.${randomUUID()}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, `${randomUUID()}\n`);
      try {
        linkSync(tmp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      closeSync(fd);
      unlinkSync(tmp);
    }
  } catch {
    return undefined;
  }
  return read(file);
}

/** What is sent in place of the id on disk, so a report can't be matched to the file by reading it. */
export function installId(anonymous: string): string {
  return createHash("sha256").update(anonymous).digest("hex");
}
