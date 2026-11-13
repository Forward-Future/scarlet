import { DatabaseSync } from "node:sqlite";
import { Timeline, TimelineOp, assignSpots } from "@scarlet/timeline";

// Read committed, immutable edit inputs in the worker. A long proposal never needs
// to be cloned across IPC, and the engine does not hold a write lock during replay.
const [database, changeId, rate] = process.argv.slice(-3);
const db = new DatabaseSync(database, { readOnly: true });
try {
  const row = db.prepare("SELECT json FROM changes WHERE id = ?").get(changeId);
  let owners = null;
  if (row) {
    const change = JSON.parse(row.json);
    const base = db.prepare("SELECT json FROM timeline_versions WHERE project_id = ? AND version = ?").get(change.projectId, change.fromVersion);
    const ops = TimelineOp.array().safeParse(change.ops);
    if (base && ops.success) owners = assignSpots(Timeline.parse(JSON.parse(base.json)), ops.data, change.ranges, undefined, Number(rate));
  }
  process.stdout.write(JSON.stringify(owners));
} finally {
  db.close();
}
