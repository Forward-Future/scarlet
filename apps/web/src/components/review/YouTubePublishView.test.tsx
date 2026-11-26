// @vitest-environment happy-dom
import {
  fullRenderContext,
  type YouTubeConnectionStatus,
  type YouTubePublishingKit,
  type YouTubeUploadJob,
} from "@scarlet/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectOption } from "../../../test/selectOption";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { buildDb } from "../../lib/mock/fixtures";
import { dispatchWsEvent } from "../../lib/realtime";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useYouTubeStore } from "../../stores/youtube";
import { ExportSheet } from "./ExportVideo";

let el: HTMLDivElement;
let root: Root;
let current: ProjectData;

const connectedStatus: YouTubeConnectionStatus = {
  state: "connected",
  configured: true,
  configSource: "env",
  channel: { id: "UC_1", title: "Forward Future Studio", handle: "@forwardfuture" },
  connectedAt: "2026-11-26T18:00:00.000Z",
};

const sampleKit: YouTubePublishingKit = {
  version: "ver_3",
  duration: 20,
  title: "Scarlet Interview Cut",
  titleOptions: ["Scarlet Interview Cut", "How We Edit Faster With Scarlet"],
  description: "Quick walkthrough of our finished cut.\n\nChapters:\n0:00 Intro\n0:08 Main Demo\n0:15 Wrap-up",
  chapters: [
    { time: 0, timestamp: "0:00", title: "Intro" },
    { time: 8, timestamp: "0:08", title: "Main Demo" },
    { time: 15, timestamp: "0:15", title: "Wrap-up" },
  ],
  tags: ["scarlet", "editing", "youtube"],
  thumbnails: [
    { id: "yt_1", time: 2, label: "0:02", source: "auto", previewUrl: "data:image/jpeg;base64,/9j/4AAQ" },
    { id: "yt_2", time: 9, label: "0:09", source: "auto", previewUrl: "data:image/jpeg;base64,/9j/4AAQ" },
    { id: "yt_3", time: 16, label: "0:16", source: "auto", previewUrl: "data:image/jpeg;base64,/9j/4AAQ" },
  ],
  draftedWith: "fallback",
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const project = db.projects[0]!;
  current = {
    id: project.id,
    project: { ...project, media: db.media[project.id] ?? [] },
    timeline: db.timelines[project.head!]!,
    media: db.media[project.id] ?? [],
    versions: db.versions[project.id] ?? [],
    changes: [],
    notes: [],
    renders: [],
    tasks: [],
    taskEvents: {},
    taskUsage: {},
    learnings: [],
  };
  useProjectStore.setState({ current });
  usePlayerStore.setState({ time: 6.4 });
  useYouTubeStore.setState({ status: null, loaded: false, uploads: {} });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  useProjectStore.setState(useProjectStore.getInitialState());
  useYouTubeStore.setState({ status: null, loaded: false, uploads: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = () => act(async () => root.render(
  <MemoryRouter>
    <ExportSheet hasCut onClose={() => {}} />
  </MemoryRouter>,
));
const buttonByText = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
const tabByText = (text: string) => [...el.querySelectorAll('[role="tab"]')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("ExportSheet — Publish to YouTube", () => {
  it("drafts Publishing Kit, supports playhead capture, visibility picker, live upload progress, and YouTube Studio link", async () => {
    vi.spyOn(api, "youtubeStatus").mockResolvedValue({ status: connectedStatus });
    vi.spyOn(api, "youtubeUploads").mockResolvedValue({ uploads: [] });
    const kitSpy = vi.spyOn(api, "youtubePublishingKit").mockResolvedValue({ kit: sampleKit });
    const captureSpy = vi.spyOn(api, "youtubeCaptureThumbnail").mockResolvedValue({
      thumbnail: { id: "yt_playhead", time: 6.4, label: "Playhead 0:06", source: "playhead", previewUrl: "data:image/jpeg;base64,/9j/4AAQ" },
    });
    const context = fullRenderContext(current.project);
    const uploadingJob: YouTubeUploadJob = {
      id: "ytup_1",
      projectId: current.id,
      version: current.project.head!,
      context,
      phase: "uploading",
      progress: 0.5,
      bytesUploaded: 5 * 1024 * 1024,
      bytesTotal: 10 * 1024 * 1024,
      reusedRender: true,
      title: "How We Edit Faster With Scarlet",
      visibility: "unlisted",
      createdAt: "2026-11-26T18:00:00.000Z",
    };
    const publishSpy = vi.spyOn(api, "youtubePublish").mockResolvedValue({ upload: uploadingJob });
    vi.spyOn(api, "youtubeUpload").mockResolvedValue({ upload: uploadingJob });
    const openWin = vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(desktop, "openUrl").mockResolvedValue();

    await mount();

    // Default tab keeps local export completely uncluttered and doesn't fetch YouTube kit until switched.
    expect(kitSpy).not.toHaveBeenCalled();
    expect(tabByText("Save to computer")?.getAttribute("aria-selected")).toBe("true");

    // Switch to Publish to YouTube
    await act(async () => tabByText("Publish to YouTube")!.click());
    expect(kitSpy).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Forward Future Studio");
    expect(el.querySelector<HTMLInputElement>("#yt-title")!.value).toBe("Scarlet Interview Cut");
    expect(el.querySelector<HTMLTextAreaElement>("#yt-description")!.value).toContain("0:00 Intro");
    expect(el.querySelector<HTMLButtonElement>("#yt-visibility")!.textContent).toBe("Private (draft)");
    expect(el.textContent).toContain("Uploads as a Private draft in YouTube Studio");

    // Pick alternate title option & change visibility to Unlisted using PreferenceSelect
    await act(async () => buttonByText("How We Edit Faster With Scarlet")!.click());
    expect(el.querySelector<HTMLInputElement>("#yt-title")!.value).toBe("How We Edit Faster With Scarlet");
    await selectOption(el.querySelector<HTMLButtonElement>("#yt-visibility")!, "Unlisted");
    expect(el.querySelector<HTMLButtonElement>("#yt-visibility")!.textContent).toBe("Unlisted");

    // Capture current playhead frame as thumbnail
    await act(async () => buttonByText("Use current frame")!.click());
    expect(captureSpy).toHaveBeenCalledWith(current.id, { version: current.project.head, time: 6.4 });
    expect(el.textContent).toContain("Playhead 0:06");

    // Submit Export & Upload to YouTube
    await act(async () => buttonByText("Export & Upload to YouTube")!.click());
    expect(publishSpy).toHaveBeenCalledWith(current.id, expect.objectContaining({
      title: "How We Edit Faster With Scarlet",
      visibility: "unlisted",
      thumbnailId: "yt_playhead",
      tags: ["scarlet", "editing", "youtube"],
    }));
    expect(el.textContent).toContain("Uploading to YouTube… · 50%");
    expect(el.textContent).toContain("Reused your existing export");
    expect(buttonByText("Cancel upload")).toBeDefined();

    // Live WebSocket completion shows Studio link + non-fatal thumbnail warning
    const doneJob: YouTubeUploadJob = {
      ...uploadingJob,
      phase: "done",
      progress: 1,
      bytesUploaded: 10 * 1024 * 1024,
      videoId: "abc123XYZ",
      studioUrl: "https://studio.youtube.com/video/abc123XYZ/edit",
      thumbnailWarning: "Video uploaded, but YouTube requires channel verification to set custom thumbnails.",
    };
    await act(async () => dispatchWsEvent({ type: "youtube.upload.updated", projectId: current.id, upload: doneJob }));
    expect(el.textContent).toContain("Uploaded to YouTube");
    expect(el.textContent).toContain("channel verification");
    const studioBtn = buttonByText("Open in YouTube Studio")!;
    expect(studioBtn).toBeDefined();
    await act(async () => studioBtn.click());
    expect(openWin).toHaveBeenCalledWith("https://studio.youtube.com/video/abc123XYZ/edit", "_blank", "noopener,noreferrer");
  });

  it("shows plain-English upload failure with Reconnect action when auth expired and disables upload while disconnected", async () => {
    vi.spyOn(api, "youtubeStatus").mockResolvedValue({
      status: { state: "disconnected", configured: false, configSource: "none" },
    });
    vi.spyOn(api, "youtubeUploads").mockResolvedValue({ uploads: [] });
    vi.spyOn(api, "youtubePublishingKit").mockResolvedValue({ kit: sampleKit });

    await mount();
    await act(async () => tabByText("Publish to YouTube")!.click());

    // Disconnected user still gets the Publishing Kit preview, with Set up in Settings CTA and disabled Upload button
    expect(el.textContent).toContain("Set up in Settings");
    expect(el.querySelector<HTMLInputElement>("#yt-title")!.value).toBe("Scarlet Interview Cut");
    expect(buttonByText("Export & Upload to YouTube")!.disabled).toBe(true);

    // Failed upload error displays clearly with Reconnect in Settings
    const failedJob: YouTubeUploadJob = {
      id: "ytup_err",
      projectId: current.id,
      version: current.project.head!,
      context: fullRenderContext(current.project),
      phase: "failed",
      progress: 0.2,
      title: "Test",
      visibility: "private",
      errorCode: "youtube_reconnect_required",
      error: "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings.",
      createdAt: "2026-11-26T18:00:00.000Z",
    };
    await act(async () => dispatchWsEvent({ type: "youtube.upload.updated", projectId: current.id, upload: failedJob }));
    expect(el.textContent).toContain("Your YouTube sign-in expired or was revoked");
    expect(buttonByText("Reconnect in Settings")).toBeDefined();
  });
});
