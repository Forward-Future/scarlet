import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capturePage, graphicCoverage, graphicOver, hasChrome, renderGraphic, renderGraphicStill, runCapture } from "./index.js";
import { resolveFfmpeg } from "./exec.js";

let dir: string;

beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-graphic-edge-")); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** RGB of one pixel of a picture ffmpeg can read. */
async function pixel(file: string, x: number, y: number): Promise<[number, number, number]> {
  const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", "-i", file, "-vf", `crop=2:2:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

/** A one-second ProRes 4444 movie with alpha, as a graphic is written, of a colour at an opacity. */
async function alphaMovie(name: string, color: string): Promise<string> {
  const file = path.join(dir, name);
  await runCapture(resolveFfmpeg(), ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=64x64:d=1:r=10,format=yuva444p10le`,
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", file]);
  return file;
}

describe("reading a graphic back", () => {
  it("finds no drawn part in a frame that is wholly transparent", async () => {
    const movie = await alphaMovie("clear.mov", "black@0.0");
    expect(await graphicCoverage(movie, [0, 0.5], { width: 64, height: 64 })).toEqual([{ time: 0, box: null }, { time: 0.5, box: null }]);
  });

  it("finds the whole frame drawn in an opaque graphic, measured at no less than two pixels", async () => {
    const movie = await alphaMovie("solid.mov", "red");
    expect(await graphicCoverage(movie, [0.2], { width: 4, height: 4 })).toEqual([{ time: 0.2, box: { left: 0, top: 0, right: 1, bottom: 1 } }]);
  });

  it("lays a graphic over the edit's own picture when there is one", async () => {
    const movie = await alphaMovie("clear-over.mov", "black@0.0");
    const background = path.join(dir, "blue.jpg");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", background]);
    const jpeg = path.join(dir, "over-blue.jpg");
    await fs.writeFile(jpeg, await graphicOver(movie, 0.5, await fs.readFile(background), { width: 63, height: 63 }));
    const [r, g, b] = await pixel(jpeg, 30, 30);
    expect(b).toBeGreaterThan(200);
    expect(Math.max(r, g)).toBeLessThan(40);
    // Over mid grey when there is none.
    await fs.writeFile(jpeg, await graphicOver(movie, 0.5, null, { width: 64, height: 64 }));
    const grey = await pixel(jpeg, 30, 30);
    expect(Math.min(...grey)).toBeGreaterThan(70);
    expect(Math.max(...grey)).toBeLessThan(110);
  });
});

describe.skipIf(!hasChrome() || process.platform === "win32")("when ffmpeg can't write the graphic", () => {
  const page = async (name: string, html: string) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, html);
    return file;
  };
  const fakeFfmpeg = async (name: string, script: string) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };
  const moving = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:50%;height:50%;background:#f00;animation:a 1s linear both"></div>
    <style>@keyframes a{from{opacity:0}to{opacity:1}}</style></body></html>`;

  it("reports what ffmpeg said, and leaves no movie behind", async () => {
    const html = await page("fail.html", moving);
    const ffmpegPath = await fakeFfmpeg("ffmpeg-fails", `echo "first line" >&2\necho "Unknown encoder 'prores_ks'" >&2\nexit 3`);
    const output = path.join(dir, "fail.mov");
    await fs.writeFile(output, "stale");
    await expect(renderGraphic({ htmlFile: html, width: 64, height: 64, fps: 10, duration: 1, output, ffmpegPath, pages: 1 }))
      .rejects.toThrow(/ffmpeg couldn't write the graphic \(exit 3\): first line Unknown encoder 'prores_ks'/);
    await expect(fs.stat(output)).rejects.toThrow();
  });

  it("stops when ffmpeg ends before the frames are written", async () => {
    const html = await page("early.html", moving);
    const ffmpegPath = await fakeFfmpeg("ffmpeg-quits", "exit 0");
    const output = path.join(dir, "early.mov");
    await expect(renderGraphic({ htmlFile: html, width: 64, height: 64, fps: 30, duration: 2, output, ffmpegPath, pages: 1 }))
      .rejects.toThrow("ffmpeg stopped before the graphic was drawn.");
  });

  it("waits for a slow ffmpeg to take each frame, and stops writing once it has gone", async () => {
    // Noise doesn't compress, so one frame is more than the pipe holds and the writer has to wait for ffmpeg.
    const html = await page("noise.html", `<!doctype html><html><body style="margin:0"><canvas id="c" width="480" height="270"></canvas><script>
      const c = document.getElementById("c").getContext("2d"), img = c.createImageData(480, 270);
      window.scarletSeek = () => { for (let i = 0; i < img.data.length; i++) img.data[i] = Math.random() * 256; c.putImageData(img, 0, 0); };
    </script></body></html>`);
    const ffmpegPath = await fakeFfmpeg("ffmpeg-slow", `sleep 0.3\necho "slow and broken" >&2\nexit 2`);
    const output = path.join(dir, "noise.mov");
    const progress: number[] = [];
    await expect(renderGraphic({ htmlFile: html, width: 480, height: 270, fps: 10, duration: 1, output, ffmpegPath, pages: 1, onProgress: f => progress.push(f) }))
      .rejects.toThrow(/exit 2\): slow and broken/);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(10);
  });
});

describe.skipIf(!hasChrome())("taking a page's picture", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/moved") { res.writeHead(302, { location: "/article" }); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Field notes</title></head><body style="margin:0;font:16px sans-serif">
        <h1 style="margin:0;height:100px">Opening</h1><p>Words a reader sees.</p>
        <div style="height:1500px"></div><h2 style="height:50px">Far down</h2><h3></h3></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it("takes the whole page down to the height allowed, after any redirect, with its words and headings", async () => {
    const capture = await capturePage({ url: `${base}/moved`, width: 400, height: 300, fullPage: true, maxHeight: 1000 });
    expect(capture).toMatchObject({ title: "Field notes", url: `${base}/article`, width: 400, height: 1000 });
    expect(capture.text).toContain("Words a reader sees.");
    expect(capture.png.readUInt32BE(16)).toBe(400);
    expect(capture.png.readUInt32BE(20)).toBe(1000);
    // The heading past the picture's foot and the empty one are left out.
    expect(capture.headings).toEqual([{ text: "Opening", box: { left: 0, top: 0, right: 1, bottom: 0.1 } }]);
  }, 30_000);

  it("says the page, not the graphic, couldn't be opened", async () => {
    const closed = http.createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const failure = capturePage({ url: `http://127.0.0.1:${port}/`, width: 200, height: 100 });
    await expect(failure).rejects.toThrow(/Chrome couldn't open the page: net::ERR_CONNECTION_REFUSED/);
    await expect(failure).rejects.not.toThrow(/graphic/);
  });

  it("draws one moment at the page's own size when no width is asked", async () => {
    const html = path.join(dir, "plain.html");
    await fs.writeFile(html, "<!doctype html><html><body style=\"margin:0;background:#00f\"></body></html>");
    const { png, missingFonts, problems } = await renderGraphicStill({ htmlFile: html, width: 120, height: 60, time: 0 });
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([120, 60]);
    expect(missingFonts).toEqual([]);
    expect(problems).toEqual([]);
  });
});
