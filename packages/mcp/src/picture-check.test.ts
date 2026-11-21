import { describe, expect, it } from "vitest";
import type { Timeline } from "@scarlet/timeline";
import type { BriefPicture } from "./brief-pictures.js";
import type { FramedStretch } from "./framing-report.js";
import { pictureFindings } from "./picture-check.js";

const clip = (id: string, mediaId: string, timelineIn: number, sourceIn: number, seconds: number) => ({ id, kind: "media", mediaId, timelineIn, sourceIn,
  sourceOut: sourceIn + seconds, speed: 1, enabled: true, opacity: 1, volume: 0 });
/** Project 88 at 4:53 (2026-11-21): the camera under two screen clips with 0.45 s of camera between them. */
function timeline(shift = 0): Timeline {
  return { version: "v", tracks: [
    { id: "v1", kind: "video", clips: [clip("cam", "camera", 293 + shift, 502.2, 23)] },
    { id: "screen-demo", kind: "video", clips: [clip("screen-1", "screen", 293.58 + shift, 497.55, 4.42), clip("screen-2", "screen", 298.45 + shift, 507.57, 4.85)] },
  ] } as unknown as Timeline;
}
const stretch = (from: number, to: number, beside: Partial<Pick<FramedStretch, "shownAfter" | "shownBefore">>): FramedStretch =>
  ({ mediaId: "screen", trackId: "screen-demo", from, to, clips: 1, holds: [], moves: [], ...beside });

describe("pictureFindings", () => {
  it("names a brief picture by what plays there, so a keep holds when the edit moves it", () => {
    const brief = (shift: number): BriefPicture[] => [{ from: 298 + shift, to: 298.45 + shift, seconds: 0.45, shows: ["cam"], before: ["screen-1"], after: ["screen-2"] }];
    const [a] = pictureFindings(timeline(), brief(0), [], []);
    const [b] = pictureFindings(timeline(-2), brief(-2), [], []);
    expect(a).toMatchObject({ kind: "brief", from: 298, to: 298.45, shows: ["cam"] });
    expect(a!.id).toBe(b!.id);
  });

  it("lists the camera back while the screen still shows what it showed, once for a gap seen from both sides", () => {
    const words = [{ mediaId: "camera", index: 1017, start: 303.4, end: 303.6 }, { mediaId: "camera", index: 1018, start: 303.7, end: 303.9 }];
    const found = pictureFindings(timeline(), [], [
      stretch(298.45, 303.3, { shownAfter: { from: 303.3, to: 315.9, unchanged: true, showing: ["Disabled below active"], said: "line and put the disabled ones",
        reads: [{ from: 303.25, to: 306.13, said: "line and put the disabled ones below the active ones" }] } }),
      stretch(315.9, 319.75, { shownBefore: { from: 312, to: 315.9, showing: ["Single-line rows"], reads: [{ from: 313, to: 315, said: "single line rows place the model label" }] } }),
    ], words);
    expect(found).toEqual([{ id: "picture-off:screen:camera:1017", kind: "offPicture", from: 303.3, to: 315.9, mediaId: "screen", unchanged: true,
      showing: ["Disabled below active", "Single-line rows"], said: "line and put the disabled ones",
      reads: [{ from: 303.25, to: 306.13, said: "line and put the disabled ones below the active ones" }, { from: 313, to: 315, said: "single line rows place the model label" }] }]);
  });
});
