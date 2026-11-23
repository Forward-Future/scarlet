// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { buildDb } from "../../lib/mock/fixtures";
import { useHostsStore } from "../../stores/hosts";
import { useModelPreferences } from "../../stores/modelPicker";
import { api } from "../../lib/client";
import { ListeningSettings } from "./ListeningSettings";
import { ModelSettings } from "./ModelSettings";

it("renders each model on one line and places disabled models below active ones", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldPrefs = useModelPreferences.getState();
  const host = buildDb().hosts[0]!;
  useHostsStore.setState({
    hosts: [{
      ...host,
      online: true,
      agents: [{
        id: "claude",
        installed: true,
        models: ["opus", "fable[1m]", "sonnet", "haiku"],
        modelLabels: {
          opus: "Opus 5.5",
          "fable[1m]": "Fable 5.2",
          sonnet: "Sonnet 5.5",
          haiku: "Haiku 5.5",
        },
      }],
    }],
  });
  useModelPreferences.setState({ hidden: ["claude:opus", "claude:sonnet"], favorites: [] });

  const container = document.createElement("div");
  const root = createRoot(container);
  const rows = () => [...container.querySelectorAll("li")];
  const labels = () => rows().map(li => li.querySelector("span")!.textContent);
  const toggle = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Show Claude Code · ${label} in selector"]`)!;

  try {
    await act(() => root.render(<MemoryRouter><ModelSettings /></MemoryRouter>));

    // Active models appear first in catalog order, disabled models below them in catalog order.
    expect(labels()).toEqual(["Fable 5.2", "Haiku 5.5", "Opus 5.5", "Sonnet 5.5"]);
    expect([...container.querySelectorAll("h4")].map(h => h.textContent)).toEqual(["Models", "Hidden· 2"]);

    // Label and raw model id share a single flex row.
    const textRow = rows()[0]!.querySelector("div")!;
    expect(textRow.className).toContain("flex");
    expect([...textRow.children].map(el => el.textContent)).toEqual(["Fable 5.2", "fable[1m]"]);

    // Turning off an active model moves it below the remaining active models.
    await act(() => toggle("Fable 5.2").click());
    expect(labels()).toEqual(["Haiku 5.5", "Opus 5.5", "Fable 5.2", "Sonnet 5.5"]);
    expect([...container.querySelectorAll("h4")].map(h => h.textContent)).toEqual(["Models", "Hidden· 3"]);

    // Turning a disabled model back on moves it back up with the active models.
    await act(() => toggle("Opus 5.5").click());
    expect(labels()).toEqual(["Opus 5.5", "Haiku 5.5", "Fable 5.2", "Sonnet 5.5"]);
    expect([...container.querySelectorAll("h4")].map(h => h.textContent)).toEqual(["Models", "Hidden· 2"]);
  } finally {
    await act(() => root.unmount());
    useHostsStore.setState(oldHosts, true);
    useModelPreferences.setState(oldPrefs, true);
    vi.unstubAllGlobals();
  }
});

it("shows a scroll cue for hidden models below when the list overflows and lets you scroll through it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldPrefs = useModelPreferences.getState();
  const host = buildDb().hosts[0]!;
  useHostsStore.setState({
    hosts: [{
      ...host,
      online: true,
      agents: [{
        id: "gemini",
        installed: true,
        models: ["m1", "m2", "m3", "m4", "m5", "m6"],
        modelLabels: {
          m1: "Model 1",
          m2: "Model 2",
          m3: "Model 3",
          m4: "Model 4",
          m5: "Model 5",
          m6: "Model 6",
        },
      }],
    }],
  });
  useModelPreferences.setState({ hidden: ["gemini:m4", "gemini:m5", "gemini:m6"], favorites: [] });

  const container = document.createElement("div");
  const root = createRoot(container);

  const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(360);

  try {
    await act(() => root.render(<MemoryRouter><ModelSettings /></MemoryRouter>));

    const list = container.querySelector<HTMLDivElement>(".model-list-scroll")!;
    // Simulate viewport height 200 where m4 (first hidden model) is visible and m5/m6 are below the fold.
    const rowTops = [20, 60, 100, 150, 210, 250];
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({
      top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200, x: 0, y: 0, toJSON: () => ({}),
    }));
    const rows = [...list.querySelectorAll<HTMLLIElement>("li[data-model-state]")];
    rows.forEach((row, i) => {
      vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
        const top = rowTops[i]! - list.scrollTop;
        return { top, bottom: top + 36, left: 0, right: 400, width: 400, height: 36, x: 0, y: top, toJSON: () => ({}) };
      });
    });

    const scrollTo = vi.spyOn(list, "scrollTo").mockImplementation((options?: ScrollToOptions | number, y?: number) => {
      list.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
      list.dispatchEvent(new Event("scroll"));
    });

    await act(() => {
      list.dispatchEvent(new Event("scroll"));
    });

    const cueButton = () => [...container.querySelectorAll("button")].find(b =>
      /below|Back to top/.test(b.textContent ?? ""),
    );
    expect(cueButton()?.textContent).toBe("2 more hidden models below");

    // Clicking the cue scrolls down to the bottom and switches the button to Back to top.
    await act(() => {
      cueButton()!.click();
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 160, behavior: "smooth" });
    expect(list.scrollTop).toBe(160);
    expect(cueButton()?.textContent).toBe("Back to top");

    // Clicking Back to top scrolls back up and restores the below-the-fold cue.
    await act(() => {
      cueButton()!.click();
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
    expect(list.scrollTop).toBe(0);
    expect(cueButton()?.textContent).toBe("2 more hidden models below");

    // When both active and hidden rows lie below the fold, the cue mentions both.
    clientHeight.mockReturnValue(110);
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({
      top: 0, bottom: 110, left: 0, right: 400, width: 400, height: 110, x: 0, y: 0, toJSON: () => ({}),
    }));
    await act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
    expect(cueButton()?.textContent).toBe("4 more models below · 3 hidden");

    // When the list no longer overflows, no scroll cue is rendered.
    scrollHeight.mockReturnValue(110);
    await act(() => {
      list.dispatchEvent(new Event("scroll"));
    });
    expect(cueButton()).toBeUndefined();
  } finally {
    clientHeight.mockRestore();
    scrollHeight.mockRestore();
    await act(() => root.unmount());
    useHostsStore.setState(oldHosts, true);
    useModelPreferences.setState(oldPrefs, true);
    vi.unstubAllGlobals();
  }
});

it("lets the editor pick which model listens, or turn listening off, and says what it means", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const host = buildDb().hosts[0]!;
  let saved = { ...buildDb().settings, listening: "auto" };
  vi.spyOn(api, "settings").mockImplementation(async () => ({ settings: saved }));
  const update = vi.spyOn(api, "updateSettings").mockImplementation(async patch => ({ settings: (saved = { ...saved, ...patch }) }));
  const container = document.createElement("div");
  const root = createRoot(container);
  const status = () => container.querySelector(".transcription-status")!.textContent;
  const shown = () => container.querySelector("#listening-model")!.textContent;
  const show = async (agents: typeof host.agents) => {
    useHostsStore.setState({ hosts: [{ ...host, online: true, agents }], status: "ready" });
    await act(async () => root.render(<MemoryRouter><ListeningSettings key={Math.random()} /></MemoryRouter>));
    await act(async () => {});
  };
  const claude = { id: "claude" as const, installed: true };
  const gemini = { id: "gemini" as const, installed: true, models: ["gemini-4-neon", "claude-opus-5-5"], modelLabels: { "gemini-4-neon": "Gemini 4 Neon", "claude-opus-5-5": "Opus 5.5" } };
  const codex = { id: "codex" as const, installed: true, models: ["gpt-6.2-sol", "gpt-6-astra-audio"], modelLabels: { "gpt-6-astra-audio": "GPT-6 Astra Audio" } };
  try {
    await show([claude]);
    expect(status()).toBe("No model here can hear. Sign in to Gemini so Scarlet listens to cuts instead of only reading the transcript. Manage sign-in");
    await show([claude, gemini, codex]);
    // Automatic says which model it uses: the best signed in, Gemini first, on Gemini's own default model.
    expect(shown()).toContain("Automatic · Gemini");
    expect(status()).toBe("Gemini listens to cuts for models that can’t hear, so Scarlet catches a stumble or a clipped word the transcript misses.");
    // The editor can pick one model that hears, of those signed in, or turn it off.
    await act(async () => container.querySelector<HTMLButtonElement>("#listening-model")!.click());
    expect([...document.querySelectorAll("[role=option]")].map(o => o.textContent)).toEqual(["Automatic", "Gemini 4 Neon", "GPT-6 Astra Audio", "Off"]);
    await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find(o => o.textContent === "GPT-6 Astra Audio")!.click());
    expect(update).toHaveBeenLastCalledWith({ listening: "codex:gpt-6-astra-audio" });
    expect(status()).toMatch(/^GPT-6 Astra Audio listens to cuts/);
    // A model picked that isn't signed in now listens for nobody, and says so: nothing else is swapped in.
    await show([claude, gemini]);
    expect(status()).toBe("gpt-6-astra-audio isn’t signed in, so nothing listens for now. Sign in again or choose another model. Manage sign-in");
    saved = { ...saved, listening: "off" };
    await show([claude, gemini]);
    expect(status()).toBe("Off: models that can’t hear read the transcript and a picture of the sound instead.");
  } finally {
    act(() => root.unmount());
    useHostsStore.setState(oldHosts, true);
    vi.restoreAllMocks();
  }
});
