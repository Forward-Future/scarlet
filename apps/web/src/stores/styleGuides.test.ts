// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StyleGuideRecord } from "@scarlet/shared";
import { api } from "../lib/client";
import { commandStyleGuideIds, useStyleGuidesStore } from "./styleGuides";

const guide = { id: "sg_brand", name: "brand", isDefault: false } as StyleGuideRecord;

beforeEach(() => {
  useStyleGuidesStore.setState({ styleGuides: [], status: "idle", error: null });
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("waits for a read of the guides already under way before resolving an @mention", async () => {
  let resolve!: (value: { styleGuides: StyleGuideRecord[] }) => void;
  const read = vi.spyOn(api, "styleGuides").mockImplementation(() => new Promise(r => { resolve = r; }));
  void useStyleGuidesStore.getState().load();
  expect(useStyleGuidesStore.getState().status).toBe("loading");
  const ids = commandStyleGuideIds("use @brand here");
  resolve({ styleGuides: [guide] });
  await expect(ids).resolves.toEqual(["sg_brand"]);
  expect(read).toHaveBeenCalledTimes(1);
});

it("says why when the guides couldn't be read, instead of leaving the @mention off unsaid", async () => {
  vi.spyOn(api, "styleGuides").mockRejectedValue(new Error("The engine isn't answering."));
  await expect(commandStyleGuideIds("use @brand here")).rejects.toThrow("The engine isn't answering.");
  // A list that read fine still leaves an unknown name as plain text.
  vi.mocked(api.styleGuides).mockResolvedValue({ styleGuides: [guide] });
  await expect(commandStyleGuideIds("use @other here")).resolves.toBeUndefined();
});
