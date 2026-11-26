import { useUiStore } from "../../stores/ui";
import { Toggle } from "../ui/primitives";

/** Whether what the editor says into the mic waits in the message box to be read and sent, or goes as soon as they stop. */
export function DictationSettings() {
  const review = useUiStore(s => s.reviewDictation);
  const setReview = useUiStore(s => s.setReviewDictation);
  return (
    <section className="card p-5 dictation-settings" aria-label="Dictation">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Review dictation before sending</div>
          <p className="mt-1 text-xs text-muted">
            When you stop talking, your words wait in the message box so you can read and fix them. Press Enter to send. Off sends them right away.
          </p>
        </div>
        <Toggle checked={review} onChange={setReview} label="Review dictation before sending" />
      </div>
    </section>
  );
}
