import { TALKING_TO_YOU_MAX } from "@scarlet/shared";
import { useEffect, useState } from "react";
import { Icon, InlineError } from "../ui/primitives";
import { useServerSetting } from "./useServerSetting";

/**
 * How Scarlet writes to the editor, in their own words: the same for every project and every model. Their own
 * instructions for Claude Code, Codex or Gemini stay with their own chats and never reach Scarlet's runs, so this is
 * where they say it for Scarlet. Saved when the field is left; how Scarlet cuts and frames stays in skills.
 */
export function TalkingToYouSettings() {
  const { value, busy, error, choose } = useServerSetting("talkingToYou");
  const [draft, setDraft] = useState<string | null>(null);
  // The field shows what is saved until the editor types, and again once a save lands.
  useEffect(() => { setDraft(null); }, [value]);
  if (value === null) return error ? <InlineError>{error}</InlineError> : null;
  const text = draft ?? value;
  const save = () => { if (draft !== null && draft.trim() !== value.trim()) void choose(draft.trim()); else setDraft(null); };
  return (
    <section className="card transcription-preferences talking-to-you" aria-labelledby="talking-to-you-heading">
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><Icon name="chat" size={22} /></span>
          <div>
            <h2 id="talking-to-you-heading">Talking to you</h2>
            <p>How Scarlet writes to you in the chat and on its cards, in your own words.</p>
          </div>
        </div>
      </div>
      <textarea className="field talking-to-you-field" aria-labelledby="talking-to-you-heading" rows={4} maxLength={TALKING_TO_YOU_MAX}
        spellCheck disabled={busy} value={text} placeholder={"For example: keep notes short and plain.\nSay times as 1:05, not 65 seconds."}
        onChange={e => setDraft(e.target.value)} onBlur={save} />
      <p className="transcription-status text-muted">Used in every project, whichever model you pick. Your instructions for Claude, Codex or Gemini in your own coding chats stay there. How Scarlet cuts and frames goes in your skills.</p>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
