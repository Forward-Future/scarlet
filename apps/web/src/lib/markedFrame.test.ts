// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PictureMark } from "@scarlet/shared";
import { markedFramePicture } from "./markedFrame";

/** A 2D context that records what was drawn, in order, with the style each call was made with. */
function recordingContext() {
  const calls: { name: string; args: unknown[]; strokeStyle?: unknown; fillStyle?: unknown; lineWidth?: unknown; font?: unknown; shadowBlur?: unknown }[] = [];
  const g: Record<string, unknown> = { lineCap: "", lineJoin: "", shadowColor: "", shadowBlur: 0, strokeStyle: "", fillStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "" };
  for (const name of ["drawImage", "strokeRect", "beginPath", "moveTo", "lineTo", "stroke", "arc", "fill", "fillText"]) {
    g[name] = (...args: unknown[]) => { calls.push({ name, args, strokeStyle: g.strokeStyle, fillStyle: g.fillStyle, lineWidth: g.lineWidth, font: g.font, shadowBlur: g.shadowBlur }); };
  }
  return { g, calls, named: (name: string) => calls.filter(c => c.name === name) };
}

const png = new Blob(["png"], { type: "image/png" });
let ctx: ReturnType<typeof recordingContext>;
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };
let canvas: HTMLCanvasElement | undefined;

beforeEach(() => {
  ctx = recordingContext();
  bitmap = { width: 1920, height: 1080, close: vi.fn() };
  canvas = undefined;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["jpeg"]), { status: 200 })));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    canvas = this;
    return ctx.g as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement["getContext"]);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done: BlobCallback, type?: string) => { done(type === "image/png" ? png : null); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const box = (x: number, y: number, w = 0, h = 0) => ({ x, y, w, h });

describe("markedFramePicture", () => {
  it("draws the frame at its own size, then a single box without a number, and saves a PNG", async () => {
    const marks: PictureMark[] = [{ kind: "box", box: box(0.25, 0.5, 0.5, 0.25) }];
    await expect(markedFramePicture("/frames/f.jpg", marks)).resolves.toBe(png);
    expect(fetch).toHaveBeenCalledWith("/frames/f.jpg");
    expect(canvas?.width).toBe(1920);
    expect(canvas?.height).toBe(1080);
    expect(ctx.calls[0]).toMatchObject({ name: "drawImage", args: [bitmap, 0, 0] });
    expect(bitmap.close).toHaveBeenCalledOnce();
    // The line grows with the frame: 1920 / 320 = 6 px, in the app's own white.
    expect(ctx.named("strokeRect")).toEqual([expect.objectContaining({ args: [480, 540, 960, 270], strokeStyle: "#f4f1e9", lineWidth: 6 })]);
    expect(ctx.named("arc")).toEqual([]);
    expect(ctx.named("fillText")).toEqual([]);
    expect(ctx.g.lineCap).toBe("round");
    expect(ctx.g.shadowBlur).toBe(9);
  });

  it("draws a point as a small dot and keeps the line at least 1.5 px on a tiny frame", async () => {
    bitmap = { width: 100, height: 80, close: vi.fn() };
    await markedFramePicture("/f.jpg", [{ kind: "point", box: box(0.5, 0.5) }]);
    expect(ctx.named("arc")).toEqual([expect.objectContaining({ args: [50, 40, 1.5 * 2.2, 0, Math.PI * 2], fillStyle: "#f4f1e9", lineWidth: 1.5 })]);
    expect(ctx.named("fill")).toHaveLength(1);
    expect(ctx.named("fillText")).toEqual([]);
  });

  it("follows a freehand line through its points and skips one with no points", async () => {
    bitmap = { width: 640, height: 320, close: vi.fn() };
    await markedFramePicture("/f.jpg", [
      { kind: "draw", box: box(0.1, 0.1, 0.5, 0.5), points: [[0.1, 0.1], [0.5, 0.25], [0.75, 1]] },
    ]);
    expect(ctx.named("moveTo").map(c => c.args)).toEqual([[64, 32]]);
    expect(ctx.named("lineTo").map(c => c.args)).toEqual([[320, 80], [480, 320]]);
    expect(ctx.named("stroke")).toHaveLength(1);

    ctx = recordingContext();
    await markedFramePicture("/f.jpg", [{ kind: "draw", box: box(0.1, 0.1), points: [] }]);
    await markedFramePicture("/f.jpg", [{ kind: "draw", box: box(0.1, 0.1) }]);
    expect(ctx.named("stroke")).toEqual([]);
    expect(ctx.named("arc")).toEqual([]);
  });

  it("numbers every mark from one when there are several, in a dark bold figure on a larger dot", async () => {
    bitmap = { width: 320, height: 320, close: vi.fn() };
    await markedFramePicture("/f.jpg", [
      { kind: "box", box: box(0.25, 0.25, 0.5, 0.5) },
      { kind: "point", box: box(0.5, 0.75) },
      { kind: "draw", box: box(0, 0, 1, 1), points: [[0, 0], [1, 1]] },
    ]);
    const r = 1.5 * 3.4;
    expect(ctx.named("arc").map(c => c.args)).toEqual([[80, 80, r, 0, Math.PI * 2], [160, 240, r, 0, Math.PI * 2], [0, 0, r, 0, Math.PI * 2]]);
    expect(ctx.named("fillText").map(c => c.args)).toEqual([["1", 80, 80 + r * 0.06], ["2", 160, 240 + r * 0.06], ["3", 0, r * 0.06]]);
    // The figure is drawn without a shadow, and each mark after it is back in white with its shadow.
    expect(ctx.named("fillText").every(c => c.fillStyle === "#141312" && c.shadowBlur === 0 && c.font === `700 ${Math.round(r * 1.25)}px -apple-system, system-ui, sans-serif`)).toBe(true);
    expect(ctx.named("arc").every(c => c.fillStyle === "#f4f1e9" && c.shadowBlur === 2.25)).toBe(true);
    expect(ctx.g.textAlign).toBe("center");
    expect(ctx.g.textBaseline).toBe("middle");
  });

  it("saves the bare frame when there are no marks", async () => {
    await expect(markedFramePicture("/f.jpg", [])).resolves.toBe(png);
    expect(ctx.calls.map(c => c.name)).toEqual(["drawImage"]);
  });

  it("says the frame didn't load when the engine answers with an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await expect(markedFramePicture("/f.jpg", [])).rejects.toThrow("The frame didn't load (404).");
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("says the frame couldn't be drawn without a 2D canvas, and couldn't be saved when no PNG comes back", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(markedFramePicture("/f.jpg", [])).rejects.toThrow("The frame couldn't be drawn.");

    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx.g as unknown as CanvasRenderingContext2D);
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((done: BlobCallback) => { done(null); });
    await expect(markedFramePicture("/f.jpg", [])).rejects.toThrow("The frame couldn't be saved.");
  });
});
