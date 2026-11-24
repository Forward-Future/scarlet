/**
 * A save made by a hand-off run (Task models) is its request's: the request owns the change, and the change says which
 * model made it, as the editor's kind of work. The route that saves runs inside this scope, and `saveChange` stamps the
 * changes it creates.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface HandedOffBy {
  /** The hand-off run that saved. */
  taskId: string;
  /** The request it works for, which owns what it saves. */
  requestId: string;
  name: string;
  agent: string;
  model?: string;
}

export const handedOffBy = new AsyncLocalStorage<HandedOffBy>();
