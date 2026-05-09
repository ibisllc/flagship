// Flagship webapp service worker.
// Strategy: cache-first for the PWA shell so the home screen icon "feels native"
// (instant launch even on lossy networks); network-first for /api/* so dynamic
// state never staleness-bites the user.

const SHELL_VERSION = "v3";
const SHELL_CACHE = `flagship-webapp-shell-${SHELL_VERSION}`;
const SHELL = [
  "/webapp/",
  "/webapp/index.html",
  "/webapp/app.js",
  "/webapp/style.css",
  "/webapp/manifest.json",
  "/webapp/icon.svg",
  "/webapp/keystore.js",
  "/webapp/providers.js",
  "/webapp/qrScanner.js",
  "/webapp/lib/router.js",
  "/webapp/lib/toast.js",
  "/webapp/lib/state.js",
  "/webapp/lib/util.js",
  "/webapp/lib/api.js",
  "/webapp/lib/podPair.js",
  "/webapp/lib/installApp.js",
  "/webapp/views/bootstrap.js",
  "/webapp/views/unlock.js",
  "/webapp/views/home.js",
  "/webapp/views/pair.js",
  "/webapp/views/settings.js",
  "/webapp/views/pod-pair.js",
  "/webapp/views/server-detail.js",
  "/webapp/views/apps-list.js",
  "/webapp/views/app-detail.js",
  "/webapp/views/paired-sessions.js",
  "/webapp/views/tier-status.js",
  "/webapp/views/marketplace.js",
  "/webapp/views/vibe-code.js",
  "/webapp/views/unlock-approvals.js",
  "/webapp/views/recovery.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("flagship-webapp-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (!url.pathname.startsWith("/webapp/")) return;

  // Never cache API calls — they're dynamic.
  if (url.pathname.startsWith("/webapp/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        // Don't cache non-200 responses or opaque responses.
        if (!res.ok || res.type === "opaque") return res;
        const clone = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(event.request, clone));
        return res;
      });
    }),
  );
});
