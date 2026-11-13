import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FfmpegError, INDEXED_MP4_INPUT, LOCAL_MEDIA_INPUT, fnum, runFfmpeg, type RunFfmpegOptions } from "./exec.js";
import type { FilterGraph } from "./graph.js";
import { avcConfigurationArgs, sameAvcConfiguration } from "./avcConfiguration.js";

/** The decoder can hand these encoders a surface on the same device. */
export function directDevice(encoder: string) {
  switch (encoder) {
    case "h264_videotoolbox": return { decoder: "videotoolbox", format: "videotoolbox_vld" };
    case "h264_nvenc": return { decoder: "cuda", format: "cuda" };
    case "h264_qsv": return { decoder: "qsv", format: "qsv" };
    case "h264_amf": return { decoder: "d3d11va", format: "d3d11" };
  }
}

/** Report true only when every encoded picture came from the corresponding source frame.
 * Nominal and average source frame rates can agree even when a recording dropped frames. */
async function matchesFrameClock(file: string, frames: number, fps: number, signal?: AbortSignal): Promise<boolean> {
  const stats = await open(file);
  let first = -1, count = 0;
  try {
    for await (const line of stats.readLines({ signal })) {
      const fields = /^(\d+) (-?\d+) (\d+)\/(\d+)$/.exec(line);
      if (!fields || count >= frames) return false;
      const input = Number(fields[1]), pts = Number(fields[2]);
      const num = Number(fields[3]), den = Number(fields[4]);
      if (count === 0) first = input;
      if (input !== first + count || num === 0 || den === 0 || Math.abs(pts * num / den * fps - count) >= 0.0001) return false;
      count++;
    }
    return count === frames;
  } finally { await stats.close(); }
}

/** Skip the software compositor only when both the picture and its actual clock match.
 * The normal render overwrites this private segment before publishing on any mismatch. */
export async function encodeDirectPicture(graph: FilterGraph, device: NonNullable<ReturnType<typeof directDevice>>,
  indexed: boolean, outputArgs: string[], output: string, execution: RunFfmpegOptions): Promise<string[] | undefined> {
  const picture = graph.directPicture;
  if (!picture) return;
  const stats = join(dirname(graph.scriptPath), "source-frames.txt");
  const configuration = join(dirname(graph.scriptPath), "avc-parameters.txt");
  const args = ["-y", "-hwaccel", device.decoder, "-hwaccel_output_format", device.format,
    ...(indexed ? INDEXED_MP4_INPUT : []), "-ss", fnum(picture.start), "-t", fnum(graph.duration),
    ...LOCAL_MEDIA_INPUT, "-i", picture.file, "-map", "0:v:0", "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
    // Recheck the canvas whenever the decoder changes format, including immediately after a seek.
    // setsar only updates frame metadata. An invalid ratio rejects the fast path without downloading GPU frames.
    "-vf", `setsar='if(eq(w,${graph.width})*eq(h,${graph.height}),sar,-1)'`,
    "-stats_enc_pre:v", stats, "-stats_enc_pre_fmt:v", "{ni} {ptsi} {tbi}", ...outputArgs, output,
    ...avcConfigurationArgs(configuration)];
  try {
    await runFfmpeg(args, execution);
  } catch (error) {
    // The encoder may accept regular frames but reject this decoder or surface format.
    if (execution.signal?.aborted || !(error instanceof FfmpegError) || !error.started) throw error;
    return;
  }
  if (await matchesFrameClock(stats, picture.frames, graph.fps, execution.signal) &&
      await sameAvcConfiguration(configuration, execution.signal)) return args;
}
