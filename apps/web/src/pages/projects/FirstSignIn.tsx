import { useEffect } from "react";
import type { AgentAvailability } from "@scarlet/shared";
import { isConfiguredAgent, useHostsStore } from "../../stores/hosts";
import { canSignIn, SignInWith, signInProvider, useLocalHost } from "../../components/shell/AgentSignIn";
import { InlineError, Loading } from "../../components/ui/primitives";

export const SIGN_IN_ORDER = ["claude", "codex", "gemini"];

/** "Claude", "Claude and ChatGPT", "Claude, ChatGPT and Google": the plans signed in, as their buttons name them. */
export function providerList(ids: string[]): string {
  const names = SIGN_IN_ORDER.filter(id => ids.includes(id)).map(id => signInProvider(id)!);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What Scarlet opens on while no model is ready: nothing can be edited without one, so signing in comes first. One
 * button per plan the editor may have; each installs what it needs and opens the browser. The editor can look around
 * first, and Quick start brings this back. `adding` is the same screen for a second plan: the ones signed in say so.
 */
export function FirstSignIn({ later, laterLabel, adding = false }: { later(): void; laterLabel: string; adding?: boolean }) {
  const host = useLocalHost();
  const agents = (host?.agents ?? []).filter(a => canSignIn(a.id))
    .sort((a, b) => SIGN_IN_ORDER.indexOf(a.id) - SIGN_IN_ORDER.indexOf(b.id)) as AgentAvailability[];
  // Signed in here: read the models now, so the screen gives way at once instead of on the next report.
  const signedIn = agents.some(isConfiguredAgent);
  useEffect(() => { if (signedIn) void useHostsStore.getState().load(); }, [signedIn]);
  return (
    <section className="library-first-edit first-sign-in" aria-labelledby="first-sign-in-title">
      <h2 id="first-sign-in-title">{adding ? "Add another plan" : "Sign in to start editing"}</h2>
      <p>{adding ? "Scarlet can use more than one, and you pick the model for each edit." : "Scarlet edits with your own Claude, ChatGPT or Google plan."} Signing in opens your browser.</p>
      {host?.error && <InlineError>{host.error}</InlineError>}
      <div className="first-sign-in-list">
        {!host ? <Loading /> : agents.length ? agents.map(a => isConfiguredAgent(a)
          ? <p key={a.id} className="first-sign-in-done">✓ Signed in with {signInProvider(a.id)}</p>
          : <SignInWith key={a.id} agent={a} />)
          : <p className="text-muted text-[13px]">Looking for Claude Code, Codex and Gemini on this computer…</p>}
      </div>
      <button type="button" className="first-sign-in-later" onClick={later}>{laterLabel}</button>
    </section>
  );
}
