/**
 * One-click sign-in for Claude Code and Codex with the user's own subscription
 * (Claude Pro/Max, ChatGPT plan). Desktop only: the app runs the CLI's login
 * flow, the CLI opens the browser, and the agent list refreshes when it's done.
 * In a plain browser the row explains the terminal command instead.
 */
import { useEffect, useState } from "react";
import type { AgentAvailability } from "@scarlet/shared";
import { desktop, isDesktop, type AgentLoginStatus, type HostStatus } from "../../lib/desktop";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { AGENT_LABEL } from "../../stores/hosts";
import { InlineError, Spinner } from "../ui/primitives";

type SignInAgent = "claude" | "codex";

export const SIGN_IN: Record<SignInAgent, { button: string; plan: string }> = {
  claude: { button: "Sign in with Claude", plan: "Claude Pro or Max" },
  codex: { button: "Sign in with ChatGPT", plan: "ChatGPT" },
};

export function canSignIn(id: string): id is SignInAgent {
  return id === "claude" || id === "codex";
}

/** What the agent is signed in with, in words. */
export function authLabel(a: AgentAvailability): string {
  if (!a.installed) return "Not installed";
  if (a.loggedIn === false) return "Not signed in";
  if (a.auth === "subscription") return a.plan ? `${capitalize(a.plan)} subscription` : "Subscription";
  if (a.auth === "api_key") return "API key (pay per use)";
  return "Signed in";
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Track (and drive) the desktop sign-in flow for one agent. */
export function useAgentLogin(agent: SignInAgent) {
  const [status, setStatus] = useState<AgentLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let alive = true;
    let off: (() => void) | undefined;
    let received = false;
    void desktop.onAgentLogin((s) => {
      if (alive && s.agent === agent) {
        received = true;
        setStatus(s);
      }
    }).then(async (unsubscribe) => {
      if (!alive) return unsubscribe();
      off = unsubscribe;
      const latest = await desktop.agentLoginStatus(agent);
      if (alive && !received && latest?.state === "waiting") setStatus(latest);
    }).catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, [agent]);

  return {
    status,
    error: error ?? (status?.state === "failed" ? status.message ?? "Sign-in failed" : null),
    waiting: status?.state === "waiting",
    async start() {
      setError(null);
      try {
        setStatus({ agent, state: "waiting", acceptsCode: agent === "claude" });
        await desktop.agentLoginStart(agent);
      } catch (e) {
        setStatus(null);
        setError(errorMessage(e));
      }
    },
    async cancel() {
      try {
        await desktop.agentLoginCancel(agent);
      } catch (e) {
        // The app couldn't be told to stop, so it reports nothing either. The row goes back to its button and says
        // why, instead of waiting on a sign-in nobody is finishing.
        setStatus(null);
        setError(errorMessage(e));
      }
    },
    async submitCode(code: string) {
      setError(null);
      try {
        await desktop.agentLoginCode(agent, code);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
  };
}

function InstallAgent({ agent }: { agent: SignInAgent }) {
  const [busy, setBusy] = useState(false);
  const [needsNode, setNeedsNode] = useState(false);
  const [error, setError] = useState("");

  const install = async () => {
    setBusy(true);
    setError("");
    try {
      setNeedsNode(await desktop.agentInstall(agent) === "needsNode");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1 text-[12px]">
      {needsNode && <p>Install Node.js LTS, then return here to finish.
        {" "}<button type="button" className="underline" onClick={() => void desktop.openUrl("https://nodejs.org/en/download").catch(e => setError(errorMessage(e)))}>Get Node.js</button>
      </p>}
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => void install()}>
        {busy ? <><Spinner className="size-3" /> Installing…</> : `Install ${AGENT_LABEL[agent]}`}
      </button>
      <InlineError>{error}</InlineError>
    </div>
  );
}

/**
 * The sign-in control for one agent. `compact` renders just the button, its
 * progress and why a sign-in failed, for menus; the full row adds the fallback
 * link and code box. A menu's row is a grid of the agent's name and this
 * control: the reason is a row of that grid by itself, under both.
 */
export function AgentSignIn({ agent, compact = false }: { agent: AgentAvailability; compact?: boolean }) {
  const id = agent.id as SignInAgent;
  const login = useAgentLogin(id);
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);

  if (!agent.installed) {
    return compact || !isDesktop() || IS_MOCK ? null : <InstallAgent agent={id} />;
  }

  if (!isDesktop()) {
    if (compact || (agent.loggedIn !== false && agent.auth !== "api_key")) return null;
    return <span className="text-dim text-[11.5px]">Run <code className="font-mono">npx scarlet-agent auth {id}</code> on that machine</span>;
  }

  const start = () => {
    setShowCode(false);
    setCode("");
    void login.start();
  };

  if (login.waiting) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-[12px]">
          <Spinner className="size-3" />
          <span className="text-muted">Finish signing in in your browser…</span>
          {login.status?.url && !compact && (
            <button className="btn-quiet py-0.5" onClick={() => void desktop.openUrl(login.status!.url!).catch(() => undefined)}>
              Open page again
            </button>
          )}
          <button className="btn-quiet py-0.5" onClick={() => void login.cancel()}>
            Cancel
          </button>
        </div>
        {!compact && login.status?.acceptsCode && (
          showCode ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) void login.submitCode(code);
              }}
            >
              <input className="field font-mono flex-1 py-1" placeholder="Paste the code from the browser" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <button className="btn-primary py-1" disabled={!code.trim()}>
                Submit
              </button>
            </form>
          ) : (
            <button className="btn-quiet py-0.5 text-[11.5px]" onClick={() => setShowCode(true)}>
              Browser showed a code instead?
            </button>
          )
        )}
        <InlineError>{login.error}</InlineError>
      </div>
    );
  }

  const signedInWithSub = agent.loggedIn !== false && agent.auth === "subscription";
  if (signedInWithSub) {
    if (compact) return null;
    return (
      <div>
        <button className="btn-quiet py-0.5" title="Sign in with a different account" onClick={start}>
          Switch account
        </button>
        <InlineError>{login.error}</InlineError>
      </div>
    );
  }

  const onApiKey = agent.loggedIn !== false && agent.auth === "api_key";
  const button = (
    <button className={onApiKey ? "btn-quiet py-0.5" : "btn-primary py-1"} title={`Uses your ${SIGN_IN[id].plan} subscription; opens your browser`} onClick={start}>
      {onApiKey && id !== "codex" ? "Use my subscription instead" : SIGN_IN[id].button}
    </button>
  );
  // In a menu the reason has the row's whole width and wraps anywhere. Beside the button it took the width from the
  // agent's name, and what a CLI printed last holds the sign-in address, which has no place to break.
  if (compact) return <>{button}{login.error && <div className="col-span-full min-w-0 wrap-anywhere"><InlineError>{login.error}</InlineError></div>}</>;
  return (
    <div className="space-y-1">
      {button}
      <InlineError>{login.error}</InlineError>
    </div>
  );
}

/** This desktop app's own agent host, live (null in a browser or until it reports). */
export function useLocalHost(): HostStatus | null {
  const [host, setHost] = useState<HostStatus | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    let alive = true;
    let off: (() => void) | undefined;
    let received = false;
    void desktop.onHostStatus((h) => {
      received = true;
      if (alive) setHost(h);
    }).then(async (unsubscribe) => {
      if (!alive) return unsubscribe();
      off = unsubscribe;
      const latest = await desktop.hostStatus();
      if (alive && !received) setHost(latest);
    }).catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return host;
}
