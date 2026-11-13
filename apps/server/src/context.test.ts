import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { engineIsAlive } from "./context.js";
import { openDb, type Db } from "./db.js";

/** `ps` as the engine runs it: what it was asked, and what each test has it say. An error when it can't be run. */
const ps = vi.hoisted(() => ({ asked: [] as string[][], says: "" as string | Error }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile(_program: string, args: string[], _options: object, done: (error: Error | null, stdout: string) => void) {
    ps.asked.push(args);
    const says = ps.says;
    setImmediate(() => says instanceof Error ? done(says, "") : done(null, says));
  },
}));

const platform = process.platform;
/** A process that is running now: another engine at work in the library, or a program since given a killed engine's id. */
const other = process.ppid;
const gone = spawnSync(process.execPath, ["-e", ""]).pid;

let directory: string;
let db: Db;
let lines: string[];
const pending = new Set<Promise<unknown>>();
const ctx = {
  get db() { return db; },
  track<T>(work: Promise<T>) { pending.add(work); void work.finally(() => pending.delete(work)); return work; },
  log(line: string) { lines.push(line); },
};
/** The time `ps` takes to answer. */
const answered = () => Promise.all([...pending]);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-context-test-"));
  db = openDb(join(directory, "library.db"));
  lines = [];
  ps.asked.length = 0;
  ps.says = "";
  // Only macOS is asked when a process began.
  Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: platform });
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

let notes = 0;
/**
 * What an engine notes as it starts: when it began, beside its process id. `ago`: how long before now, in seconds.
 * No two notes here are the same, as no two engines' are: what is learned for one note is kept for as long as it stands.
 */
const note = (ago: number) => db.prepare("INSERT OR REPLACE INTO engines (pid, started_at) VALUES (?, ?)").run(other, Date.now() - ago * 1000 - notes++ / 1000);

/** A line of `ps` for a process of that age in seconds, which it prints as [[days-]hours:]minutes:seconds. */
function line(pid: number, age: number) {
  const two = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(age / 86_400), hours = Math.floor(age / 3600) % 24;
  const printed = `${days ? `${two(days)}-` : ""}${days || hours ? `${two(hours)}:` : ""}${two(Math.floor(age / 60) % 60)}:${two(age % 60)}`;
  return `${String(pid).padStart(5)} ${printed.padStart(11)}\n`;
}
/** This engine's own line. Its process began a little before the engine in it did. */
const own = () => line(process.pid, Math.ceil((Date.now() - performance.timeOrigin) / 1000) + 30);

it("takes a process for the engine that noted its id unless it began more than a minute after the note", async () => {
  // Engines at work for days, for an hour and for seconds, as `ps` prints each age, and one whose note is half a minute early.
  for (const [noted, age] of [[833_987, 833_987], [3_723, 3_723], [5, 5], [300, 270]] as const) {
    note(noted);
    ps.says = line(other, age) + own();
    // Asking doesn't hold the engine up: the claim is its engine's until the answer is in, and after it here.
    expect(engineIsAlive(ctx, other)).toBe(true);
    await answered();
    expect(engineIsAlive(ctx, other)).toBe(true);
  }
  expect(ps.asked).toEqual(Array(4).fill(["-o", "pid=,etime=", "-p", `${other},${process.pid}`]));
  expect(lines).toEqual([]);
});

it("takes a process that began after the note for another program, once `ps` has said so", async () => {
  note(3600);
  ps.says = line(other, 5) + own();
  expect(engineIsAlive(ctx, other)).toBe(true);
  await answered();
  expect(engineIsAlive(ctx, other)).toBe(false);
  expect(lines).toEqual([expect.stringMatching(new RegExp(
    `^\\[engine\\] process ${other} began at least 59m 5\\ds after the engine that noted that id, so it is another program: what that engine left claimed is free$`))]);
  // The answer stands, and nothing more is asked.
  expect(engineIsAlive(ctx, other)).toBe(false);
  expect(ps.asked).toHaveLength(1);
  // A later engine given the same id notes its own start, and isn't taken for the one before it.
  note(5);
  expect(engineIsAlive(ctx, other)).toBe(true);
  await answered();
  expect(engineIsAlive(ctx, other)).toBe(true);
});

it.each<[string, () => string | Error, number?]>([
  ["`ps` can't be run", () => new Error("spawn /bin/ps ENOENT")],
  ["the process's age can't be made out", () => `${other} -1:-5\n` + own()],
  ["`ps` doesn't list the process", () => own()],
  ["`ps` doesn't list this engine", () => line(other, 5)],
  // Counted back from a clock set forward a day, every process began a day later than it did, this engine too.
  ["the clock moves while `ps` is asked", () => line(other, 5) + own(), 86_400_000],
])("leaves a claim with its engine when %s", async (_doubt, says, ahead = 0) => {
  note(3600);
  ps.says = says();
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => clock() + ahead);
  expect(engineIsAlive(ctx, other)).toBe(true);
  await answered();
  expect(engineIsAlive(ctx, other)).toBe(true);
  expect(ps.asked).toHaveLength(1);
  expect(lines).toEqual([]);
});

it("asks again after half a minute, since an id can go to another program at any time", async () => {
  note(3600);
  ps.says = line(other, 3600) + own();
  const time = performance.now.bind(performance);
  let passed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time() + passed);
  expect(engineIsAlive(ctx, other)).toBe(true);
  await answered();
  // The engine is killed and its id handed on. Within the half minute the last answer stands.
  ps.says = line(other, 5) + own();
  passed = 29_000;
  expect(engineIsAlive(ctx, other)).toBe(true);
  await answered();
  expect(ps.asked).toHaveLength(1);
  passed = 31_000;
  expect(engineIsAlive(ctx, other)).toBe(true);
  await answered();
  expect(ps.asked).toHaveLength(2);
  expect(engineIsAlive(ctx, other)).toBe(false);
});

it("never asks about this engine's own id, a process that is gone, an id with no note, or off macOS", () => {
  expect(engineIsAlive(ctx, process.pid)).toBe(true);
  expect(engineIsAlive(ctx, gone)).toBe(false);
  // An engine from an earlier build noted nothing: a process with its id is taken for it, as it always was.
  expect(engineIsAlive(ctx, other)).toBe(true);
  note(3600);
  for (const elsewhere of ["linux", "win32"]) {
    Object.defineProperty(process, "platform", { value: elsewhere });
    expect(engineIsAlive(ctx, other)).toBe(true);
  }
  expect(ps.asked).toEqual([]);
});
