import { useUiStore } from "../../stores/ui";
import { Toggle } from "../ui/primitives";

/** Lets the editor opt into the new three-column workspace layout (Beta) and switch back any time. */
export function WorkspaceLayoutSettings() {
  const newLayout = useUiStore(s => s.newLayout);
  const setNewLayout = useUiStore(s => s.setNewLayout);
  return (
    <section className="card p-5" aria-label="Workspace layout">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">New workspace layout (Beta)</div>
          <p className="mt-1 text-xs text-muted">
            Three-column edits panel, chat bubbles, question panel over the message box, and one-row revisions. Switch back any time.
          </p>
        </div>
        <Toggle checked={newLayout} onChange={setNewLayout} label="New workspace layout (Beta)" />
      </div>
    </section>
  );
}
