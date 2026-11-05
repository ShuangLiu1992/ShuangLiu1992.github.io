// The phone's saved camera calibration, shared by CalibLive (writes it) and VioLive (reads it).
// Both pages live on one origin, so one cookie carries it. Classic script: window.visCalib.
// WebKit caps a script-set cookie at 7 days, so the same JSON is also kept in localStorage
// (key vis_camera_calib); read() falls back to it when the cookie is gone and re-sets the cookie.
// VioLive re-writes the record it read, which restarts the cookie's clock.
//   cookie  vis_camera_calib = encodeURIComponent(JSON)   Path=/  Max-Age=1 year+  SameSite=Lax
//   JSON    {v:1, camera:{width,height,fx,fy,cx,cy,distortion_model:'RadTan',distortion:[k1,k2,p1,p2,0]},
//            rms_px, views, date, ua, device_id, label}
(function () {
  'use strict';
  var NAME = 'vis_camera_calib';
  var MAX_AGE = 34560000;
  var STORE_KEY = 'vis_camera_calib';
  var ASPECT_TOL = 0.01;  // relative difference of width/height still counted as the same aspect

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function validCamera(c) {
    return !!c && isNum(c.width) && isNum(c.height) && c.width > 0 && c.height > 0 &&
      isNum(c.fx) && isNum(c.fy) && isNum(c.cx) && isNum(c.cy) &&
      Array.isArray(c.distortion) && c.distortion.every(isNum);
  }

  function attrs(maxAge) {
    return '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }

  function storeSet(json) { try { window.localStorage.setItem(STORE_KEY, json); } catch (e) { /* private mode */ } }
  function storeGet() { try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function storeDel() { try { window.localStorage.removeItem(STORE_KEY); } catch (e) { /* private mode */ } }

  function write(rec) {
    var json = JSON.stringify(rec);
    document.cookie = NAME + '=' + encodeURIComponent(json) + attrs(MAX_AGE);
    storeSet(json);
  }

  function forget() {
    document.cookie = NAME + '=' + attrs(0);
    storeDel();
  }

  /** The record in a JSON string, or null when it is not a valid v1 record. */
  function parse(json) {
    try {
      var rec = JSON.parse(json);
      return rec && rec.v === 1 && validCamera(rec.camera) ? rec : null;
    } catch (e) {
      return null;
    }
  }

  /** {ok:true, rec} | {ok:false, why:'none'|'unreadable'} */
  function read() {
    var raw = null;
    var parts = (document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+/, '');
      if (p.indexOf(NAME + '=') === 0) { raw = p.slice(NAME.length + 1); break; }
    }
    if (raw === null || raw === '') {
      // No cookie (expired, e.g. WebKit's 7 days): the copy in localStorage, which brings it back.
      // A cookie that is there but unreadable never falls through to here.
      var stored = storeGet();
      var srec = stored ? parse(stored) : null;
      if (!srec) return { ok: false, why: 'none' };
      write(srec);
      return { ok: true, rec: srec };
    }
    var rec = null;
    try { rec = parse(decodeURIComponent(raw)); } catch (e) { rec = null; }
    return rec ? { ok: true, rec: rec } : { ok: false, why: 'unreadable' };
  }

  /**
   * Which camera block VioLive should use for a stream, and the Stats line saying why.
   * camera is null when the default (iPhone reference) applies.
   */
  function decide(readResult, streamW, streamH, trackDeviceId, trackLabel) {
    var DEFAULT = 'using the default';
    if (!readResult || !readResult.ok) {
      if (readResult && readResult.why === 'unreadable') return { camera: null, note: 'saved calibration unreadable: ' + DEFAULT };
      return { camera: null, note: 'default (iPhone reference)' };
    }
    var rec = readResult.rec, cam = rec.camera;
    // Same lens: the same deviceId, or the same track label (ids are not stable across page loads on
    // every browser). Different ids and no matching label: another lens. A missing id: assume the same.
    var sameId = rec.device_id && trackDeviceId && rec.device_id === trackDeviceId;
    var sameLabel = rec.label && trackLabel && rec.label === trackLabel;
    if (!sameId && !sameLabel && rec.device_id && trackDeviceId) {
      return { camera: null, note: 'calibrated for another lens: ' + DEFAULT };
    }
    var W = cam.width, H = cam.height;
    var sameShape = (W >= H) === (streamW >= streamH) &&
      Math.abs(streamW / streamH - W / H) <= ASPECT_TOL * (W / H);
    if (!sameShape) {
      return { camera: null, note: 'calibrated at ' + W + 'x' + H + ', stream is ' + streamW + 'x' + streamH + ': ' + DEFAULT };
    }
    var sx = streamW / W, sy = streamH / H;
    return {
      camera: {
        width: streamW, height: streamH,
        fx: cam.fx * sx, fy: cam.fy * sy, cx: cam.cx * sx, cy: cam.cy * sy,
        distortion_model: cam.distortion_model, distortion: cam.distortion.slice(),
      },
      note: 'calibrated on this phone ' + rec.date + ' (' + Number(rec.rms_px).toFixed(2) + ' px, ' + rec.views + ' views)',
    };
  }

  window.visCalib = { write: write, read: read, forget: forget, decide: decide };
})();
