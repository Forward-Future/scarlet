import { useEffect } from "react";
import { listenForFileDrops } from "./lib/dropTargets";
import type { DesktopPlatform } from "./lib/desktop";
import { captureProjectPlace } from "./lib/updatePlace";
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider, useLocation, useParams } from "react-router-dom";
import { AppShell } from "./components/shell/AppShell";
import { BootSplash } from "./components/shell/BootSplash";
import { ProjectsPage } from "./pages/ProjectsPage";
import { useUiStore } from "./stores/ui";

/** An older link to a page inside a project opens the project, with what the link carried. */
export function ProjectHome() {
  const { id = "" } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: `/p/${encodeURIComponent(id)}`, search, hash }} replace />;
}

const loadSkillEditor = async () => ({ Component: (await import("./pages/SkillEditorPage")).SkillEditorPage });

const router = createBrowserRouter(createRoutesFromElements(
  <>
    {/* Older links from when Scarlet had accounts */}
    <Route path="/login" element={<Navigate to="/" replace />} />
    <Route path="/register" element={<Navigate to="/" replace />} />
    <Route element={<AppShell />} hydrateFallbackElement={<BootSplash />}>
      <Route index element={<ProjectsPage />} />
      <Route path="/settings" lazy={async () => ({ Component: (await import("./pages/SettingsPage")).SettingsPage })}>
        <Route path="skills" lazy={async () => ({ Component: (await import("./pages/SkillsPage")).SkillsPage })} />
      </Route>
      <Route path="/settings/skills/new" lazy={loadSkillEditor} />
      <Route path="/settings/skills/:skillId" lazy={loadSkillEditor} />
      <Route path="/p/:id" lazy={async () => ({ Component: (await import("./components/shell/ProjectLayout")).ProjectLayout })}>
        <Route index lazy={async () => ({ Component: (await import("./pages/SimpleWorkspace")).SimpleWorkspace })} />
        <Route path="*" element={<ProjectHome />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </>
));

// Capture the playhead before the router unmounts the workspace, whichever control opened Settings.
let previousLocation = router.state.location;
router.subscribe(({ location }) => {
  if (location.pathname.startsWith("/settings") && !previousLocation.pathname.startsWith("/settings")) {
    useUiStore.setState({ settingsReturnTo: captureProjectPlace(previousLocation) });
  }
  previousLocation = location;
});

export function App({ platform }: { platform: DesktopPlatform }) {
  useEffect(() => listenForFileDrops(platform), [platform]);
  useEffect(() => {
    // Control+, everywhere; Cmd+, too on macOS.
    const mac = platform === "macos";
    const openSettings = (event: KeyboardEvent) => {
      const primary = event.ctrlKey !== event.metaKey && (event.ctrlKey || mac);
      if (event.key !== "," || !primary || event.altKey || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (event.repeat) return;
      useUiStore.getState().setShortcutsOpen(false);
      if (!router.state.location.pathname.startsWith("/settings")) void router.navigate("/settings");
    };
    window.addEventListener("keydown", openSettings, true);
    return () => window.removeEventListener("keydown", openSettings, true);
  }, [platform]);
  return <RouterProvider router={router} />;
}
