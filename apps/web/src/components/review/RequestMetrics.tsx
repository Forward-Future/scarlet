import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task, TaskEvent, UsageTotals } from "@scarlet/shared";
import { useShallow } from "zustand/react/shallow";
import { tokenBreakdown, tokenLabel } from "../../lib/format";
import { isWorkingTask, workTime, workTimeLabel } from "../../lib/taskRun";
import { useFloatingPosition } from "../../lib/uiHooks";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";

/**
 * Hovering or focusing the count shows the token breakdown and estimated API cost.
 * Shown only when turned on in Settings → Usage.
 * The note is placed against the window, so the pinned request's scrolling box doesn't clip it.
 */
type RunUsage = Omit<UsageTotals, "firstAt" | "lastAt" | "models" | "reasoningTokens" | "runs">;
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

function listOf(items: string[]) {
  return items.length < 3 ? items.join(" or ") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

function formatEstimatedCost(estimate: RunUsage["estimatedApiCostUsd"]) {
  if (estimate == null) return "Unavailable";
  return estimate > 0 && estimate < 0.01 ? `<${usd.format(0.01)}` : usd.format(estimate);
}

/** How long the pointer rests on a finished request's heading before its figures show. */
const PEEK_DELAY_MS = 350;

export function Tokens({ usage, className, time, details = [], quiet = false }: {
  usage?: RunUsage; className?: string; time?: string; details?: [label: string, value: string][];
  /** A finished request's figures aren't drawn: the note shows them when the pointer rests on the request's heading. */
  quiet?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [mode, setMode] = useState<"preview" | "pinned" | null>(null);
  // Quiet, the count isn't in view, so the note also opens with the active time alone.
  const hasButton = !!usage?.totalTokens || (quiet && !!time);
  const open = mode !== null && hasButton;
  // Quiet, the bubble (in beta) or heading the count sits in opens the note once the pointer rests on it, and closes it as it leaves.
  useEffect(() => {
    const host = quiet && hasButton ? ref.current?.closest<HTMLElement>(".unit-bubble, .unit-msg, .subunit-msg") : null;
    if (!host) return;
    let timer = 0;
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMode(value => value ?? "preview"), PEEK_DELAY_MS);
    };
    const leave = () => { window.clearTimeout(timer); setMode(value => value === "preview" ? null : value); };
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    return () => {
      window.clearTimeout(timer);
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
    };
  }, [quiet, hasButton]);
  // While the note is open it follows the count, which moves when the pinned request grows or the chat scrolls.
  useFloatingPosition(open, ref, panel, { clampTop: true });
  useEffect(() => {
    if (!open) { setMode(null); return; }
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !panel.current?.contains(target)) setMode(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMode(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);
  if (!usage?.totalTokens && !quiet) return time ? <span className={`run-dim ${className ?? ""}`} title="Active time">
    <span className="sr-only">Active time </span><span className="run-work-time">{time}</span>
  </span> : null;
  if (!hasButton) return null;
  const parts: [string, number][] = usage ? [
    ["Input", usage.inputTokens], ["Output", usage.outputTokens], ["Cache read", usage.cacheReadTokens],
    ["Cache write", usage.cacheWriteTokens],
  ] : [];
  const shown = details.filter(([, value]) => value);
  const label = usage ? tokenLabel(usage.totalTokens) : "";
  const [count, unit] = label.split(" ");
  const breakdown = usage ? tokenBreakdown({ ...usage, runs: undefined }) : undefined;
  const cost = usage ? formatEstimatedCost(usage.estimatedApiCostUsd) : "";
  const costDescription = !usage ? undefined : usage.estimatedApiCostUsd == null
    ? usage.unpricedModels?.length ? `No price for ${listOf(usage.unpricedModels)} yet.` : "API pricing is unavailable for some or all of the reported usage."
    : "Reported tokens at standard API rates for short context and default cache duration.";
  const accessibleDetails = [...shown.map(([name, value]) => `${name}: ${value}`), `Estimated API cost: ${cost}`].join(", ");
  const classes = ["run-dim", "run-tokens", className, quiet && "is-quiet"].filter(Boolean).join(" ");
  return <><button ref={ref} type="button" className={classes} title=""
    aria-label={usage ? `${time ? `${time} active time, ` : ""}${label}: ${breakdown}. ${accessibleDetails}` : `${time} active time`} data-breakdown={breakdown}
    aria-description={costDescription} aria-expanded={open} aria-controls={open ? id : undefined}
    onPointerEnter={e => { if (e.pointerType !== "touch") setMode(value => value ?? "preview"); }}
    onPointerLeave={() => { if (!ref.current?.matches(":focus-visible")) setMode(value => value === "preview" ? null : value); }}
    onFocus={() => setMode(value => value ?? "preview")} onBlur={() => setMode(null)}
    onClick={() => setMode(value => value === "pinned" ? null : "pinned")}>
    {time && <><span className="run-work-time">{time}</span>{usage && <> <span className="unit-metrics-dot" aria-hidden>·</span>{" "}</>}</>}
    {usage && <>{count}<span className="unit-token-word"> {unit}</span></>}
  </button>{open && createPortal(<span ref={panel} id={id} className="tokens-tip" aria-hidden data-escape-owner>
      {time && <span><span>Active time</span><b>{time}</b></span>}
      {usage && <>
        {shown.map(([name, value]) => <span key={name}><span>{name}</span><b>{value}</b></span>)}
        {parts.filter(([label, n]) => n || label === "Input" || label === "Output").map(([label, n]) =>
          <span key={label}><span>{label}</span><b>{n.toLocaleString()}</b></span>)}
        <span className="tokens-tip-total"><span>Total</span><b>{usage.totalTokens.toLocaleString()}</b></span>
        <span title={costDescription} style={mode === "pinned" ? { pointerEvents: "auto" } : undefined}><span>Est Cost</span><b>{cost}</b></span>
      </>}
    </span>, document.body)}</>;
}

function runModelName(id: string) {
  // Format versioned Claude IDs without resolving aliases against today's catalog.
  const [, family, major, minor] = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)-(\d+)$/.exec(id) ?? [];
  return family ? `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}` : id;
}

/**
 * Active time and reported tokens for the whole request, including any attempts that carried it on.
 * Only the running request needs a ticking clock. A finished request keeps them in its hover (`quiet`).
 */
export function RequestMetrics({ attempts, events, quiet }: { attempts: readonly Task[]; events: Record<string, readonly TaskEvent[]>;
  /** A finished request's figures show only when the pointer rests on its heading. */
  quiet?: boolean }) {
  const show = useUiStore(s => s.showRunTokens);
  const reports = useProjectStore(useShallow(s => show ? attempts.map(task => s.current?.taskUsage?.[task.id]) : []));
  const working = attempts.some(task => isWorkingTask(task.state));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [working]);

  const durations = attempts.flatMap(task => {
    const duration = workTime(task, events[task.id] ?? [], now);
    return duration === undefined ? [] : [duration];
  });
  const time = durations.length ? workTimeLabel(durations.reduce((total, ms) => total + ms, 0), working) : undefined;
  const sum = (key: Exclude<keyof RunUsage, "unpricedModels">) => reports.reduce((total, usage) => total + (usage?.[key] ?? 0), 0);
  const totalTokens = sum("totalTokens");
  const usage = totalTokens ? {
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"),
    totalTokens,
    estimatedApiCostUsd: reports.some(report => report?.totalTokens && report.estimatedApiCostUsd == null)
      ? null : sum("estimatedApiCostUsd"),
    unpricedModels: [...new Set(reports.flatMap(report => report?.unpricedModels ?? []))],
  } : undefined;
  const models = new Set<string>();
  const efforts = new Set<string>();
  for (const [i, task] of attempts.entries()) {
    const report = reports[i];
    if (!report) continue;
    for (const model of report.models?.length ? report.models : [task.model ?? "Unknown"]) models.add(runModelName(model));
    efforts.add(task.effort ? task.effort.charAt(0).toUpperCase() + task.effort.slice(1) : "Provider default");
  }
  return <Tokens usage={usage} time={time} quiet={quiet} className="unit-tokens" details={[
    [models.size > 1 ? "Models" : "Model", [...models].join(", ")],
    ["Thinking effort", [...efforts].join(", ")],
  ]} />;
}
