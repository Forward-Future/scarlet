import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import { canZscale, pictureColorOf, toneMapChain } from "./hdr.js";
import { buildFilterGraph, extractFrame, makeProxy, probeMedia, probeToAssetFields, renderRange, resolveFfmpeg, runCapture, segmentKey } from "./index.js";

describe("pictureColorOf", () => {
  it("reads HDR from the transfer tag", () => {
    expect(pictureColorOf({ color_transfer: "arib-std-b67", color_primaries: "bt2020", pix_fmt: "yuv420p10le" }))
      .toEqual({ hdr: "hlg", primaries: "bt2020", transfer: "arib-std-b67", bitDepth: 10 });
    expect(pictureColorOf({ color_transfer: "smpte2084", color_primaries: "bt2020", bits_per_raw_sample: "10" }))
      .toEqual({ hdr: "pq", primaries: "bt2020", transfer: "smpte2084", bitDepth: 10 });
  });

  it("reports nothing for an ordinary SDR picture, tagged or not", () => {
    expect(pictureColorOf({ pix_fmt: "yuv420p" })).toBeUndefined();
    expect(pictureColorOf({ color_transfer: "bt709", color_primaries: "bt709", pix_fmt: "yuv420p" })).toBeUndefined();
    expect(pictureColorOf({ color_transfer: "unknown", color_primaries: "unknown", pix_fmt: "rgb48le" })).toBeUndefined();
  });

  it("names a camera Log curve from the transfer or the file's metadata, without guessing from prose", () => {
    expect(pictureColorOf({ color_transfer: "log316", pix_fmt: "yuv420p" })).toEqual({ log: "Log (log316)", transfer: "log316" });
    expect(pictureColorOf({ color_transfer: "vlog", pix_fmt: "yuv422p10le" })).toEqual({ log: "V-Log", transfer: "vlog", bitDepth: 10 });
    expect(pictureColorOf({ pix_fmt: "yuv422p10le" }, { "com.sony.capture.gamma": "s-log3-cine" })).toEqual({ log: "S-Log3", bitDepth: 10 });
    expect(pictureColorOf({ color_primaries: "bt2020", pix_fmt: "yuv422p10le", tags: { "com.apple.proapps.cameraLog": "Apple Log" } }))
      .toEqual({ log: "Apple Log", primaries: "bt2020", bitDepth: 10 });
    expect(pictureColorOf({ pix_fmt: "yuv420p", tags: { handler_name: "Core Media Video" } }, { comment: "the camera's log of the day" })).toBeUndefined();
  });
});

describe("toneMapChain", () => {
  it("adds nothing for SDR and tone-maps HDR with zimg, or converts its matrix without it", () => {
    expect(toneMapChain(undefined, true)).toEqual([]);
    expect(toneMapChain("hlg", true)[0]).toContain("tin=arib-std-b67");
    expect(toneMapChain("pq", true)[0]).toContain("tin=smpte2084");
    expect(toneMapChain("pq", true)).toContain("zscale=t=bt709:m=bt709:r=tv");
    expect(toneMapChain("hlg", false)).toEqual([expect.stringMatching(/^colorspace=all=bt709:iall=bt2020/)]);
  });
});

describe("HDR sources", () => {
  const stats = async (file: string) => {
    const { stderr } = await runCapture(resolveFfmpeg(), ["-hide_banner", "-i", file, "-vf", "format=yuv420p,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
    const read = (key: string) => Number(new RegExp(`signalstats\\.${key}=([\\d.]+)`).exec(stderr.toString())?.[1]);
    return { yavg: read("YAVG"), sat: read("SATAVG") };
  };

  it("are tone-mapped to SDR in previews, frames and renders, and SDR sources are left as they were", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scarlet-hdr-"));
    try {
      const ffmpeg = resolveFfmpeg(), zscale = await canZscale();
      const sdr = join(dir, "sdr.mkv"), hlg = join(dir, "hlg.mkv");
      const bars = ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=1"];
      await runCapture(ffmpeg, [...bars, "-vf", "format=yuv420p", "-c:v", "ffv1", sdr]);
      if (zscale) {
        // The SDR picture as an HLG camera would record it: BT.2020, the HLG curve, 10 bits.
        await runCapture(ffmpeg, [...bars, "-vf", "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv," +
          "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt2020:t=arib-std-b67:m=bt2020nc:r=tv:npl=203,format=yuv420p10le",
          "-c:v", "ffv1", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", hlg]);
      } else {
        await runCapture(ffmpeg, [...bars, "-vf", "format=yuv420p10le", "-c:v", "ffv1", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", hlg]);
      }
      const probe = await probeMedia(hlg);
      expect(probe.color).toMatchObject({ hdr: "hlg", primaries: "bt2020" });
      expect(probeToAssetFields(await probeMedia(sdr)).color).toEqual({});

      const project = createProject("HDR", { width: 160, height: 90, fps: 10 });
      const asset = { id: "cam", name: "HLG", kind: "video" as const, path: hlg, ...probeToAssetFields(probe) };
      project.media.push(asset);
      const timeline = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 1 }]);
      const range = { start: 0, end: 1 };
      const graph = await buildFilterGraph(project, timeline, range, { mediaRoot: dir, quality: "delivery" });
      expect(graph.graph).toContain(zscale ? "tonemap=" : "colorspace=");
      await graph.cleanup();

      // An SDR source's graph and cache key don't change, with or without its recorded colour.
      const plain = createProject("SDR", { width: 160, height: 90, fps: 10 });
      plain.id = project.id;
      plain.media.push({ id: "cam", name: "SDR", kind: "video", path: sdr, ...probeToAssetFields(await probeMedia(sdr)) });
      const sdrGraph = await buildFilterGraph(plain, timeline, range, { mediaRoot: dir, quality: "delivery" });
      expect(sdrGraph.graph).not.toMatch(/zscale|tonemap|colorspace=/);
      await sdrGraph.cleanup();
      const { color: _color, ...uncoloured } = plain.media[0]!;
      expect(segmentKey(plain, timeline, range, "delivery")).toBe(segmentKey({ ...plain, media: [uncoloured] }, timeline, range, "delivery"));
      // An HDR source's sections are made again once its colour is known.
      const { color: _hdr, ...unread } = asset;
      expect(segmentKey(project, timeline, range, "delivery")).not.toBe(segmentKey({ ...project, media: [unread] }, timeline, range, "delivery"));

      if (!zscale) return;
      const reference = await stats(sdr);
      const untreated = await stats(hlg);
      const rendered = join(dir, "out.mp4");
      await renderRange(project, timeline, range, rendered, { mediaRoot: dir, quality: "delivery", hwaccel: "none" });
      const proxy = join(dir, "proxy.mp4");
      await makeProxy(hlg, proxy, { height: 90, hwaccel: "none" });
      const frame = join(dir, "frame.jpg");
      await writeFile(frame, await extractFrame(hlg, 0.5, { width: 160, hdr: "hlg" }));
      expect((await readFile(frame)).length).toBeGreaterThan(100);
      for (const file of [rendered, proxy]) {
        const { yavg, sat } = await stats(file);
        // Read as BT.709, the HLG picture keeps under half its colour. Tone-mapped, it is close to the SDR it was made from.
        expect(untreated.sat).toBeLessThan(reference.sat * 0.5);
        expect(sat).toBeGreaterThan(reference.sat * 0.75);
        expect(Math.abs(yavg - reference.yavg)).toBeLessThan(reference.yavg * 0.1);
      }
      const tags = (await probeMedia(proxy)).raw as { streams: Array<{ codec_type: string; color_transfer?: string }> };
      expect(tags.streams.find(s => s.codec_type === "video")?.color_transfer).toBe("bt709");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 120_000);
});
