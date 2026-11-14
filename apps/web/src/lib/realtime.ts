/**
 * WebSocket connection with auto-reconnect. Parsed WsEvents fan out to the
 * zustand stores. In mock mode the MockClient's emitter stands in for the
 * socket so the UI behaves identically.
 */
import { WsEvent } from "@scarlet/shared";
import type { WsClientMessage } from "@scarlet/shared";
import { api, IS_MOCK, mockClient } from "./client";
import { appLog } from "./appLog";
import { reportImportCheck } from "./upload";
import { useHostsStore } from "../stores/hosts";
import { useProjectStore } from "../stores/project";
import { useSkillsStore } from "../stores/skills";
import { useUiStore } from "../stores/ui";

let socket: WebSocket | null = null;
let currentProjectId: string | null = null;
let confirmedProjectId: string | null = null;
let pendingSubscription: { id: string; done: Promise<void>; finish(): void } | undefined;
let attempts = 0;
let reconnectTimer: number | null = null;
let pingTimer: number | null = null;
let stopped = true;
/** Failed tries, about fifteen seconds of them, before the window says it is offline instead of reconnecting. */
const OFFLINE_AFTER = 5;
/**
 * What the window says while the socket is down. Scarlet keeps trying the whole time, so the waits between tries read
 * as reconnecting too, not as offline with a blink of reconnecting at each try. Once it has failed for a while it
 * says offline and stays there until a try gets through.
 */
const downStatus = () => stopped || attempts >= OFFLINE_AFTER ? "closed" as const : "connecting" as const;

/**
 * What the engine told the window, by kind, with the ids it was about: the reason a list, a card or the player
 * changed without the editor touching anything. A run's stream of the same kind is one line with a count.
 */
function logEvent(ev: WsEvent) {
  const about: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(ev)) {
    if (name === "type") continue;
    if (typeof value === "string" && /Id$/.test(name)) about[name.replace(/Id$/, "")] = value;
    else if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      const { id, state } = value as { id: string; state?: unknown };
      about[name] = typeof state === "string" ? `${id}:${state}` : id;
    }
  }
  // Each step of a run has its own id, which would make every line a new one: a run's steps fold by the run.
  appLog("realtime", ev.type, about, { key: ev.type === "task.event" ? `task.event/${ev.taskId}` : `${ev.type}/${JSON.stringify(about)}` });
}

export function dispatchWsEvent(ev: WsEvent) {
  logEvent(ev);
  switch (ev.type) {
    case "media.import.checking":
      reportImportCheck(ev.importId, ev.fraction);
      return;
    case "host.updated":
      useHostsStore.getState().apply(ev.host);
      return;
    case "skill.updated":
      useSkillsStore.getState().apply(ev.skill);
      return;
    case "notification":
      // The window shows no list of notifications.
      return;
    default:
      useProjectStore.getState().applyEvent(ev);
  }
}

function send(msg: WsClientMessage) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function leaveProject(projectId: string) {
  if (currentProjectId !== projectId) return;
  send({ type: "unsubscribe", projectId });
  currentProjectId = null;
  confirmedProjectId = null;
  pendingSubscription?.finish();
}

export function subscribeProject(projectId: string) {
  if (currentProjectId !== projectId) {
    if (currentProjectId) send({ type: "unsubscribe", projectId: currentProjectId });
    pendingSubscription?.finish();
    confirmedProjectId = null;
  }
  currentProjectId = projectId;
  if (!socket || socket.readyState !== WebSocket.OPEN || confirmedProjectId === projectId) return;
  if (pendingSubscription?.id !== projectId) appLog("realtime", "subscribe", { project: projectId });
  if (pendingSubscription?.id === projectId) return pendingSubscription.done;
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  // A replacement or older engine can go away before confirming the subscription.
  const finish = () => {
    window.clearTimeout(timer);
    pendingSubscription = undefined;
    release();
  };
  const timer = window.setTimeout(() => {
    // The project is read anyway. Until the engine confirms, nothing it does there reaches the window.
    appLog("realtime", "subscribe-unconfirmed", { project: projectId }, { level: "warn" });
    finish();
  }, 1000);
  pendingSubscription = { id: projectId, done, finish };
  send({ type: "subscribe", projectId });
  return done;
}

function connect() {
  if (stopped) return;
  useUiStore.getState().setWsStatus(downStatus());
  let ws: WebSocket;
  try {
    ws = new WebSocket(api.wsUrl());
  } catch {
    scheduleReconnect();
    useUiStore.getState().setWsStatus(downStatus());
    return;
  }
  socket = ws;
  // A message the window can't read is dropped. Each kind is logged once a connection: an engine that sends one
  // sends it again and again.
  const unread = new Set<string>();
  const unreadable = (fields: Record<string, unknown>) => {
    const kind = JSON.stringify(fields);
    if (unread.has(kind)) return;
    unread.add(kind);
    appLog("realtime", "unreadable", fields, { level: "warn" });
  };
  ws.onopen = () => {
    if (socket !== ws || stopped) return;
    appLog("realtime", "connected", { after: attempts ? `${attempts} tries` : undefined, project: currentProjectId ?? undefined });
    attempts = 0;
    useUiStore.getState().setWsStatus("open");
    // An HTTP snapshot already in flight when the socket opened may have missed edits.
    if (currentProjectId) void useProjectStore.getState().load(currentProjectId);
    if (pingTimer !== null) window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => send({ type: "ping" }), 25_000);
  };
  ws.onmessage = (e) => {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch {
      if (socket === ws) unreadable({ reason: "not JSON" });
      return;
    }
    const parsed = WsEvent.safeParse(raw);
    if (socket !== ws) return;
    if (!parsed.success) {
      const type = (raw as { type?: unknown } | null)?.type;
      // The answer to a ping is not an event.
      if (type !== "pong") unreadable({ type: typeof type === "string" ? type.slice(0, 40) : undefined, at: parsed.error.issues[0]?.path.join(".") || undefined });
      return;
    }
    if (parsed.data.type === "project.subscribed") {
      if (parsed.data.projectId === currentProjectId) {
        if (!parsed.data.found) appLog("realtime", "project-unknown", { project: parsed.data.projectId }, { level: "warn" });
        confirmedProjectId = parsed.data.found ? currentProjectId : null;
        pendingSubscription?.finish();
      }
    } else dispatchWsEvent(parsed.data);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    // Until it reconnects, nothing the engine does reaches the window: lists and progress go stale.
    if (!stopped) appLog("realtime", "disconnected", { code: e.code, reason: e.reason || undefined, clean: e.wasClean }, { level: "warn" });
    socket = null;
    confirmedProjectId = null;
    pendingSubscription?.finish();
    if (pingTimer !== null) window.clearInterval(pingTimer);
    pingTimer = null;
    scheduleReconnect();
    useUiStore.getState().setWsStatus(downStatus());
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  if (stopped || reconnectTimer !== null) return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)) + Math.random() * 500;
  attempts++;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * The engine says it is ready again: connect now instead of waiting out a backoff that can be half a minute long. A
 * restart on the same address looks like no change to everything else, so nothing but this asks.
 */
export function reconnectRealtime() {
  if (stopped || IS_MOCK || (socket && socket.readyState <= WebSocket.OPEN)) return;
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  attempts = 0;
  connect();
}

/** Start the realtime connection; returns a stop function. */
export function startRealtime(): () => void {
  stopped = false;
  // Tries counted against a connection that was stopped say nothing about this one.
  attempts = 0;
  if (IS_MOCK) {
    const mock = mockClient();
    const off = mock?.events.on(dispatchWsEvent);
    useUiStore.getState().setWsStatus("open");
    return () => {
      off?.();
      stopped = true;
      useUiStore.getState().setWsStatus("closed");
    };
  }
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (pingTimer !== null) window.clearInterval(pingTimer);
    pingTimer = null;
    confirmedProjectId = null;
    pendingSubscription?.finish();
    socket?.close();
    socket = null;
    useUiStore.getState().setWsStatus("closed");
  };
}
