import { describe, expect, it } from "vitest";
import {
  createProject, emptyTimeline, exactRate, fromOtio, handoffFileNames, handoffLosses, handoffReadMe, makeMediaClip,
  makeTrack, timecodeFrames, toFcpxml, toOtio, toSrt, timelineFromKeepRanges, trackLayers, type HandoffSource, type Timeline,
} from "./index.js";

const source = (over: Partial<HandoffSource> = {}): HandoffSource => ({
  url: "file:///Users/me/Edit/Media/cam.mov", fileName: "cam.mov", hasVideo: true, hasAudio: true,
  rate: { num: 30000, den: 1001 }, width: 1920, height: 1080, audioChannels: 2, audioRate: 48000, duration: 600, ...over,
});

function project30() {
  const project = createProject("Interview", { fps: 30000 / 1001 });
  project.media.push({ id: "cam", kind: "video", name: "cam.mov", path: "cam.mov", duration: 600, fps: 30000 / 1001, hasAudio: true });
  return project;
}

describe("rates and timecode", () => {
  it("takes a measured rate to the standard rate it is, and says when it isn't one", () => {
    expect(exactRate(29.97)).toEqual({ rate: { num: 30000, den: 1001 }, standard: true });
    expect(exactRate(25)).toEqual({ rate: { num: 25, den: 1 }, standard: true });
    expect(exactRate(29.83).standard).toBe(false);
  });

  it("counts timecode in frames, dropping frame numbers for drop-frame", () => {
    expect(timecodeFrames("01:00:00:00", { num: 25, den: 1 })).toBe(90000);
    expect(timecodeFrames("00:01:00;02", { num: 30000, den: 1001 })).toBe(1800);
    expect(timecodeFrames("01:00:00;00", { num: 30000, den: 1001 })).toBe(107892);
    expect(timecodeFrames("not a timecode", { num: 25, den: 1 })).toBeUndefined();
  });

  it("names the copies so two files can't take one name", () => {
    expect(handoffFileNames(["cam.mov", "Cam.mov", "a/b:c.wav", ""])).toEqual(["cam.mov", "Cam 2.mov", "a b c.wav", "Media"]);
  });

  it("names the copies as Windows will write them: no trailing dots or spaces, no device names", () => {
    expect(handoffFileNames(["take.mov. ", "notes. . ", "CON.mov", "nul", "Com1.tar.gz", "lpt9.wav", "console.mov", "aux.mov"]))
      .toEqual(["take.mov", "notes", "CON_.mov", "nul_", "Com1_.tar.gz", "lpt9_.wav", "console.mov", "aux_.mov"]);
  });
});

describe("captions", () => {
  it("writes SubRip cues on the timeline's clock", () => {
    expect(toSrt([
      { id: "c1", kind: "caption", enabled: true, timelineIn: 1.5, timelineOut: 3.25, text: "Hello there" },
      { id: "c2", kind: "caption", enabled: true, timelineIn: 3661.001, timelineOut: 3662, text: "Later" },
    ])).toBe("1\n00:00:01,500 --> 00:00:03,250\nHello there\n\n2\n01:01:01,001 --> 01:01:02,000\nLater\n");
  });
});

describe("FCPXML", () => {
  it("lays the first video track on the storyline and the others in lanes, on whole frames", () => {
    const project = project30();
    const tl = timelineFromKeepRanges(project.id, "cam", [{ start: 1, end: 3 }, { start: 5, end: 8 }]);
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain('frameDuration="1001/30000s"');
    expect(xml).toContain('src="file:///Users/me/Edit/Media/cam.mov"');
    // Two clips on the storyline, the second right after the first.
    const clips = [...xml.matchAll(/<asset-clip [^>]*>/g)].map(m => m[0]);
    expect(clips).toHaveLength(2);
    expect(clips[0]).toContain('offset="0s"');
    expect(clips[1]).toMatch(/offset="60060\/30000s"|offset="1001\/500s"/);
    // Every time is a whole number of frames of 1001/30000 s.
    for (const [, n, d] of xml.matchAll(/="(\d+)\/(\d+)s"/g)) expect((Number(n) * 30000 / Number(d)) % 1001).toBe(0);
  });

  it("starts each clip at the footage's own timecode", () => {
    const project = project30();
    const tl = timelineFromKeepRanges(project.id, "cam", [{ start: 2, end: 4 }]);
    const xml = toFcpxml(project, tl, new Map([["cam", source({ timecode: { frames: 107892, rate: { num: 30000, den: 1001 }, dropFrame: true } })]]));
    // 01:00:00;00 is 107892 frames; the clip reads from 2 s (60 frames) after it.
    expect(xml).toMatch(/<asset id="r\d+" name="cam.mov" start="(107892\*1001|26999973\/250)s|<asset id="r\d+" name="cam.mov" start="\d+\/\d+s"/);
    const start = /<asset-clip [^>]*start="(\d+)\/(\d+)s"/.exec(xml)!;
    expect(Number(start[1]) / Number(start[2])).toBeCloseTo((107892 + 60) * 1001 / 30000, 9);
  });

  it("carries zooms, reframes, opacity, fades and volume, and connects sound and pictures above and below", () => {
    const project = project30();
    project.media.push({ id: "mic", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 600 });
    const tl: Timeline = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0, { volume: 0 })];
    const top = makeTrack("video", "Inset", "v2");
    top.clips = [makeMediaClip("cam", 20, 24, 2, { id: "inset", volume: 0, opacity: 0.5, videoFadeIn: 0.5,
      transform: { x: 0.25, y: -0.25, scale: 0.4, rotation: 90, cropLeft: 0.1, cropRight: 0, cropTop: 0.05, cropBottom: 0 },
      keyframes: [{ time: 0, transform: { scale: 0.4 }, ease: "linear" }, { time: 2, transform: { scale: 0.6 }, ease: "easeInOut" }] })];
    tl.tracks.splice(1, 0, top);
    tl.tracks[2]!.clips = [makeMediaClip("mic", 0, 10, 0, { volume: 0.5, audioFadeIn: 0.1 })];
    const xml = toFcpxml(project, tl, new Map([["cam", source()], ["mic", source({ url: "file:///m/mic.wav", fileName: "mic.wav", hasVideo: false, rate: undefined, width: undefined, height: undefined })]]));
    // The silent camera keeps only its picture; the microphone hangs below the storyline.
    expect(xml).toMatch(/<asset-clip [^>]*name="cam.mov"[^>]*srcEnable="video"/);
    expect(xml).toMatch(/<asset-clip [^>]*lane="-1"[^>]*name="mic.wav"/);
    expect(xml).toContain('<adjust-volume amount="-6.0206dB">');
    expect(xml).toContain('<fadeIn type="linear"');
    // The inset sits above, reframed, cropped, half see-through, fading in and zooming.
    expect(xml).toMatch(/<asset-clip [^>]*lane="1"/);
    expect(xml).toContain('position="44.4444 25"');
    expect(xml).toContain('rotation="-90"');
    expect(xml).toContain('<crop-rect left="17.7778" right="0" top="5" bottom="0"/>');
    expect(xml).toContain('<adjust-blend amount="0.5">');
    expect(xml).toMatch(/<param name="scale">[\s\S]*value="0.6 0.6" interp="ease" curve="smooth"/);
  });

  it("writes captions, markers and disabled clips", () => {
    const project = project30();
    const tl = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 10 }]);
    tl.tracks[0]!.clips.push({ ...makeMediaClip("cam", 20, 22, 10), enabled: false });
    const captions = makeTrack("caption", "Captions", "cap");
    captions.clips = [{ id: "c", kind: "caption", enabled: true, timelineIn: 1, timelineOut: 2, text: "Fish & chips <3" }];
    tl.tracks.push(captions);
    tl.markers = [
      { id: "m1", time: 4, kind: "chapter", text: "Part two", resolved: false },
      { id: "m2", time: 5, kind: "todo", text: "Fix", resolved: false },
    ];
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    expect(xml).toContain('role="SRT?captionFormat=SRT.en"');
    expect(xml).toContain("<text>Fish &amp; chips &lt;3</text>");
    expect(xml).toMatch(/<chapter-marker start="[^"]+" duration="1001\/30000s" value="Part two"\/>/);
    expect(xml).toMatch(/<marker [^>]*value="Fix" completed="0"\/>/);
    expect(xml).toMatch(/<asset-clip [^>]*enabled="0"/);
  });

  it("retimes a clip that plays at another speed", () => {
    const project = project30();
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 10, 14, 0, { speed: 2 })];
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    expect(xml).toContain("<timeMap>");
    const clip = /<asset-clip [^>]*start="(\d+)(?:\/(\d+))?s" duration="(\d+)\/(\d+)s"/.exec(xml)!;
    // Its own clock runs at half the footage's: 10 s in (frame 300, 10.01 s at 29.97) is 5 s on it, and it lasts 2 s.
    expect(Number(clip[1]) / Number(clip[2] ?? 1)).toBeCloseTo(300 * 1001 / 30000 / 2, 9);
    expect(Number(clip[3]) / Number(clip[4])).toBeCloseTo(2, 2);
  });

  it("starts a retimed clip on a whole frame, and maps its clock at the speed its length was counted at", () => {
    const project = createProject("Interview", { fps: 30 });
    project.media.push({ id: "cam", kind: "video", name: "cam.mov", path: "cam.mov", duration: 600, fps: 30, hasAudio: true });
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 101 / 30, 101 / 30 + 3, 0, { speed: 1.5 }), makeMediaClip("cam", 20, 22.0015, 2, { speed: 1.0005 })];
    const xml = toFcpxml(project, tl, new Map([["cam", source({ rate: { num: 30, den: 1 } })]]));
    const clips = [...xml.matchAll(/<asset-clip [^>]*start="(\d+)(?:\/(\d+))?s"[^>]*>\s*<timeMap>\s*<timept [^>]*\/>\s*<timept time="(\d+)(?:\/(\d+))?s" value="(\d+)(?:\/(\d+))?s"/g)];
    expect(clips).toHaveLength(2);
    const [first, second] = clips.map(m => m.slice(1).map(v => Number(v ?? 1)) as number[]);
    // 101 frames into the footage at 1.5x is 67.33 frames on the clip's clock: it starts on frame 67, not at 101/45 s.
    const startFrames = first![0]! * 30 / first![1]!;
    expect(startFrames).toBe(67);
    // The time map's speed is the clip's own, exactly.
    expect((first![4]! / first![5]!) / (first![2]! / first![3]!)).toBe(1.5);
    expect((second![4]! / second![5]!) / (second![2]! / second![3]!)).toBeCloseTo(1.0005, 9);
    for (const [, n, d] of xml.matchAll(/(?:start|offset|duration|time)="(\d+)\/(\d+)s"/g)) expect((Number(n) * 30 / Number(d)) % 1).toBe(0);
  });

  it("plays only the sound of a hidden picture track that is heard, and turns off one that isn't", () => {
    const project = project30();
    const tl: Timeline = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0, { id: "main" })];
    const heard = { ...makeTrack("video", "Heard", "v2"), hidden: true, clips: [makeMediaClip("cam", 20, 24, 2, { label: "heard" })] };
    const silent = { ...makeTrack("video", "Silent", "v3"), hidden: true, clips: [makeMediaClip("cam", 30, 34, 2, { label: "silent", volume: 0 })] };
    const muted = { ...makeTrack("video", "Muted", "v4"), hidden: true, muted: true, clips: [makeMediaClip("cam", 40, 44, 2, { label: "muted" })] };
    tl.tracks.splice(1, 0, heard, silent, muted);
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    const clip = (name: string) => new RegExp(`<asset-clip [^>]*name="${name}"[^>]*>`).exec(xml)![0];
    expect(clip("heard")).toContain('srcEnable="audio"');
    expect(clip("heard")).not.toContain('enabled="0"');
    for (const name of ["silent", "muted"]) expect(clip(name)).toContain('enabled="0"');
    // A hidden main track is heard but not seen too.
    tl.tracks[0]!.hidden = true;
    const hiddenMain = /<asset-clip [^>]*name="cam.mov"[^>]*>/.exec(toFcpxml(project, tl, new Map([["cam", source()]])))![0];
    expect(hiddenMain).toContain('srcEnable="audio"');
  });

  it("places a still image as a video on a format with no frame rate", () => {
    const project = project30();
    project.media.push({ id: "logo", kind: "image", name: "logo.png", path: "logo.png", duration: 0, width: 800, height: 600 });
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0)];
    tl.tracks.splice(1, 0, { ...makeTrack("video", "Logo", "v2"), clips: [makeMediaClip("logo", 0, 3, 2, { label: "Logo" })] });
    const still = source({ url: "file:///m/logo.png", fileName: "logo.png", still: true, hasAudio: false, rate: undefined, width: 800, height: 600, duration: 0 });
    const xml = toFcpxml(project, tl, new Map([["cam", source()], ["logo", still]]));
    expect(xml).toMatch(/<format id="(r\d+)" name="FFVideoFormatRateUndefined" width="800" height="600"\/>/);
    expect(xml).toMatch(/<asset id="r\d+" name="logo.png" start="0s" duration="0s" hasVideo="1"/);
    expect(xml).toMatch(/<video ref="r\d+" lane="1" offset="[^"]+" name="Logo" duration="90\/30000s|<video ref="r\d+" lane="1" offset="[^"]+" name="Logo" duration="\d+\/\d+s"/);
    expect(xml).not.toMatch(/<asset-clip [^>]*name="Logo"/);
  });
});

describe("OTIO for a hand-off", () => {
  it("links the copies, counts from their timecode, and comes back into Scarlet unchanged", () => {
    const project = project30();
    const tl = { ...timelineFromKeepRanges(project.id, "cam", [{ start: 1, end: 3 }, { start: 5, end: 8 }]), version: "v1" };
    const tc = source({ timecode: { frames: 107892, rate: { num: 30000, den: 1001 }, dropFrame: true } });
    const otio = toOtio(project, tl, { sources: new Map([["cam", tc]]) }) as { tracks: { children: Array<{ name: string; children: Array<{ source_range: { start_time: { value: number } }; media_references: { DEFAULT_MEDIA: { target_url: string } } }> }> } };
    const [v1, , sound] = otio.tracks.children;
    expect(sound!.name).toBe("V1 sound");
    expect(v1!.children[0]!.media_references.DEFAULT_MEDIA.target_url).toBe("file:///Users/me/Edit/Media/cam.mov");
    expect(v1!.children[0]!.source_range.start_time.value).toBe(107892 + 30);
    // Times come back on the project's frames, within a frame of where they were.
    const back = fromOtio(otio, project, tl);
    const clips = (t: Timeline) => t.tracks.map(track => track.clips.map(c => c.kind === "media" ? [c.mediaId, c.sourceIn, c.sourceOut, c.timelineIn] : c.id));
    expect(back.tracks.map(t => t.clips.length)).toEqual(tl.tracks.map(t => t.clips.length));
    for (const [i, track] of clips(back).entries()) {
      for (const [j, c] of track.entries()) {
        const want = clips(tl)[i]![j] as [string, number, number, number];
        (c as [string, number, number, number]).forEach((v, k) => typeof v === "number" ? expect(Math.abs(v - (want[k] as number))).toBeLessThan(1 / 29.97) : expect(v).toBe(want[k]));
      }
    }
  });
});

describe("what doesn't carry over", () => {
  it("lists effects, rounded corners, eased moves and caption styling, in timeline order", () => {
    const project = project30();
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [
      makeMediaClip("cam", 0, 5, 0, { label: "Intro", effects: [{ type: "lut", params: {}, enabled: true }] }),
      makeMediaClip("cam", 5, 9, 5, { transform: { x: 0, y: 0, scale: 0.5, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cornerRadius: 0.1 } }),
    ];
    const captions = makeTrack("caption", "Captions");
    captions.clips = [{ id: "c", kind: "caption", enabled: true, timelineIn: 1, timelineOut: 2, text: "Hi", style: { uppercase: true } }];
    tl.tracks.push(captions);
    const losses = handoffLosses(project, tl);
    expect(losses.map(l => l.what)).toEqual([
      "How the captions look, and their word highlighting: they come in as plain text",
      "LUT on “Intro”",
      "Rounded corners on “cam.mov”",
    ]);
    const readMe = handoffReadMe({ projectName: "Interview", timelineFiles: { fcpxml: "Interview.fcpxml", otio: "Interview.otio" },
      captionFiles: ["Captions.srt"], losses, warnings: [] });
    expect(readMe).toContain("File > Import > Timeline…, then choose Interview.fcpxml.");
    expect(readMe).toContain("0:05  Rounded corners on “cam.mov”");
  });

  it("lists each transition, where it is, since it comes in as a straight cut", () => {
    const project = project30();
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [
      makeMediaClip("cam", 0, 5, 0),
      makeMediaClip("cam", 10, 14, 5, { label: "Answer", transitionIn: { type: "dissolve", duration: 1, direction: "left" } }),
      makeMediaClip("cam", 20, 24, 9, { transitionIn: { type: "push", duration: 0.5, direction: "left" } }),
    ];
    expect(handoffLosses(project, tl)).toEqual([
      { at: 5, what: "The dissolve into “Answer” (it comes in as a straight cut)" },
      { at: 9, what: "The push into “cam.mov” (it comes in as a straight cut)" },
    ]);
  });
});

describe("overlapping clips on one track", () => {
  const clip = (id: string, at: number, length: number) => makeMediaClip("cam", 0, length, at, { id });
  const ids = (layers: Array<Array<{ id: string }>>) => layers.map(l => l.map(c => c.id));

  it("alternates a run of sound crossfades between two layers instead of climbing one a join", () => {
    const run = [clip("a", 0, 10), clip("b", 9, 10), clip("c", 18, 10), clip("d", 27, 10), clip("e", 40, 5)];
    expect(ids(trackLayers(run, false, true))).toEqual([["a", "c", "e"], ["b", "d"]]);
  });

  it("keeps clips that don't overlap on one layer, and draws a picture over the earlier ones it overlaps", () => {
    expect(ids(trackLayers([clip("a", 0, 5), clip("b", 5, 5), clip("c", 10, 5)], false, true))).toEqual([["a", "b", "c"]]);
    expect(ids(trackLayers([clip("a", 0, 10), clip("b", 9, 10), clip("c", 18, 10)]))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("lays a chain of crossfaded sound on two lanes in Final Cut", () => {
    const project = project30();
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 40, 0)];
    tl.tracks[1]!.clips = [0, 9, 18, 27].map((at, i) => makeMediaClip("cam", at, at + 10, at, { id: `s${i}`, label: `s${i}` }));
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    const lanes = new Set([...xml.matchAll(/<asset-clip [^>]*lane="(-\d+)"/g)].map(m => m[1]));
    expect([...lanes].sort()).toEqual(["-1", "-2"]);
  });
});
