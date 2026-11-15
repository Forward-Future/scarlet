import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, makeMediaClip, type Project, type Timeline } from "@scarlet/timeline";
import { execFile } from "node:child_process";
import { ChromeNotFound, chromeCandidates, findChrome, graphicCoverage, hasChrome, pdfPageCount, pdfPages, probeMedia, renderGraphic, renderGraphicStill, renderTimelineFrame, runCapture } from "./index.js";

let dir: string;

beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-graphic-test-")); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** A red bar that slides in from the left over the first half second, then holds, in a font that isn't installed. */
const PAGE = `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;background:transparent}
.bar{position:absolute;left:10%;top:60%;width:40%;height:20%;background:#ff0000;animation:in .5s linear both}
.word{position:absolute;left:5%;top:5%;color:#fff;font:20px "Scarlet Test Missing Face", sans-serif}
@keyframes in{from{transform:translateX(-200%)}to{transform:none}}
</style></head><body><div class="bar"></div><div class="word">Hi</div></body></html>`;

/** RGB of one pixel of a picture ffmpeg can read. */
async function pixel(file: string, x: number, y: number): Promise<[number, number, number]> {
  const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=2:2:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

describe("finding Chrome", () => {
  it("names every place it looked when there is no browser", () => {
    expect(() => findChrome(path.join(os.tmpdir(), "no-such-chrome"))).toThrow(ChromeNotFound);
    expect(() => findChrome(undefined, { SCARLET_CHROME: "/nowhere/chrome" })).toThrow(/SCARLET_CHROME and \/nowhere\/chrome/);
    expect(chromeCandidates("darwin")[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(chromeCandidates("win32", { PROGRAMFILES: "C:\\Program Files" })).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(chromeCandidates("linux", { PATH: "/usr/bin" })).toContain("/usr/bin/chrome-headless-shell");
  });
});

describe.skipIf(!hasChrome())("drawing a graphic", () => {
  it("writes every frame with alpha, steps CSS animations by the frame's time, and names a font it couldn't find", async () => {
    const html = path.join(dir, "bar.html");
    await fs.writeFile(html, PAGE);
    const output = path.join(dir, "bar.mov");
    const result = await renderGraphic({ htmlFile: html, width: 320, height: 180, fps: 10, duration: 1, output });
    expect(result.frames).toBe(10);
    expect(result.missingFonts).toEqual([{ family: "Scarlet Test Missing Face", sample: "Hi" }]);
    const probe = await probeMedia(output);
    expect(probe).toMatchObject({ hasAlpha: true, width: 320, height: 180, fps: 10 });
    expect(probe.duration).toBeCloseTo(1, 1);

    // Halfway through the slide the bar has moved half its run; once in, it sits at 10% to 50% of the width.
    const [early, settled] = await graphicCoverage(output, [0.25, 0.8], { width: 320, height: 180 });
    expect(settled!.box).toMatchObject({ left: expect.closeTo(0.025, 1), right: expect.closeTo(0.5, 1), bottom: expect.closeTo(0.8, 1) });
    expect(early!.box!.right).toBeLessThan(0.2);

    // Laid over a blue picture in the render graph, the bar is red and the rest of the frame stays blue.
    const blue = path.join(dir, "blue.mp4");
    await runCapture("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", blue]);
    const project: Project = createProject("Graphic", { width: 320, height: 180, fps: 10, aspect: "custom" });
    project.media.push(
      { id: "bg", kind: "video", name: "blue.mp4", path: "blue.mp4", duration: 2, fps: 10, width: 320, height: 180, hasAudio: false, hasAlpha: false },
      { id: "gfx", kind: "graphic", name: "bar.mov", path: "bar.mov", duration: 1, fps: 10, width: 320, height: 180, hasAudio: false, hasAlpha: true },
    );
    const timeline: Timeline = {
      version: "draft", parent: null, projectId: project.id, name: "Main", background: "#000000", markers: [], captionStyle: {},
      tracks: [
        { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [makeMediaClip("bg", 0, 2, 0, { id: "c1" })] },
        { id: "v2", kind: "video", name: "V2", muted: false, hidden: false, clips: [makeMediaClip("gfx", 0, 1, 0.5, { id: "g1" })] },
      ],
    } as Timeline;
    const frame = path.join(dir, "frame.jpg");
    const jpeg = await renderTimelineFrame(project, timeline, { start: 1.3, end: 1.4 }, dir, undefined, 320);
    await fs.writeFile(frame, jpeg);
    const [r, g, b] = await pixel(frame, 96, 126);
    expect(r).toBeGreaterThan(200);
    expect(g + b).toBeLessThan(80);
    const [r2, , b2] = await pixel(frame, 250, 30);
    expect(b2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(60);
  });

  it("draws one moment as a transparent PNG at the size asked", async () => {
    const html = path.join(dir, "still.html");
    await fs.writeFile(html, PAGE);
    const { png, missingFonts } = await renderGraphicStill({ htmlFile: html, width: 320, height: 180, time: 0.8, outputWidth: 160 });
    expect(missingFonts).toHaveLength(1);
    const file = path.join(dir, "still.png");
    await fs.writeFile(file, png);
    expect(png.readUInt32BE(16)).toBe(160);
    expect(png.readUInt32BE(20)).toBe(90);
    const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", file, "-vf", "crop=1:1:150:10", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    expect(stdout[3]).toBe(0);
  });

  it("calls the page's own seek, and reports a script error and a file the page couldn't load", async () => {
    const html = path.join(dir, "seek.html");
    await fs.writeFile(html, `<!doctype html><html><body style="margin:0;background:transparent"><link rel="stylesheet" href="missing.css">
      <div id="box" style="position:absolute;top:0;height:100%;width:10%;background:#0f0"></div>
      <script>window.scarletSeek = async t => { document.getElementById("box").style.left = (t * 80) + "%"; };
      setTimeout(() => { throw new Error("boom"); }, 0);</script></body></html>`);
    const output = path.join(dir, "seek.mov");
    const result = await renderGraphic({ htmlFile: html, width: 200, height: 100, fps: 4, duration: 1, output, pages: 2 });
    expect(result.problems.join(" ")).toMatch(/boom/);
    expect(result.problems.join(" ")).toMatch(/missing\.css|ERR_FILE_NOT_FOUND|Failed to load/);
    const boxes = await graphicCoverage(output, [0, 0.5, 0.75], { width: 200, height: 100 });
    expect(boxes.map(b => b.box?.left)).toEqual([0, expect.closeTo(0.4, 1), expect.closeTo(0.6, 1)]);
  });

  it("draws a PDF's pages for a model that can't open the file, and leaves out pages past its end", async () => {
    const html = path.join(dir, "guide.html");
    await fs.writeFile(html, `<h1 style="color:#d00">Brand guide</h1><div style="page-break-after:always"></div><h1>Lower thirds</h1>`);
    const pdf = path.join(dir, "guide.pdf");
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-print-"));
    try {
      await new Promise<void>((resolve, reject) => execFile(findChrome(), ["--headless=new", "--no-pdf-header-footer", `--user-data-dir=${profile}`, `--print-to-pdf=${pdf}`, html], error => error ? reject(error) : resolve()));
    } finally { await fs.rm(profile, { recursive: true, force: true }); }
    expect(pdfPageCount(await fs.readFile(pdf))).toBe(2);
    const pages = await pdfPages(pdf, [1, 2, 3], { width: 400, settleMs: 1500 });
    expect(pages).toHaveLength(2);
    const first = path.join(dir, "page1.jpg");
    await fs.writeFile(first, pages[0]!);
    // The heading's red is drawn on the first page.
    const { stdout } = await runCapture("ffmpeg", ["-v", "error", "-i", first, "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1"]);
    expect([...Array(stdout.length / 3).keys()].some(i => stdout[i * 3]! > 180 && stdout[i * 3 + 1]! < 80 && stdout[i * 3 + 2]! < 80)).toBe(true);
  });

  it("stops Chrome and leaves no movie when cancelled", async () => {
    const html = path.join(dir, "cancel.html");
    await fs.writeFile(html, PAGE);
    const output = path.join(dir, "cancel.mov");
    const controller = new AbortController();
    const rendering = renderGraphic({ htmlFile: html, width: 320, height: 180, fps: 30, duration: 20, output, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(rendering).rejects.toThrow();
    await expect(fs.stat(output)).rejects.toThrow();
  });
});
