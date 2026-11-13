import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { api, IS_MOCK, serverUrl } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { useHotkeys } from "../../lib/hotkeys";
import { reconnectRealtime, startRealtime } from "../../lib/realtime";
import { useAuthStore } from "../../stores/auth";
import { useHostsStore } from "../../stores/hosts";
import { useProjectStore } from "../../stores/project";
import { loadAgent, useUiStore } from "../../stores/ui";
import { scheduleStorageScan } from "../../lib/storage";
import { ExportStarNotice } from "./ExportStarNotice";
import { ShortcutsModal } from "./ShortcutsModal";
import { StartupRecovery } from "./StartupRecovery";
import { BootSplash, startup } from "./BootSplash";

/** How long the startup screen may stay before we admit something is wrong and offer logs. */
const SLOW_START_MS = 45_000;
// Survives remounts: once the engine has answered, later outages show the reconnect screen, not the startup screen.
let connectedOnce = false;

export function AppShell() {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const failed = useAuthStore((s) => s.failed);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const location = useLocation();
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  const [slowStart, setSlowStart] = useState(false);
  const listing = useProjectStore((s) => s.listStatus === "idle" || s.listStatus === "loading");
  const library = location.pathname === "/";
  if (status === "ready") connectedOnce = true;
  // The library can show whole once the project list has its first answer, and until then the startup screen stays
  // here. A project keeps it up itself until it has opened (ProjectLayout). Any other page shows at once.
  if (status === "ready" && !(library && listing) && !location.pathname.startsWith("/p/")) startup.done = true;

  useEffect(() => {
    if (connectedOnce) return;
    const timer = setTimeout(() => setSlowStart(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => status === "ready" ? scheduleStorageScan() : undefined, [status]);

  useEffect(() => {
    if (IS_MOCK) {
      void bootstrap();
      return;
    }
    let active = true;
    const listener = desktop.onEngineStatus((engine) => {
      if (!active) return;
      if (engine.state === "ready") {
        void bootstrap();
        // An engine that came back on the same address changes nothing bootstrap can see. Live updates still need a new socket.
        reconnectRealtime();
      } else if (engine.error) {
        // The engine crashed or can't start: the window says so until it is back, where each action would fail
        // without a word. A restart Scarlet asked for, to load a dev rebuild, carries no error and is over in a moment.
        void bootstrap();
      }
    });
    // Read the current status after subscribing so a restart cannot be missed.
    void listener.catch(() => undefined).then(() => { if (active) void bootstrap(); });
    return () => {
      active = false;
      void listener.then((off) => off()).catch(() => undefined);
    };
  }, [bootstrap]);

  useEffect(() => {
    if (status !== "offline") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const retry = async () => {
      await bootstrap();
      if (active) timer = setTimeout(retry, 2000);
    };
    timer = setTimeout(retry, 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [status, bootstrap]);

  useEffect(() => {
    const user = useAuthStore.getState().user;
    void desktop.log(`ui auth=${status} server=${serverUrl} user=${user?.name ?? "-"} path=${location.pathname}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (status !== "ready") return;
    const stop = startRealtime();
    let active = true;
    void api.settings().then(({ settings }) => {
      if (active) useUiStore.setState({ agent: loadAgent(settings.defaultAgent) });
    }).catch(() => undefined);
    void useHostsStore.getState().load();
    void useProjectStore.getState().loadList();
    return () => { active = false; stop(); };
  }, [status]);

  useHotkeys((e) => {
    if (e.key === "?") {
      e.preventDefault();
      // Held down, the key repeats. Only the press itself opens the list, so the list's own ? can't shut and reopen it.
      if (!e.repeat) setShortcutsOpen(!useUiStore.getState().shortcutsOpen);
    }
  });

  // An engine that has given up won't come up by waiting, so the window says why at once rather than after the slow-start wait.
  if (status === "offline" && (connectedOnce || slowStart || failed)) return (
    <StartupRecovery
      title={failed ? "Scarlet couldn’t start" : connectedOnce ? "Reconnecting to Scarlet…" : "Scarlet is taking longer than usual to start…"}
      detail={error ?? "Waiting for the local engine."}
      showLogs
    />
  );
  // On startup the engine is still booting, so "offline" is expected: the startup screen stays instead of an error.
  // An engine replaced later takes the window for a moment too, and the screen says what that is.
  if (status !== "ready" || (library && !startup.done)) return <BootSplash line={startup.done ? "Reconnecting to Scarlet…" : undefined} />;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 flex flex-col">
        <Outlet />
      </div>
      <ExportStarNotice />
      <ShortcutsModal />
    </div>
  );
}
