// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop, type ProblemReport } from "../../lib/desktop";
import { ReportProblemCard, ReportProblemDialog, ReportProblemHost, useProblemReport } from "./ReportProblem";
import { RouteErrorScreen } from "./RouteErrorScreen";

const saved: ProblemReport = {
  path: "/Users/editor/Downloads/scarlet-report-2026-11-26-1514.zip",
  version: "0.1.566", os: "macos", osVersion: "26.1", arch: "aarch64", recentProblems: [],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent === label);
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useProblemReport.setState({ open: false });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves the report, shows the file, opens the filled-in issue and says what's left to do", async () => {
  const report = vi.spyOn(desktop, "reportProblem").mockRejectedValueOnce("Disk full").mockResolvedValueOnce(saved);
  const reveal = vi.spyOn(desktop, "revealPath").mockResolvedValue();
  const open = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  const closed = vi.fn();
  await act(async () => root.render(<ReportProblemDialog open onClose={closed} context="TypeError: x is undefined" />));
  expect(document.body.textContent).toContain("No videos, projects, transcripts or sign-ins.");
  const field = document.querySelector("textarea")!;
  expect(field.hasAttribute("data-log-private")).toBe(true);
  await act(async () => type(field, "The export froze at 80%"));

  await act(async () => button("Send report…")!.click());
  expect(document.body.textContent).toContain("Couldn’t prepare the report. Disk full");
  expect(open).not.toHaveBeenCalled();

  await act(async () => button("Send report…")!.click());
  expect(report).toHaveBeenLastCalledWith("The export froze at 80%");
  expect(reveal).toHaveBeenCalledWith(saved.path);
  const url = new URL(open.mock.calls[0]![0]);
  expect(url.searchParams.get("title")).toBe("The export froze at 80%");
  expect(url.searchParams.get("body")).toContain("TypeError: x is undefined");
  expect(document.body.textContent).toContain("Almost done");
  expect(document.body.textContent).toContain("Drag scarlet-report-2026-11-26-1514.zip from the folder that opened");

  await act(async () => button("Open GitHub again")!.click());
  expect(open).toHaveBeenCalledTimes(2);
  await act(async () => button("Done")!.click());
  expect(closed).toHaveBeenCalled();
});

it("opens from Settings and from Help → Report a Problem… in the menu bar", async () => {
  let fromMenu: (() => void) | undefined;
  vi.spyOn(desktop, "onReportProblem").mockImplementation(async (cb) => { fromMenu = cb; return () => undefined; });
  await act(async () => root.render(<><ReportProblemCard /><ReportProblemHost /></>));
  expect(document.querySelector("dialog")).toBeNull();
  await act(async () => button("Report a problem…")!.click());
  expect(document.querySelector("dialog")?.textContent).toContain("What happened?");
  await act(async () => button("Cancel")!.click());
  expect(document.querySelector("dialog")).toBeNull();
  await act(async () => fromMenu!());
  expect(document.querySelector("dialog")?.textContent).toContain("Report a problem");
});

it("puts a page that broke while drawing behind a screen that can report it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const report = vi.spyOn(desktop, "reportProblem").mockResolvedValue(saved);
  vi.spyOn(desktop, "revealPath").mockResolvedValue();
  const open = vi.spyOn(desktop, "openUrl").mockResolvedValue();
  const Broken = () => { throw new TypeError("Cannot read properties of undefined (reading 'start')"); };
  const router = createMemoryRouter([{ path: "/", element: <Broken />, errorElement: <RouteErrorScreen /> }]);
  await act(async () => root.render(<RouterProvider router={router} />));
  expect(container.textContent).toContain("Something went wrong");
  expect(container.textContent).toContain("TypeError: Cannot read properties of undefined (reading 'start')");
  expect(button("Reload")).toBeDefined();
  await act(async () => button("Report this problem")!.click());
  await act(async () => button("Send report…")!.click());
  expect(report).toHaveBeenCalledWith("");
  expect(new URL(open.mock.calls[0]![0]).searchParams.get("body")).toContain("### Error on screen\n```\nTypeError: Cannot read properties of undefined (reading 'start')\n```");
});
