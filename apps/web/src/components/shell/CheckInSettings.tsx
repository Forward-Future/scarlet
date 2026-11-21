import { useEffect, useState } from "react";
import { CHECK_IN_SHARE, type CheckIn } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { Icon, InlineError } from "../ui/primitives";

const steps: { value: CheckIn; label: string }[] = [
  { value: "less", label: "Less" },
  { value: "balanced", label: "Balanced" },
  { value: "more", label: "More" },
];

/**
 * How much Scarlet checks with the editor. At the end of a pass Scarlet orders its cuts by how likely each is to be
 * wrong, and the repeats it would keep by how likely each is a restart; this picks how far down each order the editor
 * is asked to look. The same for every project, saved as chosen.
 */
export function CheckInSettings() {
  const [value, setValue] = useState<CheckIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.settings().then(r => { if (current) setValue(r.settings.checkIn); }).catch(e => { if (current) setError(errorMessage(e)); });
    return () => { current = false; };
  }, []);
  if (!value) return error ? <InlineError>{error}</InlineError> : null;
  const choose = async (next: CheckIn) => {
    const previous = value;
    setValue(next);
    setError("");
    setBusy(true);
    try {
      setValue((await api.updateSettings({ checkIn: next })).settings.checkIn);
    } catch (e) {
      setValue(previous);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card transcription-preferences check-in-preferences" aria-labelledby="check-in-heading">
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><Icon name="review" size={22} /></span>
          <div>
            <h2 id="check-in-heading">Checking with you</h2>
            <p>How many of a pass’s cuts Scarlet asks you to check.</p>
          </div>
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="check-in">Ask me to check</label>
          <PreferenceSelect id="check-in" value={value} disabled={busy} options={steps} onChange={next => void choose(next)} />
        </div>
      </div>
      <p className="transcription-status text-muted">{CHECK_IN_SHARE[value].replace(/^a/, "A")} of the cuts that take words out: the ones Scarlet thinks most likely to be wrong. They go into the video either way and wait in For you until you keep them. The same share of the lines said twice that Scarlet would leave in comes to you as a call: Keep takes one out.</p>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
