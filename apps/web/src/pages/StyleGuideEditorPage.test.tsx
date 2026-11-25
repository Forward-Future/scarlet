// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { StyleGuideRecord } from "@scarlet/shared";
import { api } from "../lib/client";
import { buildDb } from "../lib/mock/fixtures";
import { useHostsStore } from "../stores/hosts";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { useUiStore } from "../stores/ui";
import { StyleGuideEditorPage } from "./StyleGuideEditorPage";

it("leaves Enter to an input method that is composing the style guide's name", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = "2026-11-24T12:00:00.000Z";
  let guide: StyleGuideRecord = { id: "sg_main", name: "channel-brand", description: "", instructions: "", isDefault: false, assets: [], createdAt: now, updatedAt: now };
  useHostsStore.setState({ hosts: [buildDb().hosts.find(h => h.online)!] });
  useUiStore.setState({ agent: { agent: "claude", model: "claude-opus-4-6" }, styleGuidesBeta: true });
  useStyleGuidesStore.setState({ styleGuides: [guide], status: "ready", error: null });
  vi.spyOn(api, "styleGuide").mockImplementation(async () => ({ styleGuide: guide, edits: [] }));
  const update = vi.spyOn(api, "updateStyleGuide").mockImplementation(async (_id, patch) => ({ styleGuide: (guide = { ...guide, ...patch }) }));
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/settings/style-guides/:styleGuideId", element: <StyleGuideEditorPage /> }],
    { initialEntries: [`/settings/style-guides/${guide.id}`] });
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const name = el.querySelector<HTMLInputElement>("#sg-name")!;
    const key = (init: KeyboardEventInit) => act(async () => { name.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
    await act(async () => name.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "show");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The Enter that commits a composition (keyCode 229 in WebKit) doesn't save the half-written name.
    await key({ key: "Enter", keyCode: 229 });
    await key({ key: "Enter", isComposing: true });
    expect(document.activeElement).toBe(name);
    expect(update).not.toHaveBeenCalled();
    await key({ key: "Enter" });
    expect(update).toHaveBeenCalledWith(guide.id, { name: "show" });
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    useStyleGuidesStore.setState(useStyleGuidesStore.getInitialState());
    useHostsStore.setState(useHostsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
