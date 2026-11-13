// Stream a completed file through the engine's HTTP Range handler to a local
// destination. The native-save measurement uses Reqwest/Tokio; this portable
// control isolates the engine's transfer sizes using the Node HTTP client.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { serve } from "@hono/node-server";
import { serveFile } from "../dist/files.js";

const scratch = await mkdtemp(join(tmpdir(), "scarlet-file-delivery-"));
const source = join(scratch, "source.mp4"), target = join(scratch, "saved.mp4");
let server;
try {
  const block = randomBytes(1024 * 1024), checksum = createHash("sha256");
  const file = await open(source, "w");
  try {
    for (let i = 0; i < 128; i++) { await file.writeFile(block); checksum.update(block); }
  } finally { await file.close(); }
  const expected = checksum.digest("hex");
  server = serve({ hostname: "127.0.0.1", port: 0, fetch: req => serveFile(req, source) });
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/source.mp4";
  const times = { playback: [], download: [] };
  for (let i = 0; i < 8; i++) for (const mode of i % 2 ? ["download", "playback"] : ["playback", "download"]) {
    const start = performance.now();
    const [response] = await once(get(url, { headers: mode === "download" ? { "x-scarlet-download": "1" } : {} }), "response");
    assert.equal(response.statusCode, 200);
    await pipeline(response, createWriteStream(target));
    if (i) times[mode].push(performance.now() - start);
    const actual = createHash("sha256");
    for await (const chunk of createReadStream(target)) actual.update(chunk);
    assert.equal(actual.digest("hex"), expected);
  }
  console.log(JSON.stringify(times, null, 2));
} finally {
  server?.close();
  await rm(scratch, { recursive: true, force: true });
}
