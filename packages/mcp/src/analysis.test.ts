import { describe, expect, it } from "vitest";
import type { Transcript } from "@scarlet/timeline";
import { emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { flattenWords, searchTranscript } from "@scarlet/shared";
import {
  colorEvidence,
  summarizeProject,
  addedAfterRequest,
  summarizeTimeline,
  summarizeTimelinePage,
  fullTimelinePage,
  captionWordMapper,
  dedupeWords,
  detectSilences,
  dialogueCutSuggestions,
  firstCutEvidence,
  firstCutPauses,
  downsample,
  mapWordsThroughClip,
  sparkline,
} from "./analysis.js";
import { joinEvidence } from "./dialogue-join.js";

const transcript: Transcript = {
  id: "t1",
  mediaId: "m1",
  segments: [
    {
      id: "s1",
      start: 0,
      end: 3,
      text: "Hello there, welcome back.",
      speaker: "Matt",
      words: [
        { text: "Hello", start: 0.1, end: 0.4 },
        { text: "there,", start: 0.45, end: 0.7 },
        { text: "welcome", start: 1.0, end: 1.4 },
        { text: "back.", start: 1.45, end: 1.8 },
      ],
    },
    {
      id: "s2",
      start: 4,
      end: 7,
      text: "Welcome back to the channel.",
      words: [
        { text: "Welcome", start: 4.0, end: 4.4 },
        { text: "back", start: 4.45, end: 4.7 },
        { text: "to", start: 4.8, end: 4.9 },
        { text: "the", start: 4.95, end: 5.1 },
        { text: "channel.", start: 5.2, end: 5.8 },
      ],
    },
  ],
};

describe("detectSilences", () => {
  it("finds runs of low peaks at least minDuration long", () => {
    // 100 buckets over 10 s = 0.1 s each. Silence at buckets 20..29 (1.0 s) and 60..61 (0.2 s, too short).
    const peaks = Array.from({ length: 100 }, (_, i) => (i >= 20 && i < 30 ? 0.01 : i >= 60 && i < 62 ? 0.0 : 0.6));
    const s = detectSilences(peaks, 0, 10, { threshold: 0.05, minDuration: 0.25 });
    expect(s).toEqual([{ start: 2, end: 3, duration: 1 }]);
  });
  it("handles a silence that runs to the end and offsets by from", () => {
    const peaks = [0.5, 0.5, 0.0, 0.0, 0.0, 0.0];
    const s = detectSilences(peaks, 10, 13, { minDuration: 0.25 });
    expect(s).toEqual([{ start: 11, end: 13, duration: 2 }]);
  });
  it("returns nothing for empty input", () => {
    expect(detectSilences([], 0, 1)).toEqual([]);
  });
});

describe("sparkline/downsample", () => {
  it("renders one glyph per bucket and downsamples by max", () => {
    expect(sparkline([0, 0.5, 1])).toBe("▁▅█");
    expect(downsample([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
  });
});

describe("searchTranscript", () => {
  it("finds phrases regardless of case and punctuation, with context", () => {
    const words = flattenWords(transcript);
    const matches = searchTranscript(words, "welcome back", 2);
    expect(matches.length).toBe(2);
    expect(matches[0]).toMatchObject({ start: 1.0, end: 1.8, text: "welcome back.", speaker: "Matt" });
    expect(matches[1]).toMatchObject({ start: 4.0, end: 4.7 });
    expect(matches[0]!.context).toContain("[ welcome back. ]");
    expect(searchTranscript(words, "nope at all")).toEqual([]);
  });
  it("synthesizes word timings when a segment has none", () => {
    const t: Transcript = { id: "t", mediaId: "m", segments: [{ id: "s", start: 0, end: 2, text: "one two", words: [] }] };
    const words = flattenWords(t);
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([
      ["one", 0, 1],
      ["two", 1, 2],
    ]);
  });
});

describe("mapWordsThroughClip", () => {
  it("indexes repeated source cuts with half-open midpoint bounds and preserves overlapping speech order", () => {
    for (const end of [1, 8]) {
      const recording = { ...transcript, segments: [{ ...transcript.segments[0]!, words: [
        { text: "first", start: 0, end },
        { text: "second", start: 1, end: 2 },
        { text: "third", start: 2, end: 3 },
      ] }] };
      const map = captionWordMapper(flattenWords(recording));
      for (const [start, stop] of [[1.5, 2.5], [0, 1.5], [1.5, 4.1]] as const) {
        const clip = makeMediaClip("m1", start, stop, 10, { speed: 2 });
        expect(map(clip)).toEqual(mapWordsThroughClip(clip, flattenWords(recording)));
      }
    }
  });
  it("maps source words into timeline time and drops cut words", () => {
    // keep source 4.0..5.0 placed at timeline 10
    const clip = makeMediaClip("m1", 4.0, 5.0, 10);
    const words = mapWordsThroughClip(clip, flattenWords(transcript));
    // "the" (4.95-5.1) straddles the cut at 5.0 with its midpoint outside, so it is dropped.
    expect(words.map((w) => w.text)).toEqual(["Welcome", "back", "to"]);
    expect(words[0]).toMatchObject({ start: 10, end: 10.4 });
    expect(words[2]).toMatchObject({ start: 10.8, end: 10.9 });
    // a word straddling the end with its midpoint inside is clamped to the clip end
    const clamped = mapWordsThroughClip(makeMediaClip("m1", 4.0, 5.05, 10), flattenWords(transcript));
    expect(clamped[3]).toMatchObject({ text: "the", start: 10.95, end: 11.05 });
  });
  it("accounts for speed", () => {
    const clip = makeMediaClip("m1", 4.0, 6.0, 0, { speed: 2 });
    const words = mapWordsThroughClip(clip, flattenWords(transcript));
    expect(words[1]).toMatchObject({ text: "back", start: 0.225, end: 0.35 });
  });
  it("dedupes words from overlapping clips of the same media", () => {
    const a = mapWordsThroughClip(makeMediaClip("m1", 4, 5, 10), flattenWords(transcript));
    const b = mapWordsThroughClip(makeMediaClip("m1", 4, 5, 10), flattenWords(transcript));
    expect(dedupeWords([...a, ...b]).length).toBe(a.length);
  });
  it("dedupes the same recorded words when overlapping voices interleave their copies", () => {
    const first = { text: "Right.", start: 1, end: 1.6 };
    const second = { text: "Yes!", start: 1.002, end: 1.2 };
    const later = { ...first, start: 1.1 };
    expect(dedupeWords([first, second, { ...first, text: "right", start: 1.01 },
      { ...second, start: 1.012 }, later])).toEqual([first, second, later]);
  });
});

describe("dialogueCutSuggestions", () => {
  it("finds quiet at the head, tail and inside a stretched word while protecting disputed speech", () => {
    const word = { start: 2, end: 5, text: "Ready" };
    const segment = { id: "take", ...word, words: [word] };
    const t = { id: "t", mediaId: "mic", segments: [segment] };
    const voice = [{ start: 2, end: 2.5 }, { start: 5, end: 5.3 }];
    const levels = Array.from({ length: 400 }, (_, i) => voice.some(v => i/50 >= v.start && i/50 < v.end) ? .2 : .0005);
    const wf = { from: 0, to: 8, peaks: levels, rms: levels, speechActivity: voice };
    const edges = joinEvidence([word], wf);
    const pauses = firstCutPauses(t, wf, edges);
    expect(pauses.map(p => p.remove)).toEqual([{ start: .12, end: 1.88 }, { start: 2.62, end: 4.88 }, { start: 5.42, end: 7.88 }]);
    expect(pauses.every(p => !p.timingWarning)).toBe(true);
    segment.words.push({ start: 3.2, end: 3.8, text: "now" });
    expect(firstCutPauses(t, wf, edges)[1]?.timingWarning).toMatch(/timing/i);
    expect(firstCutPauses(t, wf, undefined)).toEqual([]);
  });

  it("recognizes ah and extended hesitations as candidates and preserves whole words", () => {
    const words = ["Ah!", "aahh", "Um,", "uhh", "ahead", "huh", "uh-huh"].map((text, i) => ({ text, start: i, end: i + .2 }));
    const t = { id: "t", mediaId: "m", segments: [{ id: "s", start: 0, end: 7, text: words.map(w => w.text).join(" "), words }] };
    expect(firstCutEvidence(t, { from: 0, to: 7 }).fillers.map(w => w.text)).toEqual(["Ah!", "aahh", "Um,", "uhh"]);
  });

  it("retains consonant margins and splits around an audible breath between timed words", () => {
    const rms = Array.from({ length: 350 }, (_, i) => i >= 135 && i < 148 ? 0.02 : 0.001);
    const wf = { from: 0, to: 7, peaks: rms.map(x => 2 * x), rms };
    const { candidates } = dialogueCutSuggestions(transcript, wf, { minSilence: 0.25, threshold: 0.05 });
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect([c.before, c.after]).toEqual(["back.", "Welcome"]);
      expect(c.airBefore).toBeGreaterThanOrEqual(0.1);
      expect(c.airAfter).toBeGreaterThanOrEqual(0.1);
      expect(c.remove.end <= 2.7 || c.remove.start >= 2.96).toBe(true);
    }
    const guarded = dialogueCutSuggestions(transcript, { ...wf, speechActivity: [{ start: 1.8, end: 4 }] },
      { minSilence: 0.25, threshold: 0.05 });
    expect(guarded.candidates).toEqual([]);
    const untimed = { ...transcript, segments: transcript.segments.map(s => ({ ...s, words: [] })) };
    expect(dialogueCutSuggestions(untimed, wf, { minSilence: 0.25, threshold: 0.05 }).candidates).toEqual([]);
  });
});

describe("colorEvidence", () => {
  it("tells the model what a file declares about its colour, and nothing for ordinary SDR", () => {
    expect(colorEvidence(undefined)).toBeUndefined();
    expect(colorEvidence({})).toBeUndefined();
    expect(colorEvidence({ bitDepth: 10 })).toBeUndefined();
    expect(colorEvidence({ hdr: "hlg", primaries: "bt2020", transfer: "arib-std-b67" })).toBe("HDR HLG, shown, read and exported tone-mapped to SDR BT.709");
    expect(colorEvidence({ log: "Apple Log", primaries: "bt2020" })).toBe("camera Log (Apple Log), flat and low in contrast as shot, no look applied");
    expect(colorEvidence({ primaries: "bt2020" })).toBe("colour tagged primaries bt2020");
  });

  it("is in the project summary beside the media it is about", () => {
    const project = {
      id: "prj", name: "Shoot", head: null, settings: { width: 1920, height: 1080, aspect: "16:9", fps: 30, sampleRate: 48000 },
      media: [
        { id: "phone", kind: "video", name: "Phone.mov", path: "phone.mov", duration: 4, fps: 30, width: 1920, height: 1080, color: { hdr: "pq" } },
        { id: "cam", kind: "video", name: "Cam.mp4", path: "cam.mp4", duration: 4, fps: 30, width: 1920, height: 1080, color: {} },
      ],
    } as unknown as Parameters<typeof summarizeProject>[0];
    const lines = summarizeProject(project, null).split("\n");
    expect(lines.find(line => line.includes("phone"))).toContain("HDR PQ, shown, read and exported tone-mapped to SDR BT.709");
    expect(lines.find(line => line.includes("Cam.mp4"))).not.toMatch(/HDR|Log|colour/);
  });
});

describe("the editor's word on a file", () => {
  it("gives the editor's note on a file and says which files came in after the request, and nothing for any other file", () => {
    const project = {
      id: "prj", name: "Talk", head: null, settings: { width: 1920, height: 1080, aspect: "16:9", fps: 30, sampleRate: 48000 },
      media: [
        { id: "cam", kind: "video", name: "Cam.mp4", path: "cam.mp4", duration: 3000, addedAt: "2026-11-23T20:00:24.000Z" },
        { id: "sponsor", kind: "video", name: "Integration.mp4", path: "sponsor.mp4", duration: 94, addedAt: "2026-11-23T21:10:00.000Z",
          editorNote: "Finished sponsor read.\nInsert it whole after the intro." },
      ],
    } as unknown as Parameters<typeof summarizeProject>[0];
    const lines = summarizeProject(project, null, { most: 40, requestedAt: "2026-11-23T20:19:38.414Z" }).split("\n");
    const sponsor = lines.find(line => line.includes("Integration.mp4"))!;
    expect(sponsor).toContain(`the editor's note on this file: "Finished sponsor read. Insert it whole after the intro."`);
    expect(sponsor).toContain("added after this request was sent, so not part of it unless the editor's words name it");
    expect(lines.find(line => line.includes("Cam.mp4"))).not.toMatch(/note|added after/);
    // Without a request, or for files that were there when it was sent, the list reads as it always has.
    expect(summarizeProject(project, null)).not.toContain("added after");
    expect(addedAfterRequest({ addedAt: "2026-11-23T20:00:24.000Z" }, "2026-11-23T20:19:38.414Z")).toBe(false);
    expect(addedAfterRequest({}, "2026-11-23T20:19:38.414Z")).toBe(false);
  });
});

describe("summarizeTimelinePage", () => {
  it("returns summarizeTimeline verbatim when within maxChars and pages clips by start time when over", () => {
    const tl = emptyTimeline("prj");
    tl.version = "v_many";
    for (let i = 0; i < 30; i++) {
      tl.tracks[0]!.clips.push(makeMediaClip("m1", i * 5, i * 5 + 4, i * 4, { id: `v_${i}` }));
      tl.tracks[1]!.clips.push(makeMediaClip("m1", i * 5, i * 5 + 4, i * 4, { id: `a_${i}` }));
    }
    const full = summarizeTimeline(tl, 30);
    expect(summarizeTimelinePage(tl, 30, { maxChars: full.length + 100 })).toBe(full);

    const limit = 1_200;
    const seen = new Set<string>();
    let from: number | undefined;
    let pages = 0;
    while (pages < 20) {
      const page = summarizeTimelinePage(tl, 30, { from, maxChars: limit });
      expect(page.length).toBeLessThanOrEqual(limit);
      for (const m of page.matchAll(/\b([va]_\d+)\b/g)) seen.add(m[1]!);
      pages++;
      const next = /call timeline_get with from=([\d.]+)/.exec(page);
      if (!next) break;
      from = Number(next[1]);
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(60);

    const slice = summarizeTimelinePage(tl, 30, { from: 20, to: 32, maxChars: 10_000 });
    expect(slice).toContain("v_5 ");
    expect(slice).toContain("v_7 ");
    expect(slice).not.toContain("v_4 ");
    expect(slice).not.toContain("v_8 ");
    expect(slice).toContain("Showing 6 clips in 20.00–32.00 s (of 60 total).");
  });

  it("names a clip's framing, effects and transition, so reading them needn't take format full", () => {
    const tl = emptyTimeline("prj");
    tl.tracks[0]!.clips.push(makeMediaClip("m1", 0, 4, 0, { id: "framed",
      transform: { x: 0.1, y: 0, scale: 1.5, rotation: 0, cropLeft: 0.2, cropRight: 0, cropTop: 0, cropBottom: 0.05 },
      effects: [{ type: "lut", params: {}, enabled: true }, { type: "blur", params: {}, enabled: false }],
      transitionIn: { type: "dissolve", duration: 0.5, direction: "left" } }));
    tl.tracks[0]!.clips.push(makeMediaClip("m1", 4, 8, 4, { id: "plain" }));
    const lines = summarizeTimeline(tl, 30).split("\n");
    expect(lines.find(l => l.includes("framed"))).toContain(" framed scale 1.5 x 0.1 crop l0.2 b0.05 effects lut dissolve in 0.5 s");
    expect(lines.find(l => l.includes("plain"))).toBe("  plain 0:04.00–0:08.00 <- m1 4.00–8.00");
  });
});

describe("fullTimelinePage", () => {
  const many = () => {
    const tl = emptyTimeline("prj");
    tl.version = "v_many";
    for (let i = 0; i < 30; i++) {
      tl.tracks[0]!.clips.push(makeMediaClip("m1", i * 5, i * 5 + 4, i * 4, { id: `v_${i}`, transform: { x: 0, y: 0, scale: i % 2 ? 1.2 : 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }));
      tl.tracks[1]!.clips.push(makeMediaClip("m1", i * 5, i * 5 + 4, i * 4, { id: `a_${i}`, volume: i === 3 ? 0.5 : 1 }));
    }
    return tl;
  };

  it("gives every clip property but those at their default, and nothing is lost on a timeline that fits", () => {
    const tl = many();
    const out = JSON.parse(fullTimelinePage(tl));
    expect(out.version).toBe("v_many");
    expect(out.page).toBeUndefined();
    const a3 = out.tracks[1].clips.find((c: { id: string }) => c.id === "a_3");
    expect(a3).toMatchObject({ id: "a_3", kind: "media", mediaId: "m1", sourceIn: 15, sourceOut: 19, timelineIn: 12, volume: 0.5 });
    expect(a3).not.toHaveProperty("speed");
    expect(a3).not.toHaveProperty("enabled");
    expect(a3).not.toHaveProperty("audioFadeIn");
    expect(a3).not.toHaveProperty("effects");
    expect(out.tracks[0].clips.find((c: { id: string }) => c.id === "v_1").transform).toEqual({ scale: 1.2 });
    // Filling the defaults back in gives the timeline exactly.
    expect(out.tracks.flatMap((t: { clips: unknown[] }) => t.clips)).toHaveLength(60);
    expect(fullTimelinePage(tl).length).toBeLessThan(JSON.stringify(tl).length * 0.75);
  });

  it("reads one stretch, and pages a long timeline by clip start within the result budget", () => {
    const tl = many();
    const slice = JSON.parse(fullTimelinePage(tl, { from: 20, to: 32 }));
    expect(slice.tracks[0].clips.map((c: { id: string }) => c.id)).toEqual(["v_5", "v_6", "v_7"]);
    expect(slice.page).toBe("Clips in 20–32 s: 6 of 60.");

    const limit = 3_000;
    const seen = new Set<string>();
    let from: number | undefined;
    let pages = 0;
    while (pages < 30) {
      const page = fullTimelinePage(tl, { from, maxChars: limit });
      expect(page.length).toBeLessThanOrEqual(limit);
      const parsed = JSON.parse(page);
      for (const t of parsed.tracks) for (const c of t.clips) seen.add(c.id);
      pages++;
      const next = /from=([\d.]+)/.exec(parsed.page ?? "");
      if (!next) break;
      from = Number(next[1]);
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(60);
  });
});
