const timestamp = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/;

function seconds(text: string): number {
  const parts = timestamp.exec(text);
  if (!parts) return NaN;
  return Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 1000;
}

/** Validate the whole file before proposing a timeline change. */
export function parseSubRip(source: string) {
  const blocks = source.trim().replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
  return blocks.map((block, index) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0]!.trim())) lines.shift();
    const times = lines.shift()?.trim().split(/\s*-->\s*/);
    const timelineIn = seconds(times?.[0] ?? "");
    const timelineOut = seconds(times?.[1] ?? "");
    const text = lines.join("\n").trim();
    if (times?.length !== 2 || !Number.isSafeInteger(Math.round(timelineOut * 1000)) || !(timelineOut > timelineIn) || !text) {
      throw new Error(`SubRip cue ${index + 1} needs a start time, a later end time, and caption text.`);
    }
    return { timelineIn, timelineOut, text };
  });
}
