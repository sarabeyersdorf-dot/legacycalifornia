// Legacy Desk service worker.
//
// Its ONLY job is to exist — a registered worker with a fetch handler is what
// lets the CRM install to a phone's home screen and launch full-screen like an
// app. It deliberately caches NOTHING: this is a live CRM behind auth, so every
// request must hit the network fresh — a stale cached page or API response
// could show the wrong deal, or a logged-out shell. The fetch handler is a
// pure pass-through (no respondWith), so the browser does its normal network
// fetch for everything.
//
// If offline caching is ever wanted, scope it to static shell assets only
// (css/icons) and NEVER to /api or the HTML — keep the CRM data always-fresh.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function () {
  // No respondWith → the request falls through to the network unchanged.
});
