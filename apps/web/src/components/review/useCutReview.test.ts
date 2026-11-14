// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ScarletApiError } from "@scarlet/shared";
import { api } from "../../lib/client";
import { singleCutDraft } from "./useCutReview";

afterEach(() => vi.restoreAllMocks());

it("asks once for a cut that can't be previewed on a version, until the working cut moves on", async () => {
  const refused = new ScarletApiError(409, "cut_review_stale", "Footage was inserted, replaced or changed inside the passage.");
  const ask = vi.spyOn(api, "cutReviewDraft").mockRejectedValue(refused);
  const draft = (head: string) => singleCutDraft("chg_stale", 1, 3, head, new AbortController().signal, new Map());
  await expect(draft("ver_a")).rejects.toBe(refused);
  // Opened again, or prepared as the next cut, on the same version: the engine isn't asked again (2026-11-14).
  await expect(draft("ver_a")).rejects.toBe(refused);
  expect(ask).toHaveBeenCalledTimes(1);
  // The working cut moved on: it may preview now.
  await expect(draft("ver_b")).rejects.toBe(refused);
  expect(ask).toHaveBeenCalledTimes(2);
});
