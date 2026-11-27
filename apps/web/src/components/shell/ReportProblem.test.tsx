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
  useProblemReport.setState({ open: false, follows: undefined, detailed: [] });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sends in one press beside the error, says so there, and adds the editor's words after", async () => {
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ id: "3f2a91bc-0000-4000-8000-000000000000", reference: "3F2A-91BC" });
  const details = vi.spyOn(desktop, "sendProblemDetails").mockResolvedValue();
  const open = vi.spyOn(desktop, "openUrl");
  vi.spyOn(desktop, "onReportProblem").mockResolvedValue(() => undefined);
  noteOnScreenError("Couldn’t open the project");
  await act(async () => root.render(<><ReportLink about="Couldn’t finish: Claude Code stopped responding." /><ReportProblemHost /></>));
  await act(async () => button("Report")!.click());
  // No form: the press sends the report.
  expect(send).toHaveBeenCalledWith({ description: "", about: "Couldn’t finish: Claude Code stopped responding.", page: "/", onScreen: ["Couldn’t open the project"] });
  expect(dialog()).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Report sent · Add details");
  expect(container.querySelector("[role=status]")?.getAttribute("title")).toBe("Reference 3F2A-91BC");

  await act(async () => button("Add details")!.click());
  expect(dialog()?.textContent).toContain("Report 3F2A-91BC · sent");
  expect(dialog()?.textContent).toContain("Couldn’t finish: Claude Code stopped responding.");
  // Nothing written, nothing to send.
  expect(button("Send details")!.disabled).toBe(true);
  await act(async () => type(document.querySelector("textarea")!, "I asked for captions on the opening"));
  await act(async () => button("Send details")!.click());
  expect(details).toHaveBeenCalledWith({ reportId: "3f2a91bc-0000-4000-8000-000000000000", description: "I asked for captions on the opening" });
  expect(dialog()).toBeNull();
  expect(container.textContent).toContain("Report sent with your note");
  expect(button("Add details")).toBeUndefined();
});

it("says beside the error why a report couldn't go, tries again, and can save it as a file", async () => {
  const send = vi.spyOn(desktop, "sendProblemReport").mockRejectedValueOnce("Scarlet couldn't reach the internet.").mockResolvedValueOnce({ id: "a", reference: "AAAA-BBBB" });
  const save = vi.spyOn(desktop, "saveProblemReport").mockResolvedValue("/Users/editor/Downloads/scarlet-report-2026-11-26-1514.zip");
  const reveal = vi.spyOn(desktop, "revealPath").mockResolvedValue();
  await act(async () => root.render(<ReportLink about="Export failed: disk full" />));
  await act(async () => button("Report")!.click());
  expect(container.textContent).toContain("Couldn’t send · Try again · Save as file");
  expect(container.querySelector("[role=alert] [title]")?.getAttribute("title")).toBe("Scarlet couldn't reach the internet.");
  await act(async () => button("Try again")!.click());
  expect(send).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Report sent");

  send.mockRejectedValueOnce("The report service answered 503.");
  await act(async () => root.render(<ReportLink key="again" about="Export failed: disk full" />));
  await act(async () => button("Report")!.click());
  await act(async () => button("Save as file")!.click());
  expect(save).toHaveBeenCalledWith({ description: "", about: "Export failed: disk full", page: "/", onScreen: [] });
  expect(reveal).toHaveBeenCalledWith("/Users/editor/Downloads/scarlet-report-2026-11-26-1514.zip");
  expect(container.textContent).toContain("Saved scarlet-report-2026-11-26-1514.zip");
});

it("keeps the form for the Help menu and Settings, where the editor's words are the report", async () => {
  let fromMenu: (() => void) | undefined;
  vi.spyOn(desktop, "onReportProblem").mockImplementation(async (cb) => { fromMenu = cb; return () => undefined; });
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ id: "b", reference: "CCCC-DDDD" });
  await act(async () => root.render(<><ReportProblemCard /><ReportProblemHost /></>));
  await act(async () => button("Report a problem…")!.click());
  expect(dialog()?.textContent).toContain("What happened?");
  await act(async () => button("Cancel")!.click());
  expect(dialog()).toBeNull();
  await act(async () => fromMenu!());
  await act(async () => type(document.querySelector("textarea")!, "Playback stutters after an hour"));
  await act(async () => button("Send report")!.click());
  expect(send).toHaveBeenCalledWith({ description: "Playback stutters after an hour", about: undefined, page: "/", onScreen: [] });
  expect(dialog()?.textContent).toContain("Report sent");
  expect(dialog()?.textContent).toContain("CCCC-DDDD");
});

it("lets the form say why it couldn't send, and save instead", async () => {
  vi.spyOn(desktop, "sendProblemReport").mockRejectedValue("Scarlet couldn't reach the internet.");
  const save = vi.spyOn(desktop, "saveProblemReport").mockResolvedValue("/Users/editor/Downloads/r.zip");
  vi.spyOn(desktop, "revealPath").mockResolvedValue();
  await act(async () => root.render(<ReportProblemDialog open onClose={() => undefined} />));
  await act(async () => button("Send report")!.click());
  expect(dialog()?.textContent).toContain("Couldn’t send the report. Scarlet couldn't reach the internet.");
  await act(async () => button("Save as file")!.click());
  expect(save).toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("Saved r.zip");
});

it("puts Report beside a page that couldn't load", async () => {
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ id: "c", reference: "EEEE-FFFF" });
  await act(async () => root.render(<ErrorState title="Couldn’t open the project" body="The engine stopped" onRetry={() => undefined} />));
  await act(async () => button("Report")!.click());
  expect(send.mock.calls[0]![0].about).toBe("Couldn’t open the project: The engine stopped");
});

it("keeps the newest errors shown in the last quarter hour", () => {
  for (let i = 0; i < 10; i++) noteOnScreenError(`error ${i}`, 1_000 * i);
  noteOnScreenError("error 9", 9_500);
  expect(recentOnScreenErrors(10_000)).toEqual(["error 2", "error 3", "error 4", "error 5", "error 6", "error 7", "error 8", "error 9"]);
  noteOnScreenError("later", 10 * 60_000);
  expect(recentOnScreenErrors(20 * 60_000)).toEqual(["later"]);
});

it("puts a page that broke while drawing behind a screen that reports it in one press", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const send = vi.spyOn(desktop, "sendProblemReport").mockResolvedValue({ id: "d", reference: "3F2A-91BC" });
  const Broken = () => { throw new TypeError("Cannot read properties of undefined (reading 'start')"); };
  const router = createMemoryRouter([{ path: "/", element: <Broken />, errorElement: <RouteErrorScreen /> }]);
  await act(async () => root.render(<RouterProvider router={router} />));
  expect(container.textContent).toContain("Something went wrong");
  expect(button("Reload")).toBeDefined();
  await act(async () => button("Report this problem")!.click());
  expect(send.mock.calls[0]![0].about).toBe("Something went wrong: TypeError: Cannot read properties of undefined (reading 'start')");
  expect(container.textContent).toContain("Report sent");
});
