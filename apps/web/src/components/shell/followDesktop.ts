/**
 * Follow one of the desktop app's live reports: each one it sends from now on, and, once listening, the one it holds
 * now, unless a report came first. `read` answering nothing leaves things as they are. Returns the cleanup.
 */
export function followDesktop<T>(listen: (on: (value: T) => void) => Promise<() => void>, read: () => Promise<T | null | undefined>,
  show: (value: T) => void): () => void {
  let alive = true;
  let received = false;
  const listening = listen(value => {
    received = true;
    if (alive) show(value);
  });
  void listening.then(async () => {
    if (!alive) return;
    const latest = await read();
    if (alive && !received && latest) show(latest);
  }).catch(() => undefined);
  return () => {
    alive = false;
    void listening.then(off => off()).catch(() => undefined);
  };
}
