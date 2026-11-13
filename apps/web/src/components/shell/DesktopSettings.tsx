/**
 * Settings sections that only exist inside the Scarlet desktop app.
 *
 * General shows what an editor cares about: where they are signed in. The technical bits (engine process, folders,
 * logs, host id, MCP command) live in DesktopDiagnostics on the Advanced tab, under ExportLogs.
 */
import { useEffect, useRef, useState } from "react";
import { desktop, isDesktop, type EngineStatus } from "../../lib/desktop";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { plural } from "../../lib/format";
import { AGENT_LABEL, isConfiguredAgent } from "../../stores/hosts";
import { AgentSignIn, authLabel, canSignIn, useLocalHost } from "./AgentSignIn";
import { Field, InlineError, Loading, SectionTitle } from "../ui/primitives";

const ENGINE_LABEL: Record<EngineStatus["state"], string> = {
  starting: "starting…",
  ready: "running",
  error: "error",
  stopped: "stopped",
};

/** Live engine + agent-host status from the desktop shell. */
function useDesktopStatus() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const host = useLocalHost();
  useEffect(() => {
    if (!isDesktop() || IS_MOCK) return;
    let alive = true;
    let received = false;
    const listen = desktop.onEngineStatus((e) => {
      received = true;
      if (alive) setEngine(e);
    });
    void listen.then(() => desktop.engineStatus()).then(e => { if (alive && !received) setEngine(e); }).catch(() => undefined);
    return () => {
      alive = false;
      void listen.then(off => off()).catch(() => undefined);
    };
  }, []);
  return { engine, host };
}

/** General → Sign in: Claude Code and Codex, nothing else. */
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
      <p className="text-[13px] text-muted mb-4">Choose Claude Code or Codex. Install it if needed, then sign in with your subscription.</p>
      {engine?.state === "error" && <InlineError>Scarlet hit a problem starting up. Try quitting and reopening the app.</InlineError>}
      {host?.error && <InlineError>{host.error}</InlineError>}
      {!host ? (
        <Loading />
      ) : agents.length === 0 ? (
        <div className="text-muted text-[12.5px]">Looking for Claude Code and Codex on this computer…</div>
      ) : (
        <ul className="divide-y divide-line/60">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2.5">
              <span className={`size-2 rounded-full shrink-0 ${isConfiguredAgent(a) ? "bg-ok" : "bg-dim"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px]">{AGENT_LABEL[a.id]}</div>
                <div className={`text-[12px] ${isConfiguredAgent(a) ? "text-muted" : "text-dim"}`}>{isConfiguredAgent(a) ? authLabel(a) : a.installed ? "Not signed in" : "Not installed on this computer"}</div>
              </div>
              <AgentSignIn agent={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Advanced → Diagnostics: engine process, folders, logs, host id, MCP. */
export function DesktopDiagnostics() {
  const [openError, setOpenError] = useState("");
  const { engine, host } = useDesktopStatus();
  const open = (path: string) => {
    setOpenError("");
    void desktop.openPath(path).catch(e => setOpenError(errorMessage(e)));
  };

  return (
    <div className="card p-5" id="desktop">
      <SectionTitle
        right={
          engine && (
            <span className="text-dim text-[11.5px]">
              Scarlet {engine.version} · {engine.engineKind === "sidecar" ? "bundled engine" : engine.engineKind === "dev" ? "dev engine (node)" : engine.engineKind ?? ""}
            </span>
          )
        }
      >
        Diagnostics
      </SectionTitle>
      {!engine ? (
        <Loading />
      ) : (
        <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-[12.5px]">
          <dt className="text-muted">Engine</dt>
          <dd className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${engine.state === "ready" ? "bg-ok" : engine.state === "error" ? "bg-bad" : "bg-dim"}`} />
              <span>{ENGINE_LABEL[engine.state]}</span>
              {engine.url && <code className="font-mono text-muted truncate">{engine.url}</code>}
              {engine.pid !== null && <span className="text-dim">pid {engine.pid}</span>}
              {engine.restarts > 0 && <span className="text-dim">{plural(engine.restarts, "restart")}</span>}
            </div>
            {engine.error && <InlineError>{engine.error}</InlineError>}
            {engine.engine && (
              <div className="text-dim font-mono text-[11px] truncate" title={engine.engine}>
                {engine.engine}
              </div>
            )}
          </dd>

          <dt className="text-muted">Data folder</dt>
          <dd className="flex items-center gap-2 min-w-0">
            <code className="font-mono truncate" title={engine.dataDir}>
              {engine.dataDir}
            </code>
            <button className="btn-quiet py-0.5" onClick={() => open(engine.dataDir)}>
              Open
            </button>
            <button className="btn-quiet py-0.5" onClick={() => open(engine.logDir)}>
              Logs
            </button>
          </dd>

          {openError && <dd className="col-span-2"><InlineError>{openError}</InlineError></dd>}
          <dt className="text-muted">Agent host</dt>
          <dd className="min-w-0">
            {!host ? (
              <Loading />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${host.connected ? "bg-ok" : "bg-dim"}`} />
                  <span>{host.connected ? "connected" : host.configured ? "connecting…" : "not configured"}</span>
                  {host.hostId && <code className="font-mono text-dim">{host.hostId}</code>}
                  {host.name && <span className="text-dim truncate">{host.name}</span>}
                </div>
                {host.error && <InlineError>{host.error}</InlineError>}
                <div className="text-dim">{host.running.length ? `Running ${plural(host.running.length, "task")}: ${host.running.join(", ")}` : "Idle"}</div>
                <div className="text-dim">
                  {host.agents.map((a) => `${AGENT_LABEL[a.id]}: ${a.installed ? `${a.version ? `v${a.version}` : "installed"}, ${authLabel(a)}` : "not installed"}`).join(" · ")}
                </div>
                {host.mcpCommand && (
                  <div className="text-dim font-mono text-[11px] truncate" title={host.mcpCommand}>
                    MCP: {host.mcpCommand}
                  </div>
                )}
              </>
            )}
          </dd>
        </dl>
      )}
    </div>
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
          <span className="truncate text-[12.5px] text-muted" role="status" title={state.path}>Saved {state.path.split(/[\\/]/).pop()}</span>
          <button className="btn-quiet" onClick={() => void desktop.revealPath(state.path).catch(e => setState({ phase: "failed", error: errorMessage(e) }))}>Show in folder</button>
        </>}
      </div>
      {state.phase === "failed" && <InlineError>{state.error}</InlineError>}
    </section>
  );
}
