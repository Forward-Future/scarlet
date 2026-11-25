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

it("sends attached files without requiring a typed message, derives a slug from the file, and renders only one working status in chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const now = "2026-11-25T08:00:00.000Z";
  const created: StyleGuideRecord = {
    id: "sg_brand", name: "forward-future-brand-guide", description: "", instructions: "", isDefault: false, assets: [], createdAt: now, updatedAt: now,
  };
  const asset = { id: "sga_doc", name: "forward_future_brand_guide.md", size: 420, mime: "text/markdown", createdAt: now };
  const runningTask = {
    ...buildDb().tasks[0]!,
    id: "task_sg_file",
    kind: "style_guide_edit" as const,
    state: "running" as const,
    instruction: "",
    context: {
      styleGuideId: created.id,
      attachments: [{ id: asset.id, name: asset.name, size: asset.size, mime: asset.mime }],
    },
    question: null,
    summary: null,
  };
  useHostsStore.setState({ hosts: [buildDb().hosts.find(h => h.online)!] });
  useUiStore.setState({ agent: { agent: "claude", model: "claude-opus-4-6" }, styleGuidesBeta: true });
  useStyleGuidesStore.setState({ styleGuides: [], status: "ready", error: null });

  const create = vi.spyOn(api, "createStyleGuide").mockResolvedValue({ styleGuide: created });
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockResolvedValue({
    asset, styleGuide: { ...created, assets: [asset] },
  });
  const editGuide = vi.spyOn(api, "editStyleGuide").mockResolvedValue({ task: runningTask });
  vi.spyOn(api, "styleGuide").mockResolvedValue({ styleGuide: { ...created, assets: [asset] }, edits: [runningTask] });
  vi.spyOn(api, "task").mockResolvedValue({
    task: runningTask,
    events: [{ id: "ev_1", taskId: runningTask.id, at: now, type: "tool", text: "attachment_read", data: { tool: "attachment_read" } }],
  });

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
    expect(el.querySelector('button[aria-label="Send"]')).toBeNull();

    // Stage a file without typing any message.
    const fileInput = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["# Brand guide"], "forward_future_brand_guide.md", { type: "text/markdown" });
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Send button appears immediately and Esc moves focus to Send.
    const sendBtn = el.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    expect(sendBtn).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(sendBtn);

    // Clicking Send submits the file without a text message.
    await act(async () => sendBtn!.click());
    expect(create).toHaveBeenCalledWith({ name: "forward-future-brand-guide", isDefault: false });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(editGuide).toHaveBeenCalledWith("sg_brand", expect.objectContaining({
      prompt: "",
      attachments: [{ id: "sga_doc", name: "forward_future_brand_guide.md", size: 420, mime: "text/markdown" }],
    }));
    expect(router.state.location.pathname).toBe("/settings/style-guides/sg_brand");

    // Advance polling timer so live tool activity renders.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });

    // File chip renders cleanly without an empty Said paragraph above it.
    expect(el.querySelector(".unit-msg .said")).toBeNull();
    expect(el.querySelector(".style-guide-msg-files.is-only")?.textContent).toContain("forward_future_brand_guide.md");

    // Working status appears once in chat and is not duplicated in the main preview area.
    const statuses = [...el.querySelectorAll('[role="status"]')];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.textContent).toBe("Reading an attached file…");
    expect(el.querySelector(".style-guide-preview-pane [role='status']")).toBeNull();
    expect(el.querySelector(".style-guide-preview-status")).toBeNull();
  } finally {
    vi.useRealTimers();
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
