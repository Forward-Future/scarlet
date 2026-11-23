// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AboutSettings } from "../components/shell/AboutSettings";
import { StartupRecovery } from "../components/shell/StartupRecovery";
import { api } from "./client";
import { desktop } from "./desktop";
import { buildDb } from "./mock/fixtures";
import { buildProblemReportUrl, SCARLET_ISSUES_URL } from "./reportProblem";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("builds a pre-filled GitHub issue URL with version, OS, detail, and log zip name", () => {
  const url = buildProblemReportUrl({
    version: "0.2.0",
    revision: "abcdef123456",
    platform: "macos",
    arch: "aarch64",
    logFileName: "scarlet-logs-2026.zip",
    summary: "Engine failed to start",
    detail: "Port busy",
  });
  expect(url.startsWith(`${SCARLET_ISSUES_URL}?`)).toBe(true);
  const parsed = new URL(url);
  expect(parsed.searchParams.get("title")).toBe("Engine failed to start");
  const body = parsed.searchParams.get("body") ?? "";
  expect(body).toContain("Port busy");
  expect(body).toContain("scarlet-logs-2026.zip");
  expect(body).toContain("Scarlet: 0.2.0 (abcdef1)");
  expect(body).toContain("System: macos (aarch64)");
});

it("exports logs, reveals the zip, and opens a pre-filled GitHub issue from About", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const defaults = buildDb().settings;
  vi.spyOn(api, "settings").mockResolvedValue({ settings: defaults, transcriptionAvailable: true });
  vi.spyOn(desktop, "updateStatus").mockResolvedValue({ ready: null, building: null });
  vi.spyOn(desktop, "info").mockResolvedValue({
    version: "0.2.0",
    platform: "macos",
    arch: "aarch64",
    configFile: "/tmp/config.json",
    dataDir: "/tmp/data",
    workDir: "/tmp/work",
    logDir: "/tmp/logs",
  });
  const exportLogs = vi.spyOn(desktop, "exportLogs")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("/Users/editor/Desktop/scarlet-logs.zip");
  const reveal = vi.spyOn(desktop, "revealPath").mockResolvedValue();
  const openUrl = vi.spyOn(desktop, "openUrl").mockResolvedValue();

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
  try {
    await act(async () => root.render(<AboutSettings />));
    // Cancelled save does not open browser.
    await act(async () => button("Report a problem…")!.click());
    expect(exportLogs).toHaveBeenCalledTimes(1);
    expect(openUrl).not.toHaveBeenCalled();

    // Confirmed save reveals zip and opens pre-filled issue.
    await act(async () => button("Report a problem…")!.click());
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    expect(exportLogs).toHaveBeenCalledTimes(2);
    expect(reveal).toHaveBeenCalledWith("/Users/editor/Desktop/scarlet-logs.zip");
    const opened = new URL(openUrl.mock.calls[0]![0]);
    expect(opened.origin + opened.pathname).toBe(SCARLET_ISSUES_URL);
    expect(opened.searchParams.get("body")).toContain("scarlet-logs.zip");
    expect(opened.searchParams.get("body")).toContain("macos (aarch64)");
    await vi.waitFor(() => expect(container.textContent).toContain("Saved scarlet-logs.zip"));

    // Open without logs skips exportLogs.
    await act(async () => button("Open without logs")!.click());
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));
    expect(exportLogs).toHaveBeenCalledTimes(2);
    const direct = new URL(openUrl.mock.calls[1]![0]);
    expect(direct.searchParams.get("body")).not.toContain("scarlet-logs.zip");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("offers Report a problem from StartupRecovery with error details pre-filled", async () => {
  const openUrl = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<StartupRecovery title="Scarlet couldn't start" detail="FFmpeg missing" />));
    const btn = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Report a problem")!;
    await act(async () => btn.click());
    expect(openUrl).toHaveBeenCalledOnce();
    const opened = new URL(openUrl.mock.calls[0]![0]);
    expect(opened.searchParams.get("title")).toBe("Scarlet couldn't start");
    expect(opened.searchParams.get("body")).toContain("FFmpeg missing");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
