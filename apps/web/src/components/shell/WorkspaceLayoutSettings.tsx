import { useUiStore } from "../../stores/ui";
import { Toggle } from "../ui/primitives";

/** Lets the editor switch back to the classic two-column workspace layout any time. */
export function WorkspaceLayoutSettings() {
  const newLayout = useUiStore(s => s.newLayout);
  const setNewLayout = useUiStore(s => s.setNewLayout);
  const classic = !newLayout;
  return (
    <section className="card p-5" aria-label="Workspace layout">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Classic workspace layout</div>
          <p className="mt-1 text-xs text-muted">
            Use the previous two-column layout with the edits dock under the chat instead of the three-column edits panel. Switch back any time.
          </p>
        </div>
        <Toggle checked={classic} onChange={useClassic => setNewLayout(!useClassic)} label="Classic workspace layout" />
      </div>
    </section>
  );
}
