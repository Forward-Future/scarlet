// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SourceCacheStatus } from "@scarlet/shared";
import { api } from "../../lib/client";
import { useProjectStore, type ProjectData } from "../../stores/project";
import { useSourceCaches } from "./sourceCaches";

const initial = useProjectStore.getState();
afterEach(() => {
  useProjectStore.setState(initial, true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let hook!: ReturnType<typeof useSourceCaches>;
function Probe() {
  hook = useSourceCaches();
  return null;
}

it("reads the caches for a view put up again while the read for the one before it was still out", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useProjectStore.setState({ current: { id: "prj_remount", project: { mediaPaused: false }, media: [] } as unknown as ProjectData });
  const answers: ((caches: { caches: SourceCacheStatus[] }) => void)[] = [];
  const read = vi.spyOn(api, "sourceCaches").mockImplementation(() => new Promise(resolve => { answers.push(resolve); }));
  const first = createRoot(document.createElement("div"));
  await act(async () => first.render(<Probe />));
  await act(async () => first.unmount());
  // Back before the first read answered, as when the editor leaves the workspace and comes straight back.
  const second = createRoot(document.createElement("div"));
  await act(async () => second.render(<Probe />));
  const cache = { mediaId: "med_a", state: "ready" } as SourceCacheStatus;
  await act(async () => { for (const answer of answers) answer({ caches: [cache] }); });
  expect(read).toHaveBeenCalledTimes(2);
  expect(hook.loaded).toBe(true);
  expect(hook.caches.get("med_a")).toEqual(cache);
  await act(async () => second.unmount());
});
