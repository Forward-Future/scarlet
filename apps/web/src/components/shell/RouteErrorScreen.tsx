/**
 * What the window shows when a page breaks while drawing, in place of a blank window: what broke, Reload, and a
 * report of it that carries the error on screen.
 */
import { useEffect, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { appLog, errorName, withoutAddresses } from "../../lib/appLog";
import { ReportProblemDialog } from "./ReportProblem";

export function describeRouteError(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`.trim();
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function RouteErrorScreen() {
  const error = useRouteError();
  const [reporting, setReporting] = useState(false);
  const message = describeRouteError(error);
  useEffect(() => {
    const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 6).join(" | ") : message;
    appLog("error", "page-crash", { name: errorName(error), error: withoutAddresses(stack).slice(0, 2000), path: location.pathname }, { level: "error" });
  }, [error, message]);

  return (
    <main className="h-full grid place-items-center p-6">
      <section className="max-w-lg space-y-3">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-muted">Scarlet hit a problem showing this page. Reloading usually fixes it, and a report helps us fix it for good.</p>
        <p className="font-mono text-[12px] text-dim whitespace-pre-wrap break-words select-text" data-log-private>{message}</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => setReporting(true)}>Report this problem</button>
          <button className="btn-ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </section>
      <ReportProblemDialog open={reporting} onClose={() => setReporting(false)} context={message} />
    </main>
  );
}
