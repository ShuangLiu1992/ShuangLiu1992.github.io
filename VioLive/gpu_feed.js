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
'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  let M = null, stopFn = null, frameW = 0, cfgBase = null, imuCount = 0, frameCount = 0;
  const feed = window.violiveFeed = { status: 'loading…' };

  function create(w, h) {
    const cfg = Object.assign({}, cfgBase, { camera_wh: [w, h], accel_sign: isSafari || params.get('replay') ? -1 : 1 });
    if (params.get('fast')) cfg.threaded = false;
    if (params.get('config')) Object.assign(cfg, JSON.parse(params.get('config')));
    if (M.ccall('vl_create', 'number', ['string'], [JSON.stringify(cfg)]) !== 0)
      throw new Error(M.UTF8ToString(M._vl_error()));
    console.log('[violive] resolved', JSON.parse(M.UTF8ToString(M._vl_resolved())));
    frameW = w;
  }
  function pushMotion(t, a, g) { M._vl_push_motion(t, a[0], a[1], a[2], g[0], g[1], g[2]); imuCount++; }
  function frameBuffer(bytes) { const ptr = M._vl_frame_buffer(bytes, 1, 1); return new Uint8Array(M.HEAPU8.buffer, ptr, bytes); }
  function pushFrame(t, w, h, channels) {
    if (!frameW) create(w, h);
    if (M._vl_push_frame(t, w, h, channels) !== 0) throw new Error(M.UTF8ToString(M._vl_error()));
    frameCount++;
  }

  async function startLive() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('motion permission denied');
    }
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity, r = e.rotationRate;
      if (!a || !r || a.x === null || r.alpha === null || !frameW) return;
      const d = Math.PI / 180;
      pushMotion(e.timeStamp / 1000, [a.x, a.y, a.z], [r.alpha * d, r.beta * d, r.gamma * d]);
    };
    window.addEventListener('devicemotion', onMotion);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
    const track = stream.getVideoTracks()[0];
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
            await frame.copyTo(frameBuffer(bytes), { rect: vr, format: 'RGBA' });
            pushFrame(frameTime(frame.timestamp * 1e-6), vr.width, vr.height, 4);
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
            ctx.drawImage(video, 0, 0);
            frameBuffer(w * h * 4).set(ctx.getImageData(0, 0, w, h).data);
            pushFrame(meta && meta.captureTime ? meta.captureTime / 1000 : now / 1000, w, h, 4);
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
    feed.status = `replay: fetching ${meta.frames.length} frames…`;
    const blobs = await Promise.all(meta.frames.map((f) => fetch(dir + '/' + f[1]).then((r) => r.blob())));
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
          const bmp = await createImageBitmap(blobs[fi]);
          ctx.drawImage(bmp, 0, 0); bmp.close();
          if (cover && tf - meta.frames[0][0] >= cover[0] && tf - meta.frames[0][0] < cover[1]) {
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, meta.width, meta.height);
          }
          const img = ctx.getImageData(0, 0, meta.width, meta.height);
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
    try {
      stopFn = params.get('replay') ? await startReplay(params.get('replay')) : await startLive();
    } catch (e) { feed.status = 'could not start: ' + (e.message || e); console.error(e); }
  };
  feed.stop = () => {
    if (stopFn) stopFn();
    stopFn = null;
    if (M) M._vl_destroy();
    feed.status = 'stopped';
  };
  // For tests: the run's counters (the drawn state is the wasm's own).
  window.__violiveFeed = () => ({ frames: frameCount, imu: imuCount, status: feed.status });
})();
