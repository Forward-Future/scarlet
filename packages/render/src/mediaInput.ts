/**
 * Input arguments shared by the commands that read a stretch of a media file. Not part of the package's entry point.
 */
import type { TimeRange } from "@scarlet/timeline";
import { LOCAL_MEDIA_INPUT, ffSeconds } from "./exec.js";

/** Decode on an NVIDIA GPU and keep the frames there, for `scale_cuda` to work on before they come back to memory. */
export const CUDA_FRAMES_INPUT = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] as const;

/** Open `file` at `range.start` and read for the length of `range`, as local media only. */
export function rangeInput(file: string, range: TimeRange): string[] {
  return ["-ss", ffSeconds(range.start), "-t", String(range.end - range.start), ...LOCAL_MEDIA_INPUT, "-i", file];
}
