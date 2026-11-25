import type { Timeline } from "@scarlet/timeline";

export interface MessageClock {
  duration: number;
  version?: string;
  mediaId?: string;
  timeline?: Timeline | null;
  seek(time: number): void;
}

export interface MessageTimestamp {
  start: number;
  text: string;
  time: number;
}

/** Words that say the clock after them is a time: "at 9:16", "after 9:16", "@ 9:16". */
const POINTS_AT_A_TIME = /(?:(?:^|[^\p{L}\p{N}_])(?:at|from|until|till|around|before|after)\s+|@\s*)$/iu;
/** What joins a clock to the time before it: "9:10 to 9:16", "9:10 – 9:16". */
const JOINS_TIMES = /^\s*(?:to|and|[-–—])\s*$/iu;
/** A date before a clock makes it a time of day: "2026-11-24 01:20", "11/24/2026 01:20", "24.11.2026 01:20". */
const AFTER_A_DATE = /(?:^|[^\p{L}\p{N}_])(?:\d{4}([-/.])\d{1,2}\1\d{1,2}|\d{1,2}([-/.])\d{1,2}\2\d{4})[ \t]+$/u;

/** Complete clocks in prose. A bare number, part of a longer clock, or a time outside the video stays plain text. */
export function messageTimestamps(message: string, duration: number): MessageTimestamp[] {
  const times: MessageTimestamp[] = [];
  const clocks = /(^|[^\p{L}\p{N}_:/+.])(\d+(?::\d{2}){1,2}(?:\.\d{1,3})?)(?![\p{L}\p{N}_:]|\.\d)/gu;
  for (const match of message.matchAll(clocks)) {
    const text = match[2]!;
    const start = match.index + match[1]!.length;
    const parts = text.split(":").map(Number);
    if (parts.slice(1).some(part => part >= 60)) continue;
    const earlier = times.at(-1);
    // A hyphen joins a clock to the time right before it when the clock is at least as long ("1:20-1:45",
    // "59:30-1:00:10"). Anywhere else it stays plain text ("UTC-05:00", "-0:05"), and after a longer clock or a time of
    // day it starts a UTC offset ("00:01:20-05:00", "2026-11-24 01:20-05:00").
    if (match[1] === "-" && !(earlier && earlier.start + earlier.text.length === match.index
      && parts.length >= earlier.text.split(":").length
      && !AFTER_A_DATE.test(message.slice(0, earlier.start)))) continue;
    // "9:16" is also the shape of a vertical video ("Make a 9:16 short"). It is a time only where the words say so:
    // after a word that points at a time, or joined to the time before it. Anywhere else it stays plain text.
    if (text === "9:16" && !POINTS_AT_A_TIME.test(message.slice(0, start))
      && !(earlier && JOINS_TIMES.test(message.slice(earlier.start + earlier.text.length, start)))) continue;
    const time = parts.reduce((sum, part) => sum * 60 + part, 0);
    if (time < duration) times.push({ start, text, time });
  }
  return times;
}
