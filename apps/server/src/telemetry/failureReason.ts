import type { FailureReason, Render, Task } from "@scarlet/shared";

/**
 * Why a request or an export failed, read here off the words the host, the agent's CLI or the engine left on it. Only
 * the category is reported: the words themselves never leave the installation (docs/telemetry.md).
 *
 * The words come from many places (the desktop host, three agent CLIs, the transcription providers, ffmpeg), so each
 * category is a pattern and the order matters: a CLI that exits with code 1 often says why in the stderr that follows,
 * so sign-in, limit and model patterns come before the bare exit.
 */
type Rule = readonly [FailureReason, RegExp];

const HOST_STOPPED: Rule = ["timeout", /^(?:timed out|stalled)\b/i];
const OUT_OF_DISK: Rule = ["out_of_disk",
  /ENOSPC|no space left|disk (?:is )?full|not enough (?:free )?(?:disk )?space|enough free disk space|insufficient (?:disk |storage )?space/i];

const RATE_LIMITED: Rule = ["rate_limited", new RegExp([
  /rate[ _-]?limit|usage limit|limit reached|hit your (?:usage )?limit|(?:5|five)-hour limit|weekly limit/,
  /quota|resource[ _-]?exhausted|\b429\b|too many requests|out of (?:credits|usage)|credit balance|exceeded your/,
].map(re => re.source).join("|"), "i")];

const TRANSCRIPTION: readonly Rule[] = [
  ["transcription_model_missing", new RegExp([
    /transcription provider .* is not configured/,
    /^no [\w.-]+$/, // A provider the engine has no runtime for.
    /could not download the local model/,
    /missing its uhm runtime/,
    /model checksum mismatch|model exceeds expected size/,
    /crisperwhisper installation changed/,
    /^spawn .*ENOENT/,
  ].map(re => re.source).join("|"), "i")],
  ["media_unreadable", new RegExp([
    /failed to read audio|no complete pcm audio|recording unavailable|recording's alignment store/,
    /^not (?:a file|read)$/,
    /invalid data found|moov atom not found|error opening input|could(?:n['’]t| not) (?:open|read|decode)/,
    /unsupported (?:codec|format)|no audio|ENOENT|no such file|EACCES|permission denied/,
  ].map(re => re.source).join("|"), "i")],
  RATE_LIMITED,
];

const AGENT: readonly Rule[] = [
  ["agent_not_signed_in", new RegExp([
    /not logged in|not signed in|please (?:run \/login|log ?in|sign in)|run (?:\w+ )?login\b|\/login\b|log ?in again|sign in again/,
    /invalid (?:api[ _-]?key|x-api-key|bearer|authentication)|authentication(?:_error| required| failed| error)/,
    /unauthenticated|not authenticated|unauthori[sz]ed|\b401\b/,
    /token (?:has )?(?:expired|been revoked|is invalid)|credentials? (?:are |is )?(?:missing|invalid|expired)/,
  ].map(re => re.source).join("|"), "i")],
  RATE_LIMITED,
  ["model_unavailable", new RegExp([
    /model.{0,100}?(?:not (?:found|supported|available)|does ?n[o’']t exist|may not exist|isn['’]t (?:supported|available)|unavailable|not have access)/,
    /(?:unknown|invalid|unsupported) model|no such model|model_not_found/,
  ].map(re => re.source).join("|"), "i")],
  ["agent_not_installed", /cli not found on path|not found on path|runs no copy of|command not found|not installed|^spawn (?!E(?:AGAIN|MFILE|NOMEM)\b)/i],
  ["tools_unavailable", /mcp server|no editing tools/i],
];

const LAST: readonly Rule[] = [
  ["network", new RegExp([
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed/,
    /network|connection (?:refused|reset|closed|error|lost|timed out)|could(?:n['’]t| not) (?:connect|reach)|failed to connect/,
    /stream disconnected|error sending request|\bdns\b|tls handshake|certificate/,
  ].map(re => re.source).join("|"), "i")],
  ["provider_error", /overloaded|internal server error|service unavailable|bad gateway|gateway time-?out|\bapi error\b|\b(?:500|502|503|504|529)\b/i],
  ["crashed", new RegExp([
    /exited with code|exit code|exited unexpectedly|ended without|ended with stopreason|returned no result/,
    /\bkilled\b|\bsignal\b|SIG(?:KILL|SEGV|ABRT|TERM|BUS|ILL)\b|panick?ed|crash|stopped (?:taking input|before it answered)|device lost/,
    /^agent failed$|app server/,
  ].map(re => re.source).join("|"), "i")],
];

function match(rules: readonly Rule[], text: string): FailureReason | undefined {
  return rules.find(([, pattern]) => pattern.test(text))?.[0];
}

/** For a task that ended `failed`. */
export function taskFailureReason(task: Pick<Task, "kind" | "error" | "interrupted" | "lostWorker">): FailureReason {
  const error = task.error?.trim() ?? "";
  const early = match([HOST_STOPPED, OUT_OF_DISK], error);
  if (early) return early;
  // The host or the engine stopped the run: a quit, a pause, or a worker that went missing while Scarlet stayed open.
  if (task.interrupted) return task.lostWorker ? "crashed" : "interrupted";
  if (task.kind === "transcribe") return match([...TRANSCRIPTION, ...LAST], error) ?? (/interrupted/i.test(error) ? "interrupted" : "other");
  return match([...AGENT, ...LAST], error) ?? (/interrupted/i.test(error) ? "interrupted" : "other");
}

const RENDER: readonly Rule[] = [
  OUT_OF_DISK,
  ["interrupted", /interrupted/i],
  ["media_unreadable", /can['’]t (?:find|read) .* in this project|invalid data found|moov atom not found|error opening input|no such file|ENOENT|permission denied/i],
  ["crashed", /couldn['’]t render|exited with code|\bkilled\b|\bsignal\b|SIG(?:KILL|SEGV|ABRT|TERM|BUS|ILL)\b|crash|empty file/i],
];

/** For a render that ended `failed`. Reads ffmpeg's words too, where the editor's sentence says less. */
export function renderFailureReason(render: Pick<Render, "error" | "errorDetail">): FailureReason {
  return match(RENDER, `${render.error ?? ""}\n${render.errorDetail ?? ""}`) ?? "other";
}
