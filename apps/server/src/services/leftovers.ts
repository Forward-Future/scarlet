import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../context.js";

const DAY = 24 * 60 * 60 * 1000;

// Names written by the speech route, recording analysis, and the two transcription providers.
function temporaryAudio(name: string) {
  return /^(?:recording|chunk)_[a-z0-9]{12}\.wav$/.test(name) ||
    /^wcpp_[a-z0-9]{12}\.(?:wav|json)$/.test(name) || /^speech_[a-z0-9]{12}\.[^./\\]*$/.test(name) ||
    /^(?:recording-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/.test(name);
}

/**
 * Working files are removed by the job that made them. An engine that is killed never gets to, so the next start
 * removes what it left: temporary audio, half-written downloads and encodes, and an imported copy whose import never
 * finished. Only files untouched for a day go, so nothing a job is still writing, here or in another engine on the
 * same library, is taken from under it.
 */
export function sweepLeftovers(ctx: Ctx, now = Date.now()): number {
  let removed = 0;
  const sweep = (dir: string, leftover: (name: string) => boolean) => {
    let names: string[];
    try {
      if (!lstatSync(dir).isDirectory()) return;
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!leftover(name)) continue;
      const file = join(dir, name);
      try {
        const info = lstatSync(file);
        if (!info.isFile() || now - info.mtimeMs < DAY) continue;
        rmSync(file, { force: true });
        removed++;
      } catch { /* Another engine removed it, or it can't be read. Leave it. */ }
    }
  };
  sweep(ctx.paths.tmp, temporaryAudio);
  const projects = join(ctx.paths.root, "projects");
  if (!lstatSync(projects, { throwIfNoEntry: false })?.isDirectory()) return removed;
  const known = ctx.db.prepare("SELECT 1 FROM media WHERE id = ?");
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const id = project.name;
    sweep(ctx.paths.media(id), name => {
      if (/^\..+\.part$/.test(name)) return true;
      // An original is copied into the project before its row is written. A copy with no row was never imported.
      const media = /^(med_[A-Za-z0-9]+)\.[A-Za-z0-9]+$/.exec(name)?.[1];
      return !!media && !known.get(media);
    });
    sweep(ctx.paths.proxies(id), name => name.endsWith(".part.mp4"));
    sweep(ctx.paths.segments(id), name => /\.part\.(mp4|m4a)$/.test(name));
    sweep(ctx.paths.waveforms(id), name => name.endsWith(".part") || /^speakers-.*\.tmp$/.test(name));
  }
  if (removed) ctx.log(`[storage] removed ${removed} leftover working ${removed === 1 ? "file" : "files"} from an earlier session`);
  return removed;
}
