import { restoreLastProject, restoreUpdatePlace } from "./lib/updatePlace";
import { StrictMode } from "react";
import { desktop, isDesktop } from "./lib/desktop";
import { startAppLog } from "./lib/appLog";
import { startPlaybackLog } from "./lib/playbackLog";
import { startUiLog } from "./lib/uiLog";
import { BootSplash } from "./components/shell/BootSplash";
import { StartupRecovery } from "./components/shell/StartupRecovery";
import { UpdateButton } from "./components/shell/UpdateButton";
import { enableUpdateStatus } from "./lib/updateStatus";
import "./index.css";
import "./workspace.css";

async function launch() {
  const root = document.getElementById("root")!;
  const desktopOnly = "Open Scarlet in the desktop app.";
  if (!isDesktop()) {
    root.textContent = desktopOnly;
    return;
  }

  // The startup screen is up from the window's first moment, and is the same one until the first page is ready.
  const opening = import("react-dom/client").then(({ createRoot }) => {
    const view = createRoot(root);
    view.render(<BootSplash />);
    return view;
  });
  try {
    const [native, view] = await Promise.all([desktop.info(), opening]);
    const { platform, localUpdates, customOpenaiModels, customClaudeModels } = native;
    if (platform !== "macos" && platform !== "windows" && platform !== "linux") {
      view.render(desktopOnly);
      return;
    }
    // Loading the router and stores starts the editor. Wait for the native
    // handshake first, including when using the interview fixture.
    if (localUpdates) {
      restoreUpdatePlace();
      enableUpdateStatus();
    }
    restoreLastProject();
    const [{ App }, hosts] = await Promise.all([
      import("./App"),
      customOpenaiModels?.length || customClaudeModels?.length ? import("./stores/hosts") : undefined,
    ]);
    hosts?.useHostsStore.setState({ customOpenaiModels: customOpenaiModels ?? [], customClaudeModels: customClaudeModels ?? [] });
    view.render(<StrictMode>{localUpdates && <UpdateButton />}<App platform={platform} /></StrictMode>);
  } catch (error) {
    const view = await opening;
    view.render(<StartupRecovery title="Scarlet couldn’t start"
      detail={`${error instanceof Error ? error.message : String(error)}\nClose Scarlet and open it again.`} />);
    console.error("Scarlet desktop startup failed", error);
    void desktop.log(`startup failed: ${describeUiError(error)}`, "error");
  }
}

function describeUiError(error: unknown): string {
  if (error instanceof Error) return (error.stack ?? `${error.name}: ${error.message}`).split("\n").slice(0, 6).join(" | ");
  return String(error);
}

/** The webview's console isn't kept anywhere. Send uncaught errors to the app log, once per message per minute. */
function logUncaughtErrors() {
  const recent = new Map<string, number>();
  const report = (kind: string, error: unknown) => {
    const message = `${kind}: ${describeUiError(error)}`.slice(0, 2000);
    const last = recent.get(message);
    if (last !== undefined && Date.now() - last < 60_000) return;
    recent.set(message, Date.now());
    if (recent.size > 100) recent.delete(recent.keys().next().value!);
    void desktop.log(`${message} (at ${location.pathname})`, "error");
  };
  window.addEventListener("error", event => report("uncaught error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", event => report("unhandled rejection", event.reason));
}

if (isDesktop()) {
  logUncaughtErrors();
  startAppLog();
  startUiLog();
  startPlaybackLog();
}
void launch();
