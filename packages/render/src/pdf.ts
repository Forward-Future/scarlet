/**
 * PDF page counting and rasterization via PDFium + FFmpeg JPEG encoding.
 */
import { readFile } from "node:fs/promises";
import { resolveFfmpeg, runCapture } from "./exec.js";

/** How many pages a PDF says it has, when its page tree is readable without decompressing it. */
export function pdfPageCount(pdf: Buffer): number | undefined {
  const text = pdf.toString("latin1");
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map(m => Number(m[1] ?? m[2]));
  return counts.length ? Math.max(...counts) : undefined;
}

/** Rasterize the actual PDF pages. The headless browser bundled for motion graphics has no PDF viewer. */
export async function renderPdfDocument(file: string, pageNumbers: number[], opts: { width?: number; signal?: AbortSignal } = {}) {
  opts.signal?.throwIfAborted();
  const { PDFiumLibrary } = await import("@hyzyla/pdfium/inline");
  const library = await PDFiumLibrary.init({ disableBase64Warning: true });
  try {
    const document = await library.loadDocument(await readFile(file, { signal: opts.signal }));
    try {
      const pageCount = document.getPageCount();
      const pages: { page: number; jpeg: Buffer }[] = [];
      for (const n of pageNumbers) {
        opts.signal?.throwIfAborted();
        if (!Number.isInteger(n) || n < 1 || n > pageCount) continue;
        const page = document.getPage(n - 1);
        try {
          const width = opts.width ?? 1000;
          const { originalWidth, originalHeight } = page.getOriginalSize();
          // Fit the same portrait preview area as the document tool, including very long pages.
          const scale = Math.min(width / originalWidth, width * 1.3 / originalHeight);
          const raster = await page.render({
            width: Math.max(1, Math.round(originalWidth * scale)),
            height: Math.max(1, Math.round(originalHeight * scale)),
          });
          const { stdout } = await runCapture(resolveFfmpeg(), [
            "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${raster.width}x${raster.height}`,
            "-i", "pipe:0", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1",
          ], { stdin: Buffer.from(raster.data), signal: opts.signal });
          pages.push({ page: n, jpeg: stdout });
        } finally {
          page.close();
        }
      }
      return { pageCount, pages };
    } finally {
      document.destroy();
    }
  } finally {
    library.destroy();
  }
}

/** JPEGs of the requested pages in order, omitting page numbers outside the document. */
export async function pdfPages(file: string, pages: number[], opts: { width?: number; signal?: AbortSignal } = {}): Promise<Buffer[]> {
  return (await renderPdfDocument(file, pages, opts)).pages.map(page => page.jpeg);
}
