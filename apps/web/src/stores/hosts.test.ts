// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentHost } from "@scarlet/shared";
import { api } from "../lib/client";
import { useHostsStore } from "./hosts";

const host = (id: string, online = true) => ({ id, name: id, online, agents: [] }) as unknown as AgentHost;
const ids = () => useHostsStore.getState().hosts.map(h => `${h.id}${h.online ? "" : " (offline)"}`).sort();
function deferred() {
  let resolve!: (value: { hosts: AgentHost[] }) => void, reject!: (err: Error) => void;
  const promise = new Promise<{ hosts: AgentHost[] }>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => useHostsStore.setState({ hosts: [], status: "idle", error: null }));
afterEach(() => vi.restoreAllMocks());

it("keeps the newer read and every host the socket reported when an older read of the list finishes last", async () => {
  const older = deferred(), newer = deferred();
  vi.spyOn(api, "hosts").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = useHostsStore.getState().load();
  const second = useHostsStore.getState().load();
  // Reported while both reads are out: newer than either.
  useHostsStore.getState().apply(host("reported"));
  newer.resolve({ hosts: [host("mac"), host("linux")] });
  await second;
  expect(ids()).toEqual(["linux", "mac", "reported"]);
  // The older read, from before the refresh, says the Mac was offline and knows nothing of the reported host.
  older.resolve({ hosts: [host("mac", false)] });
  await first;
  expect(ids()).toEqual(["linux", "mac", "reported"]);
  expect(useHostsStore.getState().status).toBe("ready");
});

it("lays a host reported during an older read over that read when it lands first, and leaves a newer read's failure to say so", async () => {
  const older = deferred(), newer = deferred();
  vi.spyOn(api, "hosts").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = useHostsStore.getState().load();
  useHostsStore.getState().apply(host("reported"));
  const second = useHostsStore.getState().load();
  older.resolve({ hosts: [host("mac")] });
  await first;
  expect(ids()).toEqual(["mac", "reported"]);
  newer.resolve({ hosts: [host("mac"), host("reported", false)] });
  await second;
  // The newer read began after the report, so it already holds that host as it now stands.
  expect(ids()).toEqual(["mac", "reported (offline)"]);
});

it("doesn't let an older read's failure mark the list as failed while a newer read is on its way", async () => {
  const older = deferred(), newer = deferred();
  vi.spyOn(api, "hosts").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const first = useHostsStore.getState().load();
  const second = useHostsStore.getState().load();
  older.reject(new Error("Gone"));
  await first;
  expect(useHostsStore.getState().status).toBe("loading");
  newer.resolve({ hosts: [host("mac")] });
  await second;
  expect([useHostsStore.getState().status, ids()]).toEqual(["ready", ["mac"]]);
});
