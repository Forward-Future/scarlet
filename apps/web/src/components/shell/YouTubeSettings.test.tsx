// @vitest-environment happy-dom
import type { YouTubeConnectionStatus } from "@scarlet/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { dispatchWsEvent } from "../../lib/realtime";
import { useYouTubeStore } from "../../stores/youtube";
import { YouTubeSettings } from "./YouTubeSettings";

let el: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useYouTubeStore.setState({ status: null, loaded: false, uploads: {} });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  useYouTubeStore.setState({ status: null, loaded: false, uploads: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = () => act(async () => root.render(<MemoryRouter><YouTubeSettings /></MemoryRouter>));
const buttonByText = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
const typeInto = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("YouTubeSettings", () => {
  it("guides setup when unconfigured, saves custom OAuth Client ID, connects via browser, and disconnects", async () => {
    const unconfigured: YouTubeConnectionStatus = {
      state: "disconnected",
      configured: false,
      configSource: "none",
      hasCustomClientId: false,
      hasCustomClientSecret: false,
    };
    const configured: YouTubeConnectionStatus = {
      state: "disconnected",
      configured: true,
      configSource: "custom",
      clientIdHint: "12345678…googleusercontent.com",
      hasCustomClientId: true,
      hasCustomClientSecret: false,
    };
    const connecting: YouTubeConnectionStatus = {
      ...configured,
      state: "connecting",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=12345678",
    };
    const connected: YouTubeConnectionStatus = {
      ...configured,
      state: "connected",
      channel: { id: "UC_1", title: "Forward Future", handle: "@forwardfuture" },
      connectedAt: "2026-11-26T18:00:00.000Z",
    };

    vi.spyOn(api, "youtubeStatus").mockResolvedValue({ status: unconfigured });
    const saveConfig = vi.spyOn(api, "youtubeUpdateConfig").mockResolvedValue({ status: configured });
    const startConnect = vi.spyOn(api, "youtubeConnect").mockResolvedValue({ authUrl: connecting.authUrl!, status: connecting });
    const disconnect = vi.spyOn(api, "youtubeDisconnect").mockResolvedValue({ status: configured });
    const openWin = vi.spyOn(window, "open").mockReturnValue(null);

    await mount();
    expect(el.textContent).toContain("No Google OAuth Client ID is set yet");

    // Open setup form and save a custom Client ID
    await act(async () => buttonByText("Set up OAuth")!.click());
    const idField = el.querySelector<HTMLInputElement>('input[aria-label="Google OAuth Client ID"]')!;
    await typeInto(idField, "123456789-abc.apps.googleusercontent.com");
    await act(async () => buttonByText("Save Client ID")!.click());
    expect(saveConfig).toHaveBeenCalledWith({ clientId: "123456789-abc.apps.googleusercontent.com" });
    expect(el.textContent).toContain("Ready to sign in");

    // Start OAuth sign-in -> opens browser and shows waiting state
    await act(async () => buttonByText("Connect YouTube")!.click());
    expect(startConnect).toHaveBeenCalledTimes(1);
    expect(openWin).toHaveBeenCalledWith(connecting.authUrl, "_blank", "noopener,noreferrer");
    expect(el.textContent).toContain("Waiting for Google sign-in in your browser");

    // Live WebSocket event completes connection -> displays channel & Disconnect button
    await act(async () => dispatchWsEvent({ type: "youtube.connection.updated", status: connected }));
    expect(el.textContent).toContain("Forward Future");
    expect(el.textContent).toContain("@forwardfuture");
    expect(buttonByText("Disconnect")).toBeDefined();

    // Disconnect clears the connected channel
    await act(async () => buttonByText("Disconnect")!.click());
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Not connected");
  });

  it("shows Reconnect when sign-in expired and supports cancelling an active OAuth flow", async () => {
    const expired: YouTubeConnectionStatus = {
      state: "error",
      configured: true,
      configSource: "env",
      channel: { id: "UC_1", title: "Creator Channel" },
      needsReconnect: true,
      error: "Your YouTube sign-in expired or was revoked. Reconnect your account.",
    };
    const connecting: YouTubeConnectionStatus = {
      state: "connecting",
      configured: true,
      configSource: "env",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    };
    const disconnected: YouTubeConnectionStatus = {
      state: "disconnected",
      configured: true,
      configSource: "env",
    };

    vi.spyOn(api, "youtubeStatus").mockResolvedValue({ status: expired });
    vi.spyOn(api, "youtubeConnect").mockResolvedValue({ authUrl: connecting.authUrl!, status: connecting });
    const cancel = vi.spyOn(api, "youtubeCancelConnect").mockResolvedValue({ status: disconnected });
    vi.spyOn(desktop, "openUrl").mockResolvedValue();
    vi.spyOn(window, "open").mockReturnValue(null);

    await mount();
    expect(el.textContent).toContain("Sign-in expired");
    expect(buttonByText("Reconnect")).toBeDefined();

    await act(async () => buttonByText("Reconnect")!.click());
    expect(buttonByText("Cancel")).toBeDefined();
    await act(async () => buttonByText("Cancel")!.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Not connected");
  });
});
