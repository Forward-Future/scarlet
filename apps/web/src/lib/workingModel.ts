import { useCallback } from "react";
import type { Task } from "@scarlet/shared";
import { taskModelName } from "../components/shell/TaskModelsSettings";
import { useHostsStore } from "../stores/hosts";
import { useProjectStore } from "../stores/project";
import { isActiveTask, isWorkingTask } from "./taskRun";

/**
 * Which model is doing a request's work right now, for the hover on its row in Working: the model the editor chose in
 * Task models while the request has handed a piece of its work there ("B-roll · Gemini 3 Pro"), else the request's own
 * model ("Claude Opus 4.5"). Nothing for a request that isn't at work.
 */
export function workingModel(
  request: Pick<Task, "id" | "state"> | undefined,
  tasks: readonly Pick<Task, "id" | "agent" | "model">[],
  handOffs: readonly Pick<Task, "agent" | "model" | "state" | "context">[],
  hosts: Parameters<typeof taskModelName>[0],
): string | undefined {
  if (!request || !isWorkingTask(request.state)) return undefined;
  const handedTo = handOffs.filter(h => h.context.checksTaskId === request.id && isActiveTask(h.state)).at(-1);
  if (handedTo) return `${handedTo.context.handOff?.name ?? "Handed off"} · ${taskModelName(hosts, handedTo)}`;
  const own = tasks.find(t => t.id === request.id);
  return own ? taskModelName(hosts, own) : undefined;
}

/** `workingModel`, read from the open project and the models signed in. */
export function useWorkingModel() {
  const tasks = useProjectStore(s => s.current?.tasks);
  const handOffs = useProjectStore(s => s.current?.handOffs);
  const hosts = useHostsStore(s => s.hosts);
  return useCallback((request: Pick<Task, "id" | "state"> | undefined) =>
    workingModel(request, tasks ?? [], handOffs ?? [], hosts), [tasks, handOffs, hosts]);
}
