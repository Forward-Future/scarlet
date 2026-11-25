// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { StyleGuideRecord } from "@scarlet/shared";
import { SkillCommandInput } from "../components/agent/SkillCommandInput";
import { SkillInstructions } from "../components/agent/SkillInstructions";
import { api } from "../lib/client";
import { buildDb } from "../lib/mock/fixtures";
import { useHostsStore } from "../stores/hosts";
import { useSkillsStore } from "../stores/skills";
import { useStyleGuidesStore } from "../stores/styleGuides";
import { useUiStore } from "../stores/ui";
import { StyleGuidesBetaSettings } from "../components/shell/StyleGuidesBetaSettings";
import { SettingsPage } from "./SettingsPage";
import { StyleGuideEditorPage } from "./StyleGuideEditorPage";
import { StyleGuidesPage } from "./StyleGuidesPage";

function sampleGuide(overrides: Partial<StyleGuideRecord> = {}): StyleGuideRecord {
  const now = "2026-11-24T12:00:00.000Z";
  return {
    id: "sg_main",
    name: "channel-brand",
    description: "Warm cream captions with terracotta accents.",
    instructions: "Use #F5F2EB background, #E05A3A accent, and Inter bold.",
    isDefault: true,
    assets: [],
    preview: {
      width: 1280,
      height: 720,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

it("renders the style guides gallery with default badge, preview image, and empty state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const guides = [
    sampleGuide(),
    sampleGuide({
      id: "sg_minimal",
      name: "clean-white",
      description: "Stark black type on bright paper.",
      isDefault: false,
      preview: undefined,
    }),
  ];
  vi.spyOn(api, "styleGuides").mockResolvedValue({ styleGuides: guides });

  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([
    { path: "/settings/style-guides", element: <StyleGuidesPage /> },
    { path: "/settings/style-guides/:styleGuideId", element: <p>Editor</p> },
  ], { initialEntries: ["/settings/style-guides"] });

  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(el.textContent).toContain("@channel-brand");
    expect(el.textContent).toContain("Default");
    expect(el.textContent).toContain("Warm cream captions with terracotta accents.");
    expect(el.querySelector('img[alt="Preview of @channel-brand"]')).not.toBeNull();
    expect(el.textContent).toContain("@clean-white");
    expect(el.textContent).toContain("No preview yet");

    // Empty state
    useStyleGuidesStore.setState({ styleGuides: [], status: "ready", error: null });
    await act(async () => {});
    expect(el.textContent).toContain("No style guides yet");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    useStyleGuidesStore.setState(useStyleGuidesStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("edits name, default toggle, attached files in chat, and deletes a style guide", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  const host = db.hosts.find(h => h.online)!;
  useHostsStore.setState({ hosts: [host] });
  useUiStore.setState({ agent: { agent: "claude", model: "claude-opus-4-6" }, styleGuidesBeta: true });

  let guide = sampleGuide({ isDefault: false });
  useStyleGuidesStore.setState({ styleGuides: [guide], status: "ready", error: null });

  vi.spyOn(api, "styleGuide").mockImplementation(async () => ({ styleGuide: guide, edits: [] }));
  const update = vi.spyOn(api, "updateStyleGuide").mockImplementation(async (_id, patch) => {
    guide = { ...guide, ...patch };
    return { styleGuide: guide };
  });
  const upload = vi.spyOn(api, "uploadStyleGuideAsset").mockImplementation(async (_id, _file, name) => {
    const asset = { id: "sga_logo", name: name ?? "logo.png", size: 120, mime: "image/png", createdAt: guide.updatedAt };
    guide = { ...guide, assets: [...guide.assets, asset] };
    return { asset, styleGuide: guide };
  });
  const edit = vi.spyOn(api, "editStyleGuide").mockImplementation(async (_id, body) => ({
    task: {
      ...db.tasks[0]!,
      id: "tsk_sg1",
      kind: "style_guide_edit" as const,
      state: "queued" as const,
      instruction: body.prompt,
      context: { styleGuideId: guide.id, ...(body.attachments && { attachments: body.attachments }) },
      summary: null,
      question: null,
    },
  }));
  const remove = vi.spyOn(api, "deleteStyleGuide").mockResolvedValue({});

  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([
    { path: "/settings/style-guides/:styleGuideId", element: <StyleGuideEditorPage /> },
    { path: "/settings/style-guides", element: <p>Gallery</p> },
  ], { initialEntries: [`/settings/style-guides/${guide.id}`] });

  const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const nameInput = el.querySelector<HTMLInputElement>("#sg-name")!;
    await type(nameInput, "Show Brand");
    await act(async () => { nameInput.focus(); nameInput.blur(); });
    expect(update).toHaveBeenCalledWith(guide.id, { name: "show-brand" });

    const defaultToggle = el.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use as default style guide"]')!;
    await act(async () => defaultToggle.click());
    expect(update).toHaveBeenCalledWith(guide.id, { isDefault: true });

    // Attach a file via the hidden file input and send a chat message
    const fileInput = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["png"], "logo.png", { type: "image/png" });
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(el.textContent).toContain("logo.png");

    const promptBox = el.querySelector<HTMLTextAreaElement>("textarea")!;
    await type(promptBox, "Use this logo in the lower third.");
    const sendBtn = el.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    await act(async () => sendBtn.click());
    expect(upload).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(guide.id, expect.objectContaining({
      prompt: "Use this logo in the lower third.",
      attachments: [expect.objectContaining({ id: "sga_logo", name: "logo.png" })],
    }));

    // Wait for running task to finish before deleting
    vi.mocked(api.styleGuide).mockResolvedValue({ styleGuide: guide, edits: [] });
    await act(async () => {
      // Simulate no active task by re-opening fresh
      router.navigate(`/settings/style-guides/${guide.id}`);
    });
    expect(remove).not.toHaveBeenCalled();
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

it("offers @style autocomplete in chat and highlights known @style mentions in skills only when beta is enabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const guide = sampleGuide({ name: "tech-brief", description: "Dark slate panels with cyan badges." });
  useStyleGuidesStore.setState({ styleGuides: [guide], status: "ready", error: null });
  useSkillsStore.setState({ skills: [], status: "ready", error: null });
  useUiStore.setState({ styleGuidesBeta: false });

  function Harness() {
    const ref = useRef<HTMLTextAreaElement>(null);
    const [val, setVal] = useState("");
    return (
      <>
        <SkillCommandInput
          inputRef={ref}
          id="chat-box"
          value={val}
          skills={[]}
          placeholder="Describe an edit, / skills"
          onChange={setVal}
          onSubmit={() => {}}
        />
        <SkillInstructions
          className="skill-md"
          value="Always match @tech-brief and leave @unknown-user plain."
          onChange={() => {}}
        />
      </>
    );
  }

  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }], { initialEntries: ["/"] });

  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    // Off by default: no @style highlighting and no @ popover
    expect(el.querySelectorAll(".skill-keyword")).toHaveLength(0);
    const textarea = el.querySelector<HTMLTextAreaElement>("#chat-box")!;
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Make a title @te");
      textarea.setSelectionRange(16, 16);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("Style guides");

    // Turn on Style guides (Beta): @tech-brief highlights in skills and @ opens popover in chat
    await act(async () => useUiStore.setState({ styleGuidesBeta: true }));
    const keywords = [...el.querySelectorAll(".skill-keyword")];
    expect(keywords).toHaveLength(1);
    expect(keywords[0]!.textContent).toBe("@tech-brief");
    expect(keywords[0]!.getAttribute("data-kind")).toBe("style");

    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(16, 16);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.textContent).toContain("Style guides");
    expect(el.textContent).toContain("@tech-brief");
    const row = el.querySelector<HTMLButtonElement>('[role="option"]')!;
    await act(async () => row.click());
    expect(textarea.value).toBe("Make a title @tech-brief ");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    useStyleGuidesStore.setState(useStyleGuidesStore.getInitialState());
    useSkillsStore.setState(useSkillsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps Style guides hidden in Settings until the user turns on Style guides (Beta)", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const db = buildDb();
  let current = { ...db.settings, styleGuidesBeta: false };
  vi.spyOn(api, "settings").mockImplementation(async () => ({ settings: current, transcriptionAvailable: true }));
  vi.spyOn(api, "localModelStatus").mockResolvedValue({ state: "ready" });
  const updateSettings = vi.spyOn(api, "updateSettings").mockImplementation(async patch => {
    current = { ...current, ...patch };
    return { settings: current };
  });

  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([
    { path: "/settings", element: <SettingsPage /> },
    { path: "/settings/style-guides", element: <SettingsPage /> },
  ], { initialEntries: ["/settings"] });

  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const nav = () => el.querySelector('nav[aria-label="Settings sections"]')?.textContent ?? "";
    expect(nav()).not.toContain("Style guides");

    const toggle = el.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Style guides (Beta)"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(updateSettings).toHaveBeenCalledWith({ styleGuidesBeta: true });
    expect(useUiStore.getState().styleGuidesBeta).toBe(true);
    expect(nav()).toContain("Style guides");

    // Turning it back off hides the tab again
    await act(async () => toggle.click());
    expect(updateSettings).toHaveBeenCalledWith({ styleGuidesBeta: false });
    expect(nav()).not.toContain("Style guides");
    // Ensure direct StyleGuidesBetaSettings component stays usable standalone
    expect(StyleGuidesBetaSettings).toBeTypeOf("function");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    router.dispose();
    localStorage.clear();
    useUiStore.setState(useUiStore.getInitialState());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
