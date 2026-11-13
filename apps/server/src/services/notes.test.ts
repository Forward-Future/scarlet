import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { createNote } from "./notes.js";

let dataDir: string;
let app: ScarletApp;
let project: Project;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-note-log-"));
  app = createApp({ dataDir, env: {}, log: () => {} });
  project = app.ctx.repos.projects.insert(createProject("Long interview"));
});
afterEach(async () => {
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

it("writes a note's time in the full history with hours past the first one", async () => {
  const user = localUser(app.ctx);
  // What the log says about a note made at this time.
  const logged = async (time: number) => {
    const { note } = await createNote(app.ctx, user, project.id, { time, text: "Check this" });
    return app.ctx.repos.activity.select("project_id = ?", [project.id]).find(entry => entry.data.noteId === note.id)?.summary;
  };
  expect(await logged(63.4)).toBe(`${user.name} noted at 1:03: “Check this”`);
  expect(await logged(3599)).toBe(`${user.name} noted at 59:59: “Check this”`);
  // 75 minutes in reads as the player's clock does, not as 75:03.
  expect(await logged(4503.2)).toBe(`${user.name} noted at 1:15:03: “Check this”`);
});
