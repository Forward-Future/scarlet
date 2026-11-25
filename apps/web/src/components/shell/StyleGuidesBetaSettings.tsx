import { useState } from "react";
import { api, errorMessage } from "../../lib/client";
import { useUiStore } from "../../stores/ui";
import { InlineError, Toggle } from "../ui/primitives";

/** Lets the editor opt into Style guides (Beta) and turn it back off any time. */
export function StyleGuidesBetaSettings() {
  const enabled = useUiStore(s => s.styleGuidesBeta);
  const setEnabled = useUiStore(s => s.setStyleGuidesBeta);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setError("");
    setBusy(true);
    try {
      const { settings } = await api.updateSettings({ styleGuidesBeta: next });
      setEnabled(settings.styleGuidesBeta);
    } catch (e) {
      setEnabled(previous);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5" aria-label="Style guides">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Style guides (Beta)</div>
          <p className="mt-1 text-xs text-muted">
            Create reusable visual styles with live previews and use @name in chat or skills. Turn off any time.
          </p>
        </div>
        <Toggle checked={enabled} onChange={v => void toggle(v)} disabled={busy} label="Style guides (Beta)" />
      </div>
      <InlineError>{error}</InlineError>
    </section>
  );
}
