import { useEffect, useState } from "react";
import { ASPECT_PRESETS, type ProjectSettings } from "@scarlet/timeline";
import { errorMessage } from "../../lib/client";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { ConfirmDialog, Drawer, Field, InlineError, Spinner } from "../ui/primitives";

export const ASPECTS: Array<{ value: ProjectSettings["aspect"]; label: string; dims: string }> = [
  { value: "16:9", label: "16:9 landscape", dims: "1920×1080" },
  { value: "9:16", label: "9:16 vertical", dims: "1080×1920" },
  { value: "1:1", label: "1:1 square", dims: "1080×1080" },
  { value: "4:5", label: "4:5 portrait", dims: "1080×1350" },
];
export const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const fpsLabel = (fps: number) => `${Number(fps.toFixed(3))} fps`;

export function ProjectSettingsDrawer({ onDeleted }: { onDeleted: () => void }) {
  const open = useUiStore((s) => s.projectSettingsOpen);
  const setOpen = useUiStore((s) => s.setProjectSettingsOpen);
  const project = useProjectStore(s => open ? s.current?.project : undefined);
  const updateProject = useProjectStore((s) => s.updateProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const [name, setName] = useState("");
  // Unset until the editor picks one: a format matched to the first clip while the drawer is open shows, and a Save
  // that only renames doesn't put the old format back.
  const [pickedFps, setFps] = useState<number>();
  const [pickedAspect, setAspect] = useState<ProjectSettings["aspect"]>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  // The form starts from the project when the drawer opens. A save that fails puts the project's name back in the
  // store, which must not take what was typed, or the reason it failed, with it.
  useEffect(() => {
    if (project) {
      setName(project.name);
      setFps(undefined);
      setAspect(undefined);
      setErr(null);
    }
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return null;
  const settings = project.settings;
  // A rate picked that reads the same as the project's is the project's own: the first clip can match the project to
  // its footage while the drawer is open.
  const fps = pickedFps === undefined || fpsLabel(pickedFps) === fpsLabel(settings.fps) ? settings.fps : pickedFps;
  const aspect = pickedAspect ?? settings.aspect;
  const renderAffecting = fps !== settings.fps || aspect !== settings.aspect;
  const dimensions = `${settings.width}×${settings.height}`;
  const aspectOptions = ASPECTS.map(a => ({ value: a.value, label: `${a.label} · ${settings.aspect === a.value ? dimensions : a.dims}` }));
  if (settings.aspect === "custom") aspectOptions.push({ value: "custom", label: `Custom · ${dimensions}` });

  // The drawer stays until its save settles, as Cancel does: closed while it runs, a failure would have nowhere to show,
  // and the name in the header would go back to the old one without a word.
  const close = () => { if (!busy) setOpen(false); };

  return (
    <Drawer open={open} onClose={close} title="Project settings">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const dimensions = aspect !== project.settings.aspect ? ASPECT_PRESETS[aspect] : undefined;
            await updateProject({ name: name.trim() || project.name, ...(renderAffecting && { settings: { fps, aspect, ...dimensions } }) });
            setOpen(false);
          } catch (e2) {
            setErr(errorMessage(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" htmlFor="ps-name">
          <input id="ps-name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Frame rate" htmlFor="ps-fps">
          {/* A project matched to footage keeps the footage's exact rate (30000/1001 for 29.97), which stands in for the
              preset that reads the same: two "29.97 fps" rows would move the project off its footage's rate. */}
          <PreferenceSelect id="ps-fps" value={fps} onChange={setFps}
            options={[...FPS_OPTIONS.filter(v => fpsLabel(v) !== fpsLabel(settings.fps)), settings.fps].sort((a, b) => a - b)
              .map(value => ({ value, label: fpsLabel(value) }))} />
        </Field>
        <Field label="Aspect" htmlFor="ps-aspect">
          <PreferenceSelect id="ps-aspect" value={aspect} onChange={setAspect} options={aspectOptions} />
        </Field>
        {renderAffecting && (
          <div className="rounded-md border border-warn/40 bg-warn/5 text-warn text-[12px] p-2 mb-3">Changing frame rate or aspect invalidates existing renders. Previews will re-render on next use.</div>
        )}
        <InlineError>{err}</InlineError>
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy && <Spinner className="size-3" />}Save
          </button>
        </div>
      </form>
      <div className="mt-8 pt-4 border-t border-line">
        <div className="eyebrow mb-2">Danger zone</div>
        <p className="text-muted mb-2">Moving to Trash hides the project for 30 days. Restore it from the Projects page with everything in it; after 30 days it is deleted for good.</p>
        <button className="btn-danger" onClick={() => setConfirm(true)}>
          Move to Trash
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Move “${project.name}” to Trash?`}
        body="It stays in Trash for 30 days with all its versions, history and footage, and can be restored from the Projects page. After that it's deleted for good."
        confirmLabel="Move to Trash"
        danger
        onConfirm={async () => {
          await deleteProject(project.id);
          setOpen(false);
          onDeleted();
        }}
      />
    </Drawer>
  );
}
