import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AbortError,
  FfmpegError,
  INDEXED_MP4_INPUT,
  failureReason,
  ffSeconds,
  ffmpegEncoders,
  ffmpegMajor,
  ffmpegVersion,
  fnum,
  parseProgressLine,
  mediaToolLaunchError,
  runCapture,
  runFfmpeg,
  stderrTail,
  withStreamInfoFallback,
} from "./exec.js";

it("explains how to install a missing media tool while preserving other startup failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-missing-media-"));
  try {
    await expect(runCapture(join(dir, "ffprobe"), ["-version"])).rejects.toThrow(/ffprobe.*restart Scarlet/i);
    await expect(runCapture(join(dir, "unrelated-tool"), [])).rejects.toThrow(/ENOENT/);
    expect(mediaToolLaunchError("ffprobe", { code: "EACCES" } as NodeJS.ErrnoException, "permission denied")).toBe("permission denied");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("progress lines", () => {
  it("reads the output time and ignores every other line", () => {
    expect(parseProgressLine("out_time=00:01:02.500000")).toBe(62.5);
    expect(parseProgressLine("out_time=01:00:00")).toBe(3600);
    expect(parseProgressLine("out_time_us=1500000")).toBe(1.5);
    // The misnamed field holds microseconds, so it is never read as milliseconds.
    expect(parseProgressLine("out_time_ms=1500000")).toBeUndefined();
    for (const line of ["frame=12", "progress=continue", "out_time=N/A", "out_time_us=N/A", ""]) expect(parseProgressLine(line)).toBeUndefined();
  });

  it("reports the time before the first frame as zero", () => {
    expect(parseProgressLine("out_time=-00:00:00.033333")).toBe(0);
    expect(parseProgressLine("out_time_us=-33333")).toBe(0);
  });

  it("reports each time ffmpeg prints, in order, while it runs", async () => {
    const times: number[] = [];
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=10:d=1", "-f", "null", "-"], { onProgress: t => times.push(t) });
    expect(times.length).toBeGreaterThan(0);
    expect(times.at(-1)).toBeCloseTo(1, 1);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("numbers for ffmpeg", () => {
  it("writes fixed decimals without an exponent or trailing zeros", () => {
    expect(fnum(1)).toBe("1");
    expect(fnum(1.5)).toBe("1.5");
    expect(fnum(100)).toBe("100");
    expect(fnum(1 / 3)).toBe("0.333333");
    expect(fnum(2 / 3)).toBe("0.666667");
    expect(fnum(0.1 + 0.2)).toBe("0.3");
    expect(fnum(1e-9)).toBe("0");
    expect(fnum(0.50196, 4)).toBe("0.502");
    expect(fnum(12.3456, 0)).toBe("12");
    for (const value of [NaN, Infinity, -Infinity]) expect(fnum(value)).toBe("0");
  });

  it("keeps the sign of a negative number, and drops it from one that rounds to zero", () => {
    expect(fnum(-1.25)).toBe("-1.25");
    expect(fnum(-0.5)).toBe("-0.5");
    expect(fnum(-10)).toBe("-10");
    expect(fnum(-1e-7)).toBe("0");
    expect(fnum(-0)).toBe("0");
    expect(fnum(-0.004, 2)).toBe("0");
  });

  it("writes a time under a microsecond as zero, where JavaScript would use an exponent", () => {
    expect(String(0.1 + 0.2 - 0.3)).toContain("e-");
    expect(ffSeconds(0.1 + 0.2 - 0.3)).toBe("0");
    expect(ffSeconds(-(0.1 + 0.2 - 0.3))).toBe("0");
    expect(ffSeconds(0)).toBe("0");
    expect(ffSeconds(0.000001)).toBe("0.000001");
    expect(ffSeconds(12.345678901)).toBe("12.345678901");
    expect(ffSeconds(-2.5)).toBe("-2.5");
  });

});

describe("failures", () => {
  it("keeps the end of a long error output, where ffmpeg says what went wrong", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    expect(stderrTail(lines.join("\n") + "\n\n").split("\n")).toEqual(lines.slice(-40));
    expect(stderrTail(lines.join("\r\n"), 2)).toBe("line 58\nline 59");
    expect(stderrTail("only")).toBe("only");
    expect(stderrTail("")).toBe("");
  });

  it("names a failure in one line: the first thing ffmpeg wrote and the last, or the error's first line", () => {
    const failed = new FfmpegError("ffmpeg exited with code 1:\nmany\nlines", "ffmpeg", [], 1,
      "[h264 @ 0x1] No device available for decoder\r\n[vist#0:0/h264 @ 0x2] Error initializing\nError opening output files: Cannot allocate memory\n\n");
    expect(failureReason(failed)).toBe("[h264] No device available for decoder; Error opening output files: Cannot allocate memory");
    expect(failureReason(new FfmpegError("x", "ffmpeg", [], 1, "[libx264 @ 0000029f5043d640] Odd width"))).toBe("[libx264] Odd width");
    expect(failureReason(new FfmpegError("x", "ffmpeg", [], 1, "\nCannot load nvcuda.dll\n"))).toBe("Cannot load nvcuda.dll");
    expect(failureReason(new FfmpegError("failed to start ffmpeg: spawn ffmpeg ENOENT", "ffmpeg", [], null, "", false))).toBe("failed to start ffmpeg: spawn ffmpeg ENOENT");
    expect(failureReason(new Error("No frame decoded\nat 3s"))).toBe("No frame decoded");
    expect(failureReason("plain")).toBe("plain");
    expect(failureReason(new FfmpegError("x", "ffmpeg", [], 1, "y".repeat(1000)))).toHaveLength(300);
  });

  it("names the cause of a refused encode, which ffmpeg writes first and follows with what came of it", async () => {
    // The one-frame encoder test, at a size libx264 refuses.
    const encode = () => runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=15x15:r=30",
      "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "null", "-"]).catch(e => e);
    const refused = await encode();
    expect(refused).toBeInstanceOf(FfmpegError);
    expect(refused.started).toBe(true);
    expect(stderrTail(refused.stderr, 1)).not.toContain("15x15");
    expect(failureReason(refused)).toMatch(/^\[libx264\] width not divisible by 2 \(15x15\)/);
    // Each run tags its lines with different addresses. The reason reads the same, so repeats can be told.
    expect(failureReason(await encode())).toBe(failureReason(refused));
  });

  it("rejects with the exit code and error output of a command that fails, and with an abort when cancelled", async () => {
    const failed = await runCapture("ffmpeg", ["-v", "error", "-i", join(tmpdir(), "scarlet-no-such-file.mp4"), "-f", "null", "-"]).catch(e => e);
    expect(failed).toBeInstanceOf(FfmpegError);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toMatch(/no such file/i);
    expect(failed.message).toContain(stderrTail(failed.stderr));

    const missing = await runCapture(join(tmpdir(), "scarlet-no-such-ffmpeg"), ["-version"]).catch(e => e);
    expect(missing).toBeInstanceOf(FfmpegError);
    expect(missing.code).toBeNull();
    expect(missing.started).toBe(false);
    expect(missing.message).toMatch(/^failed to start /);
    expect((await runFfmpeg(["-version"], { ffmpegPath: join(tmpdir(), "scarlet-no-such-ffmpeg") }).catch(e => e)).started).toBe(false);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(runCapture("ffmpeg", ["-version"], { signal: cancelled.signal })).rejects.toBeInstanceOf(AbortError);
    await expect(runFfmpeg(["-version"], { signal: cancelled.signal })).rejects.toBeInstanceOf(AbortError);
    const running = new AbortController();
    const endless = runFfmpeg(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=10", "-f", "null", "-"], { signal: running.signal, onProgress: () => running.abort() });
    await expect(endless).rejects.toBeInstanceOf(AbortError);
  });

  it("stops a command whose output passes the limit", async () => {
    const flood = runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=1", "-f", "rawvideo", "-"], { maxStdout: 1000 });
    await expect(flood).rejects.toThrow(/stdout exceeded 1000 bytes/);
  });

  it("streams diagnostics line by line and rejects at the diagnostic byte limit", async () => {
    const lines: string[] = [];
    const args = ["-e", "process.stderr.write('one\\ntwo')"];
    await runCapture(process.execPath, args, { maxStderr: 7, onStderrLine: line => lines.push(line) });
    expect(lines).toEqual(["one", "two"]);
    await expect(runCapture(process.execPath, args, { maxStderr: 6 })).rejects.toThrow("stderr exceeded 6 bytes");
  });
});

describe("the movie index fallback", () => {
  const indexed = ["-ss", "1", ...INDEXED_MP4_INPUT, "-i", "a.mp4", ...INDEXED_MP4_INPUT, "-i", "b.mp4"];

  it("runs once when the indexed read works", async () => {
    const calls: string[][] = [];
    expect(await withStreamInfoFallback(indexed, undefined, async args => { calls.push(args); return "ok"; })).toBe("ok");
    expect(calls).toEqual([indexed]);
  });

  it("retries with a packet scan on every input, and says why the index was dropped", async () => {
    const calls: string[][] = [];
    const reasons: unknown[] = [];
    const refused = new Error("moov atom not found");
    const result = await withStreamInfoFallback(indexed, undefined, async args => {
      calls.push(args);
      if (args.includes("-nofind_stream_info")) throw refused;
      return "scanned";
    }, error => reasons.push(error));
    expect(result).toBe("scanned");
    expect(calls[1]).toEqual(["-ss", "1", "-i", "a.mp4", "-i", "b.mp4"]);
    expect(reasons).toEqual([refused]);
    expect(indexed).toHaveLength(12); // The caller's arguments are left as they were.
  });

  it("fails with the retry's own error when the packet scan fails too", async () => {
    const reasons: unknown[] = [];
    const run = async (args: string[]) => { throw new Error(args.includes("-nofind_stream_info") ? "index" : "scan"); };
    await expect(withStreamInfoFallback(indexed, undefined, run, error => reasons.push(error))).rejects.toThrow("scan");
    expect(reasons).toHaveLength(1);
  });

  it("does not retry a read that never used the index, or one that was cancelled", async () => {
    let calls = 0;
    const fail = async () => { calls++; throw new Error("failed"); };
    await expect(withStreamInfoFallback(["-i", "a.mp4"], undefined, fail)).rejects.toThrow("failed");
    // Only the whole three-option group is an indexed input.
    await expect(withStreamInfoFallback(["-nofind_stream_info", "-i", "a.mp4"], undefined, fail)).rejects.toThrow("failed");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(withStreamInfoFallback(indexed, cancelled.signal, fail)).rejects.toThrow("failed");
    expect(calls).toBe(3);
  });
});

describe("what a build offers", () => {
  it("lists encoders by name and reads the major version", async () => {
    const encoders = await ffmpegEncoders();
    expect(encoders.has("libx264")).toBe(true);
    expect(encoders.has("aac")).toBe(true);
    // The column header and the legend above the list are not encoders.
    for (const name of ["=", "------", "Encoders:"]) expect(encoders.has(name)).toBe(false);
    expect(await ffmpegEncoders()).toBe(encoders);
    expect(await ffmpegMajor()).toBeGreaterThanOrEqual(4);
  });

  // A shell script stands in for ffmpeg here.
  it.skipIf(process.platform === "win32")("asks again after a failed start instead of remembering the failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scarlet-exec-"));
    try {
      const bin = join(dir, "ffmpeg");
      await expect(ffmpegEncoders(bin)).rejects.toThrow(/failed to start/);
      await expect(ffmpegVersion(bin)).rejects.toThrow(/failed to start/);
      await writeFile(bin, "#!/bin/sh\nif [ \"$1\" = -version ]; then echo 'ffmpeg version n7.1-test'; else echo ' V....D h264_test  A test encoder'; fi\n");
      await chmod(bin, 0o755);
      expect([...await ffmpegEncoders(bin)]).toEqual(["h264_test"]);
      expect(await ffmpegVersion(bin)).toBe("ffmpeg version n7.1-test");
      expect(await ffmpegMajor(bin)).toBe(7);
      // A good answer is kept: removing the binary does not lose it.
      await rm(bin);
      expect([...await ffmpegEncoders(bin)]).toEqual(["h264_test"]);
      expect(await ffmpegVersion(bin)).toBe("ffmpeg version n7.1-test");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
