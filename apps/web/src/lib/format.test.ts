import { afterEach, expect, it, vi } from "vitest";
import { absTime, authorLabel, clock, clockRange, durationLabel, fmtBytes, initials, pct, lengthLabel, playbackClock, plural, relTime, removedSeconds, tc, tokenBreakdown, tokenLabel, trashedLine } from "./format";

afterEach(() => vi.useRealTimers());

it("words a past time in whole units that have passed, never 60 minutes or 24 hours", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-10T12:00:00Z"));
  const ago = (seconds: number) => relTime(new Date(Date.now() - seconds * 1000).toISOString());
  expect(ago(20)).toBe("just now");
  expect(ago(50)).toBe("1m ago");
  expect(ago(59 * 60 + 40)).toBe("59m ago");
  expect(ago(60 * 60)).toBe("1h ago");
  expect(ago(23 * 3600 + 50 * 60)).toBe("23h ago");
  expect(ago(24 * 3600)).toBe("1d ago");
  expect(ago(6 * 86400 + 20 * 3600)).toBe("6d ago");
});

it("words a project in the Trash one way: when it was deleted, then when it goes for good", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-10T12:00:00Z"));
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
  expect(trashedLine(hours(-1), hours(30 * 24 - 1))).toBe("Deleted 1h ago · gone for good in 30 days");
  expect(trashedLine(hours(-72), hours(20))).toBe("Deleted 3d ago · gone for good in 1 day");
  // Past its date a project waits for the next sweep: never "in 0 days".
  expect(trashedLine(hours(-72), hours(-1))).toBe("Deleted 3d ago · gone for good today");
  // An older engine's storage list doesn't say the day.
  expect(trashedLine(hours(-72))).toBe("Deleted 3d ago");
});

it("says how much a cut took out to a tenth under ten seconds and whole above, with no \"10.0\" between, and in minutes from a minute up", () => {
  // From a minute up it reads as the sentence that sums the cuts does: minutes and seconds, rounded once.
  expect(removedSeconds(59.4)).toBe("−59 s");
  expect(removedSeconds(59.5)).toBe("−1:00");
  expect(removedSeconds(118)).toBe("−1:58");
  expect(removedSeconds(119.6)).toBe("−2:00");
  expect(removedSeconds(0.44)).toBe("−0.4 s");
  expect(removedSeconds(9.94)).toBe("−9.9 s");
  expect(removedSeconds(9.97)).toBe("−10 s");
  expect(removedSeconds(10)).toBe("−10 s");
  expect(removedSeconds(12.4)).toBe("−12 s");
  // From a minute up it reads as the mark, the band and the sentence do, not as hundreds of seconds.
  expect(removedSeconds(59.4)).toBe("−59 s");
  expect(removedSeconds(59.7)).toBe("−1:00");
  expect(removedSeconds(221)).toBe("−3:41");
  expect(lengthLabel(9.97)).toBe("10 s");
  expect(lengthLabel(221)).toBe("3:41");
});

it("reads a clock for people: minutes and seconds, with hours only when there are any", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(5.9)).toBe("0:05");
  expect(clock(62)).toBe("1:02");
  expect(clock(3727)).toBe("1:02:07");
  // A time a hair under the second, as arithmetic leaves it, is that second. Nothing reads before zero.
  expect(clock(59.9999999)).toBe("1:00");
  expect(clock(-3)).toBe("0:00");
});

it("reads a stretch as its two ends on the clock, with their tenths only when both fall in the same second", () => {
  expect(clockRange(4, 6)).toBe("0:04 – 0:06");
  expect(clockRange(4.2, 5.1)).toBe("0:04 – 0:05");
  expect(clockRange(3725.5, 3727)).toBe("1:02:05 – 1:02:07");
  // Inside one second the clock alone would read "0:04 – 0:04".
  expect(clockRange(4.2, 4.8)).toBe("0:04.2 – 0:04.8");
  expect(clockRange(3727.04, 3727.96)).toBe("1:02:07.0 – 1:02:07.9");
  // A tenth is cut, not rounded, so an end never reads as the second after it; 4.3 is 4.3 though it is stored a hair under.
  expect(clockRange(4.3, 4.99)).toBe("0:04.3 – 0:04.9");
  expect(clockRange(0.1 + 0.2, 0.7)).toBe("0:00.3 – 0:00.7");
});

it("reads the player's position to the millisecond, carrying a rounded-up millisecond into the seconds", () => {
  expect(playbackClock(0)).toBe("0:00.000");
  expect(playbackClock(61.0421)).toBe("1:01.042");
  expect(playbackClock(59.9996)).toBe("1:00.000");
  expect(playbackClock(-1)).toBe("0:00.000");
});

it("words a length in the largest units that fit, and an unknown length as a dash", () => {
  expect(durationLabel(0.4)).toBe("0s");
  expect(durationLabel(59.4)).toBe("59s");
  expect(durationLabel(59.6)).toBe("1m 00s");
  expect(durationLabel(125)).toBe("2m 05s");
  expect(durationLabel(3599.6)).toBe("1h 0m");
  expect(durationLabel(7384)).toBe("2h 3m");
  expect(durationLabel(NaN)).toBe("–");
  expect(durationLabel(Infinity)).toBe("–");
});

it("sizes a file in the unit that reads best", () => {
  expect(fmtBytes(0)).toBe("0 B");
  expect(fmtBytes(1023)).toBe("1023 B");
  expect(fmtBytes(1024)).toBe("1 KB");
  expect(fmtBytes(1536 * 1024)).toBe("1.5 MB");
  expect(fmtBytes(3.25 * 1024 ** 3)).toBe("3.25 GB");
  // Just under the next unit, the figure rounds up to it and reads in that unit, not "1024 KB" or "1024.0 MB".
  expect(fmtBytes(1024 ** 2 - 1)).toBe("1.0 MB");
  expect(fmtBytes(1024 ** 3 - 1)).toBe("1.00 GB");
});

it("counts tokens at a glance and in full", () => {
  expect(tokenLabel(1)).toBe("1 token");
  expect(tokenLabel(850)).toBe("850 tokens");
  expect(tokenLabel(48_240)).toBe("48.2K tokens");
  expect(tokenLabel(312_400)).toBe("312K tokens");
  // Just under a million rounds to a million, not to "1000K".
  expect(tokenLabel(999_499)).toBe("999K tokens");
  expect(tokenLabel(999_500)).toBe("1M tokens");
  expect(tokenLabel(1_240_000)).toBe("1.2M tokens");
  const usage = { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0 };
  expect(tokenBreakdown(usage)).toBe(`${(1200).toLocaleString()} input · 340 output`);
  expect(tokenBreakdown({ ...usage, cacheReadTokens: 50, cacheWriteTokens: 7, runs: 3 })).toBe(`${(1200).toLocaleString()} input · 340 output · 50 cache read · 7 cache write · 3 runs`);
  expect(tokenBreakdown({ ...usage, runs: 1 })).not.toContain("runs");
});

it("names who did something: an agent by its name in the interface, Scarlet, or the person", () => {
  // The engine records an agent by its id, and a model by an alias. Neither is shown.
  expect(authorLabel({ type: "agent", id: "claude", name: "claude", model: "opus" })).toBe("Claude Code");
  expect(authorLabel({ type: "agent", id: "claude", name: "Claude Code", model: "opus" })).toBe("Claude Code");
  expect(authorLabel({ type: "agent", id: "codex", name: "Codex" })).toBe("Codex");
  // One this build doesn't know keeps the name it came with.
  expect(authorLabel({ type: "agent", id: "another", name: "Another agent" })).toBe("Another agent");
  expect(authorLabel({ type: "scarlet", name: "anything" })).toBe("Scarlet");
  expect(authorLabel({ type: "human", id: "u", name: "Matt" })).toBe("Matt");
  expect(initials("Matthew Berman")).toBe("MB");
  expect(initials("  ada   king  lovelace ")).toBe("AL");
  expect(initials("matt")).toBe("MA");
  expect(initials("   ")).toBe("?");
});

it("leaves a missing or unreadable date blank", () => {
  expect(relTime()).toBe("");
  expect(relTime("not a date")).toBe("");
  expect(absTime()).toBe("");
  expect(absTime("not a date")).toBe("");
  expect(absTime("2030-01-10T12:00:00Z")).toBe(new Date("2030-01-10T12:00:00Z").toLocaleString());
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-10T12:00:00Z"));
  // Older than a week reads as the day.
  expect(relTime("2030-01-01T12:00:00Z")).toBe(new Date("2030-01-01T12:00:00Z").toLocaleDateString());
});

it("keeps a share between 0 and 100 percent, counts things in the singular or plural, and reads frames as timecode", () => {
  expect(pct(0.424)).toBe("42%");
  expect(pct(1.7)).toBe("100%");
  expect(pct(-0.2)).toBe("0%");
  expect(plural(1, "cut")).toBe("1 cut");
  expect(plural(0, "cut")).toBe("0 cuts");
  expect(plural(2, "reply", "replies")).toBe("2 replies");
  expect(tc(61.5, 30)).toBe("1:01.15");
});
