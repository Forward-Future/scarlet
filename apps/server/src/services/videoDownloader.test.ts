import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DownloaderBuild, DOWNLOADERS, VideoDownloader } from "./videoDownloader.js";

// Two stand-ins for yt-dlp: the build the engine shipped with, which a site has stopped answering, and the release after it.
const OLD = "#!/bin/sh\necho 'ERROR: [youtube] agents: Sign in to confirm you are not a bot' >&2\nexit 1\n";
const NEW = "#!/bin/sh\necho \"read $1\"\n";
const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");

let folder: string;
let server: Server;
let base: string;
let asked: string[];
let latest: Record<string, unknown>;
let files: Record<string, string>;
let clock: number;
let logged: string[];

const pinned = (): DownloaderBuild => ({ version: "2026.10.26", asset: "yt-dlp_test", name: "yt-dlp-2026.10.26", url: `${base}/files/old`, size: OLD.length, sha256: sha256(OLD) });
const release = (version: string, about: Record<string, unknown> = {}) =>
  ({ tag_name: version, assets: [{ name: "yt-dlp_other", size: 4, digest: `sha256:${sha256("else")}`, browser_download_url: `${base}/files/other` },
    { name: "yt-dlp_test", size: NEW.length, digest: `sha256:${sha256(NEW)}`, browser_download_url: `${base}/files/new`, ...about }] });
const tool = (options: Partial<ConstructorParameters<typeof VideoDownloader>[0]> = {}) =>
  new VideoDownloader({ folder, pinned: pinned(), log: line => logged.push(line), releases: `${base}/latest`, origin: `${base}/files/`, now: () => clock, ...options });
const failure = (running: Promise<unknown>) => running.then(() => "ran", (error: Error) => error.message);
const kept = () => readdirSync(folder).sort();

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "scarlet-downloader-test-"));
  asked = [], logged = [], clock = 1_000_000;
  files = { old: OLD, new: NEW };
  server = createServer((req, res) => {
    asked.push(req.url!);
    if (req.url === "/latest") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(latest));
    const body = files[req.url!.replace("/files/", "")];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  latest = release("2026.11.20");
});
afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Scarlet's video downloader", () => {
  it("moves to the newest release when a call fails, runs the call again with it, and keeps it", async () => {
    const first = tool();
    expect((await first.run(["page"])).toString()).toBe("read page\n");
    expect(asked).toEqual(["/files/old", "/latest", "/files/new"]);
    // The build that failed is gone, and the newer one is remembered by its size and checksum.
    expect(kept()).toEqual(["yt-dlp-2026.11.20", "yt-dlp-newer.json"]);
    expect(logged.filter(line => line.startsWith("[tools]"))).toEqual(["[tools] yt-dlp 2026.10.26 failed and 2026.11.20 is out: fetching it", "[tools] yt-dlp 2026.11.20 is in use"]);
    // After a restart the engine starts on the newer build, with nothing fetched and nothing asked.
    asked = [];
    const restarted = tool();
    expect((await restarted.run(["again"])).toString()).toBe("read again\n");
    expect([await restarted.path(new AbortController().signal), asked]).toEqual([join(folder, "yt-dlp-2026.11.20"), []]);
  });

  it("reports the failure as it is when no newer release is out, and asks again only after an hour", async () => {
    latest = release("2026.10.26");
    const using = tool();
    expect(await failure(using.run(["page"]))).toContain("Sign in to confirm you are not a bot");
    expect(await failure(using.run(["page"]))).toContain("Sign in to confirm you are not a bot");
    expect(asked.filter(url => url === "/latest").length).toBe(1);
    // A release came out since: the next failure after the hour finds it.
    latest = release("2026.11.20");
    clock += 59 * 60_000;
    expect(await failure(using.run(["page"]))).toContain("Sign in");
    clock += 2 * 60_000;
    expect((await using.run(["page"])).toString()).toBe("read page\n");
    expect(asked.filter(url => url === "/latest").length).toBe(2);
  });

  it("gives one newer build to calls that fail together", async () => {
    const using = tool();
    expect((await Promise.all([using.run(["a"]), using.run(["b"]), using.run(["c"])])).map(String)).toEqual(["read a\n", "read b\n", "read c\n"]);
    expect([asked.filter(url => url === "/latest").length, asked.filter(url => url === "/files/new").length]).toEqual([1, 1]);
  });

  it("never runs a release it can't check: no checksum, another site's file, or bytes that differ from the checksum", async () => {
    for (const about of [{ digest: undefined }, { digest: "sha256:abc" }, { browser_download_url: "https://example.com/yt-dlp_test" }, { size: 0 }]) {
      latest = release("2026.11.20", about);
      expect(await failure(tool().run(["page"])), JSON.stringify(about)).toContain("Sign in");
    }
    expect(asked).not.toContain("/files/new");
    latest = release("2026.11.20");
    files.new = NEW.replace("read", "REad");
    expect(await failure(tool().run(["page"]))).toContain("Sign in");
    expect(kept()).toEqual(["yt-dlp-2026.10.26"]);
    expect(logged.at(-1)).toMatch(/^\[tools\] yt-dlp: couldn't move to a newer release: /);
    // An older or malformed "newest" is no reason to move either.
    for (const version of ["2026.09.01", "nightly", "v2026.11.20"]) {
      latest = release(version);
      files.new = NEW;
      expect(await failure(tool().run(["page"])), version).toContain("Sign in");
    }
    expect(kept()).toEqual(["yt-dlp-2026.10.26"]);
  });

  it("leaves a yt-dlp of the machine's own as it is", async () => {
    const own = join(folder, "own-yt-dlp");
    writeFileSync(own, OLD);
    chmodSync(own, 0o755);
    expect(await failure(tool({ own }).run(["page"]))).toContain("Sign in");
    expect([asked, existsSync(join(folder, "yt-dlp-newer.json"))]).toEqual([[], false]);
  });

  it("says so on a machine yt-dlp has no build for", async () => {
    expect(await failure(tool({ pinned: undefined }).run(["page"]))).toBe("Scarlet has no video downloader for this kind of machine. Set YT_DLP_PATH to a yt-dlp on it.");
  });
});

describe.skipIf(!process.env.SCARLET_TEST_WEB_VIDEO)("the real release page", () => {
  it("names a build for this machine that passes its own checksum and runs", async () => {
    const mine = DOWNLOADERS[`${process.platform}-${process.arch}`]!;
    // As if the engine had shipped with an earlier build: the newest release is then the one to move to.
    const using = new VideoDownloader({ folder, pinned: { ...mine, version: "2026.01.01" }, log: line => logged.push(line) });
    const signal = new AbortController().signal;
    expect(await using.update(signal)).toBe(true);
    const path = await using.path(signal);
    expect(path).toMatch(/yt-dlp-\d{4}\.\d{2}\.\d{2}/);
    expect((await using.run(["--version"])).toString().trim()).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
  }, 300_000);
});
