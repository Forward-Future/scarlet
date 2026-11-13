// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktop } from "../../lib/desktop";
import { buildPercent, enableUpdateStatus } from "../../lib/updateStatus";
import { UpdateButton } from "./UpdateButton";

it("shows a build under way with how far along it is, then becomes the button that restarts into it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000_000));
  const commit = "b".repeat(40);
  const building = { revision: commit, done: 0.2, step: 0.6, stepStarted: 1_000_005, stepSeconds: 240 };
  const status = vi.spyOn(desktop, "updateStatus").mockResolvedValue({ ready: null, building: null });
  const restart = vi.spyOn(desktop, "restartForUpdate").mockRejectedValueOnce("An edit is running.").mockResolvedValue();
  const container = document.createElement("div");
  const root = createRoot(container);
  const dirty = (event: Event) => event.preventDefault();
  const poll = () => act(async () => vi.advanceTimersByTimeAsync(5000).then(() => undefined));
  enableUpdateStatus();
  try {
    // With nothing building and nothing ready, the header has no update control at all.
    await act(async () => root.render(<UpdateButton />));
    expect(container.childElementCount).toBe(0);
    // The updater starts a build: the control appears, as a status and not yet a button.
    status.mockResolvedValue({ ready: null, building });
    await poll();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[role=status]")!.textContent).toBe("Updating20%");
    expect(container.querySelector("[role=status]")!.closest(".update-corner")).not.toBeNull();
    // Hovering it names the build on its way and the one that's running.
    const on = `You’re on ${__SCARLET_VERSION__}${__SCARLET_REVISION__ ? `, build ${__SCARLET_REVISION__.slice(0, 7)}` : ""}.`;
    const hint = () => {
      const described = container.querySelector("[aria-describedby]")!;
      const tip = container.querySelector("[role=tooltip]")!;
      expect(described.getAttribute("aria-describedby")).toBe(tip.id);
      expect(described.hasAttribute("title")).toBe(false);
      return [...tip.firstElementChild!.children].map(line => line.textContent);
    };
    expect(hint()).toEqual(["Updating to build bbbbbbb", on,
      "Scarlet is building it in the background. Keep working: this becomes Restart to update when it’s ready."]);
    // It moves on between the updater's reports, at the pace this part took last time.
    await act(async () => vi.advanceTimersByTimeAsync(120_000).then(() => undefined));
    expect(container.querySelector("[role=status]")!.getAttribute("aria-label")).toBe("Updating Scarlet, 50% built");
    // A part that runs long waits at its end. The figure never reaches 100 by itself.
    await act(async () => vi.advanceTimersByTimeAsync(600_000).then(() => undefined));
    expect(container.querySelector(".update-button-figure")!.textContent).toBe("80%");
    expect(buildPercent({ ...building, done: 0.9, step: 0.2 }, Date.now())).toBe(99);
    // The first build is ready. A new head starts updating while this window stays open.
    status.mockResolvedValue({ ready: commit, building: null });
    await poll();
    expect(hint()).toEqual(["Build bbbbbbb is ready", on, "Restarting installs it and brings you back here."]);
    const newer = { ...building, revision: "c".repeat(40), done: 0, stepStarted: Date.now() / 1000 + 5 };
    status.mockResolvedValue({ ready: commit, building: newer });
    await poll();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[role=status]")!.textContent).toBe("Updating0%");
    expect(hint()[0]).toBe("Updating to build ccccccc");
    await act(async () => vi.advanceTimersByTimeAsync(60_000).then(() => undefined));
    expect(container.querySelector("[role=status]")!.textContent).toBe("Updating15%");
    expect(restart).not.toHaveBeenCalled();
    // If the newer build fails, the verified one is still available.
    status.mockResolvedValue({ ready: commit, building: null });
    await poll();
    expect(hint()[0]).toBe("Build bbbbbbb is ready");
    // Once the retry verifies, restart targets it even if its last progress report is still on disk.
    status.mockResolvedValue({ ready: commit, building: newer });
    await poll();
    status.mockResolvedValue({ ready: newer.revision, building: newer });
    await poll();
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Restart to update");
    expect(button.closest(".update-corner")).not.toBeNull();
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(hint()).toEqual(["Build ccccccc is ready", on, "Restarting installs it and brings you back here."]);
    window.addEventListener("beforeunload", dirty);
    await act(async () => button.click());
    expect(restart).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")!.textContent).toBe("Save your changes before restarting.");
    expect(container.querySelector("[role=tooltip]")).toBeNull();  // The reason it didn't restart takes the hint's place.
    window.removeEventListener("beforeunload", dirty);
    await act(async () => button.click());
    expect(container.querySelector("[role=alert]")!.textContent).toBe("An edit is running.");
    await act(async () => button.click());
    expect(restart).toHaveBeenLastCalledWith(newer.revision);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Restarting…");
    expect(restart).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener("beforeunload", dirty);
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("restores the update bookmark once and discards it if the restart fails", async () => {
  const { clearUpdatePlace, restoreUpdatePlace, saveUpdatePlace } = await import("../../lib/updatePlace");
  const clock = (e: Event) => (e as CustomEvent<URL>).detail.searchParams.set("t", "87.5");
  window.addEventListener("scarlet:bookmark-project", clock);
  try {
    history.replaceState(null, "", "/p/project?thread=edit");
    saveUpdatePlace();
    history.replaceState(null, "", "/");
    restoreUpdatePlace();
    expect(location.pathname + location.search).toBe("/p/project?thread=edit&t=87.5");
    history.replaceState(null, "", "/");
    restoreUpdatePlace();
    expect(location.pathname).toBe("/");
    history.replaceState(null, "", "/p/project");
    saveUpdatePlace();
    clearUpdatePlace();
    history.replaceState(null, "", "/");
    restoreUpdatePlace();
    expect(location.pathname).toBe("/");
  } finally {
    window.removeEventListener("scarlet:bookmark-project", clock);
    history.replaceState(null, "", "/");
    clearUpdatePlace();
  }
});

it("reopens the project that was on screen, forgets it at the library, and never retries one that didn't open", async () => {
  const { rememberProject, restoreLastProject } = await import("../../lib/updatePlace");
  try {
    history.replaceState(null, "", "/");
    restoreLastProject();
    expect(location.pathname).toBe("/");
    // The project finished opening, then Scarlet quit.
    rememberProject("prj_open");
    restoreLastProject();
    expect(location.pathname).toBe("/p/prj_open");
    rememberProject("prj_open");
    // Back at the library, a quit reopens the library.
    rememberProject(null);
    history.replaceState(null, "", "/");
    restoreLastProject();
    expect(location.pathname).toBe("/");
    // A project that never finished opening after a restore is not tried a second time.
    rememberProject("prj_broken");
    restoreLastProject();
    expect(location.pathname).toBe("/p/prj_broken");
    history.replaceState(null, "", "/");
    restoreLastProject();
    expect(location.pathname).toBe("/");
    restoreLastProject();
    expect(location.pathname).toBe("/");
  } finally {
    history.replaceState(null, "", "/");
    rememberProject(null);
  }
});
