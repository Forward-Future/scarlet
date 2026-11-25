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

it("reuses the created style guide and uploaded asset when retrying a failed send, and moves Esc to Send while typed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = "2026-11-24T12:00:00.000Z";
  const created: StyleGuideRecord = {
    id: "sg_new", name: "bold-editorial", description: "", instructions: "", isDefault: false, assets: [], createdAt: now, updatedAt: now,
  };
  const asset = { id: "ast_logo", name: "logo.png", path: "assets/logo.png", size: 128, mime: "image/png", createdAt: now };
  useHostsStore.setState({ hosts: [buildDb().hosts.find(h => h.online)!] });
  useUiStore.setState({ agent: { agent: "claude", model: "claude-opus-4-6" }, styleGuidesBeta: true });
  useStyleGuidesStore.setState({ styleGuides: [], status: "ready", error: null });
  const create = vi.spyOn(api, "createStyleGuide").mockResolvedValue({ styleGuide: created });
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockResolvedValue({
    asset, styleGuide: { ...created, assets: [asset] },
  });
  vi.spyOn(api, "styleGuide").mockResolvedValue({ styleGuide: { ...created, assets: [asset] }, edits: [] });
  const task = { ...buildDb().tasks[0]!, id: "task_sg_1", kind: "style_guide_edit" as const, state: "done" as const };
  const editGuide = vi.spyOn(api, "editStyleGuide")
    .mockRejectedValueOnce(new Error("Temporary network error"))
    .mockResolvedValueOnce({ task });

  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([
    { path: "/settings/style-guides", element: <div>Library</div> },
    { path: "/settings/style-guides/new", element: <StyleGuideEditorPage /> },
    { path: "/settings/style-guides/:styleGuideId", element: <StyleGuideEditorPage /> },
  ], { initialEntries: ["/settings/style-guides/new"] });

  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const fileInput = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["png"], "logo.png", { type: "image/png" });
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const box = el.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Bold editorial captions");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Pressing Escape outside the textarea focuses Send instead of leaving "/settings/style-guides/new" and losing the prompt.
    const nameInput = el.querySelector<HTMLInputElement>("#sg-name")!;
    nameInput.blur();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(router.state.location.pathname).toBe("/settings/style-guides/new");
    expect(document.activeElement).toBe(el.querySelector<HTMLButtonElement>('button[aria-label="Send"]'));

    // First send fails on editStyleGuide after creating the guide and uploading logo.png.
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(editGuide).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Temporary network error");

    // Retrying reuses sg_new and ast_logo without duplicating either.
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(editGuide).toHaveBeenCalledTimes(2);
    expect(editGuide.mock.calls[1]![0]).toBe("sg_new");
    expect(editGuide.mock.calls[1]![1]).toMatchObject({
      prompt: "Bold editorial captions",
      attachments: [{ id: "ast_logo", name: "logo.png", size: 128, mime: "image/png" }],
    });
    expect(router.state.location.pathname).toBe("/settings/style-guides/sg_new");
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
