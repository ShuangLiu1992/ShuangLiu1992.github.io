// Cross-origin isolation for static hosts that cannot set response headers (GitHub Pages).
// VioLive needs SharedArrayBuffer, i.e. COOP same-origin + COEP require-corp on the page.
// The page registers this worker when it finds itself NOT isolated, then reloads once; from then
// on the worker re-serves every same-origin response with those headers. Cross-origin requests
// (the Drive API, Google sign-in) pass through untouched: they are CORS or top-level navigations.
// A host that already sends the headers (tests/web/serve.py) never registers it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;  // Chrome DevTools quirk
  event.respondWith(fetch(req).then((res) => {
    if (res.status === 0) return res;  // opaque: nothing to rewrite
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
