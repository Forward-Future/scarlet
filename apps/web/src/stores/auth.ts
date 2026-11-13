import { create } from "zustand";
import { desktop } from "../lib/desktop";
import type { User } from "@scarlet/shared";
import { api, connectDesktopEngine, errorMessage, IS_MOCK, serverUrl } from "../lib/client";
import { appLog } from "../lib/appLog";

/** The native shell supplies the local engine address and its session token. */
type Status = "idle" | "loading" | "ready" | "offline";

interface AuthState {
  status: Status;
  user: User | null;
  error: string | null;
  /** The engine has given up starting (no engine to run, or nowhere to run it), rather than still starting. */
  failed: boolean;
  bootstrap(): Promise<void>;
}

// A later engine-ready event supersedes a check against the previous process.
let attempt = 0;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "idle",
  user: null,
  error: null,
  failed: false,
  async bootstrap() {
    const current = ++attempt;
    if (get().status === "idle") set({ status: "loading" });
    let starting = false, failed = false;
    try {
      if (!IS_MOCK) {
        const engine = await desktop.engineStatus();
        if (current !== attempt) return;
        if (engine.state !== "ready" || !engine.url || !engine.token) {
          starting = engine.state === "starting" && !engine.error;
          // A crashed engine is started again and reads "starting" meanwhile. Only "error" means it stopped trying,
          // or keeps failing to start.
          failed = engine.state === "error";
          throw new Error(engine.error ?? "Waiting for the local engine…");
        }
        if (get().status === "ready") {
          if (engine.url === serverUrl && engine.token === api.token) return;
          // Reopen media and the realtime connection against the replacement engine.
          set({ status: "loading" });
        }
        connectDesktopEngine(engine.url, engine.token);
      }
      const { user } = await api.me();
      if (current !== attempt) return;
      set({ status: "ready", user, error: null, failed: false });
      // Finish the exports that were in progress when Scarlet last quit.
      void import("../lib/exportJobs").then(jobs => jobs.resumeExports())
        .catch(error => appLog("error", "resume-exports", { error: errorMessage(error) }, { level: "warn" }));
    } catch (err) {
      if (current !== attempt) return;
      const error = errorMessage(err);
      // Why the window shows the engine as away, once: asked again while it is still away, it is the same news.
      // An engine still starting is a wait, not a failure.
      if (get().status !== "offline" || get().error !== error) {
        appLog("app", starting ? "waiting" : "offline", { error }, { level: starting ? "info" : "warn" });
      }
      set({ status: "offline", error, failed });
    }
  },
}));
