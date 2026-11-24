// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { bandLabel, gapAt, gapLabel, layoutMarks, nearestMark, type TimelineDot, type TimelineGap } from "./timelineMarkerLayout";

const dot = (time: number, n: number): TimelineDot => ({ time, n, title: `Edit ${n}` });
const shapes = (layout: ReturnType<typeof layoutMarks>) => layout.map(m => m.label);

describe("layoutMarks", () => {
  // 100 s across 1000 px: 1 s is 10 px, and a numbered circle needs 20 px to its neighbour.
  const marks = [dot(10, 1), dot(11, 2), dot(12, 3), dot(50, 4), dot(90, 5), dot(90.5, 6)];

  it("shares one pill between edits whose circles would touch, and gives an edit with room its own circle", () => {
    const layout = layoutMarks(marks, 0, 100, 1000);
    expect(shapes(layout)).toEqual(["1–3", "4", "5–6"]);
    // The pill sits over the middle of its run and stands for every edit in it.
    expect(layout[0]).toMatchObject({ time: 10, times: [10, 11, 12], at: 11 });
  });

  it("gives each edit its circle once zoomed in far enough", () => {
    expect(shapes(layoutMarks(marks, 9, 4, 1000))).toEqual(["1", "2", "3"]);
  });

  it("reaches back when sharing widens a pill into the marker before it", () => {
    // 1 and 2 have room for two circles. 3 joins 2, and their wider pill no longer clears 1.
    expect(shapes(layoutMarks([dot(10, 1), dot(12, 2)], 0, 100, 1000))).toEqual(["1", "2"]);
    expect(shapes(layoutMarks([dot(10, 1), dot(12, 2), dot(12.5, 3)], 0, 100, 1000))).toEqual(["1–3"]);
  });

  it("shows the lowest number and a plus when the edits sharing a pill skip numbers", () => {
    expect(shapes(layoutMarks([dot(10, 4), dot(10.5, 9)], 0, 100, 1000))).toEqual(["4+"]);
  });

  it("shares one marker between edits on the same frame", () => {
    expect(shapes(layoutMarks([dot(10, 4), dot(10, 5), dot(30, 9), dot(30, 7)], 0, 100, 1000))).toEqual(["4–5", "7+"]);
  });

  it("keeps duplicates and unnumbered calls out of contiguous number ranges", () => {
    const shared = [dot(10, 5), dot(10.1, 3), dot(10.2, 3), dot(10.3, 6)];
    expect(shapes(layoutMarks(shared, 0, 100, 1000))).toEqual(["3+"]);
    expect(shapes(layoutMarks([dot(10, 1), { time: 10.01, title: "Call" }], 0, 100, 1000))).toEqual(["1+"]);
  });

  it("caps a run's reach, so a dense pass reads as several runs that never touch", () => {
    // 119 cuts, one every 5 s across 600 s and 900 px: each 7.5 px from the next, so every circle would touch.
    const pass = Array.from({ length: 119 }, (_, i) => dot(5 * i + 2, i + 1));
    const layout = layoutMarks(pass, 0, 600, 900);
    expect(layout.map(m => m.label)).toEqual(["1–14", "15–28", "29–42", "43–56", "57–70", "71–84", "85–98", "99–112", "113–119"]);
    // Together the runs hold every cut once, in order.
    expect(layout.flatMap(m => m.dots.map(d => d.n))).toEqual(pass.map(d => d.n));
    for (const m of layout) expect((Math.max(...m.times) - Math.min(...m.times)) / 600 * 900).toBeLessThanOrEqual(104);
    // No pill touches the next, and none leaves the track.
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]!, b = layout[i]!;
      expect((b.at - a.at) / 100 * 900).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 + 3 - 1e-6);
    }
    expect(layout.at(-1)!.at / 100 * 900 + layout.at(-1)!.width / 2).toBeLessThanOrEqual(900 + 1e-6);
  });

  it("keeps the open edit's own circle out of every pill, the runs either side moved clear of it", () => {
    const pass = Array.from({ length: 30 }, (_, i) => ({ ...dot(5 * i + 2, i + 1), current: i === 14 }));
    const layout = layoutMarks(pass, 0, 150, 300);
    const open = layout.find(m => m.dots.some(d => d.current))!;
    expect([open.label, open.dots.length]).toEqual(["15", 1]);
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]!, b = layout[i]!;
      expect((b.at - a.at) / 100 * 300).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 + 3 - 1e-6);
    }
    expect(layout.flatMap(m => m.dots.map(d => d.n))).toEqual(pass.map(d => d.n));
  });

  it("works out its runs for the zoom on its way, so the pills don't change on the way there", () => {
    const pass = Array.from({ length: 40 }, (_, i) => dot(5 * i + 2, i + 1));
    // Halfway through a zoom from the whole 200 s to 0–40 s, the runs are already the ones at 0–40 s.
    const landed = layoutMarks(pass, 0, 40, 1000).map(m => m.label);
    const midway = layoutMarks(pass, 0, 120, 1000, 40).filter(m => m.times[0]! <= 40).map(m => m.label);
    expect(midway.slice(0, landed.length)).toEqual(landed);
  });

  it("never puts a call's number and an edit's in one pill, though their circles would touch", () => {
    // Calls 1 and 2 sit a second and a half apart, with an edit numbered 1 between them. The two calls share a pill;
    // the edit keeps its own circle.
    const call = (time: number, n: number): TimelineDot => ({ ...dot(time, n), group: "call" });
    const layout = layoutMarks([call(10, 1), dot(11, 1), call(11.5, 2), dot(50, 2)], 0, 100, 1000);
    expect(layout.map(m => [m.label, m.dots.map(d => d.group ?? "edit")])).toEqual([["1–2", ["call", "call"]], ["1", ["edit"]], ["2", ["edit"]]]);
    // On the same frame too, and each marker has its own name.
    const same = layoutMarks([call(10, 3), dot(10, 4)], 0, 100, 1000);
    expect(same.map(m => m.label)).toEqual(["3", "4"]);
    expect(new Set(same.map(m => m.key)).size).toBe(2);
  });

  it("nudges the previous pill left when clamping the last pill inside the right edge would overlap it", () => {
    // Two runs near the right end of a 1056 s (17:36) timeline on a 650 px track: together they exceed RUN_REACH, so
    // "169–175" splits off at the edge. Clamping it inside the track must pull "150–168" left to preserve MARK_GAP.
    const penultimate = Array.from({ length: 19 }, (_, i) => dot(854 + i * 9, 150 + i));
    const tail = Array.from({ length: 7 }, (_, i) => dot(1024 + i * 5, 169 + i));
    const layout = layoutMarks([...penultimate, ...tail], 0, 1056, 650);
    expect(shapes(layout)).toEqual(["150–168", "169–175"]);
    const [prev, last] = layout;
    expect(last!.at / 100 * 650 + last!.width / 2).toBeLessThanOrEqual(650 + 1e-6);
    expect((last!.at - prev!.at) / 100 * 650).toBeGreaterThanOrEqual(prev!.width / 2 + last!.width / 2 + 3 - 1e-6);
    // "150–168" was nudged left from its natural midpoint to make room for the clamped tail pill.
    expect(prev!.at).toBeLessThan((854 + 1016) / 2 / 1056 * 100);
  });

  it("nudges the next marker right when clamping the first pill inside the left edge would overlap it", () => {
    // A pill centred near 0 s (width 31 px, half 15.5 px) clamps right to 15.5 px; an open edit just beyond its
    // unclamped reach must move right so the clamped pill stays clear of it.
    const marksAtStart: TimelineDot[] = [
      dot(0.1, 1), dot(0.5, 2), dot(0.9, 3),
      { ...dot(3.2, 4), current: true },
    ];
    const layout = layoutMarks(marksAtStart, 0, 100, 1000);
    expect(shapes(layout)).toEqual(["1–3", "4"]);
    const [first, second] = layout;
    expect(first!.at / 100 * 1000 - first!.width / 2).toBeGreaterThanOrEqual(-1e-6);
    expect((second!.at - first!.at) / 100 * 1000).toBeGreaterThanOrEqual(first!.width / 2 + second!.width / 2 + 3 - 1e-6);
    expect(second!.at).toBeGreaterThan(3.2);
  });

  it("draws circles before the track is measured", () => {
    expect(shapes(layoutMarks(marks.slice(0, 2), 0, 100, 0))).toEqual(["1", "2"]);
  });

  it("keeps edits at 0:00 clear of the playhead stem and separates markers from different groups", () => {
    const atStart = layoutMarks([dot(0, 1), dot(0, 2)], 0, 16, 650);
    expect(shapes(atStart)).toEqual(["1–2"]);
    expect(atStart[0]!.at / 100 * 650 - atStart[0]!.width / 2).toBeGreaterThanOrEqual(4 - 1e-6);

    const crossGroup = layoutMarks([
      { ...dot(2, 1), group: "call" },
      { ...dot(2, 4), group: "other" },
    ], 0, 100, 1000);
    expect(shapes(crossGroup)).toEqual(["1", "4"]);
    const [a, b] = crossGroup;
    expect((b!.at - a!.at) / 100 * 1000).toBeGreaterThanOrEqual(a!.width / 2 + b!.width / 2 + 3 - 1e-6);
  });
});

describe("nearestMark", () => {
  const layout = layoutMarks([dot(10, 1), dot(11, 2), dot(50, 3)], 0, 100, 1000);

  it("picks the pill anywhere along the crowded run it stands for", () => {
    expect(nearestMark(layout, 10.1, 1000)?.label).toBe("1–2");
    expect(nearestMark(layout, 11.2, 1000)?.label).toBe("1–2");
  });

  it("picks nothing far from every edit", () => {
    expect(nearestMark(layout, 30, 1000)).toBeUndefined();
    expect(nearestMark(layout, 52, 1000)?.label).toBe("3");
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
