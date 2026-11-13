import type { WsEvent } from "@scarlet/shared";
import type { Ctx } from "./context.js";
import { clip, humanDuration } from "./logText.js";

/**
 * A line in the engine log for every change of state the engine announces: an edit proposed, applied, rejected or
 * reopened, the working edit moving to another version, a render starting and how it ended, media becoming ready or
 * failing, and each entry of the project's activity. Everything that changes state already publishes to the bus, so
 * listening here covers every route and every agent tool at once, including ones added later.
 * Runs log their own states in services/tasks.
 */
export function logStateChanges(ctx: Ctx) {
  // What was last said about each thing, so only a change is logged. Bounded: the oldest entries go first.
  const seen = new Map<string, string>();
  const started = new Map<string, number>();
  const remember = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > 4000) map.delete(map.keys().next().value!);
  };
  /** The state before, when it differs from `state`. Null when nothing changed. */
  const changed = (key: string, state: string): { from?: string } | null => {
    const from = seen.get(key);
    if (from === state) return null;
    remember(seen, key, state);
    return { from };
  };
  const span = (range: { start: number; end: number } | null | undefined) => range ? ` ${range.start.toFixed(2)}–${range.end.toFixed(2)} s` : "";

  const onEvent = (event: WsEvent) => {
    try {
      switch (event.type) {
        case "change.updated": {
          const c = event.change;
          const moved = changed(c.id, `${c.state}/${c.toVersion}/${c.appliedVersion ?? ""}`);
          if (!moved) return;
          const before = moved.from?.split("/")[0];
          const versions = `${c.fromVersion} → ${c.appliedVersion ?? c.toVersion}`;
          const how = c.autoApplied ? " (applied by Scarlet)" : "";
          ctx.log(`[edit] ${c.id} ${before && before !== c.state ? `${before} → ${c.state}` : before ? `${c.state}, new version` : c.state}${how} in ${c.projectId}, ${versions}`
            + `${c.taskId ? `, from ${c.taskId}` : ""}, ${c.ranges.length} ${c.ranges.length === 1 ? "place" : "places"}`);
          return;
        }
        case "project.updated": {
          const p = event.project;
          const head = changed(`${p.id}/head`, p.head ?? "none");
          if (head?.from !== undefined) ctx.log(`[project] ${p.id} working edit ${head.from} → ${p.head ?? "none"}`);
          const paused = changed(`${p.id}/paused`, String(!!p.mediaPaused));
          if (paused?.from !== undefined) ctx.log(`[project] ${p.id} media processing ${p.mediaPaused ? "paused" : "resumed"}`);
          return;
        }
        case "render.updated": {
          const r = event.render;
          const moved = changed(r.id, r.state);
          if (!moved) return;
          const what = `${r.kind}${r.quality ? ` ${r.quality}` : ""}${span(r.range)} of ${r.version} in ${r.projectId}`;
          if (r.state === "queued" || r.state === "running") {
            if (!started.has(r.id)) remember(started, r.id, Date.now());
            // A playback section is seconds of work and there is one per few seconds watched: only its end is logged.
            if (r.state === "running" && r.kind !== "playback") ctx.log(`[render] ${r.id} started: ${what}`);
            return;
          }
          const began = started.get(r.id);
          started.delete(r.id);
          const took = began === undefined ? (moved.from === undefined && r.state === "done" ? " from a saved file" : "") : ` after ${humanDuration(Date.now() - began)}`;
          ctx.log(`[render] ${r.id} ${r.state}${took}: ${what}${r.state === "failed" ? `: ${clip(r.error ?? "no reason given")}` : ""}`);
          return;
        }
        case "media.updated": {
          const m = event.media;
          const moved = changed(m.id, `${m.status ?? "ready"}/${m.previewMode ?? ""}`);
          if (!moved) return;
          const before = moved.from?.split("/")[0];
          const status = m.status ?? "ready";
          if (before === status) return;
          ctx.log(`[media] ${m.id} ${before ? `${before} → ${status}` : status} in ${event.projectId}: "${clip(m.name, 80)}"${status === "failed" ? `: ${clip(m.error ?? "no reason given")}` : ""}`);
          return;
        }
        case "activity.added": {
          const a = event.entry;
          ctx.log(`[activity] ${a.type}${a.projectId ? ` in ${a.projectId}` : ""}`);
          return;
        }
        default:
      }
    } catch (error) {
      // A log line must never break what it describes.
      ctx.log(`[log] couldn’t describe ${event.type}: ${(error as Error).message}`);
    }
  };
  ctx.bus.on("ws", onEvent);
  return () => { ctx.bus.off("ws", onEvent); };
}
