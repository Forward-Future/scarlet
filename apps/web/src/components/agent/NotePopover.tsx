import { useEffect, useRef, useState } from "react";
import { agentTarget } from "@scarlet/shared";
import { clipsAt } from "@scarlet/timeline";
import { errorMessage } from "../../lib/client";
import { clock } from "../../lib/format";
import { isComposing } from "../../lib/hotkeys";
import type { RecorderResult } from "../../lib/recorder";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { DialogSurface, Icon, InlineError, Spinner, Toggle } from "../ui/primitives";
import { AgentChip, useAgentAvailability } from "./AgentChip";
import { MicButton } from "./MicButton";

/** Small popover for a note on a span picked in the transcript: text or voice, optional assignment. */
export function NotePopover() {
  const popover = useUiStore((s) => s.notePopover);
  const closePopover = useUiStore((s) => s.closeNotePopover);
  const current = useProjectStore((s) => s.current);
  // A note being written is kept on this computer until it is saved or dismissed, so a quit doesn't lose it.
  const draftKey = `scarlet.noteDraft.v1/${current?.id ?? ""}`;
  const keepDraft = (value: string) => {
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch { /* Storage is optional. */ }
  };
  const close = () => { keepDraft(""); closePopover(); };
  const createNote = useProjectStore((s) => s.createNote);
  const createVoiceNote = useProjectStore((s) => s.createVoiceNote);
  const { effective, none, unavailableReason } = useAgentAvailability();
  const [text, setText] = useState("");
  const [assign, setAssign] = useState(() => { try { return localStorage.getItem("scarlet.noteAssign") !== "off"; } catch { return true; } });
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  // The note stays up while it saves (a voice note is transcribed inside the request), so a failure is said where it
  // was written and a typed note keeps its text to send again.
  const dismiss = () => { if (!saving.current) close(); };
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (popover?.open) {
      let saved = "";
      try { saved = localStorage.getItem(draftKey) ?? ""; } catch { /* Storage is optional. */ }
      setText(saved);
      setErr(null);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [popover]);

  if (!popover?.open || !current) return null;
  const clipIds = current.timeline ? clipsAt(current.timeline, popover.time).map((c) => c.clip.id) : [];
  const assignTo = assign && effective ? agentTarget(effective.agent, effective.model) : undefined;

  const tuning = assign && effective ? { effort: effective.effort, serviceTier: effective.serviceTier } : {};

  const onAssign = (v: boolean) => {
    setAssign(v);
    try { localStorage.setItem("scarlet.noteAssign", v ? "on" : "off"); } catch { /* Storage is optional. */ }
  };

  const save = async (write: () => Promise<unknown>) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setErr(null);
    try {
      await write();
      if (useUiStore.getState().notePopover === popover) close();
    } catch (e) {
      if (useUiStore.getState().notePopover === popover) setErr(errorMessage(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const fields = { time: popover.time, end: popover.end, clipIds, version: current.project.head ?? undefined, assignTo, ...tuning };
  const submit = () => {
    if (text.trim()) return save(() => createNote(current.id, { ...fields, text: text.trim() }));
  };
  const submitVoice = (r: RecorderResult) => save(() => createVoiceNote(current.id, r.blob, fields));

  return (
    <DialogSurface onDismiss={dismiss} className="fixed inset-x-0 top-auto bottom-24 mx-auto w-[460px] max-w-[calc(100%-1rem)] card text-fg shadow-2xl p-4 backdrop:bg-transparent" aria-label="New note">
      <div className="flex items-center gap-2 mb-2">
        <Icon name="note" size={14} />
        <span className="font-medium">
          Note at <span className="tnum">{clock(popover.time)}</span>
          {popover.end !== undefined && popover.end > popover.time && <span className="tnum">–{clock(popover.end)}</span>}
        </span>
        <div className="flex-1" />
        <button className="btn-icon" aria-label="Close" title="Close (Esc)" onClick={dismiss}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <textarea
        ref={input}
        className="field resize-none h-20"
        placeholder="What's wrong here, or what should happen?"
        value={text}
        disabled={busy}
        onChange={(e) => { setText(e.target.value); keepDraft(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) {
            e.preventDefault();
            void submit();
          }
        }}
        aria-label="Note text"
      />
      <div className="flex items-center gap-2 mt-2">
        <MicButton onResult={submitVoice} disabled={busy} />
        {busy && <Spinner className="size-3" />}
        <div className="flex-1" />
        <label className="inline-flex items-center gap-2 text-[12px] text-muted" title={none ? unavailableReason : undefined}>
          <Toggle checked={assign && !none} onChange={onAssign} label="Send to the agent" disabled={none} />
          {assign && !none ? "Send to" : "Just a note"}
        </label>
        {assign && !none && <AgentChip />}
        <button className="btn-primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {assign && !none ? "Send" : "Save"}
        </button>
      </div>
      <InlineError>{err}</InlineError>
    </DialogSurface>
  );
}
