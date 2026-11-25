import { chooseListener, hearingModels, listenerKey, type AgentId, type Listener } from "@scarlet/shared";
import { AGENT_LABEL, useHostsStore } from "../../stores/hosts";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { Icon, InlineError } from "../ui/primitives";
import { ManageSignIn } from "./ModelSettings";
import { useServerSetting } from "./useServerSetting";

/**
 * Which model listens to cuts for the models that can't hear (Claude, most of Codex's): Automatic, the best one signed
 * in; one the editor picks; or Off. Saved for every project, as Checking with you is.
 */
export function ListeningSettings({ onSignIn }: { onSignIn?: () => void } = {}) {
  const { hosts, status } = useHostsStore();
  const { value, busy, error, choose } = useServerSetting("listening");
  if (!value) return error ? <InlineError>{error}</InlineError> : null;
  const agents = hosts.filter(h => h.online).flatMap(h => h.agents);
  const nameOf = (l: Listener) => l.agent === "gemini" && !l.model ? "Gemini"
    : agents.find(a => a.id === l.agent)?.modelLabels?.[l.model ?? ""] ?? l.model ?? AGENT_LABEL[l.agent as AgentId];
  const models = hearingModels(agents);
  const picked = value !== "auto" && value !== "off" ? value : undefined;
  const missing = picked && !models.some(l => listenerKey(l) === picked);
  // A model that isn't signed in now goes by the name it was saved under; one saved with no name of its own goes by its maker's.
  const savedName = (key: string) => {
    const [agent = "", ...rest] = key.split(":");
    const model = rest.join(":");
    return model && model !== "default" ? model : AGENT_LABEL[agent as AgentId] ?? agent;
  };
  const pickedName = picked && (missing ? savedName(picked) : nameOf(models.find(l => listenerKey(l) === picked)!));
  const options = [
    { value: "auto", label: "Automatic" },
    ...models.map(l => ({ value: listenerKey(l) as string, label: nameOf(l) })),
    ...(missing ? [{ value: picked, label: `${pickedName} (not signed in)` }] : []),
    { value: "off", label: "Off" },
  ];
  const listener = chooseListener(agents, value);
  const signIn = <ManageSignIn onSignIn={onSignIn} />;
  const catches = "so Scarlet catches a stumble or a clipped word the transcript misses.";
  return (
    <section className="card transcription-preferences check-in-preferences" aria-labelledby="listening-heading">
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><Icon name="audio" size={22} /></span>
          <div>
            <h2 id="listening-heading">Listening</h2>
            <p>Which model listens to cuts for models that can’t hear.</p>
          </div>
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="listening-model">Listening model</label>
          <PreferenceSelect id="listening-model" value={value} disabled={busy} options={options} onChange={next => void choose(next)}
            valueLabel={value === "auto" && listener ? `Automatic · ${nameOf(listener)}` : undefined} />
        </div>
      </div>
      {/* One span: the status line lays its children out side by side, and this is one sentence. */}
      <p className="transcription-status text-muted"><span>{
        value === "off" ? "Off: models that can’t hear read the transcript and a picture of the sound instead."
        : missing ? <>{pickedName} isn’t signed in, so nothing listens for now. Sign in again or choose another model. {signIn}</>
        : listener ? <>{nameOf(listener)} listens to cuts for models that can’t hear, {catches}</>
        : status === "loading" ? "Looking for models that can hear…"
        : <>No model here can hear. Sign in to Gemini so Scarlet listens to cuts instead of only reading the transcript. {signIn}</>
      }</span></p>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
