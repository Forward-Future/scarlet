import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../context.js";
import { lipSync, lipSyncStretches, mouthOf, type LipSyncStretch } from "./lipSync.js";

const saved = vi.hoisted(() => [] as string[]);
vi.mock("../util.js", async importOriginal => {
  let saves = 0;
  return { ...await importOriginal<typeof import("../util.js")>(),
    // The first save lands last, as writes queued on a busy disk can.
    atomicWriteFile: vi.fn(async (_path: string, data: string) => {
      await new Promise(resolve => setTimeout(resolve, saves++ === 0 ? 50 : 0));
      saved.push(data);
    }) };
});
// No face in any stretch: each is answered, and kept, as soon as its faces are read.
vi.mock("./faces.js", () => ({ faceSamples: vi.fn(async () => ({ done: true, samples: [] })) }));

describe("lipSyncStretches", () => {
  it("spreads the stretches evenly across a long recording", () => {
    expect(lipSyncStretches(0, 600, 3, 30)).toEqual([{ from: 85, to: 115 }, { from: 285, to: 315 }, { from: 485, to: 515 }]);
  });

  it("splits a range shorter than all the stretches into stretches that cover it", () => {
    expect(lipSyncStretches(10, 70, 6, 30)).toEqual([{ from: 10, to: 40 }, { from: 40, to: 70 }]);
    expect(lipSyncStretches(0, 12, 6, 30)).toEqual([{ from: 0, to: 12 }]);
    expect(lipSyncStretches(5, 5)).toEqual([]);
  });
});

describe("mouthOf", () => {
  type Box = [number, number, number, number];
  const frames = (from: number, to: number, ...faces: Array<{ box: Box; yaw?: number }>) =>
    Array.from({ length: (to - from) * 2 }, (_, i) => ({ at: from + i / 2,
      faces: faces.map(f => [...f.box, 0.9, f.yaw ?? 0, 0.5, 0.3] as [number, number, number, number, number, number, number, number]) }));

  it("measures the face in frame most often, at the lower third of its usual box", () => {
    const face = mouthOf([
      ...frames(0, 20, { box: [0.4, 0.2, 0.6, 0.6] }, { box: [0.05, 0.05, 0.1, 0.1] }),
      ...frames(20, 30, { box: [0.42, 0.2, 0.62, 0.6], yaw: 20 }),
    ], 0, 30)!;
    expect(face.seconds).toBe(30);
    expect(face.yaw).toBe(0);
    expect(face.mouth).toEqual([0.43, 0.448, 0.57, 0.632]);
  });

  it("counts only the frames inside the stretch, and finds nothing without a face", () => {
    const face = mouthOf([...frames(0, 50, { box: [0.4, 0.2, 0.6, 0.6] }), ...frames(50, 100)], 40, 70)!;
    expect(face.seconds).toBe(10);
    expect(mouthOf(frames(0, 30), 0, 30)).toBeUndefined();
  });
});

it("keeps every stretch it answered on disk, however its saves land", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scarlet-lip-sync-"));
  try {
    writeFileSync(join(dir, "cam.mp4"), "");
    const ctx = { paths: { media: () => dir, waveforms: () => dir }, track: <T>(p: T) => p,
      projectSignal: () => new AbortController().signal, log: () => {} } as unknown as Ctx;
    const media = { id: "med_lipsave", projectId: "prj_1", kind: "video", path: "cam.mp4", duration: 90, width: 1920, height: 1080, fps: 30 } as Parameters<typeof lipSync>[1];
    const result = await lipSync(ctx, media, { count: 3 });
    expect(result.stretches.map(s => s.unmeasured)).toEqual(Array(3).fill("No face is in frame."));
    await vi.waitFor(() => expect(saved.length).toBeGreaterThanOrEqual(3));
    await new Promise(resolve => setTimeout(resolve, 100));
    const onDisk = JSON.parse(saved.at(-1)!) as { stretches: Record<string, LipSyncStretch> };
    expect(Object.keys(onDisk.stretches).sort()).toEqual(["0-30", "30-60", "60-90"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
