// @vitest-environment happy-dom
import {
  fullRenderContext,
  type YouTubeChaptersResponse,
  type YouTubeConnectionStatus,
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

const sampleChapters: YouTubeChaptersResponse = {
  version: "ver_3",
  duration: 20,
  chapters: [
    { time: 0, timestamp: "0:00", title: "Intro" },
    { time: 8, timestamp: "0:08", title: "Main Demo" },
    { time: 15, timestamp: "0:15", title: "Wrap-up" },
  ],
  chaptersText: "0:00 Intro\n0:08 Main Demo\n0:15 Wrap-up",
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
  it("keeps upload clean with project-name title, final-cut chapters only, visibility picker, live upload progress, and YouTube Studio link", async () => {
    vi.spyOn(api, "youtubeStatus").mockResolvedValue({ status: connectedStatus });
    vi.spyOn(api, "youtubeUploads").mockResolvedValue({ uploads: [] });
    const chaptersSpy = vi.spyOn(api, "youtubeChapters").mockResolvedValue(sampleChapters);
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
      title: current.project.name,
      visibility: "unlisted",
      createdAt: "2026-11-26T18:00:00.000Z",
    };
    const publishSpy = vi.spyOn(api, "youtubePublish").mockResolvedValue({ upload: uploadingJob });
    vi.spyOn(api, "youtubeUpload").mockResolvedValue({ upload: uploadingJob });
    const openWin = vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(desktop, "openUrl").mockResolvedValue();

    await mount();

    // Default tab keeps local export completely uncluttered and doesn't fetch chapters until switched.
    expect(chaptersSpy).not.toHaveBeenCalled();
    expect(tabByText("Save to computer")?.getAttribute("aria-selected")).toBe("true");

    // Switch to Publish to YouTube
    await act(async () => tabByText("Publish to YouTube")!.click());
    expect(chaptersSpy).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Forward Future Studio");
    expect(el.querySelector<HTMLInputElement>("#yt-title")!.value).toBe(current.project.name);
    expect(el.querySelector<HTMLTextAreaElement>("#yt-description")!.value).toBe(sampleChapters.chaptersText);
    expect(el.querySelector<HTMLButtonElement>("#yt-visibility")!.textContent).toBe("Private (draft)");
    expect(el.textContent).toContain("Uploads as a Private draft in YouTube Studio");

    // No packaging suggestions (no tags, no thumbnail picker, no Redraft)
    expect(el.querySelector("#yt-tags")).toBeNull();
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();
    expect(buttonByText("Redraft")).toBeUndefined();
    expect(buttonByText("Use current frame")).toBeUndefined();

    // Change visibility to Unlisted using PreferenceSelect
    await selectOption(el.querySelector<HTMLButtonElement>("#yt-visibility")!, "Unlisted");
    expect(el.querySelector<HTMLButtonElement>("#yt-visibility")!.textContent).toBe("Unlisted");

    // Submit Export & Upload to YouTube
    await act(async () => buttonByText("Export & Upload to YouTube")!.click());
    expect(publishSpy).toHaveBeenCalledWith(current.id, {
      version: current.project.head,
      title: current.project.name,
      description: sampleChapters.chaptersText,
      visibility: "unlisted",
      quality: "delivery",
    });
    expect(el.textContent).toContain("Uploading to YouTube… · 50%");
    expect(el.textContent).toContain("Reused your existing export");
    expect(buttonByText("Cancel upload")).toBeDefined();

    // Live WebSocket completion shows Studio link
    const doneJob: YouTubeUploadJob = {
      ...uploadingJob,
      phase: "done",
      progress: 1,
      bytesUploaded: 10 * 1024 * 1024,
      videoId: "abc123XYZ",
      studioUrl: "https://studio.youtube.com/video/abc123XYZ/edit",
    };
    await act(async () => dispatchWsEvent({ type: "youtube.upload.updated", projectId: current.id, upload: doneJob }));
    expect(el.textContent).toContain("Uploaded to YouTube");
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
    vi.spyOn(api, "youtubeChapters").mockResolvedValue(sampleChapters);

    await mount();
    await act(async () => tabByText("Publish to YouTube")!.click());

    // Disconnected user still gets their chapters, with Set up in Settings CTA and disabled Upload button
    expect(el.textContent).toContain("Set up in Settings");
    expect(el.querySelector<HTMLInputElement>("#yt-title")!.value).toBe(current.project.name);
    expect(el.querySelector<HTMLTextAreaElement>("#yt-description")!.value).toBe(sampleChapters.chaptersText);
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
