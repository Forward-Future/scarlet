// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop } from "../../lib/desktop";
import { forgetOnScreenErrors, noteOnScreenError, recentOnScreenErrors } from "../../lib/problemReportStore";
import { ErrorState } from "../ui/primitives";
import { ReportLink, ReportProblemCard, ReportProblemDialog, ReportProblemHost, useProblemReport } from "./ReportProblem";
import { RouteErrorScreen } from "./RouteErrorScreen";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent === label);
const dialog = () => document.querySelector("dialog");
const type = (field: HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  forgetOnScreenErrors();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProblemReport.setState({ open: false, about: undefined });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sends the report from Scarlet with the error, the page and what was on screen, and says it went", async () => {
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ reference: "3F2A-91BC" });
  const open = vi.spyOn(desktop, "openUrl");
  noteOnScreenError("Couldn’t open the project");
  const closed = vi.fn();
  await act(async () => root.render(<ReportProblemDialog open onClose={closed} about="Couldn’t finish: Claude Code stopped responding." />));
  expect(dialog()?.textContent).toContain("Couldn’t finish: Claude Code stopped responding.");
  expect(dialog()?.textContent).toContain("No videos, projects, transcripts or sign-ins.");
  const field = document.querySelector("textarea")!;
  expect(field.hasAttribute("data-log-private")).toBe(true);
  await act(async () => type(field, "I asked for captions and it stopped"));
  await act(async () => button("Send report")!.click());
  expect(send).toHaveBeenCalledWith({
    description: "I asked for captions and it stopped", about: "Couldn’t finish: Claude Code stopped responding.",
    page: "/", onScreen: ["Couldn’t open the project"],
  });
  // Nothing opens outside Scarlet.
  expect(open).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Report sent");
  expect(dialog()?.textContent).toContain("3F2A-91BC");
  await act(async () => button("Done")!.click());
  expect(closed).toHaveBeenCalled();
});

it("says why a report couldn't go, tries again, and can save it as a file instead", async () => {
  const send = vi.spyOn(desktop, "sendProblemReport").mockRejectedValueOnce("Scarlet couldn't reach the internet.")
    .mockRejectedValueOnce("The report service answered 503.").mockResolvedValueOnce({ reference: "AAAA-BBBB" });
  const save = vi.spyOn(desktop, "saveProblemReport").mockResolvedValue("/Users/editor/Downloads/scarlet-report-2026-11-26-1514.zip");
  const reveal = vi.spyOn(desktop, "revealPath").mockResolvedValue();
  await act(async () => root.render(<ReportProblemDialog open onClose={() => undefined} />));
  await act(async () => button("Send report")!.click());
  expect(dialog()?.textContent).toContain("Couldn’t send the report. Scarlet couldn't reach the internet.");
  await act(async () => button("Save as file")!.click());
  expect(save).toHaveBeenCalledWith({ description: "", about: undefined, page: "/", onScreen: [] });
  expect(reveal).toHaveBeenCalledWith("/Users/editor/Downloads/scarlet-report-2026-11-26-1514.zip");
  expect(dialog()?.textContent).toContain("Saved scarlet-report-2026-11-26-1514.zip");

  // Opened again it starts clean, and Try again sends.
  await act(async () => root.render(<ReportProblemDialog open={false} onClose={() => undefined} />));
  await act(async () => root.render(<ReportProblemDialog open onClose={() => undefined} />));
  expect(dialog()?.textContent).not.toContain("Couldn’t send");
  await act(async () => button("Send report")!.click());
  expect(dialog()?.textContent).toContain("The report service answered 503.");
  await act(async () => button("Try again")!.click());
  expect(send).toHaveBeenCalledTimes(3);
  expect(dialog()?.textContent).toContain("AAAA-BBBB");
});

it("opens about the error beside a Report, and from Settings and the Help menu", async () => {
  let fromMenu: (() => void) | undefined;
  vi.spyOn(desktop, "onReportProblem").mockImplementation(async (cb) => { fromMenu = cb; return () => undefined; });
  await act(async () => root.render(<>
    <ReportLink about="Export failed: disk full" />
    <ErrorState title="Couldn’t open the project" body="The engine stopped" onRetry={() => undefined} />
    <ReportProblemCard />
    <ReportProblemHost />
  </>));
  expect(dialog()).toBeNull();
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Report")!.click());
  expect(dialog()?.textContent).toContain("Export failed: disk full");
  await act(async () => button("Cancel")!.click());
  expect(dialog()).toBeNull();
  await act(async () => [...document.querySelectorAll("button")].filter(b => b.textContent === "Report")[1]!.click());
  expect(dialog()?.textContent).toContain("Couldn’t open the project: The engine stopped");
  await act(async () => button("Cancel")!.click());
  await act(async () => button("Report a problem…")!.click());
  expect(dialog()?.textContent).not.toContain("About");
  await act(async () => button("Cancel")!.click());
  await act(async () => fromMenu!());
  expect(dialog()?.textContent).toContain("What happened?");
});

it("keeps the newest errors shown in the last quarter hour", () => {
  for (let i = 0; i < 10; i++) noteOnScreenError(`error ${i}`, 1_000 * i);
  noteOnScreenError("error 9", 9_500);
  expect(recentOnScreenErrors(10_000)).toEqual(["error 2", "error 3", "error 4", "error 5", "error 6", "error 7", "error 8", "error 9"]);
  noteOnScreenError("later", 10 * 60_000);
  expect(recentOnScreenErrors(20 * 60_000)).toEqual(["later"]);
  expect(recentOnScreenErrors(30 * 60_000)).toEqual([]);
});

it("puts a page that broke while drawing behind a screen that reports it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ reference: "3F2A-91BC" });
  const Broken = () => { throw new TypeError("Cannot read properties of undefined (reading 'start')"); };
  const router = createMemoryRouter([{ path: "/", element: <Broken />, errorElement: <RouteErrorScreen /> }]);
  await act(async () => root.render(<RouterProvider router={router} />));
  expect(container.textContent).toContain("Something went wrong");
  expect(button("Reload")).toBeDefined();
  await act(async () => button("Report this problem")!.click());
  await act(async () => button("Send report")!.click());
  expect(send.mock.calls[0]![0].about).toBe("Something went wrong: TypeError: Cannot read properties of undefined (reading 'start')");
});
