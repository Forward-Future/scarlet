import { access, constants, mkdir, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { Workspace } from "./runners/types.js";

/** Where a request's shell finds its programs, in the task folder: small launchers, first on its PATH. */
export const TOOLS_DIR = ".tools";

const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);

/** The first runnable file of that name on the PATH. */
async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const file of names) if (await runnable(join(dir, file))) return join(dir, file);
  }
}

/**
 * Where the certificates the machine's own settings point TLS at are kept (`SSL_CERT_FILE`, `CURL_CA_BUNDLE` and the
 * like), so a shell that reads only its folder can still check a site's certificate: on one machine `curl` pointed at a
 * Python package's bundle, and failed every https address in Codex's sandbox (2026-11-21).
 */
async function certificateFolders(env: NodeJS.ProcessEnv): Promise<string[]> {
  const folders: string[] = [];
  for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) {
    const set = Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1]?.trim();
    if (!set || !isAbsolute(set)) continue;
    const st = await stat(set).catch(() => undefined);
    if (st) folders.push(st.isDirectory() ? set : dirname(set));
  }
  return folders;
}

/** A launcher for one program, by its full path. */
export function launcher(target: string): string {
  return `#!/bin/sh\nexec '${target.replaceAll("'", "'\\''")}' "$@"\n`;
}

/** The folder a program needs to read to run: its whole app bundle on a Mac, else the folder it sits in. */
export function programFolder(path: string): string {
  const app = path.indexOf(".app/");
  return app >= 0 ? path.slice(0, app + 4) : dirname(path);
}

/**
 * The programs a request's shell is given, as launchers in the task folder: ffmpeg and ffprobe (the engine's own, from
 * FFMPEG_PATH and FFPROBE_PATH, else the PATH's). Pages are drawn and captured in Scarlet's own Chrome (`graphic_render`,
 * `web_capture`): in every harness's sandbox Chrome either crashed at start or couldn't reach the web (2026-11-21).
 * What the host lacks is left out; the shell keeps its PATH as it was.
 */
export async function workspaceTools(cwd: string, env: NodeJS.ProcessEnv): Promise<Workspace> {
  const find = async (set: string | undefined, name: string) => set && isAbsolute(set) && await runnable(set) ? set : onPath(name, env);
  const programs = Object.entries({
    ffmpeg: await find(env.FFMPEG_PATH, "ffmpeg"),
    ffprobe: await find(env.FFPROBE_PATH, "ffprobe"),
  }).filter((entry): entry is [string, string] => !!entry[1]);
  if (!programs.length) return { readDirs: await certificateFolders(env) };
  const binDir = join(cwd, TOOLS_DIR);
  await mkdir(binDir, { recursive: true });
  for (const [name, target] of programs) {
    if (process.platform === "win32") await writeFile(join(binDir, `${name}.cmd`), `@"${target}" %*\r\n`);
    else await writeFile(join(binDir, name), launcher(target), { mode: 0o755 });
  }
  return { binDir, readDirs: [...new Set([...programs.map(([, target]) => programFolder(target)), ...await certificateFolders(env)])] };
}
