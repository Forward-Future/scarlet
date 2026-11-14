import { Worker } from "node:worker_threads";
import type { Db } from "./db.js";

// A checkpoint can spend seconds flushing to disk during a large import. Give that work a separate connection,
// leaving the writer's synchronous/durability setting intact. The packaged Node engine bundles this worker inline.
const workerSource = `
  const { DatabaseSync } = require("node:sqlite");
  const { statSync } = require("node:fs");
  const { parentPort, workerData } = require("node:worker_threads");
  const db = new DatabaseSync(workerData.file);
  const wal = workerData.file + "-wal";
  const timer = setInterval(() => {
    if ((statSync(wal, { throwIfNoEntry: false })?.size ?? 0) >= 64 * 1024) {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
  }, workerData.everyMs);
  parentPort.once("message", () => {
    clearInterval(timer);
    db.close();
    parentPort.close();
  });
  parentPort.postMessage("ready");
`;

export function startWalCheckpointer(db: Db, file: string, log: (message: string) => void, everyMs = 2000) {
  const original = Number(db.pragma("wal_autocheckpoint", { simple: true }));
  let worker: Worker;
  try {
    worker = new Worker(workerSource, { eval: true, workerData: { file, everyMs } });
  } catch (error) {
    log(`[db] Keeping SQLite's automatic checkpoints: ${error}`);
    return;
  }
  let stopping = false;
  worker.once("message", () => {
    if (!stopping) db.pragma("wal_autocheckpoint = 0");
  });
  worker.once("error", error => log(`[db] Background checkpoint failed: ${error.message}`));
  const exited = new Promise<void>(resolve => worker.once("exit", () => {
    db.pragma(`wal_autocheckpoint = ${original}`);
    resolve();
  }));
  worker.unref();
  return {
    stop() {
      if (!stopping) {
        stopping = true;
        worker.ref();
        worker.postMessage("stop");
      }
      return exited;
    },
  };
}
