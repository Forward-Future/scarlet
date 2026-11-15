import { create } from "zustand";
import type { GraphicTemplateSummary } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";

/**
 * Where each `$name` in a message is: a `$` at the start of the box or after a space, and the template name after it.
 * The engine reads the same `$name` words to pick the template, so nothing else marks one in the box.
 */
export function templateTokens(draft: string) {
  return Array.from(draft.matchAll(/(?:^|\s)(\$([a-z0-9][a-z0-9-]*)?)(?=\s|$)/gi), match => {
    const end = match.index + match[0].length;
    return { start: end - match[1]!.length, end, name: (match[2] ?? "").toLowerCase() };
  });
}

interface TemplatesState {
  templates: GraphicTemplateSummary[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Read the library again. The list the box already has stays on screen meanwhile. */
  load(): Promise<void>;
  /** The template lit in the $ list, drawn over the player's picture while it is. */
  lit: { id: string; url: string } | null;
  setLit(lit: { id: string; url: string } | null): void;
}

let loading: Promise<void> | undefined;

export const useTemplatesStore = create<TemplatesState>((set, get) => ({
  templates: [],
  status: "idle",
  error: null,
  lit: null,
  setLit: lit => {
    const was = get().lit;
    if (was?.id === lit?.id && was?.url === lit?.url) return;
    set({ lit });
  },
  load: () => {
    if (loading) return loading;
    if (get().status !== "ready") set({ status: "loading", error: null });
    loading = api.listTemplates().then(({ templates }) => set({ templates, status: "ready", error: null }), (e: unknown) => {
      // A list read before stays: a failed refresh doesn't empty it.
      if (get().status === "ready") return;
      set({ status: "error", error: errorMessage(e) });
    }).finally(() => { loading = undefined; });
    return loading;
  },
}));

/** A template's picture, cached by its preview's version. */
export const templatePreview = (template: Pick<GraphicTemplateSummary, "id" | "previewVersion">) =>
  api.templatePreviewUrl(template.id, template.previewVersion);
