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

/** Complete clocks in prose. A bare number, part of a longer clock, or a time outside the video stays plain text. */
export function messageTimestamps(message: string, duration: number): MessageTimestamp[] {
  const times: MessageTimestamp[] = [];
  const clocks = /(^|[^\p{L}\p{N}_:/+.-])(\d+(?::\d{2}){1,2}(?:\.\d{1,3})?)(?![\p{L}\p{N}_:]|\.\d)/gu;
  for (const match of message.matchAll(clocks)) {
    const text = match[2]!;
    const parts = text.split(":").map(Number);
    if (parts.slice(1).some(part => part >= 60)) continue;
    const time = parts.reduce((sum, part) => sum * 60 + part, 0);
    if (time < duration) times.push({ start: match.index + match[1]!.length, text, time });
  }
  return times;
}
