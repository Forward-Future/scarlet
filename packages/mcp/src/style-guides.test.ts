import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProject } from "@scarlet/timeline";
import { ScarletClient, StyleGuideRecord, type Task } from "@scarlet/shared";
import { buildSystemPrompt } from "./prompt.js";
import { createScarletMcpServer } from "./server.js";

function makeClient(routes: Record<string, (init?: RequestInit) => unknown>) {
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404, headers: { "Content-Type": "application/json" } });
    const data = handler(init);
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return new ScarletClient({ baseUrl: "http://127.0.0.1:4199", token: "tok", fetch: fetcher });
}

describe("style guide MCP tools and prompts", () => {
  it("reads style guides via style_guide_get and imports SFX via style_guide_sound_import", async () => {
    const guide = StyleGuideRecord.parse({
      id: "sg_studio",
      name: "studio-look",
      description: "Matte obsidian with warm camera grade",
      instructions: "Use #141416 panels.",
      isDefault: true,
      assets: [{ id: "sga_lut", name: "StudioWarm.cube", size: 2048, mime: "text/plain" }],
      transitions: [{ id: "tr_1", name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "sfx_1", usageRule: "Default between sections", isDefault: true }],
      sounds: [{ id: "sfx_1", name: "Soft whoosh", source: "builtin", builtInId: "soft-whoosh", volumeDb: -14, duration: 0.45, usageRule: "Paired with push" }],
      colorLook: { name: "Studio Warm", notes: "Warm highlights", lutAssetId: "sga_lut", lutName: "StudioWarm.cube", adjustments: { warmth: 0.2, highlights: -0.15 } },
    });

    const receivedImportBodies: unknown[] = [];
    const client = makeClient({
      "GET /style-guides": () => ({ styleGuides: [guide] }),
      "GET /style-guides/sg_studio": () => ({ styleGuide: guide, edits: [] }),
      "POST /projects/prj_1/media/from-style-sound": (init) => {
        receivedImportBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return {
          media: { id: "med_sfx1", kind: "audio", name: "Soft whoosh.wav", path: "med_sfx1.wav", duration: 0.45, hasAudio: true },
          name: "Soft whoosh",
          volumeDb: -14,
          volume: 0.1995,
          duration: 0.45,
          usageRule: "Paired with push",
        };
      },
    });

    const server = createScarletMcpServer(client, {
      projectId: "prj_1",
      author: { type: "agent", id: "claude", name: "Claude" },
    });
    const [cTr, sTr] = InMemoryTransport.createLinkedPair();
    await server.connect(sTr);
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await mcp.connect(cTr);

    const listRes = await mcp.callTool({ name: "style_guide_get", arguments: {} });
    const listData = JSON.parse((listRes.content as Array<{ text: string }>)[0]!.text);
    expect(listData.styleGuides[0]).toMatchObject({ name: "studio-look", transitionsCount: 1, soundsCount: 1, hasColorLook: true });
    expect(listData.builtInSounds.some((s: { id: string }) => s.id === "soft-whoosh")).toBe(true);

    const oneRes = await mcp.callTool({ name: "style_guide_get", arguments: { name: "@studio-look" } });
    const oneData = JSON.parse((oneRes.content as Array<{ text: string }>)[0]!.text);
    expect(oneData.styleGuide.colorLook.lutFile).toBe("sg_studio/assets/sga_lut/StudioWarm.cube");
    expect(oneData.styleGuide.sounds[0].volume).toBeCloseTo(0.1995, 3);

    const impRes = await mcp.callTool({ name: "style_guide_sound_import", arguments: { styleGuideId: "sg_studio", soundId: "sfx_1" } });
    const impData = JSON.parse((impRes.content as Array<{ text: string }>)[0]!.text);
    expect(impData).toMatchObject({ mediaId: "med_sfx1", volumeDb: -14, volume: 0.1995, duration: 0.45 });
    expect(receivedImportBodies[0]).toEqual({ styleGuideId: "sg_studio", soundId: "sfx_1" });

    // `builtin:` shorthand in soundId normalizes cleanly to builtInId
    await mcp.callTool({ name: "style_guide_sound_import", arguments: { soundId: "builtin:subtle-pop" } });
    expect(receivedImportBodies[1]).toEqual({ builtInId: "subtle-pop" });

    await mcp.close();
    await server.close();
  });

  it("allows style_guide_update to save transitions, sounds, and colorLook during style_guide_edit tasks", async () => {
    const savedBodies: unknown[] = [];
    const client = makeClient({
      "POST /projects/prj_1/tasks/tsk_sg/style-guide-edit": (init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        savedBodies.push(body);
        return {
          styleGuide: StyleGuideRecord.parse({
            id: "sg_studio",
            name: "studio-look",
            description: body.description ?? "",
            instructions: body.instructions ?? "",
            transitions: body.transitions ?? [],
            sounds: body.sounds ?? [],
            colorLook: body.colorLook ?? undefined,
          }),
        };
      },
    });
    const task = {
      id: "tsk_sg",
      projectId: "prj_1",
      kind: "style_guide_edit",
      state: "running",
      agent: "claude",
      hostId: "host_1",
      startedAt: "2026-11-26T10:00:00.000Z",
      instruction: "Add a push transition with soft whoosh and warm color look",
      context: { styleGuideId: "sg_studio" },
      createdBy: { type: "user", id: "u1", name: "Editor" },
    } as unknown as Task;

    const server = createScarletMcpServer(client, {
      projectId: "prj_1",
      taskId: task.id,
      task,
      agent: "claude",
      author: { type: "agent", id: "claude", name: "Claude" },
    });
    const [cTr, sTr] = InMemoryTransport.createLinkedPair();
    await server.connect(sTr);
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await mcp.connect(cTr);

    const res = await mcp.callTool({
      name: "style_guide_update",
      arguments: {
        transitions: [{ id: "tr_1", name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "builtin:soft-whoosh", usageRule: "Between sections", isDefault: true }],
        colorLook: { name: "Warm Studio", notes: "Warm highlights", adjustments: { exposure: 0.1, warmth: 0.25 } },
      },
    });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(out).toMatchObject({ transitionsCount: 1, hasColorLook: true });
    expect(savedBodies[0]).toMatchObject({
      styleGuideId: "sg_studio",
      hostId: "host_1",
      transitions: [expect.objectContaining({ type: "push", soundId: "builtin:soft-whoosh" })],
      colorLook: expect.objectContaining({ name: "Warm Studio" }),
    });

    await mcp.close();
    await server.close();
  });

  it("injects transitions, sound effects, and camera color look into edit and style_guide_edit prompts", () => {
    const project = createProject("Demo");
    const editPrompt = buildSystemPrompt({
      project: { project, timeline: null },
      task: { instruction: "Grade and transition the sections", kind: "edit", agent: "claude", context: {} },
      skills: [],
      libraryStyleGuides: [{
        id: "sg_1",
        name: "studio-look",
        description: "Editorial dark",
        instructions: "Use matte black cards.",
        reason: "default",
        assets: [],
        transitions: [{ id: "tr_1", name: "Section push", type: "push", duration: 0.4, direction: "left", soundId: "sfx_1", usageRule: "Default between sections", isDefault: true }],
        sounds: [{ id: "sfx_1", name: "Soft whoosh", source: "builtin", builtInId: "soft-whoosh", volumeDb: -14, volumeLinear: 0.1995, duration: 0.45, usageRule: "On push" }],
        colorLook: { name: "Warm Studio", notes: "Subtle warmth", lutAssetId: "sga_lut", lutName: "Warm.cube", lutFile: "sg_1/assets/sga_lut/Warm.cube", adjustments: { exposure: 0.15, contrast: 1.05, saturation: 1, warmth: 0.2, tint: 0, shadows: 0.1, highlights: -0.15, blacks: 0, whites: 0, gamma: 1 } },
      }],
    });
    expect(editPrompt).toContain("### Preferred transitions");
    expect(editPrompt).toContain("Section push [Default]: push left, 0.4 s");
    expect(editPrompt).toContain("### Sound effects (SFX)");
    expect(editPrompt).toContain("style_guide_sound_import");
    expect(editPrompt).toContain("### Camera color look");
    expect(editPrompt).toContain("sg_1/assets/sga_lut/Warm.cube");

    const guide = StyleGuideRecord.parse({ id: "sg_1", name: "studio-look" });
    const authorPrompt = buildSystemPrompt({
      project: { project, timeline: null },
      task: { instruction: "Add whoosh", kind: "style_guide_edit", agent: "claude", context: { styleGuideId: "sg_1" } },
      skills: [],
      editStyleGuide: { guide, assets: [], hasPreview: false },
    });
    expect(authorPrompt).toContain("soft-whoosh");
    expect(authorPrompt).toContain("Color look");
    expect(authorPrompt).toContain("lutAssetId");
  });
});
