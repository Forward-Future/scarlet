import { describe, expect, it } from "vitest";
import type { Change } from "@scarlet/timeline";
import { cutRevisionReference } from "./changes.js";

const change = {
  id: "chg_pass", fromVersion: "v1", toVersion: "v2", ranges: [], state: "ready", description: "Dialogue pass",
  cutReasons: [{ start: 600, end: 604.5, reason: "Earlier image-input take with a stumble." }],
  cutAssessments: [
    { index: 0, start: 0, end: 220, verdict: "ask", reason: "The rehearsals can go." },
    { index: 3, start: 600, end: 604.5, verdict: "ask", reason: "The corrected image-input take belongs here. Check that the sponsor name finishes first." },
  ],
} as unknown as Change;

describe("cutRevisionReference", () => {
  it("names the cut, why it was proposed and how it was assessed", () => {
    const text = cutRevisionReference(change, { cutIndex: 3, time: 600, end: 604.5, clipIds: [] });
    expect(text).toMatch(/^\n\nThis feedback is about one staged cut only\. Leave the other cuts as they are\.\n/);
    // Which cut and where are the prompt's to say, from the pass as it stands when the run starts.
    expect(text).not.toMatch(/cut index|600\.00/);
    expect(text).toContain(`Why this cut was proposed: "Earlier image-input take with a stumble."`);
    expect(text).toContain(`Review note on this cut (ask): "The corrected image-input take belongs here. Check that the sponsor name finishes first."`);
  });

  it("adds nothing when the revision isn't about one cut", () => {
    expect(cutRevisionReference(change, { time: 600, clipIds: [] })).toBe("");
    expect(cutRevisionReference(change, undefined)).toBe("");
  });

  it("still names the cut when it has no assessment", () => {
    const text = cutRevisionReference({ ...change, cutAssessments: undefined, cutReasons: undefined }, { cutIndex: 1, time: 10, end: 12, clipIds: [] });
    expect(text).toBe("\n\nThis feedback is about one staged cut only. Leave the other cuts as they are.");
  });

  it("finds the cut's reason by its own range when the request points at words chosen in its passage", () => {
    // Words chosen in the transcript of the working cut, inside the cut that has no assessment yet.
    const text = cutRevisionReference({ ...change, cutAssessments: undefined }, { cutIndex: 0, time: 601.2, end: 602.8, clipIds: [] });
    expect(text).toContain(`Why this cut was proposed: "Earlier image-input take with a stumble."`);
  });
});
