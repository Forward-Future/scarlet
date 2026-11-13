import { open } from "node:fs/promises";

/** A second output from the same read, containing hashes of only the configured and in-band H.264 parameter sets. */
export function avcConfigurationArgs(file: string): string[] {
  return ["-map", "0:v:0", "-c:v", "copy", "-bsf:v", "h264_mp4toannexb,filter_units=pass_types=7|8",
    "-f", "framehash", "-hash", "sha256", file];
}

/** FFmpeg hashes only SPS/PPS bytes. Cameras may repeat the original configuration at every GOP. */
export async function sameAvcConfiguration(file: string, signal?: AbortSignal): Promise<boolean> {
  const stats = await open(file);
  let configured: string | undefined;
  try {
    for await (const line of stats.readLines({ signal })) {
      if (line.startsWith("#extradata ")) {
        const hash = /^#extradata 0,\s*\d+, ([a-f0-9]{64})$/.exec(line)?.[1];
        if (!hash || (configured && configured !== hash)) return false;
        configured = hash;
      } else if (!line.startsWith("#")) {
        const fields = line.split(",").map(field => field.trim());
        if (!configured || fields.length !== 6 || fields[0] !== "0" || fields[5] !== configured) return false;
      }
    }
    return !!configured;
  } finally { await stats.close(); }
}
