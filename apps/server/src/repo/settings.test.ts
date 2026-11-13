import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { createRepos } from "./index.js";

it("reads an Off saved before as the engine Scarlet ships with, since transcription can't be turned off", () => {
  const repos = createRepos(openDb(":memory:"), "whispercpp");
  repos.settings.update({ transcription: { provider: "none" } });
  expect(repos.settings.get().transcription.provider).toBe("whispercpp");
});

it("keeps saying none where the build has no engine to run", () => {
  const repos = createRepos(openDb(":memory:"), "none");
  expect(repos.settings.get().transcription.provider).toBe("none");
  repos.settings.update({ transcription: { provider: "openai" } });
  expect(repos.settings.get().transcription.provider).toBe("openai");
});
