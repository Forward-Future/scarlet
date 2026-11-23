export { AgentHost, type HostOptions } from "./host.js";
export { claudeProjectDir, pruneTaskDirs, removeClaudeSessions, removeControlFiles } from "./taskDirs.js";
export { detect, findOnPath, formatAvailability, CLI_AGENTS } from "./detect.js";
export { loadConfig, saveConfig, requireConfig, scarletHome, workRoot, type AgentConfig } from "./config.js";
export * from "./runners/index.js";
