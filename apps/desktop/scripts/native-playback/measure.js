// Inject only into the isolated native Scarlet benchmark window. No app imports,
// production IPC commands, global input events or system audio changes are needed.
(() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clock = () => performance.now();
  const monitor = () => document.querySelector(".watch-monitor");
  const slider = () => document.querySelector(".cut-transport .timeline-slider");
  const video = () => [...monitor()?.querySelectorAll("video") ?? []].find(el => !el.closest("[hidden]"));
  function displayCadence() {
    return new Promise(resolve => {
      const stamps = [];
      let handle;
      const finish = () => { clearTimeout(timeout); cancelAnimationFrame(handle); resolve(stamps.slice(1).map((t,i) => t-stamps[i])); };
      const timeout = setTimeout(finish, 1200);
      const next = t => { stamps.push(t); if (stamps.length >= 14) finish(); else handle = requestAnimationFrame(next); };
      handle = requestAnimationFrame(next);
    });
  }
  async function until(get, timeout, message) {
    const start = clock();
    do {
      const value = get();
      if (value) return value;
      await sleep(25);
    } while (clock() - start < timeout);
    throw Error(message);
  }
  const transport = () => monitor()?.querySelector('.monitor-playback button');
  const selectedStill = () => monitor()?.querySelector('img[alt="Selected edit frame"],img[alt="Selected cut frame"]');
  function visibleStill(img) {
    return img?.isConnected && img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === "1" && img.getBoundingClientRect().width > 0;
  }
  function seekPresentation(observation, frame, fps, down, input) {
    for (const sample of observation.samples) {
      // Some native decoders round their PTS to a millisecond.
      if (!(sample.delivered >= input && Math.abs(sample.media * fps - frame) < 0.12)) continue;
      const el = observation.currentVideo(sample);
      if (!el) continue;
      if (sample.wall >= input && (!sample.aligned || sample.submitted >= input)) {
        return { at: sample.wall, endpoint: sample.aligned ? "video" : "videoCallback" };
      }
      // A paused WKWebView seek can report compositor times from just before
      // pointerup for a frame first requested on release. Use callback arrival
      // only for the latest exact frame of the settled, still-visible video.
      if (sample === observation.samples.at(-1) && sample.wall >= down && sample.submitted >= down &&
          el.paused && !el.seeking && Math.floor(el.currentTime * fps + 1e-7) === frame) {
        return { at: Math.max(sample.wall, sample.delivered), endpoint: "videoCallback" };
      }
    }
  }
  function observeFrames() {
    let el, callback, generation = 0;
    const samples = [];
    function follow() {
      const next = video();
      if (next === el) return;
      el?.cancelVideoFrameCallback(callback);
      el = next;
      const watching = ++generation;
      if (!el) return;
      if (!el.requestVideoFrameCallback) throw Error("Native video frame callbacks are unavailable");
      const tick = (_, info) => {
        if (watching !== generation) return;
        const delivered = clock();
        // Some WKWebView versions report compositor times on a different
        // epoch. Their deltas remain usable, but subtracting input time is not.
        const aligned = Number.isFinite(info.expectedDisplayTime) && Math.abs(info.expectedDisplayTime - delivered) < 1000;
        samples.push({ media: info.mediaTime, display: info.expectedDisplayTime, submitted: info.presentationTime,
          delivered, wall: aligned ? info.expectedDisplayTime : delivered, aligned,
          count: info.presentedFrames, width: info.width, height: info.height, generation });
        callback = el.requestVideoFrameCallback(tick);
      };
      callback = el.requestVideoFrameCallback(tick);
    }
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(monitor(), { childList: true, subtree: true });
    return { samples, currentVideo(sample) { return sample.generation === generation && el === video() ? el : undefined; },
      stop() { observer.disconnect(); el?.cancelVideoFrameCallback(callback); } };
  }
  function quality(el) {
    const q = el?.getVideoPlaybackQuality?.();
    return q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null;
  }
  async function pointer(track, type, x, held, nativePointer) {
    const bounds = track.getBoundingClientRect();
    const y = bounds.top + bounds.height / 2;
    if (nativePointer) {
      let heard, timer;
      const received = new Promise((resolve, reject) => {
        heard = e => {
          if (e.isTrusted) resolve({ x: e.clientX, at: clock(), trusted: true });
        };
        timer = setTimeout(() => reject(Error("Native slider did not receive trusted " + type)), 1800);
        track.addEventListener(type, heard, true);
      });
      try {
        const [event] = await Promise.all([received, nativePointer.postMessage({type, x, y})]);
        return event;
      } finally {
        clearTimeout(timer);
        track.removeEventListener(type, heard, true);
      }
    }
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 17, pointerType: "mouse", isPrimary: true,
      clientX: x, clientY: y, button: 0, buttons: held ? 1 : 0 });
    // A synthetic DOM pointer has no OS-level capture. All subsequent events
    // are already delivered directly to this exact slider in the private window.
    const capture = Object.getOwnPropertyDescriptor(track, "setPointerCapture");
    if (type === "pointerdown") Object.defineProperty(track, "setPointerCapture", { configurable: true, value() {} });
    const at = clock();
    try { track.dispatchEvent(event); }
    finally {
      if (type === "pointerdown") {
        if (capture) Object.defineProperty(track, "setPointerCapture", capture);
        else delete track.setPointerCapture;
      }
    }
    return { x: event.clientX, at, trusted: false };
  }
  async function scrubTo(track, time, nativePointer) {
    const rect = track.getBoundingClientRect();
    const start = Number(track.getAttribute("aria-valuemin")), end = Number(track.getAttribute("aria-valuemax"));
    if (!(rect.width > 0 && time >= start && time < end)) throw Error("Target is outside the timeline");
    const x = t => rect.left + (t - start) * rect.width / (end - start);
    const down = await pointer(track, "pointerdown", x(Math.max(start, time - 1.8)), true, nativePointer);
    await sleep(18);
    await pointer(track, "pointermove", x(Math.max(start, time - 0.8)), true, nativePointer);
    await sleep(18);
    const up = await pointer(track, "pointerup", x(time), false, nativePointer);
    return { input: up.at, down: down.at, trusted: up.trusted, target: start + (up.x - rect.left) / rect.width * (end - start) };
  }
  function resourceTimings(start, stop) {
    const groups = {};
    for (const e of performance.getEntriesByType("resource")) {
      if (e.startTime < start - 50 || !e.responseEnd || e.responseEnd > stop) continue;
      const url = new URL(e.name), path = url.pathname;
      const kind = path.endsWith("/frame") ? (url.searchParams.get("view") === "monitor" ? "monitorStill" : "thumbnail") :
        /playback|fragment/.test(path) ? "playback" : null;
      if (!kind) continue;
      (groups[kind] ??= []).push({ startMs:Math.round(e.startTime-start), durationMs:Math.round(e.duration) });
    }
    return groups;
  }
  async function scrub(track, requested, fps, timeoutMs, nativePointer) {
    const observation = observeFrames();
    let paint, stillSeen, stillTime, stillRegistered, stillLoaded;
    try {
      // Aim inside a frame. Native media timescales may round a boundary seek
      // down by a fraction of a millisecond and correctly show its predecessor.
      const aim = (Math.floor(requested * fps + 1e-7) + 0.35) / fps;
      const { input, down, trusted, target } = await scrubTo(track, aim, nativePointer);
      const frame = Math.floor(target * fps + 1e-7);
      const checkPaint = () => {
        const img = selectedStill();
        if (img && Number(new URL(img.src).searchParams.get("frame")) === frame) {
          stillRegistered ??= clock()-input;
          if (visibleStill(img)) stillLoaded ??= clock()-input;
        }
        const match = visibleStill(img) && Number(new URL(img.currentSrc || img.src).searchParams.get("frame")) === frame;
        // A decoded image visible across consecutive animation callbacks is
        // a renderer paint estimate. Native window pixels are sampled separately.
        if (match && img === stillSeen) { stillTime = clock(); return; }
        stillSeen = match ? img : undefined;
        paint = requestAnimationFrame(checkPaint);
      };
      paint = requestAnimationFrame(checkPaint);
      let picture;
      const end = input + timeoutMs;
      while (clock() < end) {
        const candidate = seekPresentation(observation, frame, fps, down, input);
        const img = selectedStill();
        if (candidate && (!visibleStill(img) || Number(new URL(img.src).searchParams.get("frame")) === frame)) picture = candidate;
        if (picture || stillTime) break;
        await sleep(4);
      }
      const done = Math.min(picture?.at ?? Infinity, stillTime ?? Infinity);
      const el = video();
      const nearest = observation.samples.filter(s=>s.delivered>=input).sort((a,b)=>Math.abs(a.media-target)-Math.abs(b.media-target))[0];
      const img = selectedStill();
      return { requested, target, frame, trusted, wallStart: input, wallEnd: clock(), sliderTime: Number(track.getAttribute("aria-valuenow")),
        latencyMs: Number.isFinite(done) ? Math.max(0, done - input) : null,
        timedOut: !Number.isFinite(done), timeoutMs, endpoint: !Number.isFinite(done) ? null :
          done === picture?.at ? picture.endpoint : "stillPaintEstimate",
        inputMs: input-down, videoWidth: el?.videoWidth, readyState: el?.readyState, stillRegisteredMs:stillRegistered,
        stillLoadedMs:stillLoaded, videoTime:el?.currentTime, observed:observation.samples.length,
        nearestPTS:nearest?.media, nearestFrameOffset:nearest ? nearest.media*fps-frame : null,
        stillFrame:img ? new URL(img.src).searchParams.get("frame") : null, stillOpacity:img ? getComputedStyle(img).opacity : null,
        targetBuffered: el ? Array.from({length:el.buffered.length},(_,i)=>[el.buffered.start(i),el.buffered.end(i)]).some(([a,b])=>target>=a && target<b) : false,
        source: el?.currentSrc?.startsWith("blob:") ? "segments" : el?.currentSrc ? "file" : "poster",
        resources: resourceTimings(down, clock()) };
    } finally { cancelAnimationFrame(paint); observation.stop(); }
  }
  function crossing(samples, cut, fps) {
    const boundary = samples.findIndex(s => s.media >= cut - 0.12/fps);
    const prev = samples[boundary-1], next = samples[boundary];
    const consecutive = !!(prev && next && next.count === prev.count+1 && next.generation === prev.generation);
    const gapMs = consecutive ? next.display-prev.display : null;
    return { cut, crossed:!!(prev && next), consecutive, gapMs,
      excessMs:gapMs === null ? null : Math.max(0,gapMs-1000/fps), preCutFrame:prev?.media, postCutFrame:next?.media };
  }
  async function playWindow(track, cut, lead, tail, fps, timeoutMs, nativePointer, timelineCuts = []) {
    // Native pointer coordinates can round to CSS pixels on long, zoomed-out
    // timelines. Prime far enough before the join to observe both sides.
    const secondsPerPixel = Number(track.getAttribute("aria-valuemax")) / track.getBoundingClientRect().width;
    const start = Math.max(0, cut - Math.max(lead, secondsPerPixel + 0.2)), end = cut + tail;
    const primer = await scrub(track, start, fps, timeoutMs, nativePointer);
    const frames = observeFrames(), el = video(), before = quality(el), source = el.currentSrc, waits = [];
    const stalled = e => waits.push({ event: e.type, wall: clock(), media: el.currentTime });
    for (const name of ["waiting", "stalled", "playing"]) el.addEventListener(name, stalled);
    const begun = clock();
    try {
      if (el.paused) transport().click();
      const limit = begun + (end - start) * 1000 + timeoutMs;
      while (clock() < limit && !(frames.samples.at(-1)?.media >= end)) await sleep(15);
      const played = frames.samples.filter(s => s.delivered >= begun && s.media >= start - 1 / fps && s.media <= end + 0.3);
      const boundary = crossing(played,cut,fps);
      const actualCuts = timelineCuts.filter(t => t > start && t < end).map(t=>crossing(played,t,fps));
      const after = quality(el), sameSource = video() === el && source === el.currentSrc && after && before && after.total >= before.total && after.dropped >= before.dropped;
      const total = sameSource ? after.total-before.total : null, dropped = sameSource ? after.dropped-before.dropped : null;
      const gaps = played.slice(1).flatMap((s,i) => s.generation === played[i].generation && s.count === played[i].count + 1 ? [s.display - played[i].display] : []);
      const finished = (played.at(-1)?.media ?? 0) >= end - 1/fps;
      const wallEnd = clock();
      const last = played.at(-1);
      return { ...boundary, actualCuts, start: primer.target, wallStart: begun, wallEnd, primerInput: primer.wallStart,
        primerResultEnd: primer.wallEnd, primerMs: primer.latencyMs,
        primerTimedOut: primer.timedOut, observedFrames: played.length, total, dropped,
        trailingGapLowerMs: !finished && last && !el.ended ? Math.max(0,wallEnd-last.wall-1000/fps) : null,
        firstPlaybackFrameMs: played.length ? played[0].wall-begun : null, worstFrameGapMs: gaps.length ? Math.max(...gaps) : null,
        finished, waits: waits.map(w => ({...w,wall:w.wall-begun})) };
    } finally {
      el.pause(); for (const name of ["waiting", "stalled", "playing"]) el.removeEventListener(name, stalled);
      frames.stop();
    }
  }
  async function run(config) {
    if (!window.__TAURI_INTERNALS__) throw Error("Use a native Scarlet benchmark window");
    const { fps, scrubTimes = [], cutTimes = [], timeoutMs = 7000, cacheMediaIds = [], projectId } = config;
    if (!(fps > 0 && fps < 241) || ![...scrubTimes,...cutTimes].every(t => Number.isFinite(t) && t >= 0)) throw Error("Invalid benchmark coordinates");
    if (projectId && !location.pathname.includes("/p/" + projectId)) {
      const link = await until(() => [...document.querySelectorAll("a[href]")].find(a => new URL(a.href).pathname === "/p/" + projectId), 20000, "Project link unavailable");
      link.click();
    }
    const track = await until(() => slider() && monitor() && video() && Number(slider().getAttribute("aria-valuemax")) > 0 && slider(), 25000, "No native timeline monitor");
    const engine = await window.__TAURI_INTERNALS__.invoke("engine_status");
    if (!engine.url || !engine.token) throw Error("Isolated engine is unavailable");
    if (config.expectedDataDir && engine.dataDir !== config.expectedDataDir) throw Error("Wrong engine data directory");
    const headers = { Authorization: "Bearer " + engine.token };
    async function cacheSnapshot() {
      return Promise.all(cacheMediaIds.map(async id => {
        const r = await fetch(engine.url + "/api/media/" + encodeURIComponent(id) + "/playback-cache", { headers });
        if (!r.ok) throw Error("Cache verification failed: " + r.status);
        const c = await r.json(); return { state:c.state, progress:c.progress ?? null };
      }));
    }
    const nativePointer = config.nativePointer === false ? undefined : window.webkit?.messageHandlers?.scarletBenchPointer ?? window.scarletBenchPointer;
    const rect = monitor().getBoundingClientRect();
    const result = { fps, timeOrigin:performance.timeOrigin ?? Date.now()-clock(), monitorRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      pictureAspect:config.pictureAspect ?? Number(config.width || 16)/Number(config.height || 9),
      pointerInput: nativePointer ? "native" : "DOM", hidden: document.hidden, focused: document.hasFocus(),
      animationIntervalsMs: await displayCadence(), viewport: [innerWidth,innerHeight], userAgent: navigator.userAgent,
      timelineCuts:config.timelineCuts ?? cutTimes, scrub: [], cuts: [], cacheSamples: [], sustained: [] };
    window.scarletPlaybackBench.partial = result;
    const sampleCache = async stage => { result.cacheSamples.push({ stage, time: clock(), sources: await cacheSnapshot() }); };
    try {
      performance.setResourceTimingBufferSize(2048);
      await sampleCache("start");
      for (const [i, t] of scrubTimes.entries()) {
        if (i && i % 10 === 0) await sampleCache("scrub-" + i);
        result.scrub.push(await scrub(track,t,fps,timeoutMs,nativePointer));
        window.scarletPlaybackBench.progress = { phase: "scrub", count: i+1, last: result.scrub.at(-1) };
      }
      for (const [i,t] of cutTimes.entries()) {
        await sampleCache("cut-" + i);
        result.cuts.push(await playWindow(track,t,config.cutLeadSeconds ?? 0.8,config.cutTailSeconds ?? 0.55,fps,timeoutMs,nativePointer,config.timelineCuts));
        window.scarletPlaybackBench.progress = { phase: "cuts", count: i+1, last: result.cuts.at(-1) };
      }
      for (const [i, w] of (config.playWindows ?? []).entries()) {
        await sampleCache("play-" + i);
        result.sustained.push(await playWindow(track, w.start+0.5, 0.5, w.seconds-0.5, fps, timeoutMs,nativePointer,config.timelineCuts));
      }
      await sampleCache("end");
      return result;
    } finally { video()?.pause(); }
  }
  window.scarletPlaybackBench = { run };
})();
