// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import * as desktopModule from "../../lib/desktop";
import { desktop } from "../../lib/desktop";
import { FfmpegSetupBanner, FfmpegSetupCard } from "./FfmpegSetup";

const MISSING = {
  installed: false,
  canInstall: true,
  installDir: "/Users/editor/.local/bin",
  ffmpegPath: null,
  ffprobePath: null,
};

const INSTALLED = {
  installed: true,
  canInstall: true,
  installDir: "/Users/editor/.local/bin",
  ffmpegPath: "/Users/editor/.local/bin/ffmpeg",
  ffprobePath: "/Users/editor/.local/bin/ffprobe",
};

it("hides the banner when FFmpeg is installed and installs FFmpeg with one click when missing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(desktopModule, "isDesktop").mockReturnValue(true);
  vi.spyOn(desktop, "ffmpegStatus").mockResolvedValue(MISSING);
  const install = vi.spyOn(desktop, "ffmpegInstall")
    .mockRejectedValueOnce(new Error("Could not download FFmpeg."))
    .mockResolvedValueOnce(INSTALLED);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<FfmpegSetupBanner />));
    expect(container.textContent).toContain("Install FFmpeg to import and export video");
    const btn = () => container.querySelector<HTMLButtonElement>("button")!;
    expect(btn().textContent).toBe("Install FFmpeg");

    await act(async () => btn().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not download FFmpeg.");

    await act(async () => btn().click());
    expect(install).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shows installed status in Settings and offers install when missing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(desktopModule, "isDesktop").mockReturnValue(true);
  vi.spyOn(desktop, "ffmpegStatus").mockResolvedValue(MISSING);
  vi.spyOn(desktop, "ffmpegInstall").mockResolvedValue(INSTALLED);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<FfmpegSetupCard />));
    expect(container.textContent).toContain("Video tools (FFmpeg)");
    const btn = container.querySelector<HTMLButtonElement>("button")!;
    expect(btn.textContent).toBe("Install FFmpeg");

    await act(async () => btn.click());
    expect(container.textContent).toContain("✓ Installed");
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shows an install started on the Projects page as still installing in Settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(desktopModule, "isDesktop").mockReturnValue(true);
  vi.spyOn(desktop, "ffmpegStatus").mockResolvedValue(MISSING);
  let finish!: (status: typeof INSTALLED) => void;
  const install = vi.spyOn(desktop, "ffmpegInstall").mockReturnValue(new Promise(resolve => { finish = resolve; }));

  const banner = document.body.appendChild(document.createElement("div")), card = document.body.appendChild(document.createElement("div"));
  const bannerRoot = createRoot(banner), cardRoot = createRoot(card);
  try {
    await act(async () => bannerRoot.render(<FfmpegSetupBanner />));
    await act(async () => banner.querySelector<HTMLButtonElement>("button")!.click());
    // The editor goes to Settings while it downloads.
    await act(async () => bannerRoot.unmount());
    await act(async () => cardRoot.render(<FfmpegSetupCard />));
    const button = card.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent).toContain("Installing FFmpeg…");
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(install).toHaveBeenCalledTimes(1);
    await act(async () => finish(INSTALLED));
    expect(card.textContent).toContain("✓ Installed");
  } finally {
    await act(() => cardRoot.unmount());
    banner.remove();
    card.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
