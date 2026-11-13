// Attach only after windows.py has certified the listener PID, desktop and mute flag.
// Node 22+ provides WebSocket; this never launches Edge or creates/focuses a tab.
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [portArg, optionsFile, output] = process.argv.slice(2);
const port = Number(portArg);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const { config, data, enginePath, stage, cacheTarget, projectUrl, timeoutMs } = JSON.parse(await readFile(optionsFile, "utf8"));
const deadline = Date.now() + timeoutMs;
class CacheWindowMiss extends Error {}
async function until(check, error) {
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(125);
  }
  throw Error(error);
}
function nativeUrl(raw) {
  try {
    const url = new URL(raw);
    return (["https:", "http:"].includes(url.protocol) && url.hostname === "tauri.localhost")
      || (url.protocol === "tauri:" && url.hostname === "localhost");
  } catch { return false; }
}
const url = await until(async () => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(3000) });
  const pages = (await response.json()).filter(t => t.type === "page" && nativeUrl(t.url));
  if (pages.length > 1) throw Error("Multiple native pages in the isolated WebView.");
  return pages[0]?.webSocketDebuggerUrl;
}, "The native Scarlet page did not appear.");
const ws = new URL(url);
assert(ws.protocol === "ws:" && ws.hostname === "127.0.0.1" && ws.port === String(port) && ws.pathname.startsWith("/devtools/page/"));
const socket = new WebSocket(ws);
const requests = new Map();
let sequence = 0;
let pointerError;
const mouseTypes = { pointerdown: "mousePressed", pointermove: "mouseMoved", pointerup: "mouseReleased" };
socket.addEventListener("message", event => {
  const response = JSON.parse(event.data);
  if (response.method === "Runtime.bindingCalled" && response.params.name === "__scarletPrivatePointer") {
    try {
      const { type, x, y } = JSON.parse(response.params.payload);
      assert(Object.hasOwn(mouseTypes, type) && Number.isFinite(x) && Number.isFinite(y));
      command("Input.dispatchMouseEvent", { type: mouseTypes[type], x, y,
        button: type === "pointermove" ? "none" : "left", buttons: type === "pointerup" ? 0 : 1,
        clickCount: type === "pointermove" ? 0 : 1, pointerType: "mouse" }).catch(err => { pointerError = err; });
    } catch (err) { pointerError = err; }
    return;
  }
  const pending = requests.get(response.id);
  if (!pending) return;
  requests.delete(response.id);
  if (response.error) pending.reject(Error("WebView2 rejected CDP command " + pending.method));
  else pending.resolve(response.result);
});
socket.addEventListener("close", () => {
  for (const pending of requests.values()) pending.reject(Error("Isolated WebView2 closed."));
  requests.clear();
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(Error("Cannot attach to the isolated WebView2 page.")), { once: true });
});
function command(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const res = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) {
    // The native app can carry engine tokens in media URLs. Don't print stack traces/URLs.
    const message = res.exceptionDetails.exception?.description?.split("\n")[0] || "Native measurement failed.";
    throw Error(message.replace(/(?:https?|blob):\S+|sct_[\w-]+|Bearer\s+\S+/gi, "[redacted]"));
  }
  return res.result?.value;
}
async function monitorPixelProbe(config, result) {
  // After timed work, sample only the interior of the private program monitor.
  // Drawability is distinct from frame accuracy: rVFC supplies independent PTS.
  // Keep just pixel statistics; never write or transfer screenshots.
  const targets = [...new Set(config.scrubTimes ?? [])].slice(0, 2);
  if (targets.length === 2 && result.monitorRect?.width > 0) {
    const { x, y, width, height } = result.monitorRect;
    const clip = { x: x + width * 0.22, y: y + height * 0.24, width: width * 0.56, height: height * 0.46, scale: 32 / (width * 0.56) };
    const probes = [];
    for (const t of targets) {
      const schedule = { ...config, scrubTimes:[t], cutTimes:[], playWindows:[], cacheMediaIds:[] };
      const probe = await evaluate("window.scarletPlaybackBench.run(" + JSON.stringify(schedule) + ")");
      const { data: png } = await command("Page.captureScreenshot", { format:"png", fromSurface:true, captureBeyondViewport:false, clip });
      const grid = await evaluate(`(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], {type:"image/png"}));
        const canvas = new OffscreenCanvas(20,12), ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap,0,0,20,12); bitmap.close();
        const rgba = ctx.getImageData(0,0,20,12).data, luma = [];
        for (let i=0;i<rgba.length;i+=4) luma.push(Math.round(.2126*rgba[i]+.7152*rgba[i+1]+.0722*rgba[i+2]));
        return luma;
      })()`);
      assert(Array.isArray(grid) && grid.length === 240);
      probes.push({target:probe.scrub[0].target, endpoint:probe.scrub[0].endpoint, grid});
    }
    const [a,b] = probes;
    return { afterTimedSamples:true, source:"WebView2 compositor surface", targets:probes.map(p => p.target),
      endpoints:probes.map(p => p.endpoint), contrast:probes.map(p => Math.max(...p.grid)-Math.min(...p.grid)),
      meanAbsoluteLumaDifference:a.grid.reduce((sum,v,i) => sum + Math.abs(v-b.grid[i]), 0)/a.grid.length };
  }
  return { available:false, reason:"Two distinct scrub targets required." };
}
async function measureBatches(config, index) {
  const batches = config.batchCount ?? 1;
  assert(Number.isInteger(batches) && batches >= 1 && batches <= 16);
  let combined;
  for (let i = 0; i < batches; ++i) {
    const slice = items => (items ?? []).slice(Math.ceil(i*(items?.length ?? 0)/batches), Math.ceil((i+1)*(items?.length ?? 0)/batches));
    const schedule = { ...config, scrubTimes:slice(config.scrubTimes), cutTimes:slice(config.cutTimes), playWindows:slice(config.playWindows) };
    if (i && !schedule.scrubTimes.length && !schedule.cutTimes.length && !schedule.playWindows.length) continue;
    const run = await evaluate("window.scarletPlaybackBench.run(" + JSON.stringify(schedule) + ")");
    if (!combined) combined = {...run, scrub:[], cuts:[], sustained:[], cacheSamples:[], animationIntervalsMs:[]};
    for (const key of ["scrub", "cuts", "sustained", "cacheSamples", "animationIntervalsMs"]) combined[key].push(...(run[key] ?? []));
    // Caching is monotonic for this disposable source. Save the crossing batch,
    // then stop the loaded trial. No already-ready tail gets called cache load.
    if (stage === "during" && run.cacheSamples.some(sample => sample.sources[index]?.state === "ready")) break;
  }
  combined.planned = {scrub:config.scrubTimes?.length ?? 0, cuts:config.cutTimes?.length ?? 0, sustained:config.playWindows?.length ?? 0};
  if (stage === "during") {
    // A caching observation after a sample ended proves the entire sample
    // happened under load. These requests began after the confirmed job start.
    let verifiedThrough = -Infinity;
    for (const sample of combined.cacheSamples) {
      if (sample.sources[index]?.state !== "caching") break;
      verifiedThrough = sample.time;
    }
    for (const key of ["scrub","cuts","sustained"]) {
      for (const row of combined[key]) row.cachePhase = Number.isFinite(row.wallEnd) && row.wallEnd <= verifiedThrough ? "caching" : "transitionOrReady";
    }
    combined.cacheVerification = {targetIndex:index, verifiedThrough:Number.isFinite(verifiedThrough) ? verifiedThrough : null};
  }
  return combined;
}
try {
  const mute = await readFile(new URL("./mute.js", import.meta.url), "utf8");
  const measure = await readFile(new URL("./measure.js", import.meta.url), "utf8");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: mute });
  await evaluate(mute);
  // Pass no auth material out of the WebView; only the local fixture directory is needed.
  const readEngine = () => evaluate(`(async () => {
    if (!window.__TAURI_INTERNALS__) return null;
    const e = await window.__TAURI_INTERNALS__.invoke("engine_status");
    return e.state === "ready" ? { dataDir:e.dataDir, file:e.engine, kind:e.engineKind, pid:e.pid, restarts:e.restarts } : null;
  })()`);
  const engine = await until(readEngine, "The native engine did not become ready.");
  const canonical = async name => {
    const path = win32.normalize(await realpath(name)).toLowerCase();
    return path.startsWith("\\\\?\\") ? path.slice(4) : path;
  };
  assert.equal(await canonical(engine.dataDir), await canonical(data),
    "Refusing to run outside the disposable engine library.");
  assert(engine.kind === "sidecar" && Number.isInteger(engine.pid) && engine.pid > 0, "Expected the packaged Windows engine.");
  assert.equal(await canonical(engine.file), await canonical(enginePath), "Expected the staged engine for this variant.");
  if (config.expectedRenderer) {
    const actual = await evaluate(`(async () => {
      const r = await fetch("/scarlet-benchmark-variant.json", {cache:"no-store"});
      if (!r.ok) throw Error("Cannot verify the native renderer.");
      return r.json();
    })()`);
    assert(actual?.variant === config.expectedRenderer.variant && actual.webSha256 === config.expectedRenderer.webSha256,
      "The native renderer does not match the selected variant.");
  }
  config.expectedDataDir = engine.dataDir;
  if (projectUrl) {
    const origin = await evaluate("location.href");
    const next = new URL(projectUrl, origin);
    assert(nativeUrl(next.href) && next.origin === new URL(origin).origin && !next.username && !next.password);
    assert.equal(next.pathname, "/p/" + encodeURIComponent(config.projectId));
    await command("Page.navigate", { url: next.href });
    await until(() => evaluate("location.pathname === " + JSON.stringify(next.pathname) + " && !!window.__scarletBenchMuted"), "Native project didn't open.");
  }
  if (stage !== "current") {
    assert(config.cacheMediaIds.includes(cacheTarget), "Include the target in cacheMediaIds.");
    const status = action => evaluate(`(async () => {
      const engine = await window.__TAURI_INTERNALS__.invoke("engine_status");
      if (engine.dataDir !== ${JSON.stringify(config.expectedDataDir)}) throw Error("Fixture engine changed.");
      const headers = { Authorization: "Bearer " + engine.token, "Content-Type": "application/json" };
      const request = async (path, init) => {
        const res = await fetch(engine.url + "/api/" + path, {headers, ...init});
        if (!res.ok) throw Error("Fixture cache request failed (" + res.status + ")");
        return res.json();
      };
      if (${JSON.stringify(action)} === "start") {
        await request("projects/" + ${JSON.stringify(encodeURIComponent(config.projectId))}, {method:"PATCH",body:JSON.stringify({mediaPaused:false})});
      }
      const cache = await request("media/" + ${JSON.stringify(encodeURIComponent(cacheTarget))} + "/playback-cache",
        {method:${JSON.stringify(action === "start" ? "POST" : "GET")}});
      if (cache.state === "failed") throw Error("Fixture source cache failed.");
      return cache.state;
    })()`);
    await status("start");
    const wanted = stage === "during" ? "caching" : "ready";
    await until(async () => {
      const current = await status("read");
      if (stage === "during" && current === "ready") throw new CacheWindowMiss("Proxy completed before sampling.");
      return current === wanted;
    }, "The requested cache state was never reached.");
  }
  // Dispatch directly into the one certified WebView2 target. Never move the
  // Windows cursor, activate the window, or inject input into another desktop.
  await command("Runtime.enable", {});
  await command("Runtime.addBinding", { name: "__scarletPrivatePointer" });
  await evaluate("window.scarletBenchPointer = Object.freeze({postMessage: e => window.__scarletPrivatePointer(JSON.stringify(e))}); void 0");
  await evaluate(measure);
  const index = config.cacheMediaIds.indexOf(cacheTarget);
  const result = await measureBatches(config, index);
  if (pointerError) throw pointerError;
  const states = result.cacheSamples.map(sample => sample.sources[index]?.state);
  if (stage === "after") assert(states.length && states.every(s => s === "ready"), "Proxy did not stay ready throughout this run.");
  // An occluded private desktop may not offer compositor capture. Preserve the
  // actual frame-callback, input and drop measurements if the pixel probe fails.
  let probeTimer;
  try {
    result.monitorPixels = await Promise.race([monitorPixelProbe(config, result), new Promise((_, reject) => {
      probeTimer = setTimeout(() => reject(Error("Pixel probe expired.")), 45000);
    })]);
  } catch {
    result.monitorPixels = { available:false, reason:"No private compositor witness available." };
  } finally { clearTimeout(probeTimer); }
  // An inactive desktop can use a software adapter. Record the WebView's
  // WebGL renderer independently of the machine's installed GPU inventory.
  result.webglAdapter = await evaluate(`(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  })()`).catch(() => null);
  const finishEngine = await readEngine();
  assert(finishEngine && finishEngine.pid === engine.pid && finishEngine.restarts === engine.restarts,
    "The measured engine restarted during the run.");
  const json = JSON.stringify(result);
  assert(!/"(?:token|authorization|password)"\s*:|Bearer\s+\S+|sct_[\w-]+/i.test(json), "Unexpected credential material in telemetry.");
  await writeFile(output, json, { flag: "wx" });
} catch (error) {
  if (!(error instanceof CacheWindowMiss)) throw error;
  console.error(error.message);
  process.exitCode = 89;
} finally { socket.close(); }
