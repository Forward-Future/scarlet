import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFfmpeg, runCapture } from "./exec.js";
import { keptPieces, soundPicture, soundPictureGraph } from "./soundPicture.js";

describe("a passage as waveform and spectrogram", () => {
  it("lays the cut row out at the recorded row's scale, with the removed range out", () => {
    expect(keptPieces({ start: 10, end: 14 }, [{ start: 11, end: 12 }, { start: 13.5, end: 20 }])).toEqual([{ start: 10, end: 11 }, { start: 12, end: 13.5 }]);
    const words = [{ text: "it's", start: 10.2, end: 10.5 }, { text: "gone:", start: 11.2, end: 11.6 }, { text: "here", start: 12.4, end: 12.8 }];
    const { graph, layout } = soundPictureGraph({ range: { start: 10, end: 14 }, remove: [{ start: 11, end: 12 }], words });
    expect(layout).toEqual({ width: 1280, height: 768, pixelsPerSecond: 320, rows: [
      { shows: "recorded", top: 0, bottom: 384, left: 0, right: 1280, seconds: 4 }, { shows: "cut", top: 384, bottom: 768, left: 0, right: 960, seconds: 3 }] });
    // The kept stretches are joined in the passage's own seconds, and the join is drawn where the first one ends.
    expect(graph).toContain("atrim=0.0000:1.0000,asetpts=PTS-STARTPTS[p0]");
    expect(graph).toContain("atrim=2.0000:4.0000,asetpts=PTS-STARTPTS[p1]");
    expect(graph).toContain("drawbox=x=319:y=406:w=2");
    // A word's text cannot break the filter graph, and a removed word is not drawn on the cut row.
    expect(graph).toContain("text='it’s'");
    expect(graph.match(/text='gone'/g)).toHaveLength(1);
    expect(graph.match(/text='here'/g)).toHaveLength(2);
    // Without a removal there is one row.
    expect(soundPictureGraph({ range: { start: 10, end: 14 } }).layout.rows).toHaveLength(1);
  });

  describe("rendered", () => {
    let dir: string;
    beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "scarlet-sound-picture-")); });
    afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

    it("draws both rows of a real recording as one JPEG of the size it reports", async () => {
      const file = join(dir, "tone.wav");
      await runCapture(resolveFfmpeg(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ar", "48000", file]);
      const { jpeg, layout } = await soundPicture(file, { range: { start: .5, end: 3.5 }, remove: [{ start: 1.5, end: 2 }], words: [{ text: "tone", start: 1, end: 1.3 }] });
      expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        { stdin: jpeg, maxStdout: 4 * 1024 * 1024 });
      expect(stdout.length).toBe(layout.width * layout.height);
      expect(layout.rows.map(r => r.seconds)).toEqual([3, 2.5]);
    });

    it("draws sound that starts after the picture at its own time on both rows", async () => {
      // As a phone or camera MP4 often is: the picture from 0, the sound from 0.5 s, a tone over [0.5, 1].
      const file = join(dir, "late-sound.mp4");
      await runCapture(resolveFfmpeg(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=2",
        "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5,apad=whole_dur=1.5",
        "-c:v", "mpeg4", "-c:a", "aac", file]);
      const { jpeg, layout } = await soundPicture(file, { range: { start: 0, end: 2 }, remove: [{ start: 1.2, end: 1.5 }] });
      const { stdout: px } = await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        { stdin: jpeg, maxStdout: 4 * 1024 * 1024 });
      // The columns where each row's waveform stands tall: the tone, at 640 px a second.
      const tone = layout.rows.map(r => Array.from({ length: r.right }, (_, x) => x).filter(x => {
        let tall = 0;
        for (let y = r.top + 22; y < r.top + 142; y++) if (px[y * layout.width + x]! > 150) tall++;
        return tall > 12;
      }));
      expect(tone).toHaveLength(2);
      for (const cols of tone) {
        expect(cols[0]).toBeGreaterThanOrEqual(312);
        expect(cols[0]).toBeLessThanOrEqual(328);
        expect(cols.at(-1)).toBeGreaterThanOrEqual(632);
        expect(cols.at(-1)).toBeLessThanOrEqual(648);
      }
    });
  });
});
