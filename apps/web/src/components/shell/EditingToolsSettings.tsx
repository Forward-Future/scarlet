import { useEffect, useState } from "react";
import { EDITING_TOOL_GROUPS, OptionalToolGroup, type EditingTools } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { ErrorState, InlineError, Loading, Toggle } from "../ui/primitives";

export function EditingToolsSettings() {
  const [preferences, setPreferences] = useState<EditingTools | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api.settings().then(({ settings }) => {
      if (active) setPreferences(settings.editingTools ?? {});
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [attempt]);

  async function save(patch: EditingTools) {
    setBusy(true);
    setError("");
    try {
      const { settings } = await api.updateSettings({ editingTools: patch });
      setPreferences(settings.editingTools);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  if (!preferences) return error
    ? <ErrorState title="Couldn’t load editing tools" body={error} onRetry={() => setAttempt(v => v + 1)} />
    : <Loading label="Loading editing tools…" />;
  const off = OptionalToolGroup.options.filter(key => preferences[key] === false);
  return (
    <div className="tool-settings">
      <div className="tools-subheading">
        <div>
          <h4>Optional tools</h4>
          <p>Scarlet can use these from its next request.</p>
        </div>
        {off.length > 0 && <button className="btn-quiet" disabled={busy}
          onClick={() => void save(Object.fromEntries(off.map(key => [key, true])))}>Restore tool defaults</button>}
      </div>
      <div className="divide-y divide-line/60">
        {EDITING_TOOL_GROUPS.map(group => group.preference && (
          <div key={group.preference} className="tool-setting-row">
            <div>
              <div className="font-medium">{group.title}</div>
              <p className="text-muted text-[12px]">{group.description}</p>
            </div>
            <Toggle label={group.title} checked={preferences[group.preference] !== false} disabled={busy}
              onChange={enabled => void save({ [group.preference]: enabled })} />
          </div>
        ))}
      </div>
      <InlineError>{error}</InlineError>
      <details className="tool-inventory">
        <summary>View all tool names</summary>
        <dl>
          {EDITING_TOOL_GROUPS.map(group => <div key={group.title}>
            <dt>{group.title}<span>{group.preference ? (preferences[group.preference] === false ? "Off" : "On") : "Built in"}</span></dt>
            <dd>{group.tools.map(tool => <code key={tool}>{tool}</code>)}</dd>
          </div>)}
        </dl>
      </details>
    </div>
  );
}
