import { runTask } from "./runs";
import type { MockStore } from "./store";
import { now, sleep } from "./util";

/** Background activity so the UI moves on its own. */
export function bootBackgroundActivity(store: MockStore) {
  void (async () => {
    // The "rendering" change finishes its after-render and becomes ready.
    const rendering = store.db.renders.find((r) => r.id === "rnd_a2");
    const change = store.db.changes.find((c) => c.id === "chg_rendering");
    if (rendering && change) {
      await sleep(4000);
      for (let p = 0.42; p < 1; p += 0.145) {
        rendering.progress = Math.min(0.99, p);
        store.emitRender(rendering);
        await sleep(900);
      }
      rendering.state = "done";
      rendering.progress = 1;
      rendering.path = `renders/${rendering.id}.mp4`;
      rendering.durationSeconds = 5;
      rendering.finishedAt = now();
      store.emitRender(rendering);
      if (change.state !== "rendering" && change.state !== "proposed") return;
      change.state = "ready";
      change.updatedAt = now();
      store.emitChange(change);
    }
  })();
  void (async () => {
    // The running filler-word task streams a few more lines, then completes with a change.
    const task = store.db.tasks.find((t) => t.id === "task_running");
    if (!task) return;
    await sleep(2500);
    const steps = [
      { type: "tool", text: "waveform.get range=15.5–19.5 points=400" },
      { type: "log", text: "All three cuts fall in gaps between spoken phrases.", data: { kind: "editor_progress" } },
    ] as const;
    for (const step of steps) {
      if (task.state !== "running") return;
      store.pushEvent(task, step.type, step.text, "data" in step ? step.data : undefined);
      await sleep(2600);
    }
    if (task.state !== "running") return;
    await runTask(store, task, { fromVersion: "ver_3", description: "Remove three filler words from the wrap (um 15.9, like 17.2, you know 18.4)", previewOnly: store.chatLayouts });
  })();
}
