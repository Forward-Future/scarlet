import { expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import { buildSystemPrompt } from "./prompt.js";

const project = createProject("Graphics");
const task = { instruction: "Put a lower third on Daniel, in our style", kind: "edit" as const, agent: "claude" as const, context: {} };

it("names the files the editor attached and the project's style guide", () => {
  const prompt = buildSystemPrompt({
    project: { project, timeline: null }, task, skills: [],
    attachments: [{ id: "att_1", name: "Inter-Bold.ttf", size: 300_000, path: "/lib/projects/p/attachments/att_1/Inter-Bold.ttf" }],
    styleGuide: { name: "Brand guide.pdf", path: "/lib/projects/p/style-guide/Brand guide.pdf", mime: "application/pdf" },
  });
  expect(prompt).toContain(`- File the editor attached: "Inter-Bold.ttf" (font file, 293 KB), attachment att_1, at /lib/projects/p/attachments/att_1/Inter-Bold.ttf`);
  expect(prompt).toContain(`# Style guide\n\nThe editor gave this project a style guide, "Brand guide.pdf", for captions, lower thirds, boxes, and graphics made in it.\n\nIt is in the PDF at /lib/projects/p/style-guide/Brand guide.pdf.`);
});

it("gives pasted guide text in full and says nothing of graphics a project doesn't have", () => {
  expect(buildSystemPrompt({ project: { project, timeline: null }, task, skills: [], styleGuide: { name: "House style", text: "White on red.\nNo drop shadows." } }))
    .toContain(`"House style", for captions, lower thirds, boxes, and graphics made in it.\n\nWhite on red.\nNo drop shadows.`);
  const plain = buildSystemPrompt({ project: { project, timeline: null }, task, skills: [] });
  expect(plain).not.toContain("# Style guide");
  expect(plain).not.toContain("File the editor attached");
});

it("says what the editor drew on the picture, where, and which attachment shows it", () => {
  const drawn = { ...task, instruction: "Blur 1 and swap 2 for the new logo", context: { pictureMarks: {
    attachmentId: "att_frame", time: 7, version: "ver_1",
    marks: [
      { kind: "draw" as const, box: { x: 0.55, y: 0.4, w: 0.1, h: 0.2 }, points: [[0.55, 0.5], [0.65, 0.5]] as [number, number][] },
      { kind: "point" as const, box: { x: 0.7, y: 0.3, w: 0, h: 0 } },
    ],
  } } };
  const prompt = buildSystemPrompt({ project: { project, timeline: null }, task: drawn, skills: [],
    attachments: [{ id: "att_frame", name: "Marked frame 0.07.png", size: 9000, mime: "image/png", path: "/lib/projects/p/attachments/att_frame/Marked frame 0.07.png" }] });
  expect(prompt).toContain(`- The editor drew 2 numbered marks on the picture at timeline 7.00 s (0:07.00) on version ver_1, in fractions of the frame from its top left: mark 1, a line drawn by hand over 0.55–0.65 across and 0.40–0.60 down; mark 2, a point at 0.70 across, 0.30 down. The frame with the marks drawn on it is attachment att_frame ("Marked frame 0.07.png").`);
  const one = buildSystemPrompt({ project: { project, timeline: null }, skills: [],
    task: { ...drawn, context: { pictureMarks: { ...drawn.context.pictureMarks, marks: [{ kind: "box" as const, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }] } } } });
  expect(one).toContain("drew a mark on the picture at timeline 7.00 s (0:07.00) on version ver_1, in fractions of the frame from its top left: a box over 0.10–0.40 across and 0.20–0.60 down.");
});

it("includes structured captionStyle and covers captions, lower thirds, boxes, and graphics in library style guide prompts", () => {
  const prompt = buildSystemPrompt({
    project: { project, timeline: null },
    task,
    skills: [],
    libraryStyleGuides: [
      {
        id: "sg_brand",
        name: "channel-brand",
        description: "Crisp white captions with amber highlight and slate cards",
        instructions: "Use Inter Bold for captions and lower thirds.",
        captionStyle: {
          fontFamily: "Inter",
          fontWeight: "bold",
          color: "#FFFFFF",
          highlightColor: "#F59E0B",
          backgroundColor: "#0F172ACC",
          y: 0.86,
        },
        reason: "default",
        assets: [{ id: "sga_1", name: "Inter-Bold.ttf", size: 220_000, mime: "font/ttf", path: "/lib/style-guides/sg_brand/assets/sga_1/Inter-Bold.ttf" }],
      },
    ],
  });
  expect(prompt).toContain("captions, lower thirds, callout boxes, motion graphics, titles, or overlays");
  expect(prompt).toContain("### Caption style");
  expect(prompt).toContain(`"fontWeight": "bold"`);
  expect(prompt).toContain(`"highlightColor": "#F59E0B"`);
  expect(prompt).toContain("captions_generate");
});

it("instructs style_guide_edit runs to design captions, lower thirds, callout boxes, and structured captionStyle", () => {
  const prompt = buildSystemPrompt({
    project: { project, timeline: null },
    task: { instruction: "Set up my channel look", kind: "style_guide_edit", agent: "claude", context: { styleGuideId: "sg_brand" } },
    skills: [],
    editStyleGuide: {
      guide: {
        id: "sg_brand",
        name: "channel-brand",
        description: "",
        instructions: "",
        captionStyle: { fontFamily: "Inter", fontWeight: "semibold", color: "#FFFFFF" },
        isDefault: true,
        assets: [],
      },
      assets: [],
      hasPreview: false,
    },
  });
  expect(prompt).toContain("captions, lower thirds, callout boxes, and motion graphics");
  expect(prompt).toContain("captionStyle");
  expect(prompt).toContain("Caption sample");
  expect(prompt).toContain("Current caption style:");
  expect(prompt).toContain(`"fontWeight": "semibold"`);
});
