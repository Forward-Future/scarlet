import { describe, expect, it } from "vitest";
import type { ProblemReport } from "./desktop";
import { issueTitle, MAX_ISSUE_URL, NEW_ISSUE_URL, problemIssueUrl } from "./problemReport";

const report = (recentProblems: string[] = []): ProblemReport => ({
  path: "/Users/editor/Downloads/scarlet-report-2026-11-26-1514.zip",
  version: "0.1.566", os: "macos", osVersion: "26.1", arch: "aarch64", recentProblems,
});

const read = (url: string) => {
  expect(url.startsWith(`${NEW_ISSUE_URL}?`)).toBe(true);
  const params = new URL(url).searchParams;
  return { title: params.get("title")!, body: params.get("body")! };
};

describe("problemIssueUrl", () => {
  it("fills the issue with the editor's words, the system, the error on screen and the newest problems", () => {
    const { title, body } = read(problemIssueUrl(report(["[2026-11-26][15:14:00][ERROR] [ui] [error] 15:14:00.123 +2ms uncaught name=TypeError"]),
      "Export froze at 80%\nIt never finished.", "TypeError: x is undefined"));
    expect(title).toBe("Export froze at 80%");
    expect(body).toContain("### What happened\nExport froze at 80%\nIt never finished.");
    expect(body).toContain("### Error on screen\n```\nTypeError: x is undefined\n```");
    expect(body).toContain("Drag **scarlet-report-2026-11-26-1514.zip**");
    expect(body).toContain("- Scarlet 0.1.566\n- macOS 26.1 (aarch64)");
    expect(body).toContain("<summary>Recent warnings and errors</summary>");
    expect(body).toContain("uncaught name=TypeError");
  });

  it("still opens a report when nothing was written and nothing went wrong in the log", () => {
    const { title, body } = read(problemIssueUrl({ ...report(), os: "windows", osVersion: null }, "   "));
    expect(title).toBe("Problem report");
    expect(body).toContain("_Not described._");
    expect(body).toContain("- Windows (aarch64)");
    expect(body).not.toContain("Error on screen");
    expect(body).not.toContain("Recent warnings");
  });

  it("stays short enough for GitHub, dropping the oldest log lines first and then the end of the words", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `[2026-11-26][15:14:${String(i).padStart(2, "0")}][WARN] ${"é".repeat(280)}`);
    const url = problemIssueUrl(report(lines), "Short words");
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    const { body } = read(url);
    expect(body).toContain("Short words");
    expect(body).toContain("15:14:11");
    expect(body).not.toContain("15:14:00");
    const long = problemIssueUrl(report(lines), `Long ${"é".repeat(9000)}`);
    expect(long.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(read(long).body).toContain("Long é");
  });

  it("titles the issue with the first line, cut to a readable length", () => {
    expect(issueTitle(`${"a".repeat(100)}\nmore`)).toBe(`${"a".repeat(79)}…`);
  });
});
