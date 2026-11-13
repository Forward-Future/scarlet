import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** Stop a CLI and its subprocesses. On POSIX it must have been started in its own group with detached: true. */
export function stopCliTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode) return;
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* process group already gone */
  }
}
