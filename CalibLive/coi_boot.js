// Cross-origin isolation on a static host (see coi_sw.js): loaded first by gpu.html, index.html and
// CalibLive's calibrate.html. A page that is not isolated registers coi_sw.js and reloads once the
// worker is ACTIVE: register() resolves while it is still installing, and a reload that beats it
// comes back unisolated with the flag already set (nothing retries).
// One flag per page directory: sessionStorage is shared by the whole origin, and CalibLive's worker
// (scope /CalibLive/) does not cover /VioLive/, which must register its own.
// When the worker cannot come in (register() rejects, the worker turns redundant, or it is not
// active within 10 s) the page does not reload: it stays unisolated, says so itself ("Reload this
// page"), and the flag is cleared so that a manual reload tries again.
//
// window.coiBoot(env) is the logic, with the browser parts passed in (tests drive it with fakes):
// env = { isolated, sw (navigator.serviceWorker or null), storage (sessionStorage), path, reload,
// timeoutMs }. Resolves to 'isolated' | 'unsupported' | 'tried' | 'reloading' | 'failed' | 'timeout'.
'use strict';
window.coiBoot = async (env) => {
  if (env.isolated) return 'isolated';
  if (!env.sw) return 'unsupported';
  const key = 'coiReloaded:' + env.path.replace(/[^/]*$/, '');
  if (env.storage.getItem(key)) return 'tried';
  env.storage.setItem(key, '1');
  let outcome;
  try {
    const reg = await env.sw.register('coi_sw.js');
    const w = reg.installing || reg.waiting || reg.active;
    outcome = !w ? 'failed' : w.state === 'activated' ? 'reloading' : await new Promise((done) => {
      const timer = setTimeout(() => done('timeout'), env.timeoutMs);
      w.addEventListener('statechange', () => {
        if (w.state === 'activated') { clearTimeout(timer); done('reloading'); }
        else if (w.state === 'redundant') { clearTimeout(timer); done('failed'); }
      });
    });
  } catch (e) {
    console.error('coi_sw.js: ' + e);
    outcome = 'failed';
  }
  if (outcome === 'reloading') env.reload();
  else env.storage.removeItem(key);
  return outcome;
};
window.coiBoot({
  isolated: self.crossOriginIsolated, sw: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
  storage: sessionStorage, path: location.pathname, reload: () => location.reload(), timeoutMs: 10000,
});
