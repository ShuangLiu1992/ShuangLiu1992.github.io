// VioLive page (app.js; not violive.js, which a case-insensitive disk confuses with Emscripten's VioLive.js): camera + DeviceMotion in, VioLive.wasm (LiveVio behind a C API) estimates, this
// file draws. The camera preview is the <video> element itself; the wasm only ever sees the luma
// plane of each frame, copied straight out of the VideoFrame.
//
// ?replay=<dir>  plays a converted recording (Apps/VioLive/make_replay.py) through the SAME push
//                calls the live sensors use, paced by its own timestamps -- how the page is tested
//                without a phone.  &fast=1 waits for the VIO instead of the clock (every frame).
// ?preset=<name> preselects msckf | msckf_pgo | vins | vins_pgo.   &autostart=1 starts at once.
//
// ANCHORS: tap the preview to drop a 3D anchor (a gravity-aligned 8 cm cube) at the depth of the
// VINS landmarks around the tap, drag one to move it (at its depth), "Clear" removes them all. A
// world-fixed anchor that walks off its spot while you move is drift (a PGO loop closure snaps it
// back). Anchors are drawn at the newest pose PREDICTED to the displayed frame with the gyro, so
// the VIO's processing latency does not read as drift (&predict=0 turns that off). "Smooth"
// (default on, &smooth=0) eases the estimator's corrections instead of jumping them (drawnPose).
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), mapCv = $('map'), statusEl = $('status');
  const glCv = $('gl');
  const goBtn = $('go'), saveBtn = $('save'), clearBtn = $('clear'), presetSel = $('preset'), preview = $('preview');
  const params = new URLSearchParams(location.search);
  if (params.get('preset')) presetSel.value = params.get('preset');
  // The checkbox starts at the preset's own default -- on, "filter", for the MSCKF presets;
  // off for VINS -- and follows the preset until &online_td / &td_method override it. It
  // applies at Start, and unticking it really turns the estimate off.
  const presetTdDefault = () => {
    const msckf = presetSel.value.startsWith('msckf');
    $('onlineTd').checked = msckf;
    $('tdMethod').value = msckf ? 'filter' : 'rotation';
  };
  presetTdDefault();
  presetSel.addEventListener('change', presetTdDefault);
  if (params.get('online_td')) $('onlineTd').checked = params.get('online_td') !== '0';
  if (params.get('td_method')) $('tdMethod').value = params.get('td_method');
  // "filter" is the MSCKF's own t_d error state; VINS has none, so it only applies there.
  const syncTdMethod = () => {
    const msckf = presetSel.value.startsWith('msckf');
    $('tdMethod').querySelector('option[value=filter]').disabled = !msckf;
    if (!msckf) $('tdMethod').value = 'rotation';
    $('tdMethod').style.display = $('onlineTd').checked ? '' : 'none';
  };
  presetSel.addEventListener('change', syncTdMethod);
  $('onlineTd').addEventListener('change', syncTdMethod);
  syncTdMethod();

  let M = null;                 // the wasm module
  let running = false, stopFn = null;
  let raw = [], pgo = [], feats = [], pose = null, posePgo = null, up = [0, 0, 1];
  let stats = {}, frameW = 0, frameH = 0, initialized = false, errText = '';
  let clockNote = '', imuCount = 0, imuT0 = 0, frameCount = 0, frameT0 = 0, resolved = null;
  let landmarks = [], poseT = 0, displayT = 0, gyroBuf = [], anchors = [], anchorEpoch = -1, anchorNote = '';
  let nextAnchorId = 1, vel = [0, 0, 0], timeOffset = 0, hosts = {}, anchorsShown = 0;
  const predictOn = params.get('predict') !== '0';
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const setStatus = (s) => { statusEl.textContent = s; };
  createVioLive({ print: (t) => console.log(t), printErr: (t) => console.warn(t) }).then((mod) => {
    M = mod;
    setStatus(self.crossOriginIsolated ? 'ready — pick a preset and press Start'
                                       : 'not cross-origin isolated: threads unavailable (reloading…)');
    if (params.get('autostart')) start();
  }).catch((e) => setStatus('wasm failed to load: ' + e));

  // ---------------------------------------------------------------------------------- wasm glue
  function create(w, h) {
    const cfg = { preset: presetSel.value, camera_wh: [w, h], accel_sign: isSafari || params.get('replay') ? -1 : 1 };
    if (params.get('fast')) cfg.threaded = false;
    // Online camera-IMU time offset (every preset; Safari's DeviceMotion lag differs per session
    // and drifts), seeded from the preset's fixed one. Sent either way, so an unticked box
    // overrides a preset that estimates by default.
    cfg.time_offset = $('onlineTd').checked ? { estimate: true, method: $('tdMethod').value }
                                            : { estimate: false };
    if (params.get('config')) Object.assign(cfg, JSON.parse(params.get('config')));
    const p = M.stringToNewUTF8(JSON.stringify(cfg));
    const rc = M._vl_create(p);
    M._free(p);
    if (rc !== 0) throw new Error(M.UTF8ToString(M._vl_error()));
    resolved = JSON.parse(M.UTF8ToString(M._vl_resolved()));
    console.log('[violive] resolved', resolved);
    frameW = w; frameH = h;
  }
  function pushMotion(t, a, g) {   // a: accelerationIncludingGravity m/s^2, g: rotationRate rad/s (alpha,beta,gamma)
    M._vl_push_motion(t, a[0], a[1], a[2], g[0], g[1], g[2]);
    // The VIO's IMU frame is diag(1,-1,-1) * the device frame (VioLiveWeb.cc): kept for the
    // anchors' latency prediction.
    gyroBuf.push([t, g[0], -g[1], -g[2]]);
    if (gyroBuf.length > 400) gyroBuf.splice(0, gyroBuf.length - 300);
    if (!imuCount) imuT0 = t;
    imuCount++;
  }
  function frameBuffer(bytes) {    // a view on wasm memory, re-made each call (memory may grow)
    const ptr = M._vl_frame_buffer(bytes, 1, 1);
    return new Uint8Array(M.HEAPU8.buffer, ptr, bytes);
  }
  function pushFrame(t, w, h, channels) {
    if (!frameW) create(w, h);
    if (M._vl_push_frame(t, w, h, channels) !== 0) throw new Error(M.UTF8ToString(M._vl_error()));
    if (!frameCount) frameT0 = t;
    frameCount++;
    displayT = t;
  }

  function poll() {
    if (!M || !frameW) return;
    const ptr = M._vl_snapshot() >> 2, n = M._vl_snapshot_len();
    if (!n) return;
    const f = M.HEAPF32.subarray(ptr, ptr + n);
    initialized = f[0] === 1;
    poseT = f[1];
    pose = f.slice(2, 18); posePgo = f.slice(18, 34);
    const g = [f[34], f[35], f[36]];
    up = [-g[0], -g[1], -g[2]];
    stats = { inN: f[37], done: f[38], dropped: f[39], last: f[40], mean: f[41], p95: f[42],
              nodes: f[43], loops: f[44], revisions: f[45], epochs: f[46],
              overhead: f[54], feed: f[55], feedMax: f[56] };
    const nRaw = f[49], nPgo = f[50], nFeat = f[51], nLm = f[53];
    if (f[52]) errText = M.UTF8ToString(M._vl_error());
    vel = [f[57], f[58], f[59]];
    timeOffset = f[60];
    const nHosts = f[62];
    let o = 63;
    for (let i = 0; i < nRaw; i++, o += 4) raw.push([f[o], f[o + 1], f[o + 2], f[o + 3]]);
    pgo = [];
    for (let i = 0; i < nPgo; i++, o += 4) pgo.push([f[o], f[o + 1], f[o + 2], f[o + 3]]);
    feats = [];
    for (let i = 0; i < nFeat; i++, o += 2) feats.push([f[o], f[o + 1]]);
    landmarks = [];
    for (let i = 0; i < nLm; i++, o += 3) landmarks.push([f[o], f[o + 1], f[o + 2]]);
    hosts = {};
    for (let i = 0; i < nHosts; i++, o += 14)
      hosts[f[o]] = { visible: f[o + 1] === 1, R: [[f[o + 2], f[o + 5], f[o + 8]], [f[o + 3], f[o + 6], f[o + 9]], [f[o + 4], f[o + 7], f[o + 10]]],
                      t: [f[o + 11], f[o + 12], f[o + 13]] };
    // A reset (a covered lens, a tracking failure) starts a new VIO world frame. Anchors are kept:
    // each hides while its host keyframe is in another frame than the drawn one, and shows again
    // once a loop closure attaches the epochs (see "anchors" below).
    const shownNow = anchors.filter(anchorVisible).length;
    if (stats.epochs !== anchorEpoch) {
      const hidden = anchors.length - shownNow;
      if (hidden) anchorNote = resolved && resolved.mapper
        ? `VIO reset: ${hidden} anchor(s) hidden until a loop closure re-finds the map`
        : `VIO reset: ${hidden} anchor(s) hidden (no map without PGO: they cannot come back)`;
      anchorEpoch = stats.epochs;
    } else if (shownNow > anchorsShown) {
      anchorNote = `loop closure re-found the map: ${shownNow - anchorsShown} anchor(s) back`;
    }
    anchorsShown = shownNow;
  }

  // ---- anchors ----
  // An anchor lives in its HOST keyframe's IMU frame (vl_anchor_host: the newest keyframe when it
  // was placed), not at a world point: a PGO revision that corrects that keyframe moves the
  // anchor with it, so it stays where it was against what the camera saw from there. The host's
  // pose comes with every snapshot, in the drawn frame; `visible` false while its epoch is not
  // the drawn frame's (after a reset, until the epochs attach). Without PGO a host is just the
  // pose at placement (a fixed world point, as before).
  function anchorVisible(a) { const h = hosts[a.host]; return !!(h && h.visible); }
  function anchorWorld(a) {   // the anchor in the drawn frame; null while hidden
    const h = hosts[a.host];
    if (!h || !h.visible) return null;
    return [0, 1, 2].map((i) => h.R[i][0] * a.p[0] + h.R[i][1] * a.p[1] + h.R[i][2] * a.p[2] + h.t[i]);
  }
  function setAnchorWorld(a, p) {   // a drawn-frame point into the host's frame: R^T (p - t)
    const h = hosts[a.host], d = [p[0] - h.t[0], p[1] - h.t[1], p[2] - h.t[2]];
    a.p = [0, 1, 2].map((j) => h.R[0][j] * d[0] + h.R[1][j] * d[1] + h.R[2][j] * d[2]);
  }
  function newAnchor(pDrawn) {
    const host = M._vl_anchor_host();
    if (host < 0) return null;
    poll();   // the host's pose is in the snapshot from now on
    if (!hosts[host]) return null;
    const a = { id: nextAnchorId++, host };
    setAnchorWorld(a, pDrawn);
    anchors.push(a);
    anchorsShown++;
    return a;
  }

  // ------------------------------------------------------------------- camera geometry, anchors
  // T: column-major 4x4 world_from_imu; the camera is the IMU (T_imu_cam = identity, OpenCV axes).
  const rotOf = (T) => [[T[0], T[4], T[8]], [T[1], T[5], T[9]], [T[2], T[6], T[10]]];
  const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((c) => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
  function expSO3(w) {
    const th = Math.hypot(w[0], w[1], w[2]);
    const K = [[0, -w[2], w[1]], [w[2], 0, -w[0]], [-w[1], w[0], 0]];
    const a = th < 1e-9 ? 1 : Math.sin(th) / th, b = th < 1e-9 ? 0.5 : (1 - Math.cos(th)) / (th * th);
    const K2 = mul3(K, K);
    return [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? 1 : 0) + a * K[r][c] + b * K2[r][c]));
  }
  // The pose drawn: PGO-corrected when the mapper runs, rotated forward by the gyro from the
  // pose's frame time to the displayed frame's (both on the camera clock; the gyro is on the IMU
  // clock, t_imu = t_cam - imu_time_offset_s), and moved on at the VIO velocity. VINS's solves
  // stall its thread (in the browser the drawn pose is often 0.3-0.6 s old), so both matter.
  // The extrapolation is capped at 0.5 s. With PGO the raw velocity is rotated into the
  // corrected frame (R_pgo R_raw^T).
  // raw = true: the uncorrected VIO pose, the frame the landmarks are in.
  // The gyro rotation (IMU body frame) from camera time a to camera time b.
  function gyroDelta(a, b) {
    let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const off = timeOffset || (resolved && resolved.imu_time_offset_s) || 0;   // the offset in use
    a -= off; b -= off;
    for (let i = 1; i < gyroBuf.length; i++) {
      const lo = Math.max(a, gyroBuf[i - 1][0]), hi = Math.min(b, gyroBuf[i][0]);
      if (hi > lo) { const g = gyroBuf[i], dt = hi - lo; R = mul3(R, expSO3([g[1] * dt, g[2] * dt, g[3] * dt])); }
    }
    return R;
  }
  function viewPose(raw = false) {
    const T = resolved && resolved.mapper && !raw ? posePgo : pose;
    if (!T) return null;
    const R0 = rotOf(T);
    let R = R0, v = vel;
    const tw = [T[12], T[13], T[14]];
    if (T === posePgo && pose) {   // the raw velocity in the corrected frame: R_pgo R_raw^T v
      const Rr = rotOf(pose), w = [0, 1, 2].map((j) => Rr[0][j] * v[0] + Rr[1][j] * v[1] + Rr[2][j] * v[2]);
      v = [0, 1, 2].map((i) => R0[i][0] * w[0] + R0[i][1] * w[1] + R0[i][2] * w[2]);
    }
    if (predictOn && displayT > poseT) {
      const dt = Math.min(0.5, displayT - poseT);
      for (let i = 0; i < 3; i++) tw[i] += v[i] * dt;
      R = mul3(R, gyroDelta(poseT, displayT));
    }
    return { R, R0, t: tw, v };
  }

  // ---- smoothing of the drawn anchors (the Smooth toggle, &smooth=0 to start it off) ----
  // Error-state smoothing: real motion is NOT filtered. It reaches the drawn pose at once through
  // the gyro + velocity prediction above. What is filtered is the CORRECTION: each time a new VIO
  // pose arrives, the previously drawn pose, carried forward by the same gyro + velocity to the
  // new display time, differs from the new pose by what the estimator changed its mind about
  // (keyframe solve, PGO revision, prediction error). That difference is kept as an offset on
  // the new pose and decays to zero, faster while the phone moves (motion hides a correction,
  // and a slow one would read as lag) and when it is large. A correction above 15 cm / 8 deg (a
  // reset, a big loop closure) is not smoothed: it snaps, so a real jump stays visible.
  const smooth = { on: params.get('smooth') !== '0', key: '', R: null, t: null, T: 0, phi: [0, 0, 0], d: [0, 0, 0],
                   lastNow: 0, epoch: -1, snaps: 0, jumps: [] };
  function logSO3(R) {
    const c = Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)), th = Math.acos(c);
    const w = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
    const k = th < 1e-6 ? 0.5 : th / (2 * Math.sin(th));
    return w.map((x) => x * k);
  }
  const tr3 = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]));
  function drawnPose(now) {
    const V = viewPose();
    if (!V) return null;
    const dtNow = smooth.lastNow ? Math.min(0.2, (now - smooth.lastNow) / 1000) : 0;
    smooth.lastNow = now;
    const reset = () => { smooth.phi = [0, 0, 0]; smooth.d = [0, 0, 0]; };
    if (!smooth.R || smooth.epoch !== stats.epochs) {
      reset(); smooth.epoch = stats.epochs;
    } else {
      const key = `${poseT},${displayT},${stats.revisions}`;
      if (key !== smooth.key) {
        // The last drawn pose carried to this display time, vs the new target: the correction.
        const dt = Math.max(0, Math.min(0.5, displayT - smooth.T));
        const Rp = mul3(smooth.R, gyroDelta(smooth.T, displayT));
        const tp = [0, 1, 2].map((i) => smooth.t[i] + V.v[i] * dt);
        const phi = logSO3(mul3(Rp, tr3(V.R))), d = [0, 1, 2].map((i) => tp[i] - V.t[i]);
        // Recorded with smoothing on or off: the jumps an unsmoothed box makes.
        smooth.jumps.push([Math.hypot(...d) * 100, Math.hypot(...phi) * 57.2958]);
        if (smooth.jumps.length > 2000) smooth.jumps.shift();
        if (!smooth.on || Math.hypot(...d) > 0.15 || Math.hypot(...phi) > 0.14) { if (smooth.on) smooth.snaps++; reset(); }
        else { smooth.phi = phi; smooth.d = d; }
      }
      // Decay: tau 0.3 s at rest, down to 0.06 s at 1 rad/s or 0.5 m/s, and quicker for big offsets.
      const g = gyroBuf.length ? gyroBuf[gyroBuf.length - 1] : [0, 0, 0, 0];
      const motion = Math.hypot(g[1], g[2], g[3]) / 1.0 + Math.hypot(...V.v) / 0.5;
      const size = Math.hypot(...smooth.d) / 0.05 + Math.hypot(...smooth.phi) / 0.035;
      const tau = Math.max(0.06, 0.3 / (1 + 4 * motion + size));
      const k = Math.exp(-dtNow / tau);
      smooth.phi = smooth.phi.map((x) => x * k); smooth.d = smooth.d.map((x) => x * k);
    }
    smooth.key = `${poseT},${displayT},${stats.revisions}`;
    smooth.T = displayT;
    const R = mul3(expSO3(smooth.phi), V.R), t = [0, 1, 2].map((i) => V.t[i] + smooth.d[i]);
    smooth.R = R; smooth.t = t;
    return { R, t, v: V.v };
  }
  const cam = () => resolved && resolved.camera;
  function toCam(V, p) {   // world -> camera: R^T (p - t)
    const d = [p[0] - V.t[0], p[1] - V.t[1], p[2] - V.t[2]], R = V.R;
    return [R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2], R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2],
            R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2]];
  }
  // THE LENS MODEL, as the page uses it. RadTan's radial polynomial is only monotone up to some
  // radius: with this calibration (k2 = -0.416) the distorted radius r(1 + k1 r^2 + k2 r^4) peaks
  // at 0.784 (r^2 = 0.83) and then FOLDS BACK, while the image corners sit at 0.88 -- past
  // anything the polynomial produces. Raw, a point just outside the frame mapped back inside it
  // and undistorting a corner diverged to NaN (which also disabled the old clamp). So the model
  // is extended: up to r2max it is RadTan; beyond, the distortion of the r2max point is scaled
  // along the ray (rad and tangential terms frozen), which is continuous and monotone. The
  // shader (u_r2max), projectCam and rayOf all use this same extended model.
  const lensK = () => (cam() && cam().distortion_model === 'RadTan' && cam().distortion) || [0, 0, 0, 0, 0];
  function distortRaw(x, y, k) {
    const r2 = x * x + y * y, rad = 1 + k[0] * r2 + k[1] * r2 * r2 + (k[4] || 0) * r2 * r2 * r2;
    return [x * rad + 2 * k[2] * x * y + k[3] * (r2 + 2 * x * x), y * rad + k[2] * (r2 + 2 * y * y) + 2 * k[3] * x * y];
  }
  let r2maxCache = null;
  function r2max() {   // 95% of the first r^2 where d(r * rad)/dr reaches 0.1 (or 4: no fold)
    if (r2maxCache !== null) return r2maxCache;
    const k = lensK();
    let lim = 4;
    for (let s2 = 0.001; s2 < 4; s2 += 0.001) {
      if (1 + 3 * k[0] * s2 + 5 * k[1] * s2 * s2 + 7 * (k[4] || 0) * s2 * s2 * s2 < 0.1) { lim = s2; break; }
    }
    return (r2maxCache = 0.95 * lim);
  }
  function distort(x, y) {
    const k = lensK(), r2 = x * x + y * y, m = r2max();
    if (r2 <= m) return distortRaw(x, y, k);
    const sc = Math.sqrt(m / r2), d = distortRaw(x * sc, y * sc, k);
    return [d[0] / sc, d[1] / sc];
  }
  function projectCam(pc) {   // camera point -> frame px; null behind the camera
    if (pc[2] < 0.05) return null;
    const c = cam(), [xd, yd] = distort(pc[0] / pc[2], pc[1] / pc[2]);
    return [c.fx * xd + c.cx, c.fy * yd + c.cy];
  }
  function rayOf(u, v) {      // frame px -> normalised undistorted (x, y, 1), on the extended model
    const c = cam(), xd = (u - c.cx) / c.fx, yd = (v - c.cy) / c.fy, rd = Math.hypot(xd, yd);
    if (rd < 1e-12) return [0, 0, 1];
    // Radial part by bisection (monotone by construction), then a few fixed-point steps for the
    // tangential terms, from that start.
    let lo = 0, hi = 20;
    for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi), q = distort(xd / rd * mid, yd / rd * mid); (Math.hypot(q[0], q[1]) < rd ? (lo = mid) : (hi = mid)); }
    let x = xd / rd * lo, y = yd / rd * lo;
    for (let i = 0; i < 5; i++) { const [dx, dy] = distort(x, y); x += xd - dx; y += yd - dy; }
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y, 1] : [xd / rd * lo, yd / rd * lo, 1];
  }
  function camToWorld(V, pc) {
    const R = V.R;
    return [0, 1, 2].map((r) => R[r][0] * pc[0] + R[r][1] * pc[1] + R[r][2] * pc[2] + V.t[r]);
  }
  function median(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; }
  // Depth for a tap: the median camera depth of the landmarks within 40 px of it; else of all the
  // landmarks in view; else 1 m (MSCKF keeps no landmarks: its anchors' depth is a guess).
  // V is the RAW pose: the landmarks are VIO-world points, not PGO-corrected ones.
  function tapDepth(V, u, v) {
    const near = [], all = [];
    for (const p of landmarks) {
      const pc = toCam(V, p), q = projectCam(pc);
      if (!q || q[0] < 0 || q[1] < 0 || q[0] > frameW || q[1] > frameH) continue;
      all.push(pc[2]);
      if (Math.hypot(q[0] - u, q[1] - v) < 40) near.push(pc[2]);
    }
    if (near.length >= 3) return { z: median(near), src: `${near.length} landmarks` };
    if (all.length >= 3) return { z: median(all), src: 'median of view' };
    return { z: 1.0, src: 'no landmarks: 1 m guess' };
  }
  function placeAnchor(u, v) {
    const V = viewPose();
    if (!V || !initialized || !cam()) { anchorNote = 'not tracking yet: move the phone sideways first'; return null; }
    const d = tapDepth(viewPose(true), u, v), r = rayOf(u, v);
    const a = newAnchor(camToWorld(V, [r[0] * d.z, r[1] * d.z, d.z]));
    if (!a) { anchorNote = 'no keyframe yet: move the phone a little'; return null; }
    anchorNote = `anchor ${a.id} at ${d.z.toFixed(2)} m (${d.src}), on keyframe ${a.host}`;
    return a;
  }
  // Frame px <-> overlay canvas px (the preview letterboxes the frame: object-fit contain).
  function frameXform() {
    const vw = (preview.style.display !== 'none' && preview.width) || video.videoWidth || frameW;
    const vh = (preview.style.display !== 'none' && preview.height) || video.videoHeight || frameH;
    const s = Math.min(overlay.width / vw, overlay.height / vh);
    return { k: (vw / frameW) * s, ox: (overlay.width - vw * s) / 2, oy: (overlay.height - vh * s) / 2 };
  }
  function cubeEdges(center) {   // 8 cm, one face level with the floor (axes from gravity)
    const n = Math.hypot(...up) || 1, z = up.map((c) => c / n);
    const ref = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let x = [ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]];
    const xn = Math.hypot(...x); x = x.map((c) => c / xn);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const h = 0.04, P = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
      P.push([0, 1, 2].map((i) => center[i] + h * (sx * x[i] + sy * y[i] + sz * z[i])));
    const E = [];
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const d = i ^ j; if (d === 1 || d === 2 || d === 4) E.push([P[i], P[j], d === 1]); }
    return E;   // [a, b, vertical]
  }
  const anchorColors = ['#ff4fd8', '#4fc3ff', '#ffe14f', '#7dff4f', '#ff8a4f'];

  // ---- WebGL cubes ----
  // The vertex shader does the camera model per vertex and outputs CLIP coordinates with w = the
  // camera depth, so the GPU clips at the near plane: a cube partly behind the camera is cut
  // there instead of being projected through it. Edges and faces are subdivided (the lens
  // distortion bends straight edges), and the distortion's radius is clamped to the image's own
  // field of view, beyond which RadTan folds back.
  const GL = { gl: null, prog: null, lines: null, tris: null, nLines: 0, nTris: 0, failed: false };
  function initGL() {
    if (GL.gl || GL.failed) return GL.gl;
    const gl = glCv.getContext('webgl', { premultipliedAlpha: false, antialias: true, alpha: true });
    if (!gl) { GL.failed = true; console.warn('[violive] no WebGL: 2D cubes'); return null; }
    const vs = `
      attribute vec3 a_local; attribute float a_shade;
      uniform vec3 u_center; uniform mat3 u_basis;          // world = center + basis * local
      uniform mat3 u_Rt; uniform vec3 u_t;                  // camera = Rt * (world - t)
      uniform vec4 u_K; uniform vec4 u_d; uniform float u_k3; uniform float u_r2max; uniform vec2 u_size;
      uniform vec2 u_off;                                   // NDC nudge: edges are drawn several times, a few px thick
      varying float v_shade;
      void main() {
        vec3 pc = u_Rt * (u_center + u_basis * a_local - u_t);
        float w = pc.z;
        // Normalised coordinates; for points at or behind the camera use a safe denominator --
        // the clip-space position below is what the clipper uses, and it stays linear in pc.
        vec2 xn = pc.xy / max(abs(w), 1e-3);
        float rr = dot(xn, xn), r2 = min(rr, u_r2max);
        float rad = 1.0 + u_d.x * r2 + u_d.y * r2 * r2 + u_k3 * r2 * r2 * r2;
        // Tangential terms at the CLAMPED radius, as a fraction of the radius, so they scale with
        // (x, y) like the radial one (unclamped they grow as x^2 / w next to the lens).
        vec2 xc = xn * sqrt(r2 / max(rr, 1e-12));
        vec2 tang = vec2(2.0 * u_d.z * xc.x * xc.y + u_d.w * (r2 + 2.0 * xc.x * xc.x),
                         u_d.z * (r2 + 2.0 * xc.y * xc.y) + 2.0 * u_d.w * xc.x * xc.y);
        // Distortion as a scale on (x, y) in clip space: x_clip = A * (x * f) + B * w, linear in
        // the camera point for a fixed f, so the near-plane clip stays where it belongs.
        // tang * w inside the field of view (|pc.xy| / r = w there); beyond it, linear in |pc.xy|.
        vec2 xy = pc.xy * rad + (r2 > 1e-12 ? tang * (length(pc.xy) / sqrt(r2)) : vec2(0.0));
        // pixel u = fx * xd + cx; ndc x = 2u / W - 1, ndc y = 1 - 2v / H  (times w)
        float cx = (2.0 * u_K.x / u_size.x) * xy.x + (2.0 * u_K.z / u_size.x - 1.0) * w;
        float cy = -(2.0 * u_K.y / u_size.y) * xy.y + (1.0 - 2.0 * u_K.w / u_size.y) * w;
        float n = 0.05, f = 50.0;
        gl_Position = vec4(cx + u_off.x * w, cy + u_off.y * w, (w * (f + n) - 2.0 * f * n) / (f - n), w);
        v_shade = a_shade;
      }`;
    const fs = `
      precision mediump float;
      uniform vec4 u_color; varying float v_shade;
      void main() { gl_FragColor = vec4(u_color.rgb * v_shade, u_color.a); }`;
    const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      GL.prog = prog;
    } catch (e) { GL.failed = true; console.error('[violive] shader', e); return null; }
    // Unit cube [-1,1]^3. Lines: 12 edges x 16 segments. Faces: 6 x (8x8) quads, shade per face.
    const L = [], T = [], N = 16, F = 8;
    const corner = (i) => [(i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1];
    for (let i = 0; i < 8; i++) for (const b of [1, 2, 4]) if (!(i & b)) {
      const A = corner(i), B = corner(i | b);
      for (let k = 0; k < N; k++) for (const s of [k / N, (k + 1) / N]) L.push(A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, A[2] + (B[2] - A[2]) * s, 1);
    }
    const faceShade = [0.55, 0.75, 0.65, 0.85, 1.0, 0.45];   // -x +x -y +y +z(top) -z
    let fi = 0;
    for (const axis of [0, 1, 2]) for (const sgn of [-1, 1]) {
      const shade = faceShade[axis === 2 ? (sgn > 0 ? 4 : 5) : axis * 2 + (sgn > 0 ? 1 : 0)];
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      for (let a = 0; a < F; a++) for (let b = 0; b < F; b++) {
        const q = (i, j) => { const p = [0, 0, 0]; p[axis] = sgn; p[u] = -1 + 2 * i / F; p[v] = -1 + 2 * j / F; return [...p, shade]; };
        T.push(...q(a, b), ...q(a + 1, b), ...q(a + 1, b + 1), ...q(a, b), ...q(a + 1, b + 1), ...q(a, b + 1));
      }
      fi++;
    }
    const buf = (arr) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); return b; };
    GL.lines = buf(L); GL.nLines = L.length / 4; GL.tris = buf(T); GL.nTris = T.length / 4;
    GL.gl = gl;
    return gl;
  }
  const hexRGB = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  function cubeBasis() {   // gravity-aligned axes, scaled to the 8 cm cube's half size (column-major mat3)
    const n = Math.hypot(...up) || 1, z = up.map((c) => c / n);
    const ref = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let x = [ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]];
    const xn = Math.hypot(...x); x = x.map((c) => c / xn);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const h = 0.04;
    return new Float32Array([...x.map((c) => c * h), ...y.map((c) => c * h), ...z.map((c) => c * h)]);
  }
  function drawAnchorsGL(V) {
    const gl = initGL();
    if (!gl) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = glCv.clientWidth * dpr, H = glCv.clientHeight * dpr;
    if (glCv.width !== W || glCv.height !== H) { glCv.width = W; glCv.height = H; }
    gl.viewport(0, 0, W, H); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const shown = anchors.map((a) => [a, anchorWorld(a)]).filter((x) => x[1]);
    if (!shown.length || !V) return true;
    // Draw into the letterboxed frame rectangle only (GL's origin is bottom-left).
    const X = frameXform(), fw = frameW * X.k, fh = frameH * X.k;
    gl.viewport(Math.round(X.ox), Math.round(H - X.oy - fh), Math.round(fw), Math.round(fh));
    gl.enable(gl.SCISSOR_TEST); gl.scissor(Math.round(X.ox), Math.round(H - X.oy - fh), Math.round(fw), Math.round(fh));
    gl.useProgram(GL.prog);
    const loc = (n) => gl.getUniformLocation(GL.prog, n);
    const c = cam(), d = (c.distortion_model === 'RadTan' && c.distortion) || [0, 0, 0, 0, 0];
    const Rt = new Float32Array([V.R[0][0], V.R[0][1], V.R[0][2], V.R[1][0], V.R[1][1], V.R[1][2], V.R[2][0], V.R[2][1], V.R[2][2]]);   // R^T column-major
    gl.uniformMatrix3fv(loc('u_Rt'), false, Rt);
    gl.uniform3f(loc('u_t'), V.t[0], V.t[1], V.t[2]);
    gl.uniform4f(loc('u_K'), c.fx, c.fy, c.cx, c.cy);
    gl.uniform4f(loc('u_d'), d[0], d[1], d[2], d[3]); gl.uniform1f(loc('u_k3'), d[4] || 0);
    gl.uniform1f(loc('u_r2max'), r2max()); gl.uniform2f(loc('u_size'), frameW, frameH);
    gl.uniformMatrix3fv(loc('u_basis'), false, cubeBasis());
    const aLocal = gl.getAttribLocation(GL.prog, 'a_local'), aShade = gl.getAttribLocation(GL.prog, 'a_shade');
    const bind = (b) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(aLocal); gl.vertexAttribPointer(aLocal, 3, gl.FLOAT, false, 16, 0);
                          gl.enableVertexAttribArray(aShade); gl.vertexAttribPointer(aShade, 1, gl.FLOAT, false, 16, 12); };
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    for (const [a, p] of shown) {
      const rgb = hexRGB(anchorColors[(a.id - 1) % anchorColors.length]);
      gl.uniform3f(loc('u_center'), p[0], p[1], p[2]);
      // Faces: translucent and depth-sorted by the GPU against the cube's own edges.
      gl.uniform2f(loc('u_off'), 0, 0);
      bind(GL.tris); gl.depthMask(false); gl.uniform4f(loc('u_color'), rgb[0], rgb[1], rgb[2], 0.38); gl.drawArrays(gl.TRIANGLES, 0, GL.nTris);
      gl.depthMask(true);
      // WebGL lines are 1 px: draw the edges at a few sub-offsets for a ~2.5 px stroke.
      bind(GL.lines); gl.uniform4f(loc('u_color'), rgb[0], rgb[1], rgb[2], 1.0);
      const px = 2 / fw, py = 2 / fh;
      for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        gl.uniform2f(loc('u_off'), ox * px * dpr * 0.6, oy * py * dpr * 0.6); gl.drawArrays(gl.LINES, 0, GL.nLines);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    return true;
  }
  function drawAnchors(ctx, dpr) {
    if (!cam()) return;
    const V = drawnPose(performance.now());   // every frame, so the smoother keeps its state
    if (!V || !anchors.length) { if (GL.gl) drawAnchorsGL(null); return; }
    const X = frameXform(), S = (q) => [X.ox + q[0] * X.k, X.oy + q[1] * X.k];
    const gpu = drawAnchorsGL(V);
    for (const a of anchors) {
      const col = anchorColors[(a.id - 1) % anchorColors.length];
      ctx.strokeStyle = col; ctx.lineWidth = 2 * dpr;
      a.screen = null;
      const w = anchorWorld(a);
      if (!w) continue;   // hidden: another VIO frame than this epoch's
      if (!gpu) for (const [p, q, vert] of cubeEdges(w)) {
        const A = projectCam(toCam(V, p)), B = projectCam(toCam(V, q));
        if (!A || !B) continue;
        const sa = S(A), sb = S(B);
        ctx.globalAlpha = vert ? 0.9 : 1; ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const pc = toCam(V, w), c = projectCam(pc);
      if (!c || c[0] < 0 || c[1] < 0 || c[0] > frameW || c[1] > frameH) continue;   // label only when in view
      const sc = S(c);
      a.screen = sc;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sc[0], sc[1], 3.5 * dpr, 0, 6.283); ctx.fill();
      ctx.font = `${11 * dpr}px -apple-system, system-ui`; ctx.fillText(`${a.id} · ${pc[2].toFixed(2)} m`, sc[0] + 7 * dpr, sc[1] - 7 * dpr);
    }
  }
  // Touch: a tap drops an anchor, a drag that starts on one moves it at its current depth.
  let drag = null;
  overlay.addEventListener('pointerdown', (e) => {
    if (!frameW || !cam()) return;
    overlay.setPointerCapture(e.pointerId);
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = overlay.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    let best = null, bd = 36 * dpr;
    for (const a of anchors) if (a.screen) { const d = Math.hypot(a.screen[0] - px, a.screen[1] - py); if (d < bd) { bd = d; best = a; } }
    const V = smooth.R ? { R: smooth.R, t: smooth.t } : viewPose();
    drag = { px, py, anchor: best, z: best && V ? toCam(V, anchorWorld(best))[2] : 0, moved: false };
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = overlay.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    if (Math.hypot(px - drag.px, py - drag.py) > 6 * dpr) drag.moved = true;
    const V = smooth.R ? { R: smooth.R, t: smooth.t } : viewPose();
    if (!drag.anchor || !V || !(drag.z > 0)) return;
    const X = frameXform(), u = (px - X.ox) / X.k, v = (py - X.oy) / X.k, ray = rayOf(u, v);
    setAnchorWorld(drag.anchor, camToWorld(V, [ray[0] * drag.z, ray[1] * drag.z, drag.z]));
    anchorNote = `anchor ${drag.anchor.id} moved (depth ${drag.z.toFixed(2)} m)`;
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (!drag.anchor && !drag.moved) {
      const X = frameXform();
      placeAnchor((drag.px - X.ox) / X.k, (drag.py - X.oy) / X.k);
    }
    drag = null;
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', () => { drag = null; });
  clearBtn.addEventListener('click', () => { anchors = []; anchorsShown = 0; anchorNote = 'anchors cleared'; });
  const smoothBox = $('smooth');
  smoothBox.checked = smooth.on;
  smoothBox.addEventListener('change', () => { smooth.on = smoothBox.checked; anchorNote = `smoothing ${smooth.on ? 'on' : 'off'}`; });

  // ----------------------------------------------------------------------------------- drawing
  function fit(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return dpr;
  }
  function drawOverlay() {
    const dpr = fit(overlay), ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!frameW) return;
    if (!cam() && GL.gl) drawAnchorsGL(null);
    const { k, ox, oy } = frameXform();
    ctx.fillStyle = initialized ? 'rgba(61,220,132,.8)' : '#ffd23a';
    const r = 2.0 * dpr;
    // The features are where they were in the PROCESSED frame; the preview is already newer.
    // Rotate each one's ray by the gyro since then (dR = R_view^T R_pose), so the dots sit on the
    // image being shown instead of trailing it while the phone turns.
    const V = initialized && predictOn && cam() ? viewPose() : null;
    const dR = V ? [0, 1, 2].map((i) => [0, 1, 2].map((j) => V.R[0][i] * V.R0[0][j] + V.R[1][i] * V.R0[1][j] + V.R[2][i] * V.R0[2][j])) : null;
    for (const [u0, v0] of feats) {
      let u = u0, v = v0;
      if (dR) {
        const q = rayOf(u0, v0), w = dR.map((row) => row[0] * q[0] + row[1] * q[1] + row[2] * q[2]), p = projectCam(w);
        if (p) [u, v] = p;
      }
      ctx.beginPath(); ctx.arc(ox + u * k, oy + v * k, r, 0, 6.283); ctx.fill();
    }
    drawAnchors(ctx, dpr);
  }
  // A top-down view: positions projected on the plane normal to "up" (the core's low-passed
  // world-frame specific force), so it is a floor plan whatever axis the backend's world uses.
  function basis() {
    const u = up, n = Math.hypot(u[0], u[1], u[2]) || 1, z = [u[0] / n, u[1] / n, u[2] / n];
    const ref = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let x = [ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]];
    const xn = Math.hypot(...x); x = x.map((c) => c / xn);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x, y];
  }
  function drawMap() {
    const dpr = fit(mapCv), ctx = mapCv.getContext('2d'), W = mapCv.width, H = mapCv.height;
    ctx.clearRect(0, 0, W, H);
    const [bx, by] = basis();
    const P = (p) => [p[0] * bx[0] + p[1] * bx[1] + p[2] * bx[2], p[0] * by[0] + p[1] * by[1] + p[2] * by[2]];
    const pts = raw.map(P), gpts = pgo.map(P);
    let lo = [-1, -1], hi = [1, 1];
    for (const q of pts.concat(gpts)) { lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])]; hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])]; }
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) * 1.15, cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    const sc = Math.min(W, H) / span, X = (q) => W / 2 + (q[0] - cx) * sc, Y = (q) => H / 2 - (q[1] - cy) * sc;
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    for (let gx = Math.floor(cx - span); gx <= cx + span; gx++) { ctx.beginPath(); ctx.moveTo(X([gx, 0]), 0); ctx.lineTo(X([gx, 0]), H); ctx.stroke(); }
    for (let gy = Math.floor(cy - span); gy <= cy + span; gy++) { ctx.beginPath(); ctx.moveTo(0, Y([0, gy])); ctx.lineTo(W, Y([0, gy])); ctx.stroke(); }
    const line = (q, src, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6 * dpr; ctx.beginPath();
      for (let i = 0; i < q.length; i++) {
        const brk = i === 0 || src[i][3] !== src[i - 1][3];   // a new epoch is a new world frame
        brk ? ctx.moveTo(X(q[i]), Y(q[i])) : ctx.lineTo(X(q[i]), Y(q[i]));
      }
      ctx.stroke();
    };
    line(pts, raw, '#ffa23a');
    if (resolved && resolved.mapper) line(gpts, pgo, '#3ddc84');
    const T = resolved && resolved.mapper ? posePgo : pose;
    if (T && raw.length) {
      const c = P([T[12], T[13], T[14]]), fw = P([T[8], T[9], T[10]]);   // camera forward = IMU z
      const fn = Math.hypot(fw[0], fw[1]) || 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(c), Y(c), 4 * dpr, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(X(c), Y(c));
      ctx.lineTo(X(c) + fw[0] / fn * 14 * dpr, Y(c) - fw[1] / fn * 14 * dpr); ctx.stroke();
    }
  }
  function pathLength(q) {
    let L = 0;
    for (let i = 1; i < q.length; i++) if (q[i][3] === q[i - 1][3]) L += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1], q[i][2] - q[i - 1][2]);
    return L;
  }
  let lastStatus = 0;
  function frameLoop(now) {
    poll(); drawOverlay(); drawMap();
    if (now - lastStatus > 250 && (running || frameW)) {
      lastStatus = now;
      const s = stats, imuHz = imuCount > 1 ? imuCount / Math.max(1e-3, (performance.now() / 1e3 - imuT0)) : 0;
      const pct = s.inN ? (100 * s.dropped / s.inN).toFixed(0) : 0;
      setStatus(
        `${resolved ? resolved.backend.toUpperCase() + (resolved.mapper ? '+PGO' : '') : ''}  ` +
        `${errText ? 'ERROR ' + errText : initialized ? 'tracking' : 'initialising — move the phone sideways'}\n` +
        `frames ${s.done | 0}/${s.inN | 0} (dropped ${pct}%)  ${(s.mean || 0).toFixed(1)} ms mean, p95 ${(s.p95 || 0).toFixed(1)}  ` +
        `resets ${Math.max(0, (s.epochs | 0) - 1)}  +${(s.overhead || 0).toFixed(1)} ms off-backend` +
        (resolved && resolved.mapper ? ` (PGO hand-off ${(s.feed || 0).toFixed(1)}, max ${(s.feedMax || 0).toFixed(0)})` : '') + `\n` +
        `path ${pathLength(raw).toFixed(2)} m` + (resolved && resolved.mapper ? `  PGO nodes ${s.nodes | 0} loops ${s.loops | 0} solves ${s.revisions | 0}` : '') +
        `  imu ${imuCount} ${clockNote}` +
        (resolved ? `  offset ${(1000 * (timeOffset || resolved.imu_time_offset_s || 0)).toFixed(1)} ms${resolved.estimate_time_offset ? ' (online)' : ''}` : '') + `\n` +
        (anchorNote || (initialized ? 'tap the preview to drop an anchor, drag one to move it' : '')) +
        (smooth.on && anchors.length ? `  smoothing ${(Math.hypot(...smooth.d) * 100).toFixed(1)} cm ${(Math.hypot(...smooth.phi) * 57.3).toFixed(1)}°` : ''));
    }
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  // -------------------------------------------------------------------------------- live sensors
  async function startLive() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();   // iOS: must run inside the tap
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
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    let alive = true, mode = '';
    // VideoFrame timestamps (us) on the DeviceMotion clock (performance.now) when they are within a
    // second of it; otherwise on their own clock, offset by the smallest arrival delay seen.
    let ownClock = null, minDelay = Infinity;
    const frameTime = (tsSec) => {
      const now = performance.now() / 1000;
      if (ownClock === null) ownClock = Math.abs(now - tsSec) > 1.0;
      if (!ownClock) return tsSec;
      minDelay = Math.min(minDelay, now - tsSec);
      return tsSec + minDelay;
    };
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      mode = 'webcodecs';
      const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
      (async () => {
        while (alive) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          try {
            const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
            const rgb = (frame.format || '').startsWith('RGB') || (frame.format || '').startsWith('BGR');
            const bytes = frame.allocationSize({ rect: vr });
            await frame.copyTo(frameBuffer(bytes), { rect: vr });
            // Planar YUV: the first w*h bytes are the luma plane, i.e. the gray image.
            const t = frameTime(frame.timestamp * 1e-6);
            clockNote = ownClock ? '(frame clock offset)' : '';
            pushFrame(t, vr.width, vr.height, rgb ? 4 : 1);
          } catch (e) { errText = String(e.message || e); console.error(e); }
          frame.close();
        }
      })();
    } else {
      // Older Safari: draw the <video> into a canvas once per presented frame.
      mode = 'canvas';
      const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
      const onFrame = (now, meta) => {
        if (!alive) return;
        const w = video.videoWidth, h = video.videoHeight;
        if (w && h) {
          cv.width = w; cv.height = h; ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, w, h);
          frameBuffer(w * h * 4).set(img.data);
          const t = meta && meta.captureTime ? meta.captureTime / 1000 : now / 1000;
          try { pushFrame(t, w, h, 4); } catch (e) { errText = String(e.message || e); }
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
    console.log('[violive] camera', track.getSettings(), 'frames via', mode);
    return () => { alive = false; window.removeEventListener('devicemotion', onMotion); track.stop(); };
  }

  // ------------------------------------------------------------------------------------- replay
  async function startReplay(dir) {
    const meta = await (await fetch(dir + '/replay.json')).json();
    setStatus(`replay: fetching ${meta.frames.length} frames…`);
    const blobs = await Promise.all(meta.frames.map((f) => fetch(dir + '/' + f[1]).then((r) => r.blob())));
    const fast = !!params.get('fast');
    const cover = params.get('cover') && params.get('cover').split(':').map(Number);
    const cv = new OffscreenCanvas(meta.width, meta.height), ctx = cv.getContext('2d', { willReadFrequently: true });
    const pctx = preview.getContext('2d');
    let alive = true;
    const imu = meta.imu;   // [t, ax, ay, az, gx, gy, gz]: raw accelerationIncludingGravity, rad/s
    const t0 = Math.min(meta.frames[0][0], imu[0][0]), wall0 = performance.now() / 1000;
    let ii = 0;
    (async () => {
     try {
      for (let fi = 0; fi < meta.frames.length && alive; fi++) {
        const tf = meta.frames[fi][0];
        const bmp = await createImageBitmap(blobs[fi]);
        ctx.drawImage(bmp, 0, 0);
        // &cover=a:b (seconds into the replay): black frames, as a hand over the lens.
        if (cover && tf - meta.frames[0][0] >= cover[0] && tf - meta.frames[0][0] < cover[1]) {
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, meta.width, meta.height);
        }
        // The replay has no <video>: show the frame being pushed, so anchors can be checked.
        if (preview.width !== meta.width) { preview.width = meta.width; preview.height = meta.height; preview.style.display = ''; }
        pctx.drawImage(cv, 0, 0); bmp.close();
        const img = ctx.getImageData(0, 0, meta.width, meta.height);
        if (!fast) {   // wait for the recording's clock
          const due = wall0 + (tf - t0);
          const wait = due - performance.now() / 1000;
          if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
        }
        if (!frameW) create(meta.width, meta.height);
        // Live DeviceMotion keeps streaming while a frame is in flight, so the worker's wait for
        // IMU past the frame time ends within one sample; give it that sample (17 ms look-ahead).
        while (ii < imu.length && imu[ii][0] <= tf + (fast ? 0 : 0.02)) { const s = imu[ii++]; pushMotion(s[0], [s[1], s[2], s[3]], [s[4], s[5], s[6]]); }
        frameBuffer(meta.width * meta.height * 4).set(img.data);
        pushFrame(tf, meta.width, meta.height, 4);
        if (fast && fi % 10 === 0) await new Promise((r) => setTimeout(r, 0));   // let the page draw
      }
      while (ii < imu.length) { const s = imu[ii++]; pushMotion(s[0], [s[1], s[2], s[3]], [s[4], s[5], s[6]]); }
      console.log('[violive] replay done');
     } catch (e) { errText = String(e.message || e); setStatus('replay failed: ' + errText); console.error(e); }
      window.__violiveReplayDone = true;
    })();
    return () => { alive = false; };
  }

  // ---------------------------------------------------------------------------------- controls
  async function start() {
    if (!M) return;
    raw = []; pgo = []; feats = []; frameW = 0; frameH = 0; errText = ''; imuCount = 0; frameCount = 0;
    r2maxCache = null;
    landmarks = []; anchors = []; anchorEpoch = -1; anchorNote = ''; gyroBuf = []; displayT = 0; poseT = 0; hosts = {}; anchorsShown = 0;
    window.__violiveReplayDone = false;
    try {
      stopFn = params.get('replay') ? await startReplay(params.get('replay')) : await startLive();
      running = true; goBtn.textContent = 'Stop'; goBtn.className = 'stop'; presetSel.disabled = true; $('onlineTd').disabled = true; $('tdMethod').disabled = true;
      saveBtn.style.display = ''; clearBtn.style.display = ''; $('smoothLabel').style.display = '';
    } catch (e) { setStatus('could not start: ' + (e.message || e)); console.error(e); }
  }
  function stop() {
    if (stopFn) stopFn();
    stopFn = null; running = false; goBtn.textContent = 'Start'; goBtn.className = ''; presetSel.disabled = false; $('onlineTd').disabled = false; $('tdMethod').disabled = false;
    poll();
    if (M) M._vl_destroy();
  }
  goBtn.addEventListener('click', () => (running ? stop() : start()));
  saveBtn.addEventListener('click', () => {
    const tum = (q) => q.map((p, i) => `${i} ${p[0]} ${p[1]} ${p[2]} 0 0 0 1 ${p[3]}`).join('\n');
    const blob = new Blob([`# VioLive ${JSON.stringify(resolved)}\n# raw\n${tum(raw)}\n# pgo\n${tum(pgo)}\n`], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'violive-trajectory.txt'; a.click();
  });
  // Exposed for tests (Playwright / the browser pane): the newest state, as plain data.
  window.__violive = () => (poll(), { initialized, stats, raw: raw.length, pathLength: pathLength(raw), pgo: pgo.length,
                              pgoLength: pathLength(pgo), error: errText, resolved, frames: frameCount, imu: imuCount,
                              heapMB: M ? M.HEAPU8.buffer.byteLength / 2 ** 20 : 0, landmarks: landmarks.length,
                              anchors: anchors.map((a) => ({ id: a.id, p: anchorWorld(a), host: a.host, local: a.p,
                                                             visible: anchorVisible(a), screen: a.screen })),
                              note: anchorNote,
                              displayT, poseT, timeOffset, smooth: { on: smooth.on, cm: Math.hypot(...smooth.d) * 100,
                              deg: Math.hypot(...smooth.phi) * 57.2958, snaps: smooth.snaps } });
  // Test hooks: drop an anchor at frame pixel (u, v); project a world point with the drawn pose.
  window.__violiveTap = (u, v) => { const a = placeAnchor(u, v); return a && { id: a.id, p: anchorWorld(a), host: a.host, note: anchorNote }; };
  // Landmarks projected with the UNPREDICTED pose vs the processed frame's features: the median
  // distance to the nearest feature checks the camera model, the pose convention and the
  // distortion together (a few px when they are right).
  window.__violiveReprojection = () => {
    const T = pose;
    if (!T || !landmarks.length || !feats.length) return null;
    const V = { R: rotOf(T), t: [T[12], T[13], T[14]] }, d = [];
    for (const p of landmarks) {
      const q = projectCam(toCam(V, p));
      if (!q || q[0] < 0 || q[1] < 0 || q[0] > frameW || q[1] > frameH) continue;
      let best = 1e9;
      for (const f of feats) best = Math.min(best, Math.hypot(f[0] - q[0], f[1] - q[1]));
      d.push(best);
    }
    return { inView: d.length, medianPx: median(d), under3px: d.filter((x) => x < 3).length };
  };
  window.__violiveDebug = () => ({ pose: pose && Array.from(pose), feats: feats.length, landmarks: landmarks.length,
                                  anchors: anchors.length, cam: cam(), poseT, displayT, gyro: gyroBuf.length });
  // Jitter probe: the drawn screen position of each anchor, sampled every animation frame for
  // `ms`; returns per-anchor mean |second difference| in px (what a jumpy box looks like).
  window.__violiveJitter = (ms = 3000) => new Promise((res) => {
    const tr = {}, t0 = performance.now();
    const tick = () => {
      for (const a of anchors) if (a.screen) (tr[a.id] = tr[a.id] || []).push(a.screen.slice());
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else res(Object.fromEntries(Object.entries(tr).map(([id, q]) => {
        let acc = 0, n = 0;
        for (let i = 2; i < q.length; i++) { acc += Math.hypot(q[i][0] - 2 * q[i - 1][0] + q[i - 2][0], q[i][1] - 2 * q[i - 1][1] + q[i - 2][1]); n++; }
        return [id, { samples: q.length, accelPx: n ? acc / n : 0 }];
      })));
    };
    requestAnimationFrame(tick);
  });
  window.__violiveJumps = () => {
    const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
    const cm = smooth.jumps.map((j) => j[0]), deg = smooth.jumps.map((j) => j[1]);
    return { n: cm.length, cm: { p50: q(cm, 0.5), p90: q(cm, 0.9), p99: q(cm, 0.99) }, deg: { p50: q(deg, 0.5), p90: q(deg, 0.9), p99: q(deg, 0.99) }, snaps: smooth.snaps };
  };
  // Test hook: an anchor at a CAMERA-frame point of the current drawn pose (e.g. straddling the
  // near plane, or behind the camera).
  window.__violiveAnchorAtCam = (pc) => {
    const V = smooth.R ? { R: smooth.R, t: smooth.t } : viewPose(); if (!V) return null;
    return newAnchor(camToWorld(V, pc));
  };
  // Lens probe: px of normalised (x, y), and the round trip px -> ray -> px.
  window.__violiveLens = { project: (x, y) => projectCam([x, y, 1]), ray: (u, v) => rayOf(u, v), r2max: () => r2max() };
  window.__violiveSmooth = (on) => { smooth.on = !!on; $('smooth').checked = smooth.on; return smooth.on; };
  window.__violiveProject = (p, predict = true) => {
    const V = viewPose(); if (!V) return null;
    return projectCam(toCam(V, p));
  };
})();
