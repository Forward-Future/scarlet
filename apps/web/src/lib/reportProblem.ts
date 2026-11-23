import { desktop, isDesktop } from "./desktop";
import { fileBaseName } from "./format";

export const SCARLET_ISSUES_URL = "https://github.com/Forward-Future/scarlet/issues/new";

export interface ProblemReportContext {
  version?: string;
  revision?: string;
  platform?: string;
  arch?: string;
  logFileName?: string;
  summary?: string;
  detail?: string;
}

/** Build a pre-filled GitHub issue URL with Scarlet version, OS, and log attachment hint. */
export function buildProblemReportUrl(ctx: ProblemReportContext = {}): string {
  const params = new URLSearchParams();
  if (ctx.summary?.trim()) params.set("title", ctx.summary.trim().slice(0, 120));

  const envLines: string[] = [];
  const version = ctx.version ?? (typeof __SCARLET_VERSION__ !== "undefined" ? __SCARLET_VERSION__ : "");
  const revision = ctx.revision ?? (typeof __SCARLET_REVISION__ !== "undefined" ? __SCARLET_REVISION__ : "");
  if (version) envLines.push(`- Scarlet: ${version}${revision ? ` (${revision.slice(0, 7)})` : ""}`);
  if (ctx.platform) envLines.push(`- System: ${ctx.platform}${ctx.arch ? ` (${ctx.arch})` : ""}`);

  const sections: string[] = [
    "### What happened",
    ctx.detail?.trim() ? ctx.detail.trim().slice(0, 1200) : "<!-- Briefly describe what you were doing and what went wrong -->",
  ];
  if (ctx.logFileName) {
    sections.push("", `### Logs`, `<!-- Drag ${ctx.logFileName} into this box to attach it -->`);
  }
  if (envLines.length) {
    sections.push("", "### Environment", ...envLines);
  }
  params.set("body", sections.join("\n"));
  return `${SCARLET_ISSUES_URL}?${params.toString()}`;
}

async function readSystemInfo(): Promise<Pick<ProblemReportContext, "version" | "platform" | "arch">> {
  if (!isDesktop()) return {};
  try {
    const info = await desktop.info();
    return { version: info.version, platform: info.platform, arch: info.arch };
  } catch {
    return {};
  }
}

export async function openProblemReport(ctx: Omit<ProblemReportContext, "version" | "platform" | "arch"> = {}): Promise<string> {
  const sys = await readSystemInfo();
  const url = buildProblemReportUrl({ ...sys, ...ctx });
  await desktop.openUrl(url);
  return url;
}

export async function exportLogsAndReport(ctx: Omit<ProblemReportContext, "version" | "platform" | "arch" | "logFileName"> = {}): Promise<{ path: string; url: string } | null> {
  const path = await desktop.exportLogs();
  if (!path) return null;
  await desktop.revealPath(path).catch(() => undefined);
  const url = await openProblemReport({ ...ctx, logFileName: fileBaseName(path) });
  return { path, url };
}
