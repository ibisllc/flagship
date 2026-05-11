// Flagship webapp service worker.
// Strategy: cache-first for the PWA shell so the home screen icon "feels native"
// (instant launch even on lossy networks); network-first for /api/* so dynamic
// state never staleness-bites the user.

// SHELL_VERSION bumped each time the SHELL list changes so existing
// installs invalidate their cache.
//   v6: web.flagshipserver.com migration (origin change made the bump
//       documentation-only since old SWs were on a different origin).
//   v7: added lib/leases.js for the auto-unlock lease flow.
//   v8: added lib/recovery.js for WebAuthn-PRF cloud-shard recovery.
//   v9: added lib/push.js + Web Push event handler for unlock-approval
//       notifications.
//  v10: push event handler reads RFC 8291 encrypted payload and
//       personalises the notification with the requesting server FQDN.
const SHELL_VERSION = "v10";
const SHELL_CACHE = `flagship-webapp-shell-${SHELL_VERSION}`;
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icon.svg",
  "/keystore.js",
  "/providers.js",
  "/qrScanner.js",
  "/lib/router.js",
  "/lib/toast.js",
  "/lib/state.js",
  "/lib/util.js",
  "/lib/api.js",
  "/lib/podPair.js",
  "/lib/installApp.js",
  "/lib/leases.js",
  "/lib/recovery.js",
  "/lib/push.js",
  "/views/bootstrap.js",
  "/views/unlock.js",
  "/views/home.js",
  "/views/pair.js",
  "/views/settings.js",
  "/views/pod-pair.js",
  "/views/server-detail.js",
  "/views/apps-list.js",
  "/views/app-detail.js",
  "/views/paired-sessions.js",
  "/views/tier-status.js",
  "/views/marketplace.js",
  "/views/vibe-code.js",
  "/views/unlock-approvals.js",
  "/views/recovery.js",
  "/views/install-progress.js",
  "/views/orders-debug.js",
  "/views/browser-viewer.js",
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
  // P2.13 — offline-replay queue.
  // Idempotent POSTs (paired-session orders, claim, backup-start) are
  // safe to retry: the daemon dedupes by signed canonical bytes +
  // issuedAt, and a stale issuedAt window-gate rejects replays. Wrap
  // those in a fetch-or-queue so a transient offline window doesn't
  // bubble a confusing error to the user.
  if (event.request.method === "POST" && shouldQueue(url.pathname)) {
    event.respondWith(fetchOrQueue(event.request));
    return;
  }
  if (event.request.method !== "GET") return;
  // Same-origin gate: scope is "/" on web.flagshipserver.com, so any
  // in-scope GET is a webapp asset. Cross-origin calls (the user's pod
  // at <server>.<user>.flagship.services for /api/screens/*) bypass
  // the SW entirely.
  if (url.origin !== self.location.origin) return;

  // Never cache API calls — they're dynamic. The webapp's only
  // same-origin /api/* paths today are the ones the offline-replay
  // queue handles above; this is a defensive skip in case future
  // additions slip through.
  if (url.pathname.startsWith("/api/")) {
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

// ---------- Offline replay queue (P2.13) -----------------------------

const REPLAY_QUEUE = [];
const REPLAY_PATH_PATTERNS = [
  /^\/api\/screens\/orders\/send$/,
  /^\/api\/screens\/url-controller\/claim$/,
  /^\/api\/screens\/app-backup\/start$/,
];

function shouldQueue(pathname) {
  return REPLAY_PATH_PATTERNS.some((re) => re.test(pathname));
}

async function fetchOrQueue(request) {
  try {
    const res = await fetch(request.clone());
    return res;
  } catch (_e) {
    // Network failure — queue the request and respond 202 Accepted so
    // the calling view doesn't error out. The replay loop will fire on
    // the next `online` event.
    const body = await request.clone().arrayBuffer();
    REPLAY_QUEUE.push({
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body,
      enqueuedAt: Date.now(),
    });
    return new Response(
      JSON.stringify({ queued: true, queueLength: REPLAY_QUEUE.length }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  }
}

self.addEventListener("online", () => {
  void replayQueue();
});

// ---------- Web Push: unlock-approval notifications -------------------
//
// .com sends an RFC 8291-encrypted payload with the JSON shape
// { kind: "unlock-request", serverFqdn, requestId }. The browser
// decrypts before the push event fires; we get the plaintext via
// event.data.json(). Empty-payload pushes (no event.data) still work
// — they fall back to a generic notification body.
//
// `notificationclick` focuses an existing webapp tab if one is open,
// otherwise opens the root (the SPA routes the user to the
// unlock-approvals view from there).
self.addEventListener("push", (event) => {
  let serverFqdn = null;
  try {
    const data = event.data?.json?.();
    if (data && typeof data.serverFqdn === "string") {
      serverFqdn = data.serverFqdn;
    }
  } catch (_e) {
    // Malformed payload — fall back to the generic body below.
  }
  const body = serverFqdn
    ? `${serverFqdn} is asking to boot — tap to review.`
    : "A server is asking to boot — tap to review.";
  event.waitUntil(
    self.registration.showNotification("Flagship", {
      body,
      tag: "flagship-unlock-request",
      renotify: true,
      requireInteraction: false,
      icon: "/icon.svg",
      data: { kind: "unlock-request", serverFqdn },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const same = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        return;
      }
      await self.clients.openWindow("/");
    })(),
  );
});

async function replayQueue() {
  // Drain in FIFO order. On any failure, re-queue and stop — we'll
  // pick up again on the next `online` event.
  while (REPLAY_QUEUE.length > 0) {
    const job = REPLAY_QUEUE[0];
    try {
      const r = await fetch(job.url, {
        method: job.method,
        headers: new Headers(job.headers),
        body: job.body,
      });
      if (!r.ok) {
        // Don't re-queue on 4xx (the request is bad) — only on 5xx /
        // network. 4xx jobs are silently dropped after the first
        // attempt; the user can retry from the UI if it matters.
        REPLAY_QUEUE.shift();
        if (r.status >= 500) {
          REPLAY_QUEUE.unshift(job);
          break;
        }
      } else {
        REPLAY_QUEUE.shift();
      }
    } catch (_e) {
      // Still offline. Stop the loop; the next `online` retries.
      break;
    }
  }
}
