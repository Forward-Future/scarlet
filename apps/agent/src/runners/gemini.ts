/**
 * Gemini via Antigravity CLI (`agy acp`), speaking Agent Client Protocol (JSON-RPC 2.0) over stdio.
 * Runs with `--sandbox` and an explicit `session/request_permission` handler: a request's agent may use agy's own
 * shell, file and web tools inside its task folder as well as Scarlet's, and a side check only Scarlet's. Supports model selection,
 * thinking level (`thought_level`), session resume (`session/resume`), and token usage reporting.
 *
 * This module drives the session; `geminiAcp.ts` parses what agy reports and decides its permissions, and
 * `geminiTranscript.ts` reads live token counts from agy's transcript.
 */
import { hasApiKey } from "../detect.js";
import { briefInput, DEFAULT_STALL_MS, workspaceEnv, type RunAgentOptions, type RunAgentResult, type RunnerEvent } from "./types.js";
import { acpConfigHasValue, DEFAULT_GEMINI_EFFORT, findAcpEffortOption, findAcpModelOption, isAcpAuthError, type AcpConfigOption } from "./acp.js";
import {
  acpMcpServer,
  asString,
  buildGeminiCommand,
  extractToolName,
  flushStreams,
  isScarletMcpPermission,
  newGeminiState,
  parseGeminiAcpUpdate,
  permissionOutcome,
  syncUsage,
  systemPromptMeta,
  takesSystemPrompt,
  workspacePermission,
} from "./geminiAcp.js";
import { TranscriptUsageTailer } from "./geminiTranscript.js";
import { asRecord, earlyResult, exitError, jsonLine, resolveCli, spawnLines, tailSummary } from "./spawn.js";
import { addUsage, createUsageReporter, geminiUsage, usageWithModel } from "./usage.js";

/** How long agy has to exit on its own once Scarlet has closed its input. It can stay up, and the run would stall. */
const STOP_GRACE_MS = 2000;

/** How many times a run carries on after agy ended Gemini's turn on a tool Scarlet refused. */
const MAX_CARRY_ONS = 4;

function configOptionId(opt: AcpConfigOption): string | undefined {
  return opt.id ?? opt.configId;
}

function parseConfigOptions(result: Record<string, unknown>): AcpConfigOption[] {
  if (!Array.isArray(result.configOptions)) return [];
  return result.configOptions
    .map(asRecord)
    .filter((o): o is Record<string, unknown> => Boolean(o)) as AcpConfigOption[];
}

type PendingStep =
  | "initialize"
  | "authenticate"
  | "session_open"
  | "set_model"
  | "set_effort"
  | "prompt"
  | "done";

export async function runGemini(opts: RunAgentOptions): Promise<RunAgentResult> {
  // Scarlet's own variables stay out of agy, so its terminal never holds the token.
  const env = workspaceEnv(opts.env ?? process.env, opts.workspace);
  const bin = await resolveCli("agy", opts.bin, env);
  const cmd = buildGeminiCommand(bin);

  const st = newGeminiState();
  let requestId = 1;
  let step: PendingStep = "initialize";
  let triedApiKeyAuth = false;
  let resumeFailed = false;
  let cancelSent = false;
  let configOptions: AcpConfigOption[] = [];
  const transcript = new TranscriptUsageTailer();
  // Tools Scarlet refused during the turn under way. agy ends Gemini's turn on a refusal.
  let refused: string[] = [];
  let carryOns = 0;
  const hasGeminiKey = hasApiKey("gemini", env);
  const resuming = Boolean(opts.resumeSession);
  const sendUsage = createUsageReporter(opts.onUsage, opts.model);
  const reportUsage = () => sendUsage(st.usage);

  const pollTranscriptUsage = () => {
    const live = transcript.poll(st.model ?? opts.model);
    if (live) {
      st.turnUsage = live;
      syncUsage(st);
    }
  };

  const emit = (evs: RunnerEvent[]) => {
    for (const ev of evs) opts.onEvent(ev);
  };

  let handle: ReturnType<typeof spawnLines>;

  const send = (message: Record<string, unknown>): boolean => {
    if (!handle?.child.stdin || handle.child.stdin.destroyed || !handle.child.stdin.writable) return false;
    handle.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    return true;
  };

  const sendRequest = (method: string, params: Record<string, unknown>) => {
    send({ id: ++requestId, method, params });
  };

  const cancelTurn = (): boolean => {
    if (cancelSent || step === "done" || !st.sessionId) return false;
    cancelSent = send({ method: "session/cancel", params: { sessionId: st.sessionId } });
    return cancelSent;
  };

  let stopTimer: NodeJS.Timeout | undefined;
  const stopSession = () => {
    step = "done";
    handle.child.stdin?.end();
    // agy can stay up after its input closes, and a finished edit would then wait out the stall check.
    stopTimer ??= setTimeout(() => handle.kill(), STOP_GRACE_MS).unref();
  };

  const failSession = (message: string) => {
    st.failed = message;
    opts.onEvent({ type: "error", text: message });
    stopSession();
  };

  const sendOpenSession = () => {
    step = "session_open";
    const mcpServers = [acpMcpServer(opts.mcp)];
    const _meta = systemPromptMeta(opts.systemPrompt);
    if (opts.resumeSession) {
      sendRequest("session/resume", { sessionId: opts.resumeSession, cwd: opts.cwd, mcpServers, _meta });
    } else {
      sendRequest("session/new", { cwd: opts.cwd, mcpServers, _meta });
    }
  };

  const sendTurn = (text: string) => {
    step = "prompt";
    refused = [];
    sendRequest("session/prompt", {
      sessionId: st.sessionId!,
      prompt: [{ type: "text", text }],
    });
  };
  const sendPrompt = () => sendTurn(opts.instruction);

  // agy ends Gemini's turn as soon as Scarlet refuses one of its tools, before the model hears why, and reports the
  // turn ended as if it were finished. Tell the model what was refused and let it carry on.
  const carryOnAfterRefusal = (): boolean => {
    if (!refused.length) return false;
    const names = [...new Set(refused)].join(", ");
    if (carryOns >= MAX_CARRY_ONS) {
      failSession(`Gemini stopped after Scarlet refused ${names}, a tool that doesn't run in Scarlet, ${carryOns + 1} times.`);
      return true;
    }
    // The words are the engine's (`refusedTool`): a host writes nothing the model reads.
    const words = opts.refusedTool?.trim();
    if (!words) {
      failSession(`Gemini stopped after Scarlet refused ${names}, and this engine gave no words to carry on with. Update Scarlet's engine.`);
      return true;
    }
    carryOns += 1;
    opts.onEvent({ type: "log", text: `Scarlet refused ${names}: only Scarlet's tools run here. Gemini carries on.`, data: { kind: "tool_refused", harnessTool: names } });
    sendTurn(words.replaceAll("{tool}", names));
    return true;
  };

  /** Take the session's options from a result that lists them again, keeping the last list when one doesn't. */
  const refreshConfigOptions = (result: Record<string, unknown>) => {
    const refreshed = parseConfigOptions(result);
    if (refreshed.length > 0) configOptions = refreshed;
  };

  const maybeSetEffortThenPrompt = () => {
    const thoughtOpt = findAcpEffortOption(configOptions);
    const configId = thoughtOpt ? configOptionId(thoughtOpt) : undefined;
    const targetEffort = opts.effort
      ?? (thoughtOpt && thoughtOpt.currentValue !== DEFAULT_GEMINI_EFFORT && acpConfigHasValue(thoughtOpt, DEFAULT_GEMINI_EFFORT)
        ? DEFAULT_GEMINI_EFFORT
        : undefined);
    if (configId && targetEffort) {
      step = "set_effort";
      sendRequest("session/set_config_option", { sessionId: st.sessionId!, configId, value: targetEffort });
      return;
    }
    sendPrompt();
  };

  /** agy asking the client something: permission for a tool, which a request's agent has inside its folder. Nothing else is answered. */
  const answerRequest = (msg: Record<string, unknown>) => {
    if (msg.method === "session/request_permission") {
      // A request's agent has agy's own tools inside its folder; a side check has Scarlet's only.
      const allow = opts.workspace ? workspacePermission(msg.params, [opts.cwd, ...opts.workspace.readDirs])
        : isScarletMcpPermission(msg.params);
      if (!allow) refused.push(extractToolName(asRecord(asRecord(msg.params)?.toolCall) ?? {}));
      send({ id: msg.id, result: { outcome: permissionOutcome(msg.params, allow) } });
    } else {
      send({ id: msg.id, error: { code: -32601, message: "Unsupported by Scarlet" } });
    }
  };

  const onSessionUpdate = (params: Record<string, unknown> | undefined) => {
    const updateRec = asRecord(params?.update);
    const kind = asString(updateRec?.sessionUpdate);
    emit(parseGeminiAcpUpdate(params?.update, st));
    if (kind === "usage_update" || kind === "tool_call" || kind === "tool_call_update" || kind === "agent_message_chunk") {
      pollTranscriptUsage();
    }
    reportUsage();
    if (st.shouldStop) {
      st.shouldStop = false;
      if (!cancelTurn()) setTimeout(() => handle.kill(), 250).unref();
      else setTimeout(() => handle.kill(), 2000).unref();
    }
  };

  /** An error answering the step under way: sign in with the API key, fall back from a resume, or fail. */
  const onStepError = (err: Record<string, unknown>) => {
    const detail = asString(err.message) ?? briefInput(err, 400) ?? "unknown error";
    const code = typeof err.code === "number" ? err.code : undefined;
    if (step === "session_open" && !triedApiKeyAuth && hasGeminiKey && isAcpAuthError(code, detail)) {
      triedApiKeyAuth = true;
      step = "authenticate";
      sendRequest("authenticate", { methodId: "gemini-api-key" });
      return;
    }
    if (step === "session_open" && resuming) {
      resumeFailed = true;
      st.failed = `Gemini could not resume session: ${detail}`;
      stopSession();
      return;
    }
    failSession(`Gemini ${step} failed: ${detail}`);
  };

  const onSessionOpened = (result: Record<string, unknown>) => {
    st.sessionId = asString(result.sessionId) ?? opts.resumeSession;
    if (!st.sessionId) {
      failSession("Gemini session returned no sessionId");
      return;
    }
    transcript.open(env, st.sessionId, resuming);
    configOptions = parseConfigOptions(result);
    const legacyModels = asRecord(result.models);
    const modelOpt = findAcpModelOption(configOptions);
    st.model = opts.model ?? asString(modelOpt?.currentValue) ?? asString(legacyModels?.currentModelId);
    opts.onEvent({
      type: "log",
      text: `Gemini session started${st.model ? ` (${st.model})` : ""}`,
      data: { kind: "init", ...(st.model ? { model: st.model } : {}), sessionId: st.sessionId },
    });
    if (opts.model) {
      const modelConfigId = modelOpt ? configOptionId(modelOpt) : undefined;
      if (modelConfigId) {
        step = "set_model";
        sendRequest("session/set_config_option", { sessionId: st.sessionId, configId: modelConfigId, value: opts.model });
        return;
      }
      if (legacyModels) {
        step = "set_model";
        sendRequest("session/set_model", { sessionId: st.sessionId, modelId: opts.model });
        return;
      }
    }
    maybeSetEffortThenPrompt();
  };

  const onTurnEnded = (result: Record<string, unknown>) => {
    const flushEvs: RunnerEvent[] = [];
    flushStreams(st, flushEvs);
    emit(flushEvs);
    pollTranscriptUsage();
    const finishedTurn = geminiUsage(result.usage, st.model ?? opts.model) ?? st.turnUsage;
    if (finishedTurn) {
      st.completedUsage = addUsage(st.completedUsage, finishedTurn);
    }
    st.turnUsage = undefined;
    transcript.resetTurn();
    syncUsage(st);
    reportUsage();
    const stopReason = asString(result.stopReason) ?? "end_turn";
    // A turn Scarlet cancelled itself (a question to stop on, a stall, a time limit, Stop this edit) ended as
    // asked: the host says why the run stopped, so it isn't reported as an error of Gemini's first.
    if (stopReason === "cancelled" && (st.question || cancelSent)) {
      stopSession();
      return;
    }
    if (stopReason === "end_turn" && carryOnAfterRefusal()) return;
    if (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "stop_sequence") {
      st.completed = true;
      opts.onEvent({
        type: "result",
        text: st.lastMessage ?? "done",
        ...(result.usage ? { data: { usage: result.usage } } : {}),
      });
      stopSession();
      return;
    }
    failSession(`Gemini ended with stopReason ${stopReason}`);
  };

  /** The answer to the request for the step under way. */
  const onResponse = (msg: Record<string, unknown>) => {
    const err = asRecord(msg.error);
    if (err) {
      onStepError(err);
      return;
    }

    const result = asRecord(msg.result) ?? {};
    switch (step) {
      case "initialize": {
        if (!takesSystemPrompt(result)) {
          const version = asString(asRecord(result.agentInfo)?.version);
          failSession(`This agy${version ? ` ${version}` : ""} doesn't take Scarlet's instructions (its initialize result lists no systemPrompt.append), so Gemini would edit without them. Update agy.`);
          return;
        }
        sendOpenSession();
        break;
      }
      case "authenticate": {
        sendOpenSession();
        break;
      }
      case "session_open": {
        onSessionOpened(result);
        break;
      }
      case "set_model": {
        st.model = opts.model ?? st.model;
        refreshConfigOptions(result);
        maybeSetEffortThenPrompt();
        break;
      }
      case "set_effort": {
        refreshConfigOptions(result);
        sendPrompt();
        break;
      }
      case "prompt": {
        onTurnEnded(result);
        break;
      }
    }
  };

  handle = spawnLines(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env,
    interactive: true,
    signal: opts.signal,
    interrupt: cancelTurn,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs ?? DEFAULT_STALL_MS,
    onLine: (line) => {
      const msg = jsonLine(line);
      if (!msg) {
        opts.onEvent({ type: "log", text: line });
        return;
      }

      // Incoming agent -> client request or notification
      if (typeof msg.method === "string") {
        if (msg.id !== undefined) answerRequest(msg);
        else if (msg.method === "session/update") onSessionUpdate(asRecord(msg.params));
        return;
      }

      // Response to our pending request
      if (msg.id !== requestId || step === "done") return;
      onResponse(msg);
    },
  });

  // Start the ACP handshake.
  send({
    id: requestId,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "scarlet", version: "0.1.4" } },
  });

  // Periodically poll transcript.jsonl while a prompt turn is active so token counts
  // still update if agy flushes PLANNER_RESPONSE right after tool_call before a slow tool runs.
  const usagePoll = setInterval(() => {
    if (step === "prompt") {
      pollTranscriptUsage();
      reportUsage();
    }
  }, 2_000);
  usagePoll.unref();

  let outcome;
  try {
    outcome = await handle.done;
  } finally {
    clearInterval(usagePoll);
    clearTimeout(stopTimer);
  }

  const remaining: RunnerEvent[] = [];
  flushStreams(st, remaining);
  emit(remaining);
  pollTranscriptUsage();
  reportUsage();

  const usage = usageWithModel(st.usage, opts.model);
  if (resumeFailed) {
    return { ok: false, summary: "", error: st.failed, resumeFailed: true, exitCode: outcome.code, usage };
  }
  const early = earlyResult(st, outcome, { sessionId: st.sessionId, usage });
  if (early) return early;
  const ok = !st.failed && st.completed;
  return {
    ok,
    summary: st.lastMessage ?? tailSummary(st.texts),
    error: ok ? undefined : st.failed ?? exitError("agy", outcome),
    exitCode: outcome.code,
    sessionId: st.sessionId,
    usage,
  };
}
