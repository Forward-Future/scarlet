import { expect, it } from "vitest";
import { styleGuideMentions } from "./styleGuides.js";

it("finds @style-name mentions beside markdown, quotes, possessives, and punctuation", () => {
  for (const text of [
    "**@neon-dark**",
    "`@neon-dark`",
    '"@neon-dark"',
    "“@neon-dark”",
    "'@neon-dark'",
    "‘@neon-dark’",
    "@neon-dark's",
    "@neon-dark’s",
    "Match **@neon-dark**'s palette",
    "(@neon-dark)",
    "@neon-dark.",
  ]) {
    expect(styleGuideMentions(text), text).toEqual(["neon-dark"]);
  }
});

it("ignores @ inside URLs, emails and longer handles", () => {
  expect(
    styleGuideMentions(
      'Use **@neon-dark** for https://x.com/@a, bob@b.com, alice.smith@c.com, alice+tag@d.com, https://www.youtube.com/results?search_query=@e, credit @f_studio, @g-dark_studio and @h-dark-v2_studio and "video team"@i.studio',
    ),
  ).toEqual(["neon-dark"]);
});
