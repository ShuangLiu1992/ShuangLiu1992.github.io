// CalibLive's feeder (calibrate.html): the rear camera, pushed into the wasm through
// CalibLiveWeb.cc's C API (cl_create, cl_frame_buffer, cl_push_frame), and the hand-off after a
// solve: an accepted one is written to the cookie (calib_cookie.js) and VioLive opens 3 s later
// unless Redo was pressed; a rejected one is dropped (cl_drop_and_resume) and capturing goes on.
// Everything drawn is the wasm's (CalibLiveApp.cc); this file draws nothing.
//
// window.calibFeed: ready(Module) -- from main(); start() / stop() / restart() / forget() -- from
// the bar; status -- one line, shown on the bar; saved -- the Stats line about the cookie;
// countdown -- seconds until VioLive opens (0 when not counting); device {id, label}.
// &camera_size=WxH asks for another stream size (e.g. 480x640, the portrait stream a phone gives);
// the jump to VioLive carries it, and &stats=, through unchanged.
// The camera is watched: a track that ends, or no frame for 3 s while the page is visible, stops it
// for real and shows Retry; coming back to the page restarts it by itself. The screen stays on
// (wake lock) while the camera runs.
'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const JUMP_MS = 3000;
  const STALL_MS = 3000;   // no frame for this long, page visible: the camera is stuck
  const FIRST_FRAME_MS = 10000;   // a cold camera (iOS: play(), exposure) can take seconds to start
  const DENIED = 'Camera not available: allow camera access, then press Retry';
  let M = null, stopFn = null, created = false, pollTimer = null, jumpTimer = null, jumpAt = 0;
  let cookieSeq = 0, dropSeq = 0, startToken = 0;
  let needRestart = false;   // the camera ended or stalled (not stopped by the user): restart when the page is visible again
  let lastFrameAt = 0, gotFrame = false, wake = null, wakeWanted = false, wakePending = false;
  const feed = window.calibFeed = Object.assign(window.calibFeed || {}, {
    status: 'loading…', saved: '', countdown: 0, device: { id: '', label: '' }, autostart: false,
  });

  const [camW, camH] = (params.get('camera_size') || '640x480').split('x').map(Number);

  const state = () => JSON.parse(M.UTF8ToString(M._cl_state()));

  function today() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function describeSaved() {
    const r = window.visCalib ? window.visCalib.read() : { ok: false, why: 'none' };
    feed.saved = r.ok ? `saved calibration: ${r.rec.date}, ${Number(r.rec.rms_px).toFixed(2)} px, ${r.rec.views} views`
                      : (r.why === 'unreadable' ? 'saved calibration: unreadable' : 'saved calibration: none');
  }

  function cancelJump() {
    if (jumpTimer) clearTimeout(jumpTimer);
    jumpTimer = null; jumpAt = 0; feed.countdown = 0;
  }

  // The hand-off, run on a timer: a finished solve is either saved and counted down to VioLive,
  // or dropped so capturing resumes.
  function poll() {
    if (!M || !created) return;
    const s = state();
    if (jumpAt) feed.countdown = Math.max(0, Math.ceil((jumpAt - performance.now()) / 1000));
    if (!s.result || s.solve_seq === 0) return;
    if (s.phase === 'done' && s.result.accepted && cookieSeq !== s.solve_seq) {
      cookieSeq = s.solve_seq;
      window.visCalib.write({
        v: 1, camera: s.result.camera, rms_px: s.result.rms_px, views: s.result.views,
        date: today(), ua: navigator.userAgent.trim().slice(0, 200), device_id: feed.device.id, label: feed.device.label,
      });
      describeSaved();
      cancelJump();
      jumpAt = performance.now() + JUMP_MS;
      feed.countdown = Math.ceil(JUMP_MS / 1000);
      jumpTimer = setTimeout(() => {
        // camera_size goes along only if this page was given one, verbatim: VioLive then asks the
        // camera for the same stream CalibLive did. stats= is carried over too.
        const q = new URLSearchParams();
        for (const k of ['camera_size', 'stats']) if (params.get(k) !== null) q.set(k, params.get(k));
        location.replace('../VioLive/gpu.html' + (q.toString() ? '?' + q : ''));
      }, JUMP_MS);
    } else if (s.phase === 'rejected' && dropSeq !== s.solve_seq) {
      dropSeq = s.solve_seq;
      M._cl_drop_and_resume();
    }
  }

  function create(w, h) {
    if (M._cl_create(w, h) !== 0) throw new Error(M.UTF8ToString(M._cl_error()));
    created = true; cookieSeq = 0; dropSeq = 0;
  }
  // The buffer is taken from HEAPU8 only after _cl_frame_buffer: its resize can grow the memory,
  // which detaches the old ArrayBuffer.
  function frameBuffer(bytes) { const ptr = M._cl_frame_buffer(bytes); return new Uint8Array(M.HEAPU8.buffer, ptr, bytes); }
  function pushFrame(t, w, h) {
    lastFrameAt = performance.now();
    gotFrame = true;
    if (!created) create(w, h);   // the first frame's shape; the wasm moves it while no view is kept
    if (M._cl_push_frame(t, w, h, 4) !== 0) throw new Error(M.UTF8ToString(M._cl_error()));
  }

  // Calibration takes a minute without a touch: keep the screen on while the camera runs. Any
  // failure (no API, refused, page hidden) is ignored; the lock is dropped when the page hides, so
  // coming back asks again.
  async function acquireWake() {
    if (!wakeWanted || wake || wakePending || !navigator.wakeLock) return;
    wakePending = true;   // camera start and a quick visibilitychange must not both take a lock
    try {
      const w = await navigator.wakeLock.request('screen');
      if (!wakeWanted) { w.release().catch(() => {}); return; }
      wake = w;
      w.addEventListener('release', () => { if (wake === w) wake = null; });
    } catch (e) { /* ignored */ } finally { wakePending = false; }
  }
  function releaseWake() {
    wakeWanted = false;
    const w = wake;
    wake = null;
    try { if (w) w.release().catch(() => {}); } catch (e) { /* ignored */ }
  }

  async function startLive(token) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: camW }, height: { ideal: camH }, frameRate: { ideal: 30 } } });
    if (token !== startToken) { stream.getTracks().forEach((t) => t.stop()); return () => {}; }
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    feed.device = { id: settings.deviceId || '', label: track.label || '' };
    let alive = true, video = null;
    // A failing frame, an ended track or a stall stops the camera for real, so the bar's Retry
    // (start()) can run again.
    const fail = (e) => {
      console.error(e);
      if (token !== startToken) return;
      startToken++;
      const stop = stopFn;
      stopFn = null;
      if (stop) stop();
      feed.status = 'The camera stopped sending pictures: press Retry';
    };
    // Another app took the camera, the phone locked, the page was backgrounded: the track ends
    // (or just stops delivering). Both end here; coming back to the page restarts the camera.
    const lost = (e) => { needRestart = true; fail(e); };
    const onEnded = () => lost(new Error('camera track ended'));
    track.addEventListener('ended', onEnded);
    lastFrameAt = performance.now();
    gotFrame = false;
    const stallTimer = setInterval(() => {
      const limit = gotFrame ? STALL_MS : FIRST_FRAME_MS;
      if (alive && document.visibilityState === 'visible' && performance.now() - lastFrameAt > limit)
        lost(new Error('no camera frame for ' + limit / 1000 + ' s'));
    }, 500);
    wakeWanted = true;
    acquireWake();
    if (typeof MediaStreamTrackProcessor !== 'undefined' && params.get('camera') !== 'canvas') {
      const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
      (async () => {
        while (alive) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) { if (alive) lost(new Error('camera stream closed')); break; }
          try {
            const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
            await frame.copyTo(frameBuffer(vr.width * vr.height * 4), { rect: vr, format: 'RGBA' });
            pushFrame(frame.timestamp * 1e-6, vr.width, vr.height);
          } catch (e) { fail(e); }
          frame.close();
        }
      })();
    } else {
      // Safari has no MediaStreamTrackProcessor on the main thread: play the stream in a <video>
      // behind the canvas and read each presented frame back through a 2D canvas.
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
            pushFrame(meta && meta.captureTime ? meta.captureTime / 1000 : now / 1000, w, h);
          } catch (e) { fail(e); }
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    return () => {
      alive = false;
      clearInterval(stallTimer);
      track.removeEventListener('ended', onEnded);
      releaseWake();
      track.stop();
      if (video) video.remove();
    };
  }

  feed.ready = (mod) => {
    M = mod;
    feed.status = self.crossOriginIsolated ? 'Starting the camera…' : 'Reload this page to continue';
    describeSaved();
    pollTimer = setInterval(() => { try { poll(); } catch (e) { console.error(e); } }, 200);
    if (feed.autostart) feed.start();
  };
  feed.start = async () => {
    if (!M || stopFn) return;
    const token = ++startToken;
    needRestart = false;
    feed.status = 'Starting the camera…';
    try {
      const stop = await startLive(token);
      if (token !== startToken) { stop(); return; }   // stopped, or a frame failed, while starting
      stopFn = stop;
      if (feed.status === 'Starting the camera…') feed.status = 'Camera on';
    } catch (e) {
      stopFn = null;
      feed.status = DENIED;
      console.error(e);
    }
  };
  feed.stop = () => {
    startToken++;
    needRestart = false;
    if (stopFn) stopFn();
    stopFn = null;
    cancelJump();
  };
  // Redo / Restart: back to the first view; the saved calibration stays until a new solve replaces it.
  feed.restart = () => {
    cancelJump();
    if (M && created) M._cl_reset();
  };
  // Back on the page: the wake lock was dropped when it hid, and a camera that ended meanwhile
  // restarts by itself (the kept views stay: the session is not reset).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    lastFrameAt = performance.now();
    if (stopFn) { wakeWanted = true; acquireWake(); }
    if (needRestart && !stopFn) feed.start();
  });
  feed.forget = () => { window.visCalib.forget(); describeSaved(); };
  // For tests: the session's cached state.
  window.__calibState = () => (M && created ? state() : null);
  // For tests: one blank w x h frame, as a camera that starts in another orientation delivers.
  window.__calibPushBlank = (w, h) => { frameBuffer(w * h * 4).fill(100); pushFrame(performance.now() / 1000, w, h); };
})();
