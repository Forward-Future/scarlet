import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { adoptLinkedFiles, attachmentName, saveStyleGuide, swapInFolder } from "./graphics.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-graphics-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  project = workspace.ctx.repos.projects.insert(createProject("Graphics"));
  workspace.ctx.paths.ensureProject(project.id);
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function linked(folder: string) {
  return existsSync(join(folder, "linked")) ? readdirSync(join(folder, "linked")) : [];
}

it("brings in a linked file whose name has a space, a percent sign or a %-escape, and links its copy", async () => {
  const root = workspace.ctx.paths.project(project.id);
  const files = join(root, "attachments", "att_1");
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "My Logo.png"), "logo");
  writeFileSync(join(files, "100%.png"), "full");
  writeFileSync(join(files, "a b.png"), "spaced");
  const folder = join(directory, "page");
  mkdirSync(folder);
  const html = [
    `<img src="${join(files, "My Logo.png")}">`,
    `<img src='${join(files, "100%.png")}'>`,
    `<img src="${pathToFileURL(join(files, "a b.png")).href}">`,
    `<div style="background: url(${join(files, "a%20b.png")})"></div>`,
  ].join("\n");
  const out = await adoptLinkedFiles(html, folder, [root]);
  expect(linked(folder).map(n => n.slice(9)).sort()).toEqual(["100%.png", "My Logo.png", "a b.png"]);
  // Each link now names its copy, encoded as a URL, in the quotes it had.
  const links = [...out.matchAll(/(?:src=|url\()(["']?)([^"')]+)\1/g)].map(m => m[2]!);
  expect(links).toHaveLength(4);
  for (const link of links) {
    expect(link.startsWith("linked/")).toBe(true);
    expect(existsSync(join(folder, decodeURIComponent(link)))).toBe(true);
  }
  expect(readFileSync(join(folder, decodeURIComponent(links[1]!)), "utf8")).toBe("full");
  // The file URL and the %-escaped path name the same file, so both use one copy.
  expect(links[2]).toBe(links[3]);
  expect(readFileSync(join(folder, decodeURIComponent(links[3]!)), "utf8")).toBe("spaced");
});

it("leaves a page alone when a link's escapes don't decode and name no file", async () => {
  const folder = join(directory, "page");
  mkdirSync(folder);
  const html = `<img src="/nowhere/100%zz.png"><a href="https://example.com/a b">x</a>`;
  expect(await adoptLinkedFiles(html, folder, [workspace.ctx.paths.project(project.id)])).toBe(html);
});

it("puts a staged folder in place, and keeps the one there when the new one can't go in", async () => {
  const folder = join(directory, "guide");
  mkdirSync(folder);
  writeFileSync(join(folder, "old.txt"), "old");
  await expect(swapInFolder(join(directory, "missing-staging"), folder)).rejects.toThrow();
  expect(readFileSync(join(folder, "old.txt"), "utf8")).toBe("old");

  const staging = join(directory, "guide.next");
  mkdirSync(staging);
  writeFileSync(join(staging, "new.txt"), "new");
  await swapInFolder(staging, folder);
  expect(readdirSync(folder)).toEqual(["new.txt"]);
  expect(readdirSync(directory).filter(n => n.startsWith("guide"))).toEqual(["guide"]);
});

// Windows ignores a file mode of 0, and root reads through it, so neither can make the copy fail this way.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves no staging folder and keeps the guide there when its file can't be copied", async () => {
  const { ctx } = workspace;
  const attachment = join(ctx.paths.attachments(project.id), "att_guide");
  mkdirSync(attachment, { recursive: true });
  writeFileSync(join(attachment, "guide.pdf"), "guide");
  await saveStyleGuide(ctx, project.id, { name: "House style", attachmentId: "att_guide" }, null);
  chmodSync(join(attachment, "guide.pdf"), 0o000);
  try {
    await expect(saveStyleGuide(ctx, project.id, { name: "New style", attachmentId: "att_guide" }, null)).rejects.toThrow();
  } finally {
    chmodSync(join(attachment, "guide.pdf"), 0o600);
  }
  const root = ctx.paths.project(project.id);
  expect(readdirSync(root).filter(n => n.startsWith("style-guide"))).toEqual(["style-guide"]);
  expect(readFileSync(join(ctx.paths.styleGuides(project.id), "guide.pdf"), "utf8")).toBe("guide");
});

it("keeps an attachment's name as given, minus what could leave its folder or hide it", () => {
  expect(attachmentName("C:\\Users\\me\\Brand: guide?.pdf")).toBe("Brand_ guide_.pdf");
  expect(attachmentName("../..//.hidden")).toBe("hidden");
  expect(attachmentName("tab\there.png")).toBe("tab_here.png");
});
