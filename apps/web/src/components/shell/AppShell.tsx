import { useEffect, useLayoutEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { api, IS_MOCK } from "../../lib/client";
import { appLog } from "../../lib/appLog";
import { desktop } from "../../lib/desktop";
import { useHotkeys } from "../../lib/hotkeys";
import { reconnectRealtime, startRealtime } from "../../lib/realtime";
import { useAuthStore } from "../../stores/auth";
import { useHostsStore } from "../../stores/hosts";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { scheduleStorageScan } from "../../lib/storage";
import { ExportStarNotice } from "./ExportStarNotice";
import { ShortcutsModal } from "./ShortcutsModal";
import { StartupRecovery } from "./StartupRecovery";
import { BootSplash, startup } from "./BootSplash";
import { captureProjectPlace } from "../../lib/updatePlace";

/** How long the startup screen may stay before we admit something is wrong and offer logs. */
const SLOW_START_MS = 45_000;
// Survives remounts: once the engine has answered, later outages show the reconnect screen, not the startup screen.
let connectedOnce = false;

/**
 * Where the editor was in a project when the engine went away under the window. The page is taken off screen while
 * the engine is gone, and its playhead and its open cut go with it, so it is asked for its place first, as it is before
 * Settings opens. This listens from before any page is on screen, so it is told ahead of the page being taken down.
 */
let leftAt: string | null = null;
useAuthStore.subscribe((state, before) => {
  if (before.status === "ready" && state.status !== "ready") leftAt = captureProjectPlace(window.location) ?? leftAt;
});

export function AppShell() {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const failed = useAuthStore((s) => s.failed);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const location = useLocation();
  const navigate = useNavigate();
  // The engine is back: the page opens at the place it was left at, which goes into the address before it is shown.
  const [, shown] = useState(0);
  const returning = status === "ready" && leftAt !== null;
  useLayoutEffect(() => {
    if (!returning) return;
    const place = leftAt!;
    leftAt = null;
    if (place.split("?")[0] === window.location.pathname) navigate(place, { replace: true });
    shown(n => n + 1);
  }, [returning]); // eslint-disable-line react-hooks/exhaustive-deps
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

  useEffect(() => { appLog("app", "auth", { state: status }); }, [status]);

  // The connection starts before any page's effects run, so a project opened in the same moment reads once, after the
  // engine is listening, and not a second time when the connection opens.
  useLayoutEffect(() => {
    if (status !== "ready") return;
    return startRealtime();
  }, [status]);
  useEffect(() => {
    if (status !== "ready") return;
    let active = true;
    void api.settings().then(({ settings }) => {
      if (active) useUiStore.getState().setDefaultAgent(settings.defaultAgent);
    }).catch(() => undefined);
    void useHostsStore.getState().load();
    void useProjectStore.getState().loadList();
    return () => { active = false; };
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
  if (status !== "ready" || returning || (library && !startup.done)) return <BootSplash line={startup.done ? "Reconnecting to Scarlet…" : undefined} />;

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
