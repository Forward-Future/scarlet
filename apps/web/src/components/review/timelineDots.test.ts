// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { bandLabel, gapAt, gapLabel, isPill, layoutMarks, MARK_GAP, nearestMark, type TimelineDot, type TimelineGap } from "./timelineMarkerLayout";

const dot = (time: number, extra: Partial<TimelineDot> = {}): TimelineDot => ({ time, title: `Edit at ${time}`, ...extra });
/** Each marker by the times of the edits it stands for: one time is a dot, several a pill. */
const shapes = (layout: ReturnType<typeof layoutMarks>) => layout.map(m => m.dots.map(d => d.time));

describe("layoutMarks", () => {
  // 100 s across 1000 px: 1 s is 10 px, and a dot needs 12 px to its neighbour.
  const marks = [dot(10), dot(11), dot(12), dot(50), dot(90), dot(90.5)];

  it("shares one pill between edits whose dots would touch, and gives an edit with room its own dot", () => {
    const layout = layoutMarks(marks, 0, 100, 1000);
    expect(shapes(layout)).toEqual([[10, 11, 12], [50], [90, 90.5]]);
    // No marker carries a number or a time: a pill is wider than a dot, and that is all.
    expect(layout.map(m => m.width)).toEqual([15, 9, 15]);
    // The pill sits over the middle of its run and stands for every edit in it.
    expect(layout[0]).toMatchObject({ time: 10, times: [10, 11, 12], at: 11 });
  });

  it("gives each edit its dot once zoomed in far enough", () => {
    expect(shapes(layoutMarks(marks, 9, 4, 1000))).toEqual([[10], [11], [12]]);
  });

  it("reaches back when sharing widens a pill into the marker before it", () => {
    // 10 and 11.3 have room for two dots. 11.6 joins 11.3, and their wider pill no longer clears 10.
    expect(shapes(layoutMarks([dot(10), dot(11.3)], 0, 100, 1000))).toEqual([[10], [11.3]]);
    expect(shapes(layoutMarks([dot(10), dot(11.3), dot(11.6)], 0, 100, 1000))).toEqual([[10, 11.3, 11.6]]);
  });

  it("shares one marker between edits on the same frame, a dot and not a pill", () => {
    const layout = layoutMarks([dot(10), dot(10), dot(30), dot(30)], 0, 100, 1000);
    expect(shapes(layout)).toEqual([[10, 10], [30, 30]]);
    expect(layout.map(m => m.width)).toEqual([9, 9]);
  });

  it("caps a run's reach, so a dense pass reads as several runs that never touch", () => {
    // 119 cuts, one every 5 s across 600 s and 900 px: each 7.5 px from the next, so every dot would touch.
    const pass = Array.from({ length: 119 }, (_, i) => dot(5 * i + 2));
    const layout = layoutMarks(pass, 0, 600, 900);
    expect(layout.map(m => m.dots.length)).toEqual([14, 14, 14, 14, 14, 14, 14, 14, 7]);
    // Together the runs hold every cut once, in order.
    expect(layout.flatMap(m => m.dots.map(d => d.time))).toEqual(pass.map(d => d.time));
    for (const m of layout) expect((Math.max(...m.times) - Math.min(...m.times)) / 600 * 900).toBeLessThanOrEqual(104);
    // No pill touches the next, and none leaves the track.
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]!, b = layout[i]!;
      expect((b.at - a.at) / 100 * 900).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 + 3 - 1e-6);
    }
    expect(layout.at(-1)!.at / 100 * 900 + layout.at(-1)!.width / 2).toBeLessThanOrEqual(900 + 1e-6);
  });

  it("keeps the open edit's own dot out of every pill, the runs either side moved clear of it", () => {
    const pass = Array.from({ length: 30 }, (_, i) => ({ ...dot(5 * i + 2), current: i === 14 }));
    const layout = layoutMarks(pass, 0, 150, 300);
    const open = layout.find(m => m.dots.some(d => d.current))!;
    expect(shapes([open])).toEqual([[72]]);
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]!, b = layout[i]!;
      expect((b.at - a.at) / 100 * 300).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 + 3 - 1e-6);
    }
    expect(layout.flatMap(m => m.dots.map(d => d.time))).toEqual(pass.map(d => d.time));
  });

  it("works out its runs for the zoom on its way, so the pills don't change on the way there", () => {
    const pass = Array.from({ length: 40 }, (_, i) => dot(5 * i + 2));
    // Halfway through a zoom from the whole 200 s to 0–40 s, the runs are already the ones at 0–40 s.
    const landed = shapes(layoutMarks(pass, 0, 40, 1000));
    const midway = shapes(layoutMarks(pass, 0, 120, 1000, 40).filter(m => m.times[0]! <= 40));
    expect(midway.slice(0, landed.length)).toEqual(landed);
  });

  it("never puts a call and an edit in one pill, though their dots would touch", () => {
    // Two calls a little under a second apart, with an edit between them. The two calls share a pill; the edit keeps
    // its own dot.
    const call = (time: number): TimelineDot => ({ ...dot(time), group: "call" });
    const layout = layoutMarks([call(10), dot(10.5), call(10.8), dot(50)], 0, 100, 1000);
    expect(layout.map(m => m.dots.map(d => d.group ?? "edit"))).toEqual([["call", "call"], ["edit"], ["edit"]]);
    // On the same frame too, and each marker has its own name.
    const same = layoutMarks([call(10), dot(10)], 0, 100, 1000);
    expect(same).toHaveLength(2);
    expect(new Set(same.map(m => m.key)).size).toBe(2);
  });

  it("nudges the previous pill left when clamping the open edit's dot inside the right edge would overlap it", () => {
    // Near the right end of a 1056 s (17:36) timeline on a 650 px track, a pill of three edits sits just before the open
    // edit, which keeps its own dot. Clamping that dot inside the track must pull the pill left to preserve MARK_GAP.
    const layout = layoutMarks([dot(1040), dot(1043), dot(1046), { ...dot(1055), current: true }], 0, 1056, 650);
    expect(shapes(layout)).toEqual([[1040, 1043, 1046], [1055]]);
    const [prev, last] = layout;
    expect(last!.at / 100 * 650 + last!.width / 2).toBeLessThanOrEqual(650 + 1e-6);
    expect((last!.at - prev!.at) / 100 * 650).toBeGreaterThanOrEqual(prev!.width / 2 + last!.width / 2 + 3 - 1e-6);
    // The pill was nudged left from its natural midpoint to make room for the clamped dot.
    expect(prev!.at).toBeLessThan(1043 / 1056 * 100);
  });

  it("nudges the next marker right when clamping the first pill inside the left edge would overlap it", () => {
    // A pill centred near 0 s (width 15 px) clamps right, clear of the playhead stem; an open edit just beyond it must
    // move right so the clamped pill stays clear of it.
    const marksAtStart: TimelineDot[] = [dot(0.1), dot(0.5), dot(0.9), { ...dot(2), current: true }];
    const layout = layoutMarks(marksAtStart, 0, 100, 1000);
    expect(shapes(layout)).toEqual([[0.1, 0.5, 0.9], [2]]);
    const [first, second] = layout;
    expect(first!.at / 100 * 1000 - first!.width / 2).toBeGreaterThanOrEqual(-1e-6);
    expect((second!.at - first!.at) / 100 * 1000).toBeGreaterThanOrEqual(first!.width / 2 + second!.width / 2 + 3 - 1e-6);
    expect(second!.at).toBeGreaterThan(2);
  });

  it("draws dots before the track is measured", () => {
    expect(shapes(layoutMarks(marks.slice(0, 2), 0, 100, 0))).toEqual([[10], [11]]);
  });

  it("keeps edits at 0:00 clear of the playhead stem and separates markers from different groups", () => {
    const atStart = layoutMarks([dot(0), dot(0)], 0, 16, 650);
    expect(shapes(atStart)).toEqual([[0, 0]]);
    expect(atStart[0]!.at / 100 * 650 - atStart[0]!.width / 2).toBeGreaterThanOrEqual(4 - 1e-6);

    const crossGroup = layoutMarks([{ ...dot(2), group: "call" }, { ...dot(2), group: "other" }], 0, 100, 1000);
    expect(crossGroup).toHaveLength(2);
    const [a, b] = crossGroup;
    expect((b!.at - a!.at) / 100 * 1000).toBeGreaterThanOrEqual(a!.width / 2 + b!.width / 2 + 3 - 1e-6);
  });
});

describe("nearestMark", () => {
  const layout = layoutMarks([dot(10), dot(11), dot(50)], 0, 100, 1000);

  it("picks the pill anywhere along the crowded run it stands for", () => {
    expect(nearestMark(layout, 10.1, 1000)?.times).toEqual([10, 11]);
    expect(nearestMark(layout, 11.2, 1000)?.times).toEqual([10, 11]);
  });

  it("picks nothing far from every edit", () => {
    expect(nearestMark(layout, 30, 1000)).toBeUndefined();
    expect(nearestMark(layout, 52, 1000)?.times).toEqual([50]);
  });
});

describe("gapLabel", () => {
  const gap = { label: "Cut at 12:05", shortLabel: "12:05" };

  it("names the cut in full where the gap has room", () => {
    expect(gapLabel(gap, 200)).toBe("Cut at 12:05");
  });

  it("falls back to the cut's time on a narrow gap, so the tag isn't cut off", () => {
    expect(gapLabel(gap, 85)).toBe("12:05");
  });

  it("draws no label on a gap too narrow for even the time, rather than one cut off mid-word", () => {
    expect(gapLabel(gap, 43)).toBe("12:05");
    expect(gapLabel(gap, 24)).toBe("");
  });

  it("keeps the full label before the track is measured, or without a short one", () => {
    expect(gapLabel(gap, 0)).toBe("Cut at 12:05");
    expect(gapLabel({ label: "Cut at 12:05" }, 40)).toBe("Cut at 12:05");
  });
});

describe("bandLabel", () => {
  it("keeps the open edit's label whole while it fits its band, then just the amount, then nothing", () => {
    expect(bandLabel("Took out · 7.2 s", 320)).toBe("Took out · 7.2 s");
    // A one-second cut zoomed with five seconds either side is a band a few dozen pixels wide.
    expect(bandLabel("Took out · 1.4 s", 60)).toBe("1.4 s");
    expect(bandLabel("Took out · 0.5 s", 30)).toBe("");
    // A label with no amount is whole or absent, never cut off mid-word.
    expect(bandLabel("Audio", 60)).toBe("Audio");
    expect(bandLabel("Audio", 20)).toBe("");
    // Before the track is measured there is nothing to fit it to.
    expect(bandLabel("Took out · 1.4 s", 0)).toBe("Took out · 1.4 s");
  });
});

describe("gapAt", () => {
  // 10 s across 1000 px: 1 s is 100 px.
  const make = (start: number, end: number, label: string): TimelineGap => ({ start, end, label, title: label, skipped: false });
  const wide = make(101, 102.3, "Cut at 9:50");
  const touchingSliver = make(102.3, 102.4, "Sliver beside wide");
  const tiny = make(105, 105.04, "Tiny cut");
  const offscreen = make(200, 201, "Offscreen");
  const gaps = [wide, touchingSliver, tiny, offscreen];

  it("picks a gap strictly containing the pointer and prefers the narrower sliver on a shared edge", () => {
    expect(gapAt(gaps, 100, 10, 1000, 150)?.label).toBe("Cut at 9:50");
    expect(gapAt(gaps, 100, 10, 1000, 230)?.label).toBe("Sliver beside wide");
    expect(gapAt(gaps, 100, 10, 1000, 235)?.label).toBe("Sliver beside wide");
  });

  it("expands a narrow gap's hit zone so a 4 px cut can still be clicked", () => {
    // `tiny` spans 500–504 px (center 502 px), so its 16 px hit zone covers 494–510 px.
    expect(gapAt(gaps, 100, 10, 1000, 495)?.label).toBe("Tiny cut");
    expect(gapAt(gaps, 100, 10, 1000, 509)?.label).toBe("Tiny cut");
    expect(gapAt(gaps, 100, 10, 1000, 480)).toBeUndefined();
    expect(gapAt(gaps, 100, 10, 1000, 520)).toBeUndefined();
  });
});

describe("layoutMarks across groups and dense tracks", () => {
  it("keeps a dot and a call pill near 0:00 clear of each other and both clickable", () => {
    const marks: TimelineDot[] = [
      dot(0),
      dot(0, { group: "call" }),
      dot(0.03, { group: "call" }),
    ];
    const layout = layoutMarks(marks, 0, 16, 650);
    expect(layout.map(m => m.key)).toEqual(["@0", "call@0"]);
    const [editDot, callPill] = layout;
    const gap = (callPill!.at - editDot!.at) / 100 * 650;
    expect(gap).toBeGreaterThanOrEqual(editDot!.width / 2 + callPill!.width / 2 + MARK_GAP - 1e-6);
    expect(nearestMark(layout, editDot!.at, 650)?.key).toBe("@0");
    expect(nearestMark(layout, callPill!.at, 650)?.key).toBe("call@0");
  });

  it("holds non-overlap, bounds, group separation, and center hit-testing across crowded multi-group passes", () => {
    const rng = (seed: number) => {
      let s = seed >>> 0;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    };
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const span = [1.5, 16, 100, 600][Math.floor(r() * 4)]!;
      const width = [320, 650, 900][Math.floor(r() * 3)]!;
      const count = [2, 40, 150, 300][Math.floor(r() * 4)]!;
      const open = Math.floor(r() * (count + 2));
      const groups = r() < 0.5;
      const marks = Array.from({ length: count }, (_, i) => {
        const time = Math.round(r() * span * 30) / 30;
        return dot(time, { current: i === open, ...(groups && r() < 0.4 && { group: "call" }) });
      });
      const layout = layoutMarks(marks, 0, span, width);
      expect(layout.flatMap(m => m.dots)).toHaveLength(marks.length);
      const sorted = [...layout].sort((a, b) => a.at - b.at);
      for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i]!;
        const x = m.at / 100 * width;
        expect(x - m.width / 2).toBeGreaterThanOrEqual(-1e-6);
        expect(x + m.width / 2).toBeLessThanOrEqual(width + 1e-6);
        expect(new Set(m.dots.map(d => d.group ?? "")).size).toBe(1);
        expect(m.dots.some(d => d.current) && isPill(m)).toBe(false);
        expect(nearestMark(layout, m.at, width)?.key).toBe(m.key);
        if (i > 0) {
          const prev = sorted[i - 1]!;
          const gap = (m.at - prev.at) / 100 * width;
          expect(gap).toBeGreaterThanOrEqual(prev.width / 2 + m.width / 2 + MARK_GAP - 1e-6);
        }
      }
    }
  });
});
