import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { binMouthMotion, mouthBoxFor, prominentFaceTracks } from "./mouthActivity.js";
import type { FaceTrack } from "./faces.js";

describe("mouthActivity helpers and route validation", () => {
  it("computes mouth boxes inside the lower face and bins frame motion cleanly", () => {
    expect(mouthBoxFor([0.2, 0.2, 0.6, 0.7])).toEqual([0.26, 0.51, 0.54, 0.74]);
    const frames = [1, 1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 5]; // 12 frames at 6 fps = 2 s
    expect(binMouthMotion(frames, 6, 1)).toEqual([1, 5]);
    expect(binMouthMotion([], 30, 5)).toEqual([]);
  });

  it("filters prominent face tracks by screen time and confidence", () => {
    const tracks: FaceTrack[] = [
      { track: 1, start: 0, end: 60, seconds: 58, box: [0.1, 0.2, 0.3, 0.5], eyes: [0.2, 0.3], confidence: 0.92 },
      { track: 2, start: 0, end: 60, seconds: 55, box: [0.6, 0.2, 0.8, 0.5], eyes: [0.7, 0.3], confidence: 0.88 },
      { track: 3, start: 10, end: 10.5, seconds: 0.5, box: [0.4, 0.4, 0.5, 0.5], eyes: [0.45, 0.45], confidence: 0.9 },
      { track: 4, start: 0, end: 30, seconds: 30, box: [0.8, 0.1, 0.9, 0.2], eyes: [0.85, 0.15], confidence: 0.3 },
    ];
    expect(prominentFaceTracks(tracks).map(t => t.track)).toEqual([1, 2]);
  });

  describe("POST /projects/:projectId/media/:mediaId/mouth-activity route", () => {
    let dataDir: string;
    let app: ScarletApp;
    let projectId: string;
    let headers: Record<string, string>;

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "scarlet-mouth-"));
      app = createApp({ dataDir, env: {}, log: () => {} });
      const project = app.ctx.repos.projects.insert(createProject("Multi-cam"));
      projectId = project.id;
      app.ctx.repos.projects.putMedia(projectId, {
        id: "aud1", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 30, hasAudio: true,
      }, "ready");
      headers = { Authorization: `Bearer ${accessToken(app.ctx)}`, "content-type": "application/json" };
    });

    afterEach(async () => {
      await app.ctx.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    it("rejects audio-only assets and invalid stretch payloads", async () => {
      const audioRes = await app.app.request(`/api/projects/${projectId}/media/aud1/mouth-activity`, {
        method: "POST", headers, body: JSON.stringify({ stretches: [{ from: 0, to: 5 }] }),
      });
      expect(audioRes.status).toBe(400);
      expect(await audioRes.json()).toMatchObject({ error: { code: "no_picture" } });
    });
  });
});
