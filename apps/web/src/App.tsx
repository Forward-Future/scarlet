import { useEffect } from "react";
import { listenForFileDrops } from "./lib/dropTargets";
import { captureProjectPlace } from "./lib/updatePlace";
import { reviewItemPath } from "@scarlet/shared";
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider, useLocation, useParams } from "react-router-dom";
import { AppShell } from "./components/shell/AppShell";
import { BootSplash } from "./components/shell/BootSplash";
import { ProjectsPage } from "./pages/ProjectsPage";
import { buildThreads, groupThreads } from "./lib/threads";
import { useUiStore } from "./stores/ui";
import { useProjectStore } from "./stores/project";

function LegacyProjectView({ view }: { view: "review" | "watch" | "media" | "changelog" | "history" }) {
  const { id = "" } = useParams();
  const { search, hash } = useLocation();
  const current = useProjectStore((s) => s.current);
  const params = new URLSearchParams(search);
  if (view === "media") params.set("panel", "media");
  if (view === "changelog" || view === "history") params.set("panel", "history");
  if (view === "review" && !params.has("item") && !params.has("thread") && !params.has("new") && current) {
    const first = groupThreads(buildThreads(current)).needsYou[0];
    if (first) params.set("thread", first.id);
  }
  return <Navigate to={{ pathname: `/p/${encodeURIComponent(id)}`, search: params.toString(), hash: view === "history" ? "#history" : hash }} replace />;
}

function LegacyItem({ note = false }: { note?: boolean }) {
  const { id = "", itemId } = useParams();
  const { hash } = useLocation();
  const item = itemId || hash.slice(1);
  const project = `/p/${encodeURIComponent(id)}`;
  const to = note ? `${project}?note=${encodeURIComponent(item)}` : item ? reviewItemPath(id, item) : `${project}/review`;
  return <Navigate to={to} replace />;
}

function LegacySkills() {
  const { skillId } = useParams();
  const { search, hash } = useLocation();
  const pathname = skillId ? `/settings/skills/${encodeURIComponent(skillId)}` : "/settings/skills";
  return <Navigate to={{ pathname, search, hash }} replace />;
}

const loadSkillEditor = async () => ({ Component: (await import("./pages/SkillEditorPage")).SkillEditorPage });

const router = createBrowserRouter(createRoutesFromElements(
  <>
    {/* Older links from when Scarlet had accounts */}
    <Route path="/login" element={<Navigate to="/" replace />} />
    <Route path="/register" element={<Navigate to="/" replace />} />
    <Route element={<AppShell />} hydrateFallbackElement={<BootSplash />}>
      <Route path="/projects/:id/tasks/:itemId" element={<LegacyItem />} />
      <Route path="/projects/:id/changes/:itemId" element={<LegacyItem />} />
      <Route path="/projects/:id/notes/:itemId" element={<LegacyItem note />} />
      <Route index element={<ProjectsPage />} />
      <Route path="/skills/:skillId?" element={<LegacySkills />} />
      <Route path="/settings" lazy={async () => ({ Component: (await import("./pages/SettingsPage")).SettingsPage })}>
        <Route path="skills" lazy={async () => ({ Component: (await import("./pages/SkillsPage")).SkillsPage })} />
      </Route>
      <Route path="/settings/skills/new" lazy={loadSkillEditor} />
      <Route path="/settings/skills/:skillId" lazy={loadSkillEditor} />
      <Route path="/p/:id" lazy={async () => ({ Component: (await import("./components/shell/ProjectLayout")).ProjectLayout })}>
        <Route index lazy={async () => ({ Component: (await import("./pages/SimpleWorkspace")).SimpleWorkspace })} />
        <Route path="review" element={<LegacyProjectView view="review" />} />
        <Route path="watch" element={<LegacyProjectView view="watch" />} />
        <Route path="changelog" element={<LegacyProjectView view="changelog" />} />
        <Route path="media" element={<LegacyProjectView view="media" />} />
        {/* Older links */}
        <Route path="changes" element={<LegacyItem />} />
        <Route path="history" element={<LegacyProjectView view="history" />} />
        <Route path="notes" element={<LegacyItem note />} />
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

export function App({ platform }: { platform: "macos" | "windows" }) {
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
