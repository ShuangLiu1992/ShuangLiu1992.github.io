// The AddApp page's feeder (gpu.html): camera + DeviceMotion, or a ?replay=, pushed into the
// wasm through VioLiveWeb.cc's C API -- the same calls app.js makes, so the estimator sees the
// same input on both pages. Everything drawn is the wasm's (VioLiveApp.cc); this file draws
// nothing.
//
// Prototype: startLive / startReplay are copies of app.js's, minus the drawing. Before the
// thin page is retired or kept as a fallback, the two pages should share one feeder module.
//
// window.violiveFeed: ready(Module) -- from main(); start(cfgJson) / stop() -- from the bar's
// Start button (or &autostart, which VioLiveApp.cc handles); status -- one line, shown on the bar.
// ?replay=<dir> &fast=1 &cover=a:b &config=<json> as on the thin page. There is no &preset /
// &online_td / &td_method: the app runs one configuration (VioLiveApp.cc kConfig).
// &record=1: keep everything pushed -- every motion row and every frame (as JPEG), with the times
// the wasm got -- and on Stop download it as one .zip in the replay format (replay.json + frames/),
// so it plays back here with ?replay= unchanged, and Apps/VioLive/replay_to_capture.py turns it
// into a capture for the native tools. The bar shows its progress (feed.rec).
// &trace=1: system tracing (VisLog/Trace.hh) -- every wasm thread's spans (VINS, mapper, reseed,
// main), queue depths and latencies, plus this page's own spans (frame read-back, push, decode),
// main-thread stalls (requestAnimationFrame gaps) and long tasks -- and on Stop download it as
// violive_trace_<time>.vislog, which the VisLog viewer opens (trace panel). Combines with &record=1.
'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  let M = null, stopFn = null, frameW = 0, cfgBase = null, imuCount = 0, frameCount = 0;
  let replaySign = null;   // a recording's own accel_sign (replay.json), else the Safari assumption
  const feed = window.violiveFeed = { status: 'loading…', rec: '' };

  // ---- &trace=1 ----
  const tracing = params.get('trace') === '1';
  let traceOn = false, traceT0 = null;
  const tnow = () => M._vl_trace_now_ms();   // the wasm threads' clock, so the spans line up
  function tspan(name, begin) {
    if (traceOn) M.ccall('vl_trace_span', null, ['string', 'string', 'number', 'number'], ['page', name, begin, tnow()]);
  }
  function tcount(name, v) { if (traceOn) M.ccall('vl_trace_counter', null, ['string', 'number'], [name, v]); }
  function traceStart() {
    if (!tracing) return;
    M._vl_trace_enable(1);
    traceOn = true; traceT0 = new Date();
    // Main-thread stalls: the gap between animation frames (16.7 ms when nothing blocks it).
    let last = null;
    const raf = () => {
      if (!traceOn) return;
      const t = tnow();
      if (last !== null) tcount('page/raf_gap_ms', t - last);
      last = t;
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    if (typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
      const off = tnow() - performance.now();   // longtask entries are on performance.now()'s clock
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (traceOn) M.ccall('vl_trace_span', null, ['string', 'string', 'number', 'number'],
                               ['page long tasks', e.name || 'longtask', e.startTime + off, e.startTime + e.duration + off]);
      });
      po.observe({ entryTypes: ['longtask'] });
      traceStart.po = po;
    }
    feed.rec = (feed.rec ? feed.rec + ' · ' : '') + 'tracing';
  }
  function traceFinish() {
    if (!traceOn) return;
    traceOn = false;
    if (traceStart.po) traceStart.po.disconnect();
    M._vl_trace_enable(0);
    const ptr = M.ccall('vl_trace_export', 'number', ['string'], ['VioLive gpu.html trace: ' + navigator.userAgent]);
    const bytes = new Uint8Array(M.HEAPU8.buffer, ptr, M._vl_trace_size()).slice();
    window.__violiveTrace = bytes;
    const name = 'violive_trace_' + traceT0.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.vislog';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes])), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    feed.rec = `saved ${name} (${(bytes.length / 1e6).toFixed(1)} MB)`;
  }

  // ---- &record=1 ----
  // Frames are encoded one at a time on a queue (createImageBitmap is cheap and keeps the frame;
  // the JPEG encode is the slow part). A queue that falls 60 behind drops the NEWEST frames from
  // the recording (counted), never from what the estimator gets.
  const recording = params.get('record') === '1';
  let rec = null;
  function recStart(info) {
    rec = { imu: [], frames: [], blobs: [], crcs: [], queue: [], busy: false, dropped: 0, bytes: 0, w: 0, h: 0,
            t0: new Date(), info, canvas: null, ctx: null };
  }
  function recMotion(t, a, g) { if (rec) rec.imu.push([t, a[0], a[1], a[2], g[0], g[1], g[2]]); }
  async function recFrame(t, source, w, h) {
    if (!rec) return;
    if (rec.queue.length > 60) { rec.dropped++; return; }
    rec.w = w; rec.h = h;
    rec.queue.push({ t, bmp: await createImageBitmap(source) });
    if (!rec.busy) recDrain();
  }
  async function recDrain() {
    rec.busy = true;
    while (rec && rec.queue.length) {
      const { t, bmp } = rec.queue.shift();
      if (!rec.canvas) { rec.canvas = new OffscreenCanvas(bmp.width, bmp.height); rec.ctx = rec.canvas.getContext('2d'); }
      rec.ctx.drawImage(bmp, 0, 0); bmp.close();
      const blob = await rec.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      const name = `frames/${String(rec.frames.length).padStart(6, '0')}.jpg`;
      rec.frames.push([t, name]); rec.blobs.push(blob); rec.bytes += blob.size;
      rec.crcs.push(crc32(new Uint8Array(await blob.arrayBuffer())));
      feed.rec = `recording ${rec.frames.length} frames, ${rec.imu.length} imu, ${(rec.bytes / 1e6).toFixed(1)} MB` +
                 (rec.dropped ? `, ${rec.dropped} frames not kept` : '');
    }
    if (rec) rec.busy = false;
  }
  async function recFinish() {
    if (!rec) return;
    const r = rec;
    feed.rec = 'saving the recording…';
    while (r.busy || r.queue.length) await new Promise((res) => setTimeout(res, 50));
    rec = null;
    const meta = { width: r.w, height: r.h, frames: r.frames, imu: r.imu,
                   accel_sign: isSafari ? -1 : 1, source: 'VioLive gpu.html recorder', recorded: r.t0.toISOString(),
                   user_agent: navigator.userAgent, camera: r.info, frames_not_kept: r.dropped };
    const name = 'violive_' + r.t0.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const files = [{ name: name + '/replay.json', blob: new Blob([JSON.stringify(meta)]), crc: null }];
    r.frames.forEach((f, i) => files.push({ name: name + '/' + f[1], blob: r.blobs[i], crc: r.crcs[i] }));
    const zip = await zipStore(files);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(zip), download: name + '.zip' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    feed.rec = `saved ${name}.zip: ${r.frames.length} frames, ${r.imu.length} imu, ${(zip.size / 1e6).toFixed(1)} MB` +
               (r.dropped ? ` (${r.dropped} frames not kept)` : '');
    window.__violiveRecording = { name, frames: r.frames.length, imu: r.imu.length, bytes: zip.size, dropped: r.dropped };
  }
  // CRC-32 (zip's) and a STORE-only zip writer: no compression (JPEGs do not compress), no zip64
  // (a recording stays far below 4 GB).
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zipStore(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), size = f.blob.size;
      const crc = f.crc !== null ? f.crc : crc32(new Uint8Array(await f.blob.arrayBuffer()));
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);   // utf-8 names
      h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
      parts.push(h, name, f.blob);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(c, name);
      off += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, e], { type: 'application/zip' });
  }

  function create(w, h) {
    const sign = replaySign !== null ? replaySign : (isSafari || params.get('replay') ? -1 : 1);
    const cfg = Object.assign({}, cfgBase, { camera_wh: [w, h], accel_sign: sign });
    if (params.get('fast')) cfg.threaded = false;
    if (params.get('config')) Object.assign(cfg, JSON.parse(params.get('config')));
    if (M.ccall('vl_create', 'number', ['string'], [JSON.stringify(cfg)]) !== 0)
      throw new Error(M.UTF8ToString(M._vl_error()));
    console.log('[violive] resolved', JSON.parse(M.UTF8ToString(M._vl_resolved())));
    frameW = w;
  }
  function pushMotion(t, a, g) { M._vl_push_motion(t, a[0], a[1], a[2], g[0], g[1], g[2]); imuCount++; }
  function frameBuffer(bytes) { const ptr = M._vl_frame_buffer(bytes, 1, 1); return new Uint8Array(M.HEAPU8.buffer, ptr, bytes); }
  let lastFrameWall = null;
  function pushFrame(t, w, h, channels) {
    if (!frameW) create(w, h);
    const b = traceOn ? tnow() : 0;
    if (M._vl_push_frame(t, w, h, channels) !== 0) throw new Error(M.UTF8ToString(M._vl_error()));
    frameCount++;
    if (traceOn) {
      tspan('push frame', b);
      if (lastFrameWall !== null) tcount('page/frame_gap_ms', b - lastFrameWall);
      lastFrameWall = b;
    }
  }

  const [camW, camH] = (params.get('camera_size') || '640x480').split('x').map(Number);
  async function startLive() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('motion permission denied');
    }
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity, r = e.rotationRate;
      if (!a || !r || a.x === null || r.alpha === null) return;
      const d = Math.PI / 180, t = e.timeStamp / 1000, acc = [a.x, a.y, a.z], gyr = [r.alpha * d, r.beta * d, r.gamma * d];
      recMotion(t, acc, gyr);   // recorded from the first event, whether or not the estimator runs yet
      if (frameW) pushMotion(t, acc, gyr);
    };
    window.addEventListener('devicemotion', onMotion);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // &camera_size=WxH asks for another size (e.g. 480x640, the portrait stream a phone gives).
      video: { facingMode: { ideal: 'environment' }, width: { ideal: camW }, height: { ideal: camH }, frameRate: { ideal: 30 } } });
    const track = stream.getVideoTracks()[0];
    if (recording) {   // the camera's settings, minus the per-site device identifiers
      const { deviceId, groupId, ...settings } = track.getSettings ? track.getSettings() : {};
      recStart(settings);
    }
    let alive = true, ownClock = null, minDelay = Infinity;
    const frameTime = (tsSec) => {
      const now = performance.now() / 1000;
      if (ownClock === null) ownClock = Math.abs(now - tsSec) > 1.0;
      if (!ownClock) return tsSec;
      minDelay = Math.min(minDelay, now - tsSec);
      return tsSec + minDelay;
    };
    let video = null;
    if (typeof MediaStreamTrackProcessor !== 'undefined' && params.get('camera') !== 'canvas') {
      const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
      (async () => {
        while (alive) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          try {
            // RGBA for the preview: the wasm keeps the colour frame and takes its gray itself.
            const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
            const bytes = vr.width * vr.height * 4;
            const tb = traceOn ? tnow() : 0;
            await frame.copyTo(frameBuffer(bytes), { rect: vr, format: 'RGBA' });
            tspan('copyTo RGBA', tb);
            const tf = frameTime(frame.timestamp * 1e-6);
            if (rec) { const tr = traceOn ? tnow() : 0; await recFrame(tf, frame, vr.width, vr.height); tspan('record frame', tr); }
            pushFrame(tf, vr.width, vr.height, 4);
          } catch (e) { feed.status = 'frame failed: ' + (e.message || e); console.error(e); }
          frame.close();
        }
      })();
      feed.status = 'live (webcodecs)';
    } else {
      // Safari has no MediaStreamTrackProcessor on the main thread: as the thin page does, play
      // the stream in a <video> and read each presented frame back through a canvas
      // (&camera=canvas forces this path elsewhere). The <video> must be in the document and
      // playing for iOS to deliver frames, so it sits full size BEHIND the wasm's canvas.
      video = Object.assign(document.createElement('video'), { playsInline: true, muted: true, autoplay: true });
      video.setAttribute('playsinline', '');
      video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1';
      document.body.prepend(video);
      video.srcObject = stream;
      await video.play().catch(() => {});
      const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
      const onFrame = (now, meta) => {
        if (!alive) return;
        const w = video.videoWidth, h = video.videoHeight;
        if (w && h) {
          try {
            if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
            const tb = traceOn ? tnow() : 0;
            ctx.drawImage(video, 0, 0);
            frameBuffer(w * h * 4).set(ctx.getImageData(0, 0, w, h).data);
            tspan('canvas read-back', tb);
            const tf = meta && meta.captureTime ? meta.captureTime / 1000 : now / 1000;
            if (rec) recFrame(tf, cv, w, h);   // kept even if the estimator refuses it
            pushFrame(tf, w, h, 4);
          } catch (e) { feed.status = 'frame failed: ' + (e.message || e); console.error(e); }
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
      feed.status = 'live (video + canvas)';
    }
    return () => {
      alive = false; window.removeEventListener('devicemotion', onMotion); track.stop();
      if (video) video.remove();
    };
  }

  async function startReplay(dir) {
    const meta = await (await fetch(dir + '/replay.json')).json();
    replaySign = typeof meta.accel_sign === 'number' ? meta.accel_sign : null;
    feed.status = `replay: fetching ${meta.frames.length} frames…`;
    // At most 16 fetches in flight: a minute-long recording is ~1800 frames, and fetching them all
    // at once fails in Chromium (net::ERR_INSUFFICIENT_RESOURCES).
    const blobs = new Array(meta.frames.length);
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < meta.frames.length) {
        const k = next++;
        blobs[k] = await (await fetch(dir + '/' + meta.frames[k][1])).blob();
        if (k % 100 === 0) feed.status = `replay: fetched ${k} / ${meta.frames.length} frames…`;
      }
    }));
    const fast = !!params.get('fast');
    const cover = params.get('cover') && params.get('cover').split(':').map(Number);
    const cv = new OffscreenCanvas(meta.width, meta.height), ctx = cv.getContext('2d', { willReadFrequently: true });
    let alive = true;
    const imu = meta.imu;   // [t, ax, ay, az, gx, gy, gz]: raw accelerationIncludingGravity, rad/s
    const t0 = Math.min(meta.frames[0][0], imu[0][0]), wall0 = performance.now() / 1000;
    let ii = 0;
    feed.status = `replay ${dir}`;
    (async () => {
      try {
        for (let fi = 0; fi < meta.frames.length && alive; fi++) {
          const tf = meta.frames[fi][0];
          const td = traceOn ? tnow() : 0;
          const bmp = await createImageBitmap(blobs[fi]);
          ctx.drawImage(bmp, 0, 0); bmp.close();
          if (cover && tf - meta.frames[0][0] >= cover[0] && tf - meta.frames[0][0] < cover[1]) {
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, meta.width, meta.height);
          }
          const img = ctx.getImageData(0, 0, meta.width, meta.height);
          tspan('decode replay frame', td);
          if (!fast) {
            const wait = wall0 + (tf - t0) - performance.now() / 1000;
            if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
          }
          if (!alive) break;
          if (!frameW) create(meta.width, meta.height);
          while (ii < imu.length && imu[ii][0] <= tf + (fast ? 0 : 0.02)) { const s = imu[ii++]; pushMotion(s[0], [s[1], s[2], s[3]], [s[4], s[5], s[6]]); }
          frameBuffer(meta.width * meta.height * 4).set(img.data);
          pushFrame(tf, meta.width, meta.height, 4);
          if (fast && fi % 10 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        while (alive && ii < imu.length) { const s = imu[ii++]; pushMotion(s[0], [s[1], s[2], s[3]], [s[4], s[5], s[6]]); }
        feed.status = `replay ${dir}: done (${frameCount} frames, ${imuCount} imu)`;
        console.log('[violive] replay done');
      } catch (e) { feed.status = 'replay failed: ' + (e.message || e); console.error(e); }
      window.__violiveReplayDone = true;
    })();
    return () => { alive = false; };
  }

  feed.ready = (mod) => {
    M = mod;
    feed.status = self.crossOriginIsolated ? 'ready — press Start'
                                           : 'not cross-origin isolated: threads unavailable';
  };
  feed.start = async (cfgJson) => {
    if (!M || stopFn) return;
    cfgBase = JSON.parse(cfgJson); frameW = 0; imuCount = 0; frameCount = 0;
    window.__violiveReplayDone = false;
    traceStart();
    try {
      stopFn = params.get('replay') ? await startReplay(params.get('replay')) : await startLive();
    } catch (e) { feed.status = 'could not start: ' + (e.message || e); console.error(e); }
  };
  feed.stop = () => {
    if (stopFn) stopFn();
    stopFn = null;
    if (M) M._vl_destroy();   // joins the VINS and mapper threads, so their last spans are in
    if (M) traceFinish();
    feed.status = 'stopped';
    if (rec) recFinish().catch((e) => { feed.rec = 'saving failed: ' + (e.message || e); console.error(e); });
  };
  // For tests: the run's counters (the drawn state is the wasm's own).
  window.__violiveFeed = () => ({ frames: frameCount, imu: imuCount, status: feed.status });
  // For tests: the anchors, their note and the smoother, as the app holds them (VioLiveApp.cc vla_state).
  window.__violiveAnchors = () => M && JSON.parse(M.UTF8ToString(M._vla_state()));
})();
