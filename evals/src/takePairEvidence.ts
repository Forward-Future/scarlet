/// <reference path="../../packages/render/src/vad-embedded.d.ts" />
/** Read source-only evidence through the same take finder and audio decoder as Scarlet's tools. */
import { readFileSync, writeFileSync } from "node:fs";
import { findRepeatedTakes } from "../../packages/mcp/src/dialogue-retakes.ts";
import { audition } from "../../packages/render/src/inspection.ts";
import type { TranscriptWord } from "../../packages/timeline/src/index.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
if (process.argv[2] === "repeats") {
  console.log(JSON.stringify(findRepeatedTakes(input as TranscriptWord[])));
} else if (process.argv[2] === "audio") {
  const { source, stream, windows } = input as {
    source: string; stream: number; windows: Array<{ path: string; from: number; to: number }>;
  };
  for (const w of windows) {
    if (!(w.to > w.from && w.to - w.from <= 8.0000001)) throw new Error("Invalid source audio window");
    const audio = await audition(source, { start: w.from, end: w.to }, undefined, stream);
    writeFileSync(w.path, Buffer.from(audio, "base64"), { flag: "wx" });
  }
} else {
  throw new Error("Expected repeats or audio.");
}
