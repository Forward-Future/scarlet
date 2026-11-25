// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { invalidateStorageScan } from "../../lib/storage";
import { StorageSettings } from "./StorageSettings";

afterEach(() => {
  invalidateStorageScan();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sorts cached projects largest first, tucks clean projects away, and supports Clear all", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invalidateStorageScan();
  const projects = [
    { id: "prj_small", name: "Small clip", busy: false, missingSource: false, segments: ["a.mp4"], deletedAt: null },
    { id: "prj_clean", name: "Clean project", busy: false, missingSource: false, segments: [], deletedAt: null },
    { id: "prj_big", name: "Big documentary", busy: false, missingSource: false, segments: ["b.mp4", "c.mp4"], deletedAt: null },
  ];
  const storageSpy = vi.spyOn(api, "storage").mockResolvedValue({ projects });
  vi.spyOn(desktop, "measureProjectStorage").mockResolvedValue({
    prj_small: { bytes: 2048, files: 1, estimated: false },
    prj_clean: { bytes: 0, files: 0, estimated: false },
    prj_big: { bytes: 50 * 1024 * 1024, files: 12, estimated: false },
  });
  const cleanSpy = vi.spyOn(api, "cleanStorage").mockResolvedValue({ projects: 2 });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<StorageSettings />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const cacheSection = container.querySelector('section[aria-label="Render cache"]')!;
    const items = [...cacheSection.querySelectorAll(".usage-storage-item")].map(el => el.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Big documentary");
    expect(items[1]).toContain("Small clip");
    // Clean project isn't rendered as a noisy 0 B row with a disabled button.
    expect(cacheSection.textContent).not.toContain("Clean project");
    expect(cacheSection.textContent).toContain("1 other project with no cached files.");

    // Clear all confirms and clears both cached projects in one call.
    const clearAll = [...cacheSection.querySelectorAll("button")].find(b => b.textContent?.trim() === "Clear all")!;
    await act(async () => clearAll.click());
    const dialog = container.querySelector("dialog[open]")!;
    expect(dialog.textContent).toContain("2 projects");

    storageSpy.mockResolvedValue({ projects: projects.map(p => ({ ...p, segments: [] })) });
    vi.mocked(desktop.measureProjectStorage).mockResolvedValue({
      prj_small: { bytes: 0, files: 0, estimated: false },
      prj_clean: { bytes: 0, files: 0, estimated: false },
      prj_big: { bytes: 0, files: 0, estimated: false },
    });
    const confirmBtn = [...dialog.querySelectorAll("button")].find(b => b.textContent?.trim() === "Clear cache")!;
    await act(async () => confirmBtn.click());
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(cleanSpy).toHaveBeenCalledWith({
      kind: "cache",
      projects: [
        { id: "prj_big", deletedAt: null },
        { id: "prj_small", deletedAt: null },
      ],
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Render cache cleared.");
    expect(cacheSection.textContent).toContain("No cached render files across 3 projects.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
