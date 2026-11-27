import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScarletClient, StyleGuideRecord, type AgentCapabilities, type Task } from "@scarlet/shared";
import { relativeLinks } from "./graphics-tools.js";
import { createScarletMcpServer, type ScarletMcpContext } from "./server.js";

type Handler = (init: RequestInit | undefined, url: URL) => unknown;
interface Sent { key: string; url: URL; init?: RequestInit }

let workDir: string;
let sent: Sent[];
let routes: Record<string, Handler>;
const open: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  // The tools write under the folder's real path: /private/var on macOS, the long name of an 8.3 TEMP on Windows.
  workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "scarlet-graphics-tools-")));
  sent = [];
  routes = {};
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  rmSync(workDir, { recursive: true, force: true });
});

const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const key = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}`;
  sent.push({ key, url, init });
  const handler = routes[key];
  if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404, headers: { "Content-Type": "application/json" } });
  const data = handler(init, url);
  if (data instanceof Response) return data;
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
};

const full: AgentCapabilities = { images: true, audio: false, files: true, shell: true, plan: false };
const bare: AgentCapabilities = { images: false, audio: false, files: false, shell: false, plan: false };

async function connect(ctx: Partial<ScarletMcpContext> = {}) {
  const server = createScarletMcpServer(new ScarletClient({ baseUrl: "http://127.0.0.1:4199", token: "tok", fetch: fetcher }), {
    projectId: "prj_1",
    agent: "claude",
    author: { type: "agent", id: "claude", name: "Claude", model: "opus" },
    capabilities: full,
    workDir,
    ...ctx,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  open.push(c, server);
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => await c.callTool({ name, arguments: args }) as CallToolResult;
const texts = (r: CallToolResult) => r.content.filter(c => c.type === "text").map(c => (c as { text: string }).text);
const firstJson = (r: CallToolResult) => JSON.parse(texts(r)[0]!);
const images = (r: CallToolResult) => r.content.filter(c => c.type === "image").map(c => (c as { data: string }).data);
const body = (s: Sent) => JSON.parse(String(s.init?.body ?? "{}"));
const sentTo = (key: string) => sent.filter(s => s.key === key);
const tools = async (c: Client) => (await c.listTools()).tools.map(t => t.name);

const renderResult = (over: Record<string, unknown> = {}) => ({
  media: { id: "med_gfx", name: "Lower third", kind: "video" },
  source: "graphics/med_gfx/index.html",
  missingFonts: [],
  problems: [],
  checks: [{ time: 0.5, box: { left: 0.1, top: 0.7, right: 0.6, bottom: 0.9 }, jpeg: "SlBFR0E=" }, { time: 2, box: null }],
  width: 1920, height: 1080, fps: 30, duration: 4,
  renderMs: 1234.5678,
  ...over,
});

const editTask = (over: Partial<Task> = {}) => ({
  id: "tsk_sg",
  projectId: "prj_1",
  kind: "style_guide_edit",
  state: "running",
  agent: "claude",
  hostId: "host_1",
  startedAt: "2026-11-26T10:00:00.000Z",
  instruction: "Refresh the look",
  context: { styleGuideId: "sg_studio" },
  createdBy: { type: "user", id: "u1", name: "Editor" },
  ...over,
}) as unknown as Task;

describe("relativeLinks", () => {
  it("lists each page-relative file once, decoded, without queries, schemes or absolute paths", () => {
    const html = `<img src="logo.png?v=2"><img src='./img/hero%20shot.jpg#top'><link href=fonts/Brand.woff2>
      <div style="background: url( bg.png )"></div><img src="logo.png"><img src="https://cdn.example.com/x.png">
      <img src="data:image/png;base64,AAA"><img src="/abs/path.png"><img src="\\\\share\\x.png"><img src="100%.png"><img src="">`;
    expect(relativeLinks(html)).toEqual(["logo.png", "./img/hero shot.jpg", "fonts/Brand.woff2", "bg.png", "100%.png"]);
    expect(relativeLinks("<p>No links</p>")).toEqual([]);
  });
});

describe("graphic_render", () => {
  it("draws a page sent as html, aims checks at the editor's playhead, and reports what was added with its check pictures", async () => {
    let form: FormData | undefined;
    routes["POST /projects/prj_1/graphics"] = init => { form = init?.body as FormData; return renderResult({ problems: ["Image failed: a.png"], checkAt: 12 }); };
    const c = await connect({ task: { ...editTask(), kind: "edit", id: "tsk_e", context: { time: 12 } } as unknown as Task, taskId: "tsk_e" });
    const r = await call(c, "graphic_render", { html: "<html>\n<body>Hi</body></html>", name: "Lower third", duration: 4 });
    expect(r.isError).toBeFalsy();
    expect(firstJson(r)).toEqual({
      mediaId: "med_gfx", name: "Lower third", source: "graphics/med_gfx/index.html",
      duration: 4, width: 1920, height: 1080, fps: 30,
      problems: ["Image failed: a.png"],
      checks: [{ time: 0.5, box: { left: 0.1, top: 0.7, right: 0.6, bottom: 0.9 } }, { time: 2, box: null }],
      checkAt: 12, renderSeconds: 1.235,
    });
    expect(images(r)).toEqual(["SlBFR0E="]);
    const options = JSON.parse(String(form!.get("options")));
    expect(options).toMatchObject({ name: "Lower third", duration: 4, checkAt: 12, pictures: true, provenance: { name: "Claude", model: "opus" } });
    expect(await (form!.get("html") as Blob).text()).toBe("<html>\n<body>Hi</body></html>");
    expect(form!.getAll("asset")).toEqual([]);
  });

  it("checks at the start when a request is about a media file rather than the playhead, and says when a missing font kept it out", async () => {
    let form: FormData | undefined;
    routes["POST /projects/prj_1/graphics"] = init => {
      form = init?.body as FormData;
      return renderResult({ media: undefined, source: undefined, checks: [], missingFonts: [{ family: "Brand Sans", sample: "Hello" }], installedFonts: ["Inter", "Helvetica"] });
    };
    const c = await connect({ task: { ...editTask(), kind: "edit", id: "tsk_e", context: { time: 9, mediaId: "med_x" } } as unknown as Task, taskId: "tsk_e" });
    const r = await call(c, "graphic_render", { html: "<p>x</p>" });
    const out = firstJson(r);
    expect(out).toMatchObject({ added: false, missingFonts: [{ family: "Brand Sans", sample: "Hello" }], installedFonts: ["Inter", "Helvetica"] });
    expect(out.next).toContain("Not added.");
    expect(out.mediaId).toBeUndefined();
    expect(JSON.parse(String(form!.get("options"))).checkAt).toBe(0);
    expect(images(r)).toEqual([]);
  });

  it("reports a missing font without installed fonts when the engine lists none", async () => {
    routes["POST /projects/prj_1/graphics"] = () => renderResult({ media: undefined, checks: [], missingFonts: [{ family: "Brand", sample: "A" }] });
    const c = await connect();
    const out = firstJson(await call(c, "graphic_render", { html: "<p>x</p>", checkAt: 3 }));
    expect(out.installedFonts).toBeUndefined();
    expect(out.missingFonts).toHaveLength(1);
  });

  it("reads a page from the task folder with the linked files that exist beside it", async () => {
    writeFileSync(join(workDir, "page.html"), `<img src="logo.svg"><img src="missing.png"><img src="https://x.test/a.png">`);
    writeFileSync(join(workDir, "logo.svg"), "<svg/>");
    let form: FormData | undefined;
    routes["POST /projects/prj_1/graphics"] = init => { form = init?.body as FormData; return renderResult(); };
    const c = await connect();
    const r = await call(c, "graphic_render", { path: "page.html" });
    expect(r.isError).toBeFalsy();
    expect(await (form!.get("html") as Blob).text()).toContain(`src="logo.svg"`);
    const assets = form!.getAll("asset") as File[];
    expect(assets.map(a => a.name)).toEqual(["logo.svg"]);
    expect(await assets[0]!.text()).toBe("<svg/>");
  });

  it("refuses a page given both as html and as a path", async () => {
    const c = await connect();
    const r = await call(c, "graphic_render", { html: "<p>x</p>", path: "page.html" });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual(["Send html or path, not both."]);
    expect(sentTo("POST /projects/prj_1/graphics")).toEqual([]);
  });
});

describe("graphic_get", () => {
  it("returns the graphic as the engine describes it", async () => {
    routes["GET /projects/prj_1/graphics/med_gfx"] = () => ({ html: "<p>x</p>", source: "graphics/med_gfx/index.html", files: ["logo.svg"] });
    const c = await connect();
    expect(firstJson(await call(c, "graphic_get", { mediaId: "med_gfx" }))).toEqual({ html: "<p>x</p>", source: "graphics/med_gfx/index.html", files: ["logo.svg"] });
  });
});

describe("web_capture", () => {
  const shot = (url: string) => ({
    png: Buffer.from("PNGDATA").toString("base64"), title: "Article", url, text: "Words", width: 1280, height: 2400,
    headings: [{ text: "Title", box: { left: 0.12345, top: 0.0004, right: 0.98765, bottom: 0.11111 } }],
  });

  it("saves the picture under a name from the page's host and rounds heading boxes", async () => {
    routes["POST /projects/prj_1/web-captures"] = () => shot("https://www.example.com/post");
    const c = await connect();
    const r = await call(c, "web_capture", { url: "https://example.com/post", fullPage: true });
    const out = firstJson(r);
    expect(out.path).toMatch(/capture-example\.com-\d+\.png$/);
    expect(readFileSync(out.path, "utf8")).toBe("PNGDATA");
    expect(out.headings).toEqual([{ text: "Title", box: { left: 0.123, top: 0, right: 0.988, bottom: 0.111 } }]);
    expect(out).toMatchObject({ width: 1280, height: 2400, title: "Article", text: "Words" });
    expect(body(sentTo("POST /projects/prj_1/web-captures")[0]!)).toEqual({ url: "https://example.com/post", fullPage: true });
  });

  it("uses the path asked for, and a plain name when the address can't be read", async () => {
    routes["POST /projects/prj_1/web-captures"] = () => shot("not a url");
    const c = await connect();
    expect(firstJson(await call(c, "web_capture", { url: "x", path: "shots/mine.png" })).path).toBe(join(workDir, "shots", "mine.png"));
    expect(firstJson(await call(c, "web_capture", { url: "x" })).path).toMatch(/capture-page-\d+\.png$/);
  });

  it("is not offered to a harness without a shell", async () => {
    const c = await connect({ capabilities: bare });
    const names = await tools(c);
    expect(names).not.toContain("web_capture");
    expect(names).not.toContain("web_video");
  });
});

describe("web_video", () => {
  const video = { url: "https://www.youtube.com/watch?v=abc", title: "Talk", channel: "Chan", duration: 600, license: "cc-by" };

  it("describes a video and its captions when no part is asked for", async () => {
    routes["POST /projects/prj_1/web-videos"] = () => ({ video, captions: { language: "en", automatic: true, text: "0 hello\n2 world", next: 120 } });
    const c = await connect();
    const r = await call(c, "web_video", { url: video.url, captionsFrom: 0 });
    expect(texts(r)).toEqual([
      JSON.stringify({ ...video, captions: { language: "en", automatic: true, captionsNext: 120 } }),
      "0 hello\n2 world",
    ]);
  });

  it("says so when the video has no captions", async () => {
    routes["POST /projects/prj_1/web-videos"] = () => ({ video });
    const c = await connect();
    const r = await call(c, "web_video", { url: video.url });
    expect(texts(r)).toEqual([JSON.stringify({ ...video, captions: "This video has no captions." })]);
  });

  it("keeps captions' last page without a next marker and without an empty text block", async () => {
    routes["POST /projects/prj_1/web-videos"] = () => ({ video, captions: { language: "de", automatic: false, text: "" } });
    const c = await connect();
    const r = await call(c, "web_video", { url: video.url });
    expect(texts(r)).toEqual([JSON.stringify({ ...video, captions: { language: "de", automatic: false } })]);
  });

  it("downloads the part asked for with its poster and says where it came from", async () => {
    routes["POST /projects/prj_1/web-videos"] = () => ({
      video, part: { id: "part 1", from: 10, to: 20, duration: 10, width: 1920, height: 1080, size: 9, poster: Buffer.from("JPG").toString("base64") },
    });
    routes["GET /projects/prj_1/web-videos/part%201"] = () => new Response(Buffer.from("MP4BYTES"), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    const c = await connect();
    const out = firstJson(await call(c, "web_video", { url: video.url, from: 10, to: 20 }));
    expect(out.path).toMatch(/video-youtube\.com-\d+\.mp4$/);
    expect(readFileSync(out.path, "utf8")).toBe("MP4BYTES");
    expect(out.picture).toBe(out.path.replace(/\.mp4$/, ".jpg"));
    expect(readFileSync(out.picture, "utf8")).toBe("JPG");
    expect(out).toMatchObject({
      from: 10, to: 20, duration: 10, width: 1920, height: 1080, title: "Talk", channel: "Chan", license: "cc-by",
      source: { url: video.url, capture: out.picture, clip: { start: 10, end: 20 } },
    });
  });

  it("saves a part without a poster at the path asked for, named plainly when the address can't be read", async () => {
    routes["POST /projects/prj_1/web-videos"] = () => ({ video: { ...video, url: "::" }, part: { id: "p2", from: 0, to: 5, duration: 5, size: 3 } });
    routes["GET /projects/prj_1/web-videos/p2"] = () => new Response(Buffer.from("MP4"), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    const c = await connect();
    const out = firstJson(await call(c, "web_video", { url: "x", from: 0, to: 5 }));
    expect(out.path).toMatch(/video-web-\d+\.mp4$/);
    expect(out.picture).toBeUndefined();
    expect(out.source).toEqual({ url: "::", clip: { start: 0, end: 5 } });
    expect(readdirSync(workDir).filter(n => n.endsWith(".jpg"))).toEqual([]);
  });
});

describe("style_guide_save", () => {
  it("needs the guide's text or an attachment", async () => {
    const c = await connect();
    const r = await call(c, "style_guide_save", { name: "Brand", text: "   " });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual(["Give the guide's text or the attachment it is in."]);
    expect(sentTo("PUT /projects/prj_1/style-guide")).toEqual([]);
  });

  it("saves pasted text as the project's guide", async () => {
    routes["PUT /projects/prj_1/style-guide"] = init => ({ styleGuide: { name: "Brand", ...JSON.parse(String(init?.body)) } });
    const c = await connect();
    const r = await call(c, "style_guide_save", { name: "Brand", text: "Use cream." });
    expect(firstJson(r)).toEqual({ name: "Brand", text: "Use cream." });
  });

  it("uploads a file from the task folder as an attachment and saves the guide from it", async () => {
    writeFileSync(join(workDir, "guide.md"), "# Guide");
    let uploaded: File | undefined;
    routes["POST /projects/prj_1/attachments"] = init => { uploaded = (init?.body as FormData).get("file") as File; return { attachment: { id: "att_9", name: "guide.md", size: 7 } }; };
    routes["PUT /projects/prj_1/style-guide"] = () => ({ styleGuide: { name: "Guide" } });
    const c = await connect();
    const r = await call(c, "style_guide_save", { name: "Guide", path: "guide.md" });
    expect(r.isError).toBeFalsy();
    expect(uploaded!.name).toBe("guide.md");
    expect(await uploaded!.text()).toBe("# Guide");
    expect(body(sentTo("PUT /projects/prj_1/style-guide")[0]!)).toEqual({ name: "Guide", attachmentId: "att_9" });
  });
});

describe("style_guide_get and style_guide_sound_import", () => {
  const guide = StyleGuideRecord.parse({
    id: "sg_plain", name: "plain-look", description: "No color look", instructions: "Plain.",
    sounds: [{ id: "sfx_1", name: "Pop", source: "builtin", builtInId: "subtle-pop", volumeDb: 0 }],
  });

  it("reads one guide by id with the starter sounds, without waveform data", async () => {
    routes["GET /style-guides/sg_plain"] = () => ({ styleGuide: guide, edits: [] });
    const c = await connect();
    const out = firstJson(await call(c, "style_guide_get", { styleGuideId: "sg_plain" }));
    expect(out.styleGuide).toMatchObject({ id: "sg_plain", name: "plain-look", sounds: [{ id: "sfx_1", volume: 1 }] });
    expect(out.styleGuide.colorLook).toBeUndefined();
    expect(out.builtInSounds.length).toBeGreaterThan(0);
    expect(out.builtInSounds.every((s: Record<string, unknown>) => !("waveform" in s))).toBe(true);
  });

  it("says when no guide has the name asked for", async () => {
    routes["GET /style-guides"] = () => ({ styleGuides: [guide] });
    const c = await connect();
    const r = await call(c, "style_guide_get", { name: "@@Missing-Look" });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`No style guide named "@missing-look" was found.`]);
  });

  it("refuses a sound import that names neither a built-in nor a guide's sound or file", async () => {
    const c = await connect();
    const r = await call(c, "style_guide_sound_import", { styleGuideId: "sg_plain" });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual(["Provide builtInId, or styleGuideId with soundId or assetId."]);
    expect(sentTo("POST /projects/prj_1/media/from-style-sound")).toEqual([]);
  });

  it("falls back to the media's duration when the engine doesn't give the sound's own", async () => {
    routes["POST /projects/prj_1/media/from-style-sound"] = () => ({
      media: { id: "med_a", duration: 1.5 }, name: "Custom", volumeDb: -10, volume: 0.316, usageRule: "",
    });
    const c = await connect();
    const out = firstJson(await call(c, "style_guide_sound_import", { styleGuideId: "sg_plain", assetId: "sga_a" }));
    expect(out).toEqual({ mediaId: "med_a", name: "Custom", duration: 1.5, volumeDb: -10, volume: 0.316, usageRule: "" });
  });
});

describe("attachment_read", () => {
  const doc = { name: "brand.pdf", path: "/x/brand.pdf", size: 10, mime: "application/pdf", text: "Brand words", pageCount: 3,
    pages: [{ page: 1, jpeg: "P1" }, { page: 2, jpeg: "P2" }], image: { mime: "image/png", data: "IMG" } };

  it("needs exactly one thing to read", async () => {
    const c = await connect();
    for (const args of [{}, { attachmentId: "att_1", styleGuide: true }, { assetId: "sga_1" }]) {
      const r = await call(c, "attachment_read", args);
      expect(r.isError).toBe(true);
      expect(texts(r)).toEqual(["Name an attachmentId, styleGuide, or styleGuideId + assetId."]);
    }
  });

  it("returns an attachment's text, picture and page pictures to a harness that sees images", async () => {
    routes["POST /projects/prj_1/documents/read"] = () => doc;
    const c = await connect();
    const r = await call(c, "attachment_read", { attachmentId: "att_1", pages: [1, 2] });
    expect(body(sentTo("POST /projects/prj_1/documents/read")[0]!)).toEqual({ attachmentId: "att_1", pages: [1, 2] });
    expect(texts(r)).toEqual([
      JSON.stringify({ name: "brand.pdf", path: "/x/brand.pdf", size: 10, mime: "application/pdf", pageCount: 3, pagesShown: [1, 2] }),
      "Brand words",
    ]);
    expect(r.content.filter(c => c.type === "image")).toEqual([
      { type: "image", mimeType: "image/png", data: "IMG" },
      { type: "image", mimeType: "image/jpeg", data: "P1" },
      { type: "image", mimeType: "image/jpeg", data: "P2" },
    ]);
  });

  it("asks for no pages and returns no pictures to a harness that can't see them", async () => {
    routes["POST /projects/prj_1/documents/read"] = () => doc;
    const c = await connect({ capabilities: bare });
    const r = await call(c, "attachment_read", { styleGuide: true, pages: [1] });
    expect(body(sentTo("POST /projects/prj_1/documents/read")[0]!)).toEqual({ styleGuide: true, pages: [] });
    expect(firstJson(r).pagesShown).toBeUndefined();
    expect(images(r)).toEqual([]);
  });

  it("reads a library style guide's file by id, or the editing guide's file by asset id alone", async () => {
    routes["POST /style-guides/sg_other/assets/sga_1/read"] = () => ({ name: "rules.md", path: "/x/rules.md", size: 5, text: "Rules" });
    routes["POST /style-guides/sg_studio/assets/sga_2/read"] = () => ({ name: "logo.png", path: "/x/logo.png", size: 5, image: { mime: "image/png", data: "LOGO" } });
    const c = await connect({ task: editTask(), taskId: "tsk_sg" });
    const one = await call(c, "attachment_read", { styleGuideId: "sg_other", assetId: "sga_1" });
    expect(texts(one)).toEqual([JSON.stringify({ name: "rules.md", path: "/x/rules.md", size: 5 }), "Rules"]);
    expect(body(sentTo("POST /style-guides/sg_other/assets/sga_1/read")[0]!)).toEqual({});
    const two = await call(c, "attachment_read", { assetId: "sga_2", pages: [2] });
    expect(images(two)).toEqual(["LOGO"]);
    expect(body(sentTo("POST /style-guides/sg_studio/assets/sga_2/read")[0]!)).toEqual({ pages: [2] });
  });

  it("asks a style guide's file for no pages when the harness can't see pictures", async () => {
    routes["POST /style-guides/sg_other/assets/sga_1/read"] = () => ({ name: "deck.pdf", path: "/x/deck.pdf", size: 5, pages: [{ page: 1, jpeg: "P" }] });
    const c = await connect({ capabilities: bare });
    const r = await call(c, "attachment_read", { styleGuideId: "sg_other", assetId: "sga_1", pages: [1] });
    expect(body(sentTo("POST /style-guides/sg_other/assets/sga_1/read")[0]!)).toEqual({ pages: [] });
    expect(texts(r)).toEqual([JSON.stringify({ name: "deck.pdf", path: "/x/deck.pdf", size: 5 })]);
  });
});

describe("style guide authoring tools", () => {
  it("are offered only to the running style_guide_edit task the session was launched for", async () => {
    const authoring = ["style_guide_update", "style_guide_preview_render", "style_guide_preview_get"];
    const has = async (ctx: Partial<ScarletMcpContext>) => {
      const names = await tools(await connect(ctx));
      return authoring.filter(n => names.includes(n));
    };
    expect(await has({ task: editTask(), taskId: "tsk_sg" })).toEqual(authoring);
    expect(await has({ task: editTask({ agent: "codex" }), taskId: "tsk_sg" })).toEqual([]);
    expect(await has({ task: editTask({ state: "queued" }), taskId: "tsk_sg" })).toEqual([]);
    expect(await has({ task: editTask(), taskId: "tsk_other" })).toEqual([]);
    expect(await has({ task: editTask(), taskId: "tsk_sg", agent: undefined })).toEqual(authoring);
    expect(await has({})).toEqual([]);
  });

  it("refuses an update with nothing in it", async () => {
    const c = await connect({ task: editTask(), taskId: "tsk_sg" });
    const r = await call(c, "style_guide_update", {});
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain("Provide at least one field to update");
    expect(sentTo("POST /projects/prj_1/tasks/tsk_sg/style-guide-edit")).toEqual([]);
  });

  it("saves a description, caption style and cleared color look, and reports the guide's caption style back", async () => {
    routes["POST /projects/prj_1/tasks/tsk_sg/style-guide-edit"] = init => {
      const b = JSON.parse(String(init?.body));
      return { styleGuide: StyleGuideRecord.parse({ id: "sg_studio", name: "studio-look", description: b.description, captionStyle: b.captionStyle }) };
    };
    const c = await connect({ task: editTask(), taskId: "tsk_sg" });
    const r = await call(c, "style_guide_update", {
      description: "Warm cream",
      instructions: "Use cream.",
      captionStyle: { fontFamily: "Inter", uppercase: true },
      sounds: [],
      colorLook: null,
    });
    expect(body(sentTo("POST /projects/prj_1/tasks/tsk_sg/style-guide-edit")[0]!)).toEqual({
      styleGuideId: "sg_studio", hostId: "host_1", description: "Warm cream", instructions: "Use cream.",
      captionStyle: { fontFamily: "Inter", uppercase: true }, sounds: [], colorLook: null,
    });
    expect(firstJson(r)).toEqual({
      styleGuideId: "sg_studio", name: "studio-look", description: "Warm cream",
      captionStyle: { fontFamily: "Inter", uppercase: true }, transitionsCount: 0, soundsCount: 0, hasColorLook: false,
    });
  });

  it("renders a preview and shows its picture, or says a missing font left the old preview", async () => {
    let reply: Record<string, unknown> = {
      styleGuide: StyleGuideRecord.parse({ id: "sg_studio", name: "studio-look", preview: { updatedAt: "2026-11-26T10:00:00.000Z", width: 1920, height: 1080 } }),
      missingFonts: [], problems: ["Slow font"], width: 1920, height: 1080, jpeg: "PREVIEW",
    };
    routes["POST /style-guides/sg_studio/preview"] = () => reply;
    const c = await connect({ task: editTask(), taskId: "tsk_sg" });
    const ok = await call(c, "style_guide_preview_render", { html: "<p>x</p>", width: 1920, height: 1080, at: 1 });
    expect(firstJson(ok)).toEqual({ saved: true, width: 1920, height: 1080, updatedAt: "2026-11-26T10:00:00.000Z", problems: ["Slow font"] });
    expect(images(ok)).toEqual(["PREVIEW"]);
    expect(body(sentTo("POST /style-guides/sg_studio/preview")[0]!)).toEqual({ html: "<p>x</p>", width: 1920, height: 1080, at: 1 });

    reply = { missingFonts: [{ family: "Brand", sample: "Aa" }], installedFonts: ["Inter"], problems: [], width: 1920, height: 1080 };
    const missing = firstJson(await call(c, "style_guide_preview_render", { html: "<p>x</p>" }));
    expect(missing).toMatchObject({ saved: false, missingFonts: [{ family: "Brand", sample: "Aa" }], installedFonts: ["Inter"] });
    expect(missing.next).toContain("Preview not updated.");
    expect(missing.updatedAt).toBeUndefined();

    reply = { missingFonts: [{ family: "Brand", sample: "Aa" }], problems: [], width: 1920, height: 1080 };
    expect(firstJson(await call(c, "style_guide_preview_render", { html: "<p>x</p>" })).installedFonts).toBeUndefined();
  });

  it("keeps preview pictures from a harness that can't see them", async () => {
    routes["POST /style-guides/sg_studio/preview"] = () => ({ missingFonts: [], problems: [], width: 640, height: 360, jpeg: "PREVIEW" });
    routes["GET /style-guides/sg_studio/preview/source"] = () => ({ html: "<p>sheet</p>", width: 640, height: 360, updatedAt: "2026-11-26T10:00:00.000Z", jpeg: "SRC" });
    const c = await connect({ task: editTask(), taskId: "tsk_sg", capabilities: bare });
    expect(images(await call(c, "style_guide_preview_render", { html: "<p>x</p>" }))).toEqual([]);
    expect(images(await call(c, "style_guide_preview_get"))).toEqual([]);
  });

  it("reads the current preview's page with its picture", async () => {
    routes["GET /style-guides/sg_studio/preview/source"] = () => ({ html: "<p>sheet</p>", width: 640, height: 360, updatedAt: "2026-11-26T10:00:00.000Z", jpeg: "SRC" });
    const c = await connect({ task: editTask(), taskId: "tsk_sg" });
    const r = await call(c, "style_guide_preview_get");
    expect(texts(r)).toEqual([JSON.stringify({ width: 640, height: 360, updatedAt: "2026-11-26T10:00:00.000Z" }), "<p>sheet</p>"]);
    expect(images(r)).toEqual(["SRC"]);
  });
});
