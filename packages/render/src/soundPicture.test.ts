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
  });
});
