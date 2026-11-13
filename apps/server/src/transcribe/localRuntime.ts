import { constants, accessSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findOnPath } from "@scarlet/agent";
import { selectedLocalModel, type LocalModelStatus, type LocalTranscriptionModel, type ServerSettings } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { bundledWhisperOnGpu } from "./whispercpp.js";

type Settings = ServerSettings["transcription"];

/** Check a local installation without running code or reading its weights into memory. */
function usableFile(path: string, mode = constants.R_OK) {
  try {
    const file = statSync(path);
    if (!file.isFile() || file.size === 0) return false;
    accessSync(path, mode);
    return true;
  } catch { return false; }
}

function crisperPaths(root: string) {
  const dir = join(root, "models", "crisperwhisper");
  const windows = process.platform === "win32";
  return {
    binary: join(dir, "venv", ...(windows ? ["Scripts", "python.exe"] : ["bin", "python"])),
    script: join(dir, "crisper_cli.py"),
    model: join(dir, "model", "model.safetensors"),
    building: join(dir, ".building-venv"),
    legacyCli: join(dir, windows ? "crisper-cli.exe" : "crisper-cli"),
  };
}

function crisperInstallation(paths: ReturnType<typeof crisperPaths>) {
  // The installer builds the venv at its permanent path. Python appears before its dependencies are ready.
  if (existsSync(paths.building)) return "installing";
  return usableFile(paths.binary, constants.X_OK) && usableFile(paths.script) && usableFile(paths.model) ? "ready" : "missing";
}

export function hasCrisperWhisper(root: string) {
  return crisperInstallation(crisperPaths(root)) === "ready";
}

export interface LocalRuntime {
  selected: LocalTranscriptionModel;
  active?: LocalTranscriptionModel;
  binary?: string;
  /** The preset's adapter runs in its own Python environment. */
  script?: string;
  model?: string;
  /** Legacy binary-only overrides use the bundled GGML weights. Explicit adapters may own their weights. */
  adapterOwnsModel?: boolean;
  gpu?: boolean;
  gpuBinary?: string;
  reason?: string;
}

export function resolveLocalRuntime(ctx: Pick<Ctx, "paths" | "whisperCli" | "whisperGpu">, settings: Settings): LocalRuntime {
  const paths = crisperPaths(ctx.paths.root);
  // A release without presets could still use the installer-provided launcher and weights.
  const legacyPreset = !settings.localModel && settings.whisperCppPath && settings.whisperModelPath &&
    resolve(settings.whisperCppPath) === resolve(paths.legacyCli) && resolve(settings.whisperModelPath) === resolve(paths.model);
  const selected = legacyPreset ? "crisperwhisper" : selectedLocalModel(settings);
  const installation = selected === "crisperwhisper" ? crisperInstallation(paths) : undefined;
  if (installation === "ready") {
    // The pinned Transformers adapter runs on the CPU, including on Apple silicon.
    return { selected, active: selected, binary: paths.binary, script: paths.script, model: paths.model, gpu: false };
  }
  if (selected === "custom" && !settings.whisperCppPath && !settings.whisperModelPath) {
    return { selected, reason: "Choose a local model file or adapter executable in Advanced settings." };
  }
  const customBinary = selected === "custom" ? settings.whisperCppPath : undefined;
  const model = selected === "custom" ? settings.whisperModelPath : undefined;
  if ([customBinary, model].some(path => path && /^[a-z][a-z\d+.-]*:\/\//i.test(path))) {
    return { selected, reason: "Choose local files for the model and adapter." };
  }
  if (customBinary && process.platform === "win32" && /\.(cmd|bat)$/i.test(customBinary)) {
    return { selected, reason: "Choose a Windows executable (.exe) for the local adapter." };
  }
  const binary = customBinary || ctx.whisperCli || (model ? "whisper-cli" : undefined);
  const presetIssue = installation === "installing" ? "CrisperWhisper setup is in progress. " : installation === "missing" ? "CrisperWhisper is not installed. " : "";
  if (!binary) return { selected, reason: presetIssue + "The bundled Whisper runtime is unavailable." };
  const bundledBinary = !customBinary && binary === ctx.whisperCli;
  return { selected, active: selected === "custom" ? "custom" : "whispercpp", binary, model,
    adapterOwnsModel: settings.localModel === "custom" && !!customBinary && !model,
    gpu: bundledBinary && bundledWhisperOnGpu(), gpuBinary: bundledBinary ? ctx.whisperGpu : undefined,
    reason: presetIssue ? presetIssue + "Scarlet is using bundled Whisper." : undefined };
}

export async function resolvedBinary(binary: string) {
  return basename(binary) === binary ? await findOnPath(binary) : binary;
}

/** The bundled weights can be fetched on demand. A custom path has to be usable as selected. */
export async function localRuntimeIssue(runtime: LocalRuntime) {
  if (!runtime.binary) return runtime.reason;
  if (runtime.selected !== "custom") return;
  const binary = await resolvedBinary(runtime.binary);
  if (!binary || !usableFile(binary, constants.X_OK)) return "The local adapter executable is missing or cannot be run.";
  if (runtime.model && !usableFile(runtime.model)) return "The selected model file is missing, empty or unreadable.";
}

export async function localRuntimeStatus(ctx: Ctx): Promise<LocalModelStatus> {
  const runtime = resolveLocalRuntime(ctx, ctx.settings().transcription);
  const { selected, active, reason } = runtime;
  const issue = await localRuntimeIssue(runtime);
  if (issue) return { state: "missing", selected, fallback: false, reason: issue };
  const selection = { selected, active, reason, fallback: selected === "crisperwhisper" && active === "whispercpp" };
  const status: LocalModelStatus = runtime.model || runtime.adapterOwnsModel ? { state: "ready" } : await ctx.whisperModel.status();
  return { ...status, ...selection };
}
