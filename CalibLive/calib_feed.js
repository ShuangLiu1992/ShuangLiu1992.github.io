// CalibLive's page glue (calibrate.html). The camera is the wasm's: VisBase's WebSensor, started
// and stopped through CalibLiveCamera.cc's C API (cl_camera_start / cl_camera_stop / cl_camera), with
// its frames going straight into the detection pipeline (LiveFeed). This file owns what is left
// around it: the status line, noticing a camera that ended or stalled, the wake lock, and the
// hand-off after a solve: an accepted one is written to the cookie (calib_cookie.js) and VioLive opens
// 3 s later unless Redo was pressed; a rejected one is dropped (cl_drop_and_resume) and capturing
// goes on. Everything drawn is the wasm's (CalibLiveApp.cc); this file draws nothing.
//
// window.calibFeed: ready(Module) -- from main(); start() / stop() / restart() / forget() -- from
// the bar; status -- one line, shown on the bar; saved -- the Stats line about the cookie;
// countdown -- seconds until VioLive opens (0 when not counting); device {id, label} -- the lens the
// camera opened (the cookie records it).
// &camera_size=WxH asks for another stream size (e.g. 480x640, the portrait stream a phone gives);
// the jump to VioLive carries it, and &stats=, through unchanged.
// &camera=canvas takes the frames through the <video> + canvas readback even where the browser has
// MediaStreamTrackProcessor: the path iOS Safari always takes, so a desktop browser can test it.
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
  let M = null, running = false, opened = false, pollTimer = null, jumpTimer = null, jumpAt = 0;
  let cookieSeq = 0, dropSeq = 0, lastFrames = 0;
  let needRestart = false;   // the camera ended or stalled (not stopped by the user): restart when the page is visible again
  let lastFrameAt = 0, gotFrame = false, wake = null, wakeWanted = false, wakePending = false;
  const feed = window.calibFeed = Object.assign(window.calibFeed || {}, {
    status: 'loading…', saved: '', countdown: 0, device: { id: '', label: '' }, autostart: false,
  });

  const [camW, camH] = (params.get('camera_size') || '640x480').split('x').map(Number);

  const state = () => JSON.parse(M.UTF8ToString(M._cl_state()));
  const camera = () => JSON.parse(M.UTF8ToString(M._cl_camera()));

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
    if (!M) return;
    watchCamera();
    const s = state();
    if (!s.created) return;
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

  // The buffer is taken from HEAPU8 only after _cl_frame_buffer: its resize can grow the memory,
  // which detaches the old ArrayBuffer. (Test hook only: real frames come from WebSensor.)
  function frameBuffer(bytes) { const ptr = M._cl_frame_buffer(bytes); return new Uint8Array(M.HEAPU8.buffer, ptr, bytes); }

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

  // A failing, ended or stalled camera is stopped for real, so the bar's Retry (start()) can run again.
  function fail(e) {
    console.error(e);
    if (!running) return;
    stopCamera();
    feed.status = 'The camera stopped sending pictures: press Retry';
  }
  // Another app took the camera, the phone locked, the page was backgrounded: the track ends (or just
  // stops delivering). Both end here; coming back to the page restarts the camera.
  function lost(e) { needRestart = true; fail(e); }

  function stopCamera() {
    running = false;
    opened = false;
    if (M) M._cl_camera_stop();
    releaseWake();
  }

  // On the poll timer: the camera's state (opened, refused) and its frame count (the stall check).
  function watchCamera() {
    if (!running) return;
    const c = camera();
    if (c.state === 'failed') {
      console.error('camera: ' + c.error);
      stopCamera();
      feed.status = DENIED;
      return;
    }
    if (c.state === 'on' && !opened) {
      opened = true;
      feed.device = { id: c.device_id, label: c.label };
      if (feed.status === 'Starting the camera…') feed.status = 'Camera on';
      lastFrameAt = performance.now();
      wakeWanted = true;
      acquireWake();
    }
    if (!opened) return;   // still asking for permission / opening: no stall clock yet
    if (c.frames !== lastFrames) { lastFrames = c.frames; lastFrameAt = performance.now(); gotFrame = c.frames > 0; }
    const limit = gotFrame ? STALL_MS : FIRST_FRAME_MS;
    if (document.visibilityState === 'visible' && performance.now() - lastFrameAt > limit)
      lost(new Error('no camera frame for ' + limit / 1000 + ' s'));
  }

  feed.ready = (mod) => {
    M = mod;
    // WebSensor forwards its track's 'ended' here.
    M.onWebSensorEnded = () => lost(new Error('camera track ended'));
    feed.status = self.crossOriginIsolated ? 'Starting the camera…' : 'Reload this page to continue';
    describeSaved();
    pollTimer = setInterval(() => { try { poll(); } catch (e) { console.error(e); } }, 200);
    if (feed.autostart) feed.start();
  };
  feed.start = () => {
    if (!M || running) return;
    running = true;
    opened = false;
    needRestart = false;
    gotFrame = false;
    lastFrames = 0;
    feed.status = 'Starting the camera…';
    M._cl_camera_start(camW, camH, params.get('camera') === 'canvas' ? 1 : 0);
  };
  feed.stop = () => {
    needRestart = false;
    stopCamera();
    cancelJump();
  };
  // Redo / Restart: back to the first view; the saved calibration stays until a new solve replaces it.
  feed.restart = () => {
    cancelJump();
    if (M) M._cl_reset();
  };
  // Back on the page: the wake lock was dropped when it hid, and a camera that ended meanwhile
  // restarts by itself (the kept views stay: the session is not reset).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    lastFrameAt = performance.now();
    if (running && opened) { wakeWanted = true; acquireWake(); }
    if (needRestart && !running) feed.start();
  });
  feed.forget = () => { window.visCalib.forget(); describeSaved(); };
  // For tests: the session's cached state (drawn: what the view drew, see cl_state), and the camera's.
  window.__calibState = () => { if (!M) return null; const s = state(); return s.created ? s : null; };
  window.__calibCamera = () => (M ? camera() : null);
  // For tests: one blank w x h frame, as a camera that starts in another orientation delivers.
  window.__calibPushBlank = (w, h) => {
    frameBuffer(w * h * 4).fill(100);
    if (M._cl_push_frame(performance.now() / 1000, w, h, 4) !== 0) throw new Error(M.UTF8ToString(M._cl_error()));
  };
})();
