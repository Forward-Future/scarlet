// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { useUiStore } from "../../stores/ui";
import { WindowActions } from "./WorkspaceNavigation";

it("omits the notification button even with unread notifications", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const previous = useUiStore.getState().notifications;
  try {
    useUiStore.setState({ notifications: [] });
    useUiStore.getState().notify({ title: "Change ready" });
    await act(async () => root.render(<MemoryRouter><WindowActions /></MemoryRouter>));
    expect(container.querySelector('[aria-label="Settings"]')).toBeTruthy();
    expect(container.querySelector('[aria-label^="Notifications"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useUiStore.setState({ notifications: previous });
    vi.unstubAllGlobals();
  }
});
