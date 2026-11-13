import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function smokeEnvironment(work) {
  const env = { HOME: process.env.HOME ?? work, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SCARLET_TELEMETRY_ENABLED: "false" };
  if (process.platform === "win32") {
    // Native Windows startup and Windows PowerShell use the OS environment. Keep CI credentials,
    // provider overrides and tools installed on the runner out of this engine process.
    for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "ProgramData", "ProgramFiles",
      "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
      "ALLUSERSPROFILE", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH",
      "USERNAME", "USERDOMAIN", "COMPUTERNAME", "PROCESSOR_ARCHITECTURE"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Let Windows PowerShell build its native module search path, independent of the shell running CI.
    env.HOME = env.USERPROFILE ?? work;
    env.PATH = [join(env.SystemRoot, "System32"), env.SystemRoot].join(";");
    env.TEMP = env.TMP = work;
  }
  return env;
}

export async function startSmokeEngine(engine, work, env) {
  const data = join(work, "data");
  const cwd = join(work, "work");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(data, { mode: 0o755 });
  const child = spawn(engine, ["serve", "--solo", "--data", data, "--port", "0"], {
    cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.pipe(process.stderr, { end: false });
  const exited = new Promise((res, rej) => {
    child.once("error", rej);
    child.once("exit", (code, signal) => res({ code, signal }));
  });
  let timer;
  try {
    const ready = await Promise.race([
      new Promise((res, rej) => {
        lines.on("line", line => {
          const match = /^\s*SCARLET_READY\s+(.+)$/.exec(line);
          if (!match) return;
          try { res(JSON.parse(match[1])); } catch { rej(new Error("Invalid SCARLET_READY payload")); }
        });
        timer = setTimeout(() => {
          const files = ["scarlet.db", "skills", "access-token", "desktop-session.json"];
          const created = files.filter(file => existsSync(join(data, file)));
          rej(new Error(`Engine did not print SCARLET_READY within 60 s. Created in the test library: ${created.join(", ") || "nothing"}.`));
        }, 60_000);
      }),
      exited.then(({ code, signal }) => { throw new Error(`Engine exited before SCARLET_READY (${signal ?? code})`); }),
    ]);
    if (!Number.isInteger(ready?.port) || ready.port < 1 || ready.url !== `http://127.0.0.1:${ready.port}` ||
        typeof ready.token !== "string" || !ready.token) throw new Error("Incomplete SCARLET_READY payload");
    return { child, ready, exited };
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdout.resume();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = mkdtempSync(join(tmpdir(), "scarlet-startup-"));
  let child;
  let timer;
  try {
    const start = await startSmokeEngine(resolve(process.argv[2]), work, smokeEnvironment(work));
    child = start.child;
    console.log(`[smoke] packaged engine ready on ${start.ready.url}`);
    child.stdin.end();
    const result = await Promise.race([start.exited, new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("Packaged engine did not stop after stdin closed")), 15_000);
    })]);
    if (result.code !== 0) throw new Error(`Packaged engine stopped with ${result.signal ?? result.code}`);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
