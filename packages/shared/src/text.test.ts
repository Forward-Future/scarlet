import { expect, it } from "vitest";
import { cutText, wellFormed } from "./text.js";

it("cuts text short without keeping half of an emoji", () => {
  const text = "Make the opening feel warmer x😊 please";
  // The 😊 starts at unit 30: a plain slice keeps only its first half.
  expect(wellFormed(text.slice(0, 31)) === text.slice(0, 31)).toBe(false);
  expect(cutText(text, 31)).toBe("Make the opening feel warmer x");
  expect(cutText(text, 32)).toBe("Make the opening feel warmer x😊");
  expect(cutText("short", 31)).toBe("short");
  const long = cutText("a".repeat(599) + "🎬 tighten", 600);
  expect(wellFormed(long)).toBe(long);
});

it("replaces any lone half of a character, and leaves whole ones alone", () => {
  expect(wellFormed("ok \uD83C…")).toBe("ok \uFFFD…");
  expect(wellFormed("\uDC00 tail")).toBe("\uFFFD tail");
  expect(wellFormed("❤️ 👍🏽 👨‍👩‍👧 🇺🇸")).toBe("❤️ 👍🏽 👨‍👩‍👧 🇺🇸");
});
