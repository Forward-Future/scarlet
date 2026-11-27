/**
 * What each harness actually delivers to its model and allows in its workspace.
 * Scarlet shapes its tools and prompt from this table instead of asking the
 * model to judge its own abilities ("only if you can play WAV").
 *
 * Keep entries conservative: claim a capability only after checking that the
 * harness forwards that content type from MCP tool results in headless mode.
 * Power users can override per run with SCARLET_AGENT_CAPS='{"audio":true}'. `plan` is read by the engine, which
 * tells each host how to launch the CLI, so set it where the engine runs: SCARLET_AGENT_CAPS='{"plan":true}'.
 */
export interface AgentCapabilities {
  /** Image content blocks in MCP tool results reach the model. */
  images: boolean;
  /** Audio content blocks (WAV) in MCP tool results reach the model. */
  audio: boolean;
  /**
   * The model hears a WAV file in its task folder when it opens the file with its harness's own file viewer, though
   * audio in a tool's result doesn't reach it. Only a run with file tools (`files`) can open one.
   */
  audioFiles?: boolean;
  /** The agent can read and write files in its task artifact directory (needed before `asset_add`). */
  files: boolean;
  /**
   * The agent has a shell in its task folder, sandboxed by its harness: it writes only there, and has ffmpeg and ffprobe
   * on its PATH where the host has them. What it builds with them is its own choice. Every request has one.
   */
  shell?: boolean;
  /** The agent can search the web through its harness's own tools. Every request can. */
  web?: boolean;
  /** Character target for paging long MCP text responses. Configurable per harness. */
  resultChars?: number;
  /**
   * Scarlet can launch the harness with its own to-do tool on, and the plan its model keeps there reaches Scarlet as
   * `plan` task events. Off, the model has no such tool and the chat shows no plan. The tool and its description are
   * the harness's. Where it is on, the engine launches a run with the tool, and asks for the steps, only when the
   * chat will show them (`taskPrompt` in `apps/server/src/services/tasks.ts`).
   */
  plan: boolean;
  /** Prefix the harness uses when it exposes Scarlet's MCP tools to the model. */
  toolPrefix?: string;
  /**
   * How long one tool call may wait for evidence still being measured before it answers "still running" and costs the
   * model a turn. Scarlet's hosts launch Claude Code (MCP_TOOL_TIMEOUT) and Codex (tool_timeout_sec) with a 300 s tool
   * deadline; agy ends a tool call at 180 s whatever Scarlet asks; a client Scarlet didn't launch keeps the common 60 s
   * one, so it waits less.
   */
  toolWaitSeconds?: number;
  /**
   * The harness keeps only so much of its tools' definitions and drops the rest without telling the model, so Scarlet
   * lists whole only the tools Claude Code gets from the start, names every other tool on one line of `tool_call`, which
   * calls it, and the model reads a tool's whole description and parameters from `tool_help`.
   */
  briefTools?: boolean;
  /**
   * The most characters one tool's description may have before the harness cuts the rest off. Claude Code turns tool
   * search off for an endpoint that isn't Anthropic's and cuts an MCP tool's description at 4,096 characters, so
   * `tool_call`'s index is kept under this ceiling.
   */
  toolDescriptionChars?: number;
}

/** Wait for a client whose tool deadline is unknown: a margin below the common 60-second one. */
export const DEFAULT_TOOL_WAIT_SECONDS = 45;

/**
 * Seconds one tool call may wait for evidence still being measured: `margin` under the harness's `toolWaitSeconds`, to
 * leave time for the answer itself. At a margin of 20: 220 s on Claude Code and Codex, 100 s on Gemini and 25 s for a
 * client Scarlet didn't launch.
 */
export function toolWait(caps: Pick<AgentCapabilities, "toolWaitSeconds">, margin: number): number {
  return Math.max(5, Math.min(240, (caps.toolWaitSeconds ?? DEFAULT_TOOL_WAIT_SECONDS) - margin));
}

// A 58-minute transcript exceeded Claude Code's result window and was saved to a file its
// file-disabled session couldn't read. Leave headroom below its 50,000-character spill point.
export const DEFAULT_RESULT_CHARS = 40_000;

// `plan` is off for every harness. On 2026-11-08 Claude Code, given the tool and one sentence asking for its steps, laid
// them out within twelve seconds in each of eleven real requests, at a median of about 15 seconds a request. Since
// 2026-11-10 the chat shows only what Scarlet is doing this moment, not a plan, so no run pays for one.
// SCARLET_AGENT_CAPS='{"plan":true}' still turns Claude Code's on. Codex's has not been measured.
const KNOWN: Record<string, AgentCapabilities> = {
  // What each harness delivers launched with Scarlet's tools only, as a side check is. A request is launched with its
  // harness's own shell, file and web tools as well (`workspaceCapabilities`).
  // claude -p then runs with tool search alone (--tools ToolSearch, no file tools); Claude models take images but not audio.
  // Plan: Claude Code 2.1.316 has TaskCreate and TaskUpdate (TodoWrite before it) only when --tools names them.
  claude: { images: true, audio: false, files: false, plan: false, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 },
  // codex exec has a writable workspace. It forwards MCP audio blocks, but only some models hear them (`HEARING_MODELS`).
  // Plan: Codex 0.166 has update_plan only with tools.update_plan.enabled, and reports it as `todo_list` items.
  codex: { images: true, audio: false, files: true, plan: false, toolWaitSeconds: 240 },
  // agy acp then runs with Scarlet's permission handler allowing only Scarlet MCP tools (no file tools); audio forwarding from MCP is unverified. Its runner reads no plan.
  // Brief tools: agy 1.x keeps about 60 KB of MCP tool definitions a session and drops the largest past it, listing
  // nothing in their place. On 2026-11-19 it dropped seven of Scarlet's 50 (117 KB), timeline_propose and
  // dialogue_apply_cuts among them, so a Gemini pass couldn't save an edit; listed briefly (43 KB) all 51 stayed.
  // Tool wait: agy 1.x ends a tool call at 180 s (two saves on 2026-11-20 failed at 181 s; a 94 s call answered). With
  // no wait set, Gemini's calls waited 45 s less their margin, so a save that needed area checks gave up at once.
  // Result size: agy 1.5 spills MCP text results over ~10,200 chars (~10 KiB) to output.txt (measured 2026-11-22:
  // 10,134 chars stayed inline, 10,304 chars spilled), forcing extra read_file turns. Leave headroom under that cliff.
  // Audio: checked through `agy acp` on 2026-11-22. Gemini hears no audio in an MCP tool result, nor in the prompt as an
  // audio, embedded or linked block, but agy's own file viewer gives it a WAV from its folder: it wrote out a restart
  // word for word, hesitations and all ("they are lobbying against, mm, they are lobbying to control GPUs").
  gemini: { images: true, audio: false, audioFiles: true, files: false, plan: false, briefTools: true, resultChars: 9_000, toolWaitSeconds: 120 },
  // Ollama, LM Studio and OpenRouter run through Claude Code pointed at their Anthropic-compatible endpoint, so the
  // harness is Claude Code's, but the model is not Claude. Claude Code turns its tool search off for an endpoint that
  // isn't Anthropic's, and would then send all of Scarlet's definitions (about 117 KB) every turn, more than a local
  // model's context holds; listed briefly they are about 43 KB. Images reach only a model that reads them
  // (`IMAGE_MODELS`): sent to one that doesn't, the request fails. Local models get shorter pages for their smaller
  // contexts.
  ollama: { images: false, audio: false, files: false, plan: false, briefTools: true, toolDescriptionChars: 4_000, resultChars: 16_000, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 },
  lmstudio: { images: false, audio: false, files: false, plan: false, briefTools: true, toolDescriptionChars: 4_000, resultChars: 16_000, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 },
  openrouter: { images: false, audio: false, files: false, plan: false, briefTools: true, toolDescriptionChars: 4_000, toolPrefix: "mcp__scarlet__", toolWaitSeconds: 240 },
};

/**
 * Models that read images where their provider's others may not. OpenRouter's Claude, Gemini and GPT models all take
 * pictures; a model that takes none fails the whole request when a frame reaches it, so the rest stay text-only.
 */
const IMAGE_MODELS: Record<string, RegExp> = { openrouter: /^(anthropic\/|google\/gemini|openai\/(gpt-(4o|4\.1|5)|o\d))/i };

/** Whether this model reads images, though its provider's other models may not. */
export function modelSeesImages(agent: string | undefined, model: string | undefined): boolean {
  return !!(agent && model && Object.hasOwn(IMAGE_MODELS, agent) && IMAGE_MODELS[agent]!.test(model));
}

// An agent Scarlet didn't launch is someone's own MCP client, such as Claude Code or Claude Desktop pointed at Scarlet,
// and each of those shows the model the images a tool returns. Turning images off here would take the frame tools away
// from the one way to run Scarlet without a host. A client that drops images gets them as unreadable content, not a
// wrong measurement: every tool also answers in text.
const UNKNOWN: AgentCapabilities = { images: true, audio: false, files: false, plan: false };

/**
 * What a run launched with its harness's own tools has (`workspace` on the task's prompt): files, a shell sandboxed to
 * its task folder, and the web. Checked headless on each harness, 2026-11-21: Claude Code and Codex have all three;
 * agy's terminal has no network and agy no page fetch, so a Gemini run reads the web by search and `web_capture`.
 */
export function workspaceCapabilities(caps: AgentCapabilities): AgentCapabilities {
  return { ...caps, files: true, shell: true, web: true };
}

function validResultChars(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 2_000;
}

/**
 * Models that hear audio in a tool's result where their harness's other models don't. Checked through Codex on
 * 2026-11-22 with an MCP audio block: gpt-6-astra-audio wrote out all four slips of a hearing test, as Gemini did;
 * gpt-6.2-sol heard nothing, and gpt-6.1-terra two of four.
 */
const HEARING_MODELS: Record<string, RegExp> = { codex: /-audio\b/i };

/**
 * Models that hear a WAV file opened through their harness's file viewer, where the harness also exposes third-party
 * models that don't. `agy` (`agent: "gemini"`) offers Claude and GPT models alongside Gemini; only Gemini models hear
 * WAV files opened there (2026-11-23: `agy` + `claude-opus-5-5` received `source_audio` WAVs it couldn't hear).
 */
const AUDIO_FILE_MODELS: Record<string, RegExp> = { gemini: /(?:^|\/)gemini\b/i };

/** Whether this model hears audio in a tool's result, though its harness's others don't. */
export function modelHearsAudio(agent: string | undefined, model: string | undefined): boolean {
  return !!(agent && model && Object.hasOwn(HEARING_MODELS, agent) && HEARING_MODELS[agent]!.test(model));
}

/** Whether this model hears a WAV file opened with its harness's file viewer. Unset model means the harness's default. */
export function modelHearsAudioFiles(agent: string | undefined, model: string | undefined): boolean {
  const known = agent && Object.hasOwn(KNOWN, agent) ? KNOWN[agent] : undefined;
  if (!known?.audioFiles) return false;
  if (!model) return true;
  return !Object.hasOwn(AUDIO_FILE_MODELS, agent!) || AUDIO_FILE_MODELS[agent!]!.test(model);
}

/** Whether a run with these capabilities can hear a recording: in a tool's result, or as a file it opens itself. */
export function canHear(caps: Pick<AgentCapabilities, "audio" | "audioFiles">): boolean {
  return caps.audio || !!caps.audioFiles;
}

/** A model that listens for a request whose own model can't hear, on a host that has it. */
export interface Listener {
  agent: string;
  /** The model passed to its CLI; none for the CLI's own default. */
  model?: string;
}

/** What a request heard through the model that listens for it (`POST /projects/:id/listen`). */
export type ListenResult =
  | { state: "heard"; answer: string; by: Listener }
  | { state: "listening"; by: Listener }
  | { state: "failed"; error: string; by: Listener }
  | { state: "unavailable"; reason: string };

/** What the listening setting needs to know of a host's agent. */
type SignedInAgent = { id: string; installed: boolean; loggedIn?: boolean; model?: string; models?: string[] };

/**
 * The editor's listening setting: "auto" for the best model signed in that can hear (`listenerAmong`), "off" for none,
 * or one model as "agent:model" ("gemini:gemini-4-neon", "codex:gpt-6-astra-audio").
 */
export type ListeningSetting = "auto" | "off" | `${string}:${string}`;

/**
 * How a model that did something is named to the editor and to another model: the name its host gives it, else the
 * model, else its agent. agy's own default model is Gemini's. The one place outside the hosts that names a provider for
 * this, so the engine's tools and prompt never do.
 */
export function modelDisplayName(by: { agent: string; model?: string; label?: string }): string {
  return by.label ?? (by.agent === "gemini" && !by.model ? "Gemini" : by.model ?? by.agent);
}

/** The setting's value for one model: "agent:model", or "agent:default" for its CLI's own default model. */
export const listenerKey = (listener: Listener): ListeningSetting => `${listener.agent}:${listener.model ?? "default"}`;

/** Every model signed in on these agents that can hear, Gemini's first, for the editor to pick from. */
export function hearingModels(agents: ReadonlyArray<SignedInAgent>): Listener[] {
  const usable = agents.filter(a => a.installed && a.loggedIn !== false);
  const seen = new Set<string>();
  const out: Listener[] = [];
  for (const a of [...usable.filter(a => a.id === "gemini"), ...usable.filter(a => a.id !== "gemini")]) {
    const listed = [a.model, ...(a.models ?? [])].filter((m): m is string => !!m);
    const models = listed.filter(m => a.id === "gemini" ? modelHearsAudioFiles(a.id, m) : modelHearsAudio(a.id, m));
    for (const model of models) {
      if (seen.has(`${a.id}:${model}`)) continue;
      seen.add(`${a.id}:${model}`);
      out.push({ agent: a.id, model });
    }
    // Gemini whose CLI lists no models still hears, on its own default.
    if (a.id === "gemini" && !listed.length && !seen.has("gemini:")) {
      seen.add("gemini:");
      out.push({ agent: "gemini" });
    }
  }
  return out;
}

/**
 * The model that listens under the editor's setting. A model they picked that isn't signed in now listens for nobody:
 * Scarlet doesn't swap in another behind their back, and Settings says so.
 */
export function chooseListener(agents: ReadonlyArray<SignedInAgent>, setting: string = "auto"): Listener | undefined {
  if (setting === "off") return undefined;
  if (setting === "auto") return listenerAmong(agents);
  return hearingModels(agents).find(l => listenerKey(l) === setting);
}

/**
 * The model that listens for a request whose own model can't hear, among the agents the editor's hosts have signed in:
 * Gemini first, which caught the most of the editor's own slips (6 of 9 on 40 labelled spots, 2026-11-22), then a Codex
 * model that hears. None when no host has one.
 */
export function listenerAmong(agents: ReadonlyArray<SignedInAgent>): Listener | undefined {
  const usable = agents.filter(a => a.installed && a.loggedIn !== false);
  for (const gemini of usable.filter(a => a.id === "gemini")) {
    if (gemini.model) {
      if (modelHearsAudioFiles("gemini", gemini.model)) return { agent: "gemini", model: gemini.model };
      const heard = (gemini.models ?? []).find(m => modelHearsAudioFiles("gemini", m));
      if (heard) return { agent: "gemini", model: heard };
    } else if (!gemini.models?.length || gemini.models.some(m => modelHearsAudioFiles("gemini", m))) {
      return { agent: "gemini" };
    }
  }
  for (const a of usable) {
    const model = [a.model, ...(a.models ?? [])].find(m => modelHearsAudio(a.id, m));
    if (model) return { agent: a.id, model };
  }
  return undefined;
}

export function agentCapabilities(agent: string | undefined, override?: Partial<AgentCapabilities> | string, model?: string): AgentCapabilities {
  const known = (agent && Object.hasOwn(KNOWN, agent) && KNOWN[agent]) || UNKNOWN;
  let base = modelHearsAudio(agent, model) ? { ...known, audio: true } : known;
  if (!base.images && modelSeesImages(agent, model)) base = { ...base, images: true };
  if (base.audioFiles && !modelHearsAudioFiles(agent, model)) base = { ...base, audioFiles: false };
  let extra: Partial<AgentCapabilities> = {};
  if (typeof override === "string" && override.trim()) {
    try {
      const parsed = JSON.parse(override) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      for (const key of ["images", "audio", "audioFiles", "files", "shell", "web", "plan", "briefTools"] as const) if (typeof parsed[key] === "boolean") extra[key] = parsed[key] as boolean;
      if (typeof parsed.resultChars === "number") extra.resultChars = parsed.resultChars;
      if (typeof parsed.toolDescriptionChars === "number" && Number.isSafeInteger(parsed.toolDescriptionChars) && parsed.toolDescriptionChars >= 1_000) extra.toolDescriptionChars = parsed.toolDescriptionChars;
      if (typeof parsed.toolWaitSeconds === "number" && Number.isFinite(parsed.toolWaitSeconds) && parsed.toolWaitSeconds > 0) extra.toolWaitSeconds = parsed.toolWaitSeconds;
    } catch {
      extra = {};
      // The value is the user's own text, so it stays out of the log.
      console.warn('[scarlet] SCARLET_AGENT_CAPS ignored: it must be a JSON object such as {"audio":true}');
    }
  } else if (override && typeof override === "object") extra = override;
  const fallbackResultChars = validResultChars(base.resultChars) ? base.resultChars : DEFAULT_RESULT_CHARS;
  const resultChars = validResultChars(extra.resultChars) ? extra.resultChars : fallbackResultChars;
  return { ...base, ...extra, resultChars };
}
