// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop } from "../../lib/desktop";
import { StartupRecovery } from "./StartupRecovery";

it("opens native logs while the engine is offline and can copy an error without the native bridge", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const info = vi.spyOn(desktop, "info").mockResolvedValue({
    logDir: "/fixture/logs", configFile: "", dataDir: "", workDir: "", platform: "windows", version: "test", arch: "x64",
  });
  const open = vi.spyOn(desktop, "openPath").mockResolvedValue();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label);
  try {
    await act(async () => root.render(<StartupRecovery title="Reconnecting" detail="Engine stopped" showLogs />));
    await act(async () => button("Open logs")!.click());
    expect(open).toHaveBeenCalledWith("/fixture/logs");
    info.mockClear();
    await act(async () => root.render(<StartupRecovery title="Scarlet couldn’t start" detail="Bridge unavailable" />));
    expect(button("Open logs")).toBeUndefined();
    await act(async () => button("Copy diagnostics")!.click());
    expect(copy).toHaveBeenCalledWith("Scarlet couldn’t start\nBridge unavailable");
    expect(info).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Diagnostics copied.");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("sends a report of what stopped Scarlet in one press", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ id: "a", reference: "AAAA-BBBB" });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<StartupRecovery title="Scarlet couldn’t start" detail="Engine exited with code 1" showLogs />));
    expect([...container.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Report a problem", "Open logs", "Copy diagnostics"]);
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Report a problem")!.click());
    expect(send.mock.calls[0]![0].about).toBe("Scarlet couldn’t start: Engine exited with code 1");
    expect(container.textContent).toContain("Report sent");
  } finally {
    await act(async () => root.unmount());
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
