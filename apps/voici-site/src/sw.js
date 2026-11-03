// voi.ci's reply-alert service worker (the "Alerts:" note in docs/voici-and-messages.md §8.3). A classic script with
// no imports, served by `.com` as https://voi.ci/-/sw.js (this build's file, listed in its MANIFEST.json) and
// registered by flagship-web's enableReplyAlerts with the scope /-/alerts/, under which no page lives: it controls no
// page and has no fetch handler, it only shows alerts.
//
// A push carries {kind:"voici-reply", u:<page username>} and nothing else. The text shown is fixed: the localized
// {title, body} the site stored when the visitor turned alerts on (flagship-web's store, key "voici-alerts:notice"),
// else the English default. Tapping opens https://voi.ci/<u> (this worker's own origin; the username is checked).

const DB_NAME = "flagship-web";
const OBJECT_STORE = "kv";
const NOTICE_KEY = "voici-alerts:notice";
const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const DEFAULT_NOTICE = { title: "voi.ci", body: "You have a reply on voi.ci." };

self.addEventListener("install", () => self.skipWaiting());

function readNotice() {
  return new Promise((resolve) => {
    let open;
    try {
      open = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(OBJECT_STORE)) open.result.createObjectStore(OBJECT_STORE);
    };
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      try {
        const get = open.result.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE).get(NOTICE_KEY);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
  });
}

const text = (v, fallback, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : fallback);

async function showAlert(data) {
  let u = null;
  try {
    const d = data ? data.json() : null;
    if (d && d.kind === "voici-reply" && typeof d.u === "string" && USERNAME.test(d.u)) u = d.u;
  } catch {
    u = null;
  }
  const n = (await readNotice()) ?? {};
  const icon = typeof n.icon === "string" && n.icon.startsWith("/-/") ? n.icon : undefined;
  return self.registration.showNotification(text(n.title, DEFAULT_NOTICE.title, 80), {
    body: text(n.body, DEFAULT_NOTICE.body, 200),
    tag: u ? `voici-reply:${u}` : "voici-reply",
    data: { u },
    ...(icon ? { icon } : {}),
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(showAlert(event.data));
});

async function openPage(u) {
  const url = new URL(u ? `/${u}` : "/", self.location.origin).href;
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of open) {
    if (c.url === url && "focus" in c) return c.focus();
  }
  return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const u = event.notification.data && typeof event.notification.data.u === "string" && USERNAME.test(event.notification.data.u) ? event.notification.data.u : null;
  event.waitUntil(openPage(u));
});
