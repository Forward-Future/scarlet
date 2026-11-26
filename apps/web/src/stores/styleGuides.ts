import { create } from "zustand";
import {
  styleGuideCommands,
  styleGuideMentions,
  type CreateStyleGuideRequest,
  type StyleGuideFromGraphicRequest,
  type StyleGuideRecord,
  type UpdateStyleGuideRequest,
} from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";
import { changedDuringLoad } from "./changedDuringLoad";

interface StyleGuidesState {
  styleGuides: StyleGuideRecord[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load(): Promise<void>;
  apply(guide: StyleGuideRecord): void;
  removeLocal(id: string): void;
  create(body: CreateStyleGuideRequest): Promise<StyleGuideRecord>;
  createFromGraphic(body: StyleGuideFromGraphicRequest): Promise<StyleGuideRecord>;
  update(id: string, body: UpdateStyleGuideRequest): Promise<StyleGuideRecord>;
  remove(id: string): Promise<void>;
}

const sortGuides = (list: StyleGuideRecord[]) =>
  [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

export { styleGuideCommands, styleGuideMentions };

/** Resolve known @style-name mentions in a message draft. Unknown @handles stay plain text. */
export async function commandStyleGuideIds(draft: string): Promise<string[] | undefined> {
  const names = styleGuideMentions(draft);
  if (!names.length) return;
  const store = useStyleGuidesStore.getState();
  // A read under way is waited for, and one that failed is tried again: a guide named isn't left off unsaid.
  if (store.status !== "ready") await store.load();
  const { styleGuides, error } = useStyleGuidesStore.getState();
  if (error) throw new Error(error);
  const byName = new Map(styleGuides.map(g => [g.name.toLowerCase(), g.id]));
  const ids = names.flatMap(name => {
    const id = byName.get(name);
    return id ? [id] : [];
  });
  return ids.length ? [...new Set(ids)] : undefined;
}

let loading: Promise<void> | undefined;
const changes = changedDuringLoad<StyleGuideRecord>();

export const useStyleGuidesStore = create<StyleGuidesState>((set, get) => ({
  styleGuides: [],
  status: "idle",
  error: null,
  load() {
    if (loading) return loading;
    set({ status: "loading", error: null });
    const read = changes.begin();
    loading = api.styleGuides()
      .then(({ styleGuides }) => set({ styleGuides: sortGuides(read.merge(styleGuides)), status: "ready", error: null }))
      .catch(err => set({ status: "error", error: errorMessage(err) }))
      .finally(() => { loading = undefined; read.end(); });
    return loading;
  },
  apply(guide) {
    changes.set(guide.id, guide);
    const rest = get().styleGuides
      .filter(g => g.id !== guide.id)
      .map(g => (guide.isDefault && g.isDefault ? { ...g, isDefault: false } : g));
    set({ styleGuides: sortGuides([...rest, guide]) });
  },
  removeLocal(id) {
    changes.set(id, null);
    set({ styleGuides: get().styleGuides.filter(g => g.id !== id) });
  },
  async create(body) {
    const { styleGuide } = await api.createStyleGuide(body);
    get().apply(styleGuide);
    return styleGuide;
  },
  async createFromGraphic(body) {
    const { styleGuide } = await api.createStyleGuideFromGraphic(body);
    get().apply(styleGuide);
    return styleGuide;
  },
  async update(id, body) {
    const prev = get().styleGuides;
    const existing = prev.find(g => g.id === id);
    if (existing) {
      const { captionStyle, ...rest } = body;
      const next: StyleGuideRecord = {
        ...existing,
        ...rest,
        isDefault: body.isDefault ?? existing.isDefault,
      };
      if (captionStyle === null) delete next.captionStyle;
      else if (captionStyle !== undefined) next.captionStyle = captionStyle;
      get().apply(next);
    }
    try {
      const { styleGuide } = await api.updateStyleGuide(id, body);
      get().apply(styleGuide);
      return styleGuide;
    } catch (err) {
      set({ styleGuides: prev });
      throw err;
    }
  },
  async remove(id) {
    await api.deleteStyleGuide(id);
    get().removeLocal(id);
  },
}));
