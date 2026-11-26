/**
 * The GitHub issue a problem report opens: the editor's words, the error on screen if there was one, the system,
 * and the newest warnings and errors from the log. The .zip with the whole log is attached by the editor, who sees
 * everything before it is posted.
 */
import type { ProblemReport } from "./desktop";
import { fileBaseName } from "./format";

export const NEW_ISSUE_URL = "https://github.com/Forward-Future/scarlet/issues/new";
/** GitHub turns away longer addresses; the oldest log lines go first, then the end of the editor's words. */
export const MAX_ISSUE_URL = 7500;

const OS_NAME: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The title: the first line the editor wrote, else a plain one. */
export function issueTitle(description: string) {
  const first = description.trim().split("\n")[0]?.trim() ?? "";
  return first ? clip(first, 80) : "Problem report";
}

function issueBody(report: ProblemReport, words: string, context: string | undefined, recent: string[]) {
  const os = `${OS_NAME[report.os] ?? report.os}${report.osVersion ? ` ${report.osVersion}` : ""}`;
  const parts = [
    "### What happened",
    words || "_Not described._",
    ...(context ? ["### Error on screen", "```", context, "```"] : []),
    "### Diagnostics",
    `Drag **${fileBaseName(report.path)}** from the folder Scarlet opened into this box. It holds Scarlet's logs and system details: no videos, projects, transcripts or sign-ins.`,
    "### System",
    `- Scarlet ${report.version}\n- ${os} (${report.arch})`,
    ...(recent.length ? ["<details><summary>Recent warnings and errors</summary>", "", "```", ...recent, "```", "</details>"] : []),
  ];
  return parts.join("\n");
}

export function problemIssueUrl(report: ProblemReport, description: string, context?: string): string {
  const title = issueTitle(description);
  const shownContext = context?.trim() ? clip(context.trim(), 600) : undefined;
  let words = description.trim();
  let recent = report.recentProblems;
  const url = () => `${NEW_ISSUE_URL}?${new URLSearchParams({ title, body: issueBody(report, words, shownContext, recent) })}`;
  while (url().length > MAX_ISSUE_URL && recent.length) recent = recent.slice(1);
  while (url().length > MAX_ISSUE_URL && words.length > 200) words = clip(words, Math.floor(words.length * 0.8));
  return url();
}
