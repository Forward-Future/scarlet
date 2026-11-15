import { expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import { buildSystemPrompt } from "./prompt.js";

const project = createProject("Graphics");
const task = { instruction: "Put $lower-third on Daniel, in our style", kind: "edit" as const, agent: "claude" as const, context: {} };

it("names the files the editor attached, the template they picked and the project's style guide", () => {
  const prompt = buildSystemPrompt({
    project: { project, timeline: null }, task, skills: [],
    attachments: [{ id: "att_1", name: "Inter-Bold.ttf", size: 300_000, path: "/lib/projects/p/attachments/att_1/Inter-Bold.ttf" }],
    pickedTemplates: [{ id: "tpl_1", name: "lower-third", title: "Lower third", fields: ["Name", "Title"] }],
    styleGuide: { name: "Brand guide.pdf", path: "/lib/projects/p/style-guide/Brand guide.pdf", mime: "application/pdf" },
  });
  expect(prompt).toContain(`- File the editor attached: "Inter-Bold.ttf" (font file, 293 KB), attachment att_1, at /lib/projects/p/attachments/att_1/Inter-Bold.ttf`);
  expect(prompt).toContain(`- The editor picked the graphic template $lower-third: "Lower third" (template tpl_1), with the fields "Name", "Title".`);
  expect(prompt).toContain(`# Style guide\n\nThe editor gave this project a style guide, "Brand guide.pdf", for every graphic made in it.\n\nIt is in the PDF at /lib/projects/p/style-guide/Brand guide.pdf.`);
});

it("gives pasted guide text in full and says nothing of graphics a project doesn't have", () => {
  expect(buildSystemPrompt({ project: { project, timeline: null }, task, skills: [], styleGuide: { name: "House style", text: "White on red.\nNo drop shadows." } }))
    .toContain(`"House style", for every graphic made in it.\n\nWhite on red.\nNo drop shadows.`);
  const plain = buildSystemPrompt({ project: { project, timeline: null }, task, skills: [] });
  expect(plain).not.toContain("# Style guide");
  expect(plain).not.toContain("File the editor attached");
});
