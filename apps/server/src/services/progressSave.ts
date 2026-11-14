/**
 * Save a progress figure from inside a child process's output or message listener. A throw there is uncaught and
 * stops the engine, and the figure is only for show: the job goes on, and its outcome is saved where a failure is handled.
 */
export function quietProgress(ctx: { log(message: string): void }, what: string, save: () => void) {
  try { save(); }
  catch (err) { ctx.log(`[progress] couldn’t save ${what}: ${err instanceof Error ? err.message : String(err)}`); }
}
