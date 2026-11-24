import { describe, expect, it } from "vitest";
import { fitSync, matchAudio, syncPoints, syncRate } from "./audio-sync.js";

function envelope(seed: number, length = 1500) {
  return Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
}

describe("shared audio sync", () => {
  const ref = envelope(41);
  const later = ref.slice(127).map((n, i) => 0.1 + n * 0.55 + 0.02 * Math.cos(i));
  it("measures either start order with different gain and noise", () => {
    expect(matchAudio(ref, later)?.secondaryStartRelativeToReference).toBe(127 / syncRate);
    expect(matchAudio(later, ref)?.secondaryStartRelativeToReference).toBe(-127 / syncRate);
    expect(matchAudio(ref, ref)?.secondaryStartRelativeToReference).toBe(0);
  });
  it("leaves ambiguous, missing, unrelated and drifting audio unresolved", () => {
    for (const other of [[], Array(600).fill(0), envelope(79), [...ref, ...ref], [...ref.slice(0, 710), ...ref.slice(720)]]) {
      expect(matchAudio(ref, other)).toBeNull();
    }
  });

  // The camera carries continuous speech. Only a few short passages of it reach the
  // screen recording, all between the regularly spaced sync samples.
  const camera = envelope(73, 30_000);
  const delay = 83;
  function screenTrack(length: number, passages: number[], drift = 0) {
    const screen = new Array<number>(length).fill(0);
    for (const start of passages) {
      const offset = delay + (start === passages.at(-1) ? drift : 0);
      for (let i = start; i < start + 150; i++) screen[i] = camera[i + offset]! * 0.5;
    }
    return screen;
  }

  it.each([camera.length - 50, camera.length + 50])("finds sparse shared sound with a screen track of %i samples", length => {
    const screen = screenTrack(length, [1100, 14500, 26600]);
    expect(matchAudio(camera, screen)?.secondaryStartRelativeToReference).toBe(delay / syncRate);
    expect(matchAudio(screen, camera)?.secondaryStartRelativeToReference).toBe(-delay / syncRate);
  });

  it("needs independent shared passages that agree, even when a cue matches in both directions", () => {
    expect(matchAudio(camera, screenTrack(camera.length, [8400]))).toBeNull();
    expect(matchAudio(camera, screenTrack(camera.length, [1100, 14500, 26600], 12))).toBeNull();
    const screen = screenTrack(camera.length, [1100, 14500, 26600]);
    expect(matchAudio([...camera, ...camera], screen)).toBeNull();
  });
});

describe("sync across the whole recording", () => {
  const reference = envelope(91, 36_000); // 12 minutes
  it("reports a constant offset", () => {
    const secondary = reference.slice(83).map(n => n * 0.5);
    const fit = fitSync(syncPoints(reference, secondary));
    expect(fit).toEqual({ kind: "constant", offset: 83 / syncRate });
  });

  it("reports a steady drift with the speed that cancels it", () => {
    // 30 ms per minute: after ten minutes the secondary is 0.3 s behind.
    const rate = 1 + 0.0005;
    const secondary = Array.from({ length: 30_000 }, (_, i) => reference[Math.round(i * rate) + 83]! * 0.7);
    const fit = fitSync(syncPoints(reference, secondary));
    expect(fit.kind).toBe("drift");
    if (fit.kind !== "drift") return;
    expect(fit.offsetAtStart).toBeCloseTo(83 / syncRate, 1);
    expect(fit.msPerMinute).toBeGreaterThan(25);
    expect(fit.msPerMinute).toBeLessThan(35);
    expect(fit.secondarySpeed).toBeCloseTo(1 / rate, 4);
  });

  it("reports a jump where one recording lost a moment", () => {
    // The secondary dropped 0.8 s at its sixth minute: the offset steps from 1.66 s to 2.46 s.
    const secondary = [...reference.slice(83, 83 + 18_000), ...reference.slice(83 + 18_000 + 40, 83 + 33_000)];
    const fit = fitSync(syncPoints(reference, secondary));
    expect(fit.kind).toBe("steps");
    if (fit.kind !== "steps") return;
    expect(fit.parts.map(p => p.offset)).toEqual([83 / syncRate, 123 / syncRate]);
    expect(fit.parts[0]!.to).toBeLessThan(360);
    expect(fit.parts[1]!.from).toBeGreaterThanOrEqual(360);
  });

  it("says so when nothing matches", () => {
    expect(fitSync(syncPoints(reference, envelope(7, 30_000))).kind).toBe("unclear");
  });
  it("says when only one passage matched, rather than that none did", () => {
    expect(fitSync([{ at: 0, offset: 1.5 }])).toEqual({ kind: "unclear", reason: "Only one passage matched." });
    expect(fitSync([])).toEqual({ kind: "unclear", reason: "No passage matched." });
  });
});
