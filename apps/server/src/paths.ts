import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { restrictWindowsAccess } from "./privateStorage.js";

const chooseLibrary = "Choose an empty directory or an existing Scarlet library for --data so its files can be made private.";

function canTightenLibraryPermissions(path: string) {
  const root = realpathSync(path);
  const shared = [parse(root).root, homedir(), tmpdir(), process.cwd()].some(dir => existsSync(dir) && realpathSync(dir) === root);
  if (shared) throw new Error(chooseLibrary);
  const entries = readdirSync(root);
  if (!entries.length) return true;
  // A restored database can be on its own. A copy saved among unrelated documents isn't a library.
  if (entries.some(name => !/^scarlet\.db(?:-wal|-shm)?$/.test(name)) &&
      !["tmp", "skills"].every(name => lstatSync(join(root, name), { throwIfNoEntry: false })?.isDirectory())) return false;
  const db = join(root, "scarlet.db");
  if (lstatSync(db, { throwIfNoEntry: false })?.isFile()) {
    const fd = openSync(db, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const header = Buffer.alloc(16);
      if (fstatSync(fd).isFile() && readSync(fd, header, 0, header.length, 0) === header.length &&
          header.equals(Buffer.from("SQLite format 3\0"))) return true;
    } finally { closeSync(fd); }
  }
  return false;
}

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error("Expected a directory inside the Scarlet library.");
}

/** Project storage layout under the --data directory. */
export class Paths {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  get db() {
    return join(this.root, "scarlet.db");
  }
  /** The local access token (plain text, owner-only permissions). */
  get accessToken() {
    return join(this.root, "access-token");
  }
  /** The random id anonymous usage reports are sent under. See docs/telemetry.md. */
  get telemetryId() {
    return join(this.root, "telemetry-id");
  }
  get skills() {
    return join(this.root, "skills");
  }
  get tmp() {
    return join(this.root, "tmp");
  }
  project(id: string) {
    return join(this.root, "projects", id);
  }
  media(projectId: string) {
    return join(this.project(projectId), "media");
  }
  proxies(projectId: string) {
    return join(this.project(projectId), "proxies");
  }
  waveforms(projectId: string) {
    return join(this.project(projectId), "waveforms");
  }
  renders(projectId: string) {
    return join(this.project(projectId), "renders");
  }
  segments(projectId: string) {
    return join(this.project(projectId), "segments");
  }
  notes(projectId: string) {
    return join(this.project(projectId), "notes");
  }
  ensureProject(projectId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Invalid project directory.");
    for (const d of [
      join(this.root, "projects"),
      this.project(projectId),
      this.media(projectId),
      this.proxies(projectId),
      this.waveforms(projectId),
      this.renders(projectId),
      this.segments(projectId),
      this.notes(projectId),
    ]) {
      ensureDirectory(d);
    }
  }
  ensureRoot() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.root).isDirectory()) throw new Error("The library must be a directory, not a link.");
    if (process.platform === "win32") {
      restrictWindowsAccess(this.root, "Directory", canTightenLibraryPermissions(this.root) ? undefined : chooseLibrary);
    } else {
      // The directory protects existing projects and SQLite sidecars as well as future files.
      const fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (fstatSync(fd).mode & 0o077) {
          if (!canTightenLibraryPermissions(this.root)) throw new Error(chooseLibrary);
          fchmodSync(fd, 0o700);
        }
      } finally { closeSync(fd); }
    }
    ensureDirectory(this.tmp);
    ensureDirectory(this.skills);
  }
}
