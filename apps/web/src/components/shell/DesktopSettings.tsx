/**
 * Settings sections that only exist inside the Scarlet desktop app.
 *
 * General shows what an editor cares about: where they are signed in. The technical bits (engine process, folders,
 * logs, host id, MCP command) live in DesktopDiagnostics on the Advanced tab, under ExportLogs.
 */
import { useEffect, useRef, useState } from "react";
import { isExtraProvider, type AgentAvailability } from "@scarlet/shared";
import { desktop, isDesktop, type EngineStatus } from "../../lib/desktop";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { fileBaseName, plural } from "../../lib/format";
import { AGENT_LABEL, isConfiguredAgent } from "../../stores/hosts";
import { AgentSignIn, AgentUpdate, authLabel, canSignIn, useLocalHost } from "./AgentSignIn";
import { followDesktop } from "./followDesktop";
import { Icon, InlineError, Loading, SectionTitle, Spinner } from "../ui/primitives";

const ENGINE_LABEL: Record<EngineStatus["state"], string> = {
  starting: "Starting…",
  ready: "Running",
  error: "Error",
  stopped: "Stopped",
};

function engineKindLabel(kind: string | null) {
  if (kind === "sidecar") return "Bundled engine";
  if (kind === "dev") return "Dev engine (node)";
  return kind ?? "";
}

function providerSummary(a: AgentAvailability): string {
  if (isExtraProvider(a.id)) {
    if (a.loggedIn === false) return "Invalid key";
    const count = a.models?.length ?? 0;
    return count ? plural(count, "model") : "No tool-capable models";
  }
  return authLabel(a);
}

/** Live engine + agent-host status from the desktop shell. */
function useDesktopStatus() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const host = useLocalHost();
  useEffect(() => {
    if (!isDesktop() || IS_MOCK) return;
    return followDesktop(on => desktop.onEngineStatus(on), () => desktop.engineStatus(), setEngine);
  }, []);
  return { engine, host };
}

/** General → Sign in: Claude Code, Codex and Gemini. */
export function DesktopAgents({ onConnected }: { onConnected?: () => void }) {
  const { engine, host } = useDesktopStatus();
  const agents = host?.agents.filter((a) => canSignIn(a.id)) ?? [];
  const connected = agents.length ? agents.some(isConfiguredAgent) : undefined;
  const previouslyConnected = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (connected === undefined) return;
    const justConnected = previouslyConnected.current === false && connected;
    previouslyConnected.current = connected;
    if (justConnected) onConnected?.();
  }, [connected, onConnected]);
  if (IS_MOCK) return <p className="text-muted">The sample project already has a model.</p>;

  return (
    <div className={onConnected ? "" : "card p-5"} id="hosts">
      {!onConnected && <SectionTitle>Sign in</SectionTitle>}
      <p className="text-[13px] text-muted mb-4">Choose Claude Code, Codex or Gemini. Install it if needed, then sign in with your subscription.</p>
      {engine?.state === "error" && <InlineError>Scarlet hit a problem starting up. Try quitting and reopening the app.</InlineError>}
      {host?.error && <InlineError>{host.error}</InlineError>}
      {!host ? (
        <Loading />
      ) : agents.length === 0 ? (
        <div className="text-muted text-[12.5px]">Looking for Claude Code, Codex and Gemini on this computer…</div>
      ) : (
        <ul className="divide-y divide-line/60">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2.5">
              <span className={`size-2 rounded-full shrink-0 ${isConfiguredAgent(a) ? "bg-ok" : "bg-dim"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px]">{AGENT_LABEL[a.id]}</div>
                <div className={`text-[12px] ${isConfiguredAgent(a) ? "text-muted" : "text-dim"}`}>{isConfiguredAgent(a) ? authLabel(a) : a.installed ? "Not signed in" : "Not installed on this computer"}</div>
                <AgentUpdate agent={a} />
              </div>
              <AgentSignIn agent={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Advanced → Diagnostics: engine process, host status, providers, folders and technical details. */
export function DesktopDiagnostics() {
  const [openError, setOpenError] = useState("");
  const { engine, host } = useDesktopStatus();
  const open = (path: string) => {
    setOpenError("");
    void desktop.openPath(path).catch(e => setOpenError(errorMessage(e)));
  };

  const kind = engine ? engineKindLabel(engine.engineKind) : "";
  const installed = host?.agents.filter(a => a.installed) ?? [];
  const missing = host?.agents.filter(a => !a.installed) ?? [];
  const technicalRows = engine ? [
    engine.engine && { label: "Engine binary", value: engine.engine },
    engine.logDir && { label: "Logs folder", value: engine.logDir },
    host?.hostId && { label: "Host ID", value: host.hostId },
    host?.mcpCommand && { label: "MCP command", value: host.mcpCommand },
  ].filter((row): row is { label: string; value: string } => Boolean(row)) : [];

  return (
    <section className="card p-5 diag-card" id="desktop" aria-labelledby="diagnostics-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3">
        <h3 id="diagnostics-heading" className="text-[14px] font-semibold text-fg">Diagnostics</h3>
        {engine && (
          <span className="text-dim text-[12px] tnum">
            Scarlet {engine.version}{kind ? ` · ${kind}` : ""}
          </span>
        )}
      </div>
      {!engine ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted">
          <Spinner className="size-3.5" />
          <span>Loading diagnostics…</span>
        </div>
      ) : (
        <>
          <dl className="diag-rows">
            <div className="diag-row">
              <dt>Engine</dt>
              <dd>
                <div className="diag-line">
                  <span className="diag-status">
                    <span className={`size-2 rounded-full shrink-0 ${engine.state === "ready" ? "bg-ok" : engine.state === "error" ? "bg-bad" : "bg-dim"}`} />
                    <span>{ENGINE_LABEL[engine.state]}</span>
                  </span>
                  {(engine.url || engine.pid !== null || engine.restarts > 0) && (
                    <span className="diag-meta">
                      {engine.url && <code className="font-mono">{engine.url}</code>}
                      {engine.pid !== null && <span>pid {engine.pid}</span>}
                      {" "}
                      {engine.restarts > 0 && <span>{plural(engine.restarts, "restart")}</span>}
                    </span>
                  )}
                </div>
                {engine.error && <InlineError>{engine.error}</InlineError>}
              </dd>
            </div>

            <div className="diag-row">
              <dt>Agent host</dt>
              <dd>
                {!host ? (
                  <div className="flex items-center gap-2 text-[12.5px] text-muted">
                    <Spinner className="size-3" />
                    <span>Connecting…</span>
                  </div>
                ) : (
                  <>
                    <div className="diag-line">
                      <span className="diag-status min-w-0">
                        <span className={`size-2 rounded-full shrink-0 ${host.connected ? "bg-ok" : "bg-dim"}`} />
                        <span className="shrink-0">{host.connected ? "Connected" : host.configured ? "Connecting…" : "Not configured"}</span>
                        {host.name && <span className="diag-host-name" title={host.name}>{host.name}</span>}
                      </span>
                      <span className="diag-activity">
                        {host.running.length ? (
                          <>Running {plural(host.running.length, "task")}: <code className="font-mono">{host.running.join(", ")}</code></>
                        ) : "Idle"}
                      </span>
                    </div>
                    {host.error && <InlineError>{host.error}</InlineError>}
                  </>
                )}
              </dd>
            </div>

            {host && host.agents.length > 0 && (
              <div className="diag-row">
                <dt>Providers</dt>
                <dd>
                  {installed.length > 0 && (
                    <ul className="diag-providers">
                      {installed.map(a => (
                        <li key={a.id}>
                          <span className="diag-provider-name">
                            <span className={`size-1.5 mx-[1px] rounded-full shrink-0 ${isConfiguredAgent(a) ? "bg-ok" : "bg-dim"}`} />
                            <span>{AGENT_LABEL[a.id]}</span>
                            {a.version && <span className="diag-version">v{a.version}</span>}
                          </span>
                          <span className="diag-provider-auth">{providerSummary(a)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {missing.length > 0 && (
                    <div className={`text-[11.5px] text-dim ${installed.length > 0 ? "mt-2" : ""}`}>
                      Not set up: {missing.map(a => AGENT_LABEL[a.id]).join(", ")}
                    </div>
                  )}
                </dd>
              </div>
            )}

            <div className="diag-row diag-row-center">
              <dt>Data folder</dt>
              <dd>
                <div className="flex items-center gap-2.5 min-w-0">
                  <code className="diag-path" title={engine.dataDir}>{engine.dataDir}</code>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button type="button" className="btn-ghost" title={engine.dataDir} onClick={() => open(engine.dataDir)}>
                      Open
                    </button>
                    <button type="button" className="btn-ghost" title={engine.logDir} onClick={() => open(engine.logDir)}>
                      Logs
                    </button>
                  </div>
                </div>
                {openError && <InlineError>{openError}</InlineError>}
              </dd>
            </div>
          </dl>

          {technicalRows.length > 0 && (
            <details className="diag-disclosure">
              <summary>
                <span>Technical details</span>
                <Icon name="chevron" size={12} />
              </summary>
              <dl className="diag-details">
                {technicalRows.map(row => (
                  <div key={row.label} className="diag-detail-row">
                    <dt>{row.label}</dt>
                    <dd><code>{row.value}</code></dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** Advanced → Share logs: one .zip a tester can send to whoever is helping them. */
export function ExportLogs() {
  const [state, setState] = useState<{ phase: "idle" | "saving" } | { phase: "saved"; path: string } | { phase: "failed"; error: string }>({ phase: "idle" });
  if (!isDesktop() || IS_MOCK) return null;
  const save = () => {
    setState({ phase: "saving" });
    desktop.exportLogs().then(
      path => setState(path ? { phase: "saved", path } : { phase: "idle" }),
      e => setState({ phase: "failed", error: errorMessage(e) }),
    );
  };
  return (
    <section className="card p-5" aria-label="Share logs">
      <SectionTitle>Share logs</SectionTitle>
      <p className="text-[13px] text-muted mb-4">One .zip to send for support. No videos, projects or sign-ins.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={state.phase === "saving"} onClick={save}>{state.phase === "saving" ? "Saving…" : "Export logs…"}</button>
        {state.phase === "saved" && <>
          <span className="truncate text-[12.5px] text-muted" role="status" title={state.path}>Saved {fileBaseName(state.path)}</span>
          <button className="btn-quiet" onClick={() => void desktop.revealPath(state.path).catch(e => setState({ phase: "failed", error: errorMessage(e) }))}>Show in folder</button>
        </>}
      </div>
      {state.phase === "failed" && <InlineError><span data-log-private>{state.error}</span></InlineError>}
    </section>
  );
}
