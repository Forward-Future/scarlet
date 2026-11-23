/**
 * One-click sign-in for Claude Code, Codex, and Gemini with the user's own subscription
 * (Claude Pro/Max, ChatGPT plan, Google AI). Desktop only: the app runs the CLI's login
 * flow, opens the browser, and refreshes the agent list when it's done.
 * In a plain browser the row explains the terminal command instead.
 */
import { useEffect, useState } from "react";
import type { AgentAvailability } from "@scarlet/shared";
import { desktop, isDesktop, type AgentLoginStatus, type HostStatus } from "../../lib/desktop";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { AGENT_LABEL } from "../../stores/hosts";
import { InlineError, Spinner } from "../ui/primitives";
import { followDesktop } from "./followDesktop";

type SignInAgent = "claude" | "codex" | "gemini";

const SIGN_IN: Record<SignInAgent, { button: string; plan: string }> = {
  claude: { button: "Sign in with Claude", plan: "Claude Pro or Max" },
  codex: { button: "Sign in with ChatGPT", plan: "ChatGPT" },
  gemini: { button: "Sign in with Google", plan: "Google AI" },
};

/** What a sign-in button says on hover. */
const signInTitle = (id: SignInAgent) => `Uses your ${SIGN_IN[id].plan} subscription; opens your browser`;

export function canSignIn(id: string): id is SignInAgent {
  return id === "claude" || id === "codex" || id === "gemini";
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
function useAgentLogin(agent: SignInAgent) {
  const [status, setStatus] = useState<AgentLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    return followDesktop<AgentLoginStatus>(
      on => desktop.onAgentLogin(s => { if (s.agent === agent) on(s); }),
      async () => {
        const latest = await desktop.agentLoginStatus(agent);
        return latest?.state === "waiting" ? latest : null;
      },
      setStatus,
    );
  }, [agent]);

  return {
    status,
    error: error ?? (status?.state === "failed" ? status.message ?? "Sign-in failed" : null),
    waiting: status?.state === "waiting",
    async start() {
      setError(null);
      try {
        setStatus({ agent, state: "waiting", acceptsCode: agent === "claude" || agent === "gemini" });
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

/** Opens the Node.js download page, which Claude Code and Codex need to install. */
function GetNodeButton({ onError }: { onError(message: string): void }) {
  return <button type="button" className="underline" onClick={() => void desktop.openUrl("https://nodejs.org/en/download").catch(e => onError(errorMessage(e)))}>Get Node.js</button>;
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
        {" "}<GetNodeButton onError={setError} />
      </p>}
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => void install()}>
        {busy ? <><Spinner className="size-3" /> Installing…</> : `Install ${AGENT_LABEL[agent]}`}
      </button>
      <InlineError>{error}</InlineError>
    </div>
  );
}

/**
 * A newer version of an installed agent's command-line tool, and the press that updates it. The app updates it the
 * way it was installed, in place, and offers nothing for a copy it can't update that way. `compact` is the model
 * selector's row: the button, its progress and why it failed, as a grid row under the agent's name and the button.
 */
export function AgentUpdate({ agent, compact = false }: { agent: AgentAvailability; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  if (!isDesktop() || IS_MOCK || !canSignIn(agent.id)) return null;
  const id = agent.id;

  const update = async () => {
    setBusy(true);
    setDone("");
    setError("");
    try {
      const after = await desktop.agentUpdate(id);
      setDone(after && after !== agent.version ? `Updated to ${after}` : "Already up to date");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = agent.version && `${AGENT_LABEL[id]} ${agent.version} is installed`;
  if (compact) {
    const control = busy
      ? <span className="flex items-center gap-1.5 text-[12px] text-muted" role="status"><Spinner className="size-3" /> Updating…</span>
      : agent.latestVersion
        ? <button type="button" className="btn-quiet py-0.5" title={title} onClick={() => void update()}>Update to {agent.latestVersion}</button>
        : <span className="text-[12px] text-muted" role="status">{done}</span>;
    return <>{control}{error && <div className="col-span-full min-w-0 wrap-anywhere"><InlineError>{error}</InlineError></div>}</>;
  }
  if (busy) return <div className="flex items-center gap-2 text-[12px] text-muted" role="status"><Spinner className="size-3" /> Updating {AGENT_LABEL[id]}…</div>;
  return (
    <div className="space-y-1 text-[12px]">
      {agent.latestVersion ? (
        <div className="flex items-center gap-2">
          <span className="text-muted">Version {agent.latestVersion} is available</span>
          <button type="button" className="btn-quiet py-0.5" title={title} onClick={() => void update()}>
            Update
          </button>
        </div>
      ) : done && <div className="text-muted" role="status">{done}</div>}
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** A sign-in under way: the browser has the next step. Claude and Gemini can hand back a code to paste instead. */
function LoginWaiting({ id, login, compact }: { id: SignInAgent; login: ReturnType<typeof useAgentLogin>; compact: boolean }) {
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(id === "gemini");
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
      {(!compact || id === "gemini") && login.status?.acceptsCode && (
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

/**
 * The sign-in control for one agent. `compact` renders just the button, its
 * progress and why a sign-in failed, for menus; the full row adds the fallback
 * link and code box. A menu's row is a grid of the agent's name and this
 * control: the reason is a row of that grid by itself, under both.
 */
export function AgentSignIn({ agent, compact = false }: { agent: AgentAvailability; compact?: boolean }) {
  const id = agent.id as SignInAgent;
  const login = useAgentLogin(id);

  if (!agent.installed) {
    return compact || !isDesktop() || IS_MOCK ? null : <InstallAgent agent={id} />;
  }

  if (!isDesktop()) {
    if (compact || (agent.loggedIn !== false && agent.auth !== "api_key")) return null;
    return <span className="text-dim text-[11.5px]">Run <code className="font-mono">npx scarlet-agent auth {id}</code> on that machine</span>;
  }

  const start = () => void login.start();

  if (login.waiting) return <LoginWaiting id={id} login={login} compact={compact} />;

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
    <button className={onApiKey ? "btn-quiet py-0.5" : "btn-primary py-1"} title={signInTitle(id)} onClick={start}>
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

/**
 * The first screen's button for one agent: one press installs its command-line tool when this computer lacks it, then
 * signs in, so a new editor doesn't meet an Install step first. Claude Code and Codex install with npm, so a computer
 * without Node.js says how to get it.
 */
export function SignInWith({ agent }: { agent: AgentAvailability }) {
  const id = agent.id as SignInAgent;
  const login = useAgentLogin(id);
  const [installing, setInstalling] = useState(false);
  const [needsNode, setNeedsNode] = useState(false);
  const [error, setError] = useState("");

  const press = async () => {
    setError("");
    setNeedsNode(false);
    if (!agent.installed) {
      setInstalling(true);
      try {
        if (await desktop.agentInstall(id) === "needsNode") return setNeedsNode(true);
      } catch (e) {
        return setError(errorMessage(e));
      } finally {
        setInstalling(false);
      }
    }
    void login.start();
  };

  if (login.waiting) return <div className="first-sign-in-waiting"><LoginWaiting id={id} login={login} compact={false} /></div>;
  return (
    <div className="first-sign-in-choice">
      <button type="button" className="btn-ghost" disabled={installing} title={signInTitle(id)} onClick={() => void press()}>
        {installing ? <><Spinner className="size-3" /> Installing {AGENT_LABEL[id]}…</> : SIGN_IN[id].button}
      </button>
      {needsNode && <p className="text-[12px] text-muted">{AGENT_LABEL[id]} needs Node.js. Install it, then press {SIGN_IN[id].button} again.
        {" "}<GetNodeButton onError={setError} />
      </p>}
      <InlineError>{error || login.error}</InlineError>
    </div>
  );
}

/** Who a configured agent signs in with, as its button says it: Claude, ChatGPT or Google. */
export function signInProvider(id: string): string | undefined {
  return canSignIn(id) ? SIGN_IN[id].button.replace(/^Sign in with /, "") : undefined;
}

/** This desktop app's own agent host, live (null in a browser or until it reports). */
export function useLocalHost(): HostStatus | null {
  const [host, setHost] = useState<HostStatus | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    return followDesktop(on => desktop.onHostStatus(on), () => desktop.hostStatus(), setHost);
  }, []);
  return host;
}
