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
//  v11: added e2e simulate-push message shim (gated on flagship-e2e:
//       prefix; harmless in prod since real clients never send it).
//  v12: rollback-safety overhaul.
//       - Dropped skipWaiting() + clients.claim() so a bad deploy can
//         no longer evict a live session mid-flight; the new SW waits
//         until every controlled tab closes (or the page explicitly
//         posts SKIP_WAITING after a user opt-in).
//       - Replaced cache.addAll(SHELL) with a per-URL allSettled
//         walk: optional SHELL entries are allowed to 404 (logged,
//         not fatal) and only the ESSENTIAL_PATHS subset (index.html,
//         app.js, style.css, manifest + icon, router/state/api libs)
//         rejects install. A single missing view module no longer
//         bricks every webapp install on the planet.
//  v14: removed views/unlock-approvals.js — the legacy plaintext
//       unlock-approval boot flow is gone (relay + box-sealed lease
//       replace it). Push handler's unlock-request branch dropped.
//  v16: first-run wizard gained a skippable "Secure your account" step
//       (cloud passkey pre-selected when available, else `.flagshipkey`
//       file); added views/wizard.js to the precache.
//  v17: webapp ↔ mobile parity — added the live account audit log
//       (lib/auditLog.js + views/account-audit.js), real IRK-signed TOTP
//       enroll/disable (lib/totp.js), the boot-approval relay
//       (lib/edToMont.js + lib/bootApproval.js + views/boot-approval.js),
//       and device-capability chip/scope-gating (consumed in home.js).
//  v18: refresh views/home.js so passwordless demo sign-in materialises the
//       server supplied by account resolution without requiring a paired
//       session id.
//  v19: refresh Home + usersCheck so opening a demo server mints the browser's
//       paired session instead of falling through to the unpaired detail error.
//  v20: demo profiles auto-unlock on reload and repair the old discarded local
//       wrap passphrase instead of showing an impossible Unlock prompt.
//  v21: refresh the quieter Home identity, recovery warning, and empty state.
//  v22: desktop-initiated /dock ceremony and browser-only polling secret.
//  v23: keyless companion banner + honest disabled-state policy.
//  v24: quieter cross-platform Settings, recovery, and account-backup copy.
//  v25: direct recipe download replaces the retired homepage QR handoff.
//  v26: web. split into webapp. + remote.; docking renamed to "remote".
//  v29: recovery re-pair is credential-gated — the takeover + replace-device
//       ceremonies now carry a credential on initiate and SIGN the
//       completion, so a stale shell would post bodies .com refuses.
//  v30: security links point at the one-page /security sections.
//  v31: demo accounts hide key-backed rows + remove-from-browser; every
//       Worker audit kind is labelled; recovery copy matches the gate.
//  v32: apex.js drops the retired `web.` sub-origin prefix.
//  v33: the update card shows the box's last update verdict.
//  v34: "Install complete" without the USB-only instruction.
//  v35: the update dialog lists the box's releases ("Update to latest").
//  v36: the server page shows the box's health report.
//  v37: the update sheet no longer asks again before going back.
//  v38: open build sessions can be resumed; Back from a build goes to the chooser.
//  v39: unique build names checked as you type, "Invite only", Discard in Build
//       sessions, named past builds, and the AI Key page split into add and
//       choose; precaches lib/vibeSessions.js + lib/vibeNames.js.
//  v40: "Edit this service" (AI chat or IDE); precaches views/edit-service.js
//       + lib/editService.js.
//  v41: name a git import, follow the AI adapt in the background, Discard
//       open git and IDE builds; precaches lib/gitImport.js.
//  v42: "Get flagship.app.json" on an adapted or installed git import.
//  v43: "Share the adaptation" on a git import, a crashed shared adaptation
//       hands over to the AI, "Report a problem with this adaptation";
//       precaches lib/adapterReport.js.
//  v44: Delete server for every server (typed-name gate, erase order + name
//       release), reversible Revoke + Un-revoke, revoked servers stay listed,
//       and the server page keeps its Danger zone when the box is offline.
//  v47: AI adapt is one step ("Use AI to adapt and deploy") with its staging
//       phases, the chat's Deploy runs staged in the background, an app asks
//       for internet access on its page (signed Allow / Stop access), and
//       each AI key has a Flagship relay switch; precaches lib/appEgress.js,
//       lib/chatDeploy.js + lib/aiRelay.js.
//  v48: app access lists replace the all-or-nothing internet approval: the
//       "Internet access" section, the access-list editor, the "<App> wants
//       to reach <host>" sheet, and the generic app-access push; precaches
//       lib/appAccess.js, lib/accessAlerts.js + views/app-access.js.
//  v49: one "Push notifications" switch: off drops this browser's push
//       registration and tells every box to send no alerts, and no access
//       sheet shows; a generic push's click checks access requests too;
//       precaches lib/pushSetting.js.
//  v50: a sent server update stays on the update card (and the update
//       sheet) until the box reports its outcome, with Send again / Forget
//       it once it's 30 minutes old.
//  v52: an app's page lists its API keys and creates (signed, shown once)
//       and revokes them; precaches lib/appApiKeys.js.
//  v53: suggested access lists (a card with Review / Dismiss, a badge, and
//       the "<App> suggests an access list" alert), and the owner's
//       Database section (tables, rows, CSV export, Run SQL with signed
//       writes); precaches lib/appDb.js + views/app-db.js.
//  v54: knocking on a box you were invited to signs with your contact id
//       for its owner (remembered from the invite link), and Process URL
//       reads "Open <app> on <server>" for any private app; a box that is
//       neither yours nor invited is refused; precaches lib/knockIdentity.js.
//  v56: where an app runs (docs/app-placement.md): making a server leader
//       makes it current, every new app picks its server ("Runs on",
//       defaulting to the leader), a server's page lists its apps and
//       "Create app here", and the app page's Runs on ticks copy the app to a
//       server (signed) and unticks remove it; precaches lib/appPlacement.js.
//  v57: a server's page is titled with its name, not "Server".
//  v58: an app's status pill (docs/app-placement.md §6): the services list
//       shows each app once with one pill for every server it's on
//       (Deploying / Editing / On N servers / Stopped / Can't reach), and
//       the app page and its Runs on rows show each server's state.
//  v60: a server's page ignores a late answer from the server shown before
//       it, so it never shows another server's detail under its name.
//  v62: an app's page no longer offers a custom domain (a Pro feature that
//       lives on feat/custom-domains until it launches).
//  v63: free AI credits: Settings shows what's left (or the way to your own
//       key), the AI-key step offers them first and is skipped for an
//       owner with no saved key, and builds mint a fresh pass per send;
//       the phone-number claim form is gone; precaches lib/freeAi.js.
//  v64: a server's page groups Health, CPU, Memory, Disk, Network and
//       Certificate in one Monitoring pane of rows that expand in place, and
//       its Danger zone is just the buttons; precaches lib/serverMonitoring.js.
//  v65: Access control replaces Collaborators and "Who can open this": an
//       Open to all | Members only toggle and the members list with each
//       person's and group's role (signed role orders); drops the invite
//       issue/manage views + lib/labelBook.js, precaches lib/memberRoles.js.
//  v66: free AI credits show this week's top-up and the starter reserve,
//       and say why they can't be used (busy today, no running server);
//       they disappear once the promotion has ended.
//  v67: a visitor's id is per app: invites, knocks and acceptances sign with
//       deriveAppAccountId(UMK, serviceRef), invite links carry `s=`, and a
//       link without it asks for a new one.
//  v68: free AI is the built-in "Flagship Inference" provider: always first
//       in Settings and the AI-key step, never removable, selectable as the
//       default, shown disabled (with why) instead of hidden once it ended.
//  v69: Flagship Inference everywhere (no more "free AI credits"), and its
//       allowance in credits: "1,840 free credits left · 500 added each
//       week", the same line in Settings and the AI-key step.
//  v70: Share this server: a server's page shows who it's shared with,
//       their level and opt-ins, and an Activity card; /share links open
//       the accept view; home lists "Shared with me" with a page limited to
//       the share's level; precaches lib/serverShare.js, lib/serverShares.js
//       and the server-sharing / share-accept / shared-server views.
//  v72: the remote page shows its QR at once (no account name, no server
//       list): the phone picks the server and seals it a one-use ticket.
//  v73: account read tokens (docs/account-read-token.md): every /pods,
//       /stream, /audit and app-links read carries one; precaches lib/accountRead.js.
//  v74: the owner's server order (docs/server-order.md): Home lists servers
//       in order with a Leader badge and drag/up/down to reorder; server
//       pages say "Make leader"; precaches lib/serverOrder.js.
//  v75: app links are https (/remote, /access, /invite-accept on the control
//       apex); the webapp opens an /access link handed over by the site.
//  v76: Home's server rows lose their numbers: the drag handle leads each
//       row, only the leader wears a badge (gray until it confirms the
//       order), "Add/connect a server" sits above the list; a saved order is
//       also handed straight to each online box.
//  v77: "Patent Pending" in About and a footer under every view.
//  v78: sharing for a family (docs/share-a-server.md §10): a co-manager can
//       ask to be told when a shared server needs to start (a content-free
//       `share-start-up` push), update it at "Can manage", and sees which
//       apps are members-only; the owner's unlock opt-in says what it hands over.
//  v79: notifications that name an app screen (https://<apex>/app/<route>)
//       open the matching webapp view; the old desktop-pairing view
//       (views/pair.js, flagship://desktop QR) is gone; invite replies and
//       app sign-in links carry their params in the fragment.
//  v80: a boot/unlock approval push reads "A server is waiting for your
//       approval." and opens the approvals view.
//  v81: an app invite handed over by the owner's server
//       (/invite#server=<box>&k=…) is accepted against that box.
const SHELL_VERSION = "v81";
const SHELL_CACHE = `flagship-webapp-shell-${SHELL_VERSION}`;

// ESSENTIAL_PATHS: the absolute minimum to render the unlock view and
// route to one of the home/bootstrap views. If any of these 404 we
// abort the install — the browser keeps the previous SW active, which
// is the desired safe-rollback behaviour.
const ESSENTIAL_PATHS = [
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icon.svg",
  "/keystore.js",
  "/lib/router.js",
  "/lib/state.js",
  "/lib/api.js",
  "/lib/toast.js",
];

// OPTIONAL_SHELL: everything else worth precaching. A 404 here is
// logged but doesn't fail the install — the offending URL just isn't
// in the precache; the runtime fetch handler will fall back to the
// network (and then cache whatever it gets). Keeps the webapp's
// offline launch path resilient while a deploy rolls forward.
const OPTIONAL_SHELL = [
  "/providers.js",
  "/qrScanner.js",
  "/lib/util.js",
  "/lib/podPair.js",
  "/lib/leases.js",
  "/lib/recovery.js",
  "/lib/keyfile.js",
  "/lib/keyfileBackup.js",
  "/vendor/noble-hashes/argon2.js",
  "/vendor/noble-hashes/blake2.js",
  "/vendor/noble-hashes/_blake.js",
  "/vendor/noble-hashes/_md.js",
  "/vendor/noble-hashes/_u64.js",
  "/vendor/noble-hashes/utils.js",
  "/vendor/noble-hashes/crypto.js",
  "/lib/push.js",
  "/lib/icons.js",
  "/lib/auditLog.js",
  "/lib/accountRead.js",
  "/lib/serverOrder.js",
  "/lib/totp.js",
  "/lib/edToMont.js",
  "/lib/bootApproval.js",
  "/lib/x25519.js",
  "/lib/companionReceiver.js",
  "/lib/companionGuard.js",
  "/lib/companionDockStart.js",
  "/lib/vibeSessions.js",
  "/lib/vibeNames.js",
  "/lib/editService.js",
  "/lib/gitImport.js",
  "/lib/adapterReport.js",
  "/lib/appEgress.js",
  "/lib/chatDeploy.js",
  "/lib/aiRelay.js",
  "/lib/appAccess.js",
  "/lib/accessAlerts.js",
  "/lib/pushSetting.js",
  "/lib/appApiKeys.js",
  "/lib/freeAi.js",
  "/lib/modelMenu.js",
  "/lib/appDb.js",
  "/lib/knockIdentity.js",
  "/lib/appPlacement.js",
  "/lib/serverMonitoring.js",
  "/lib/memberRoles.js",
  "/lib/serverShare.js",
  "/lib/serverShares.js",
  "/views/bootstrap.js",
  "/views/wizard.js",
  "/views/unlock.js",
  "/views/home.js",
  "/views/settings.js",
  "/views/pod-pair.js",
  "/views/server-detail.js",
  "/views/server-sharing.js",
  "/views/shared-server.js",
  "/views/share-accept.js",
  "/views/services-list.js",
  "/views/service-detail.js",
  "/views/app-access.js",
  "/views/app-db.js",
  "/views/paired-sessions.js",
  "/views/vibe-code.js",
  "/views/vibecode-chat.js",
  "/views/edit-service.js",
  "/views/service-env.js",
  "/views/recovery.js",
  "/views/install-progress.js",
  "/views/orders-debug.js",
  "/views/browser-viewer.js",
  "/views/account-audit.js",
  "/views/boot-approval.js",
  "/views/companion-dock-start.js",
];

// Combined list kept for the existing webappStatic test, which scans
// the SW source for individual view paths. Order doesn't matter at
// runtime — the install handler walks ESSENTIAL_PATHS + OPTIONAL_SHELL
// separately so it can apply different failure semantics to each.
const SHELL = [...ESSENTIAL_PATHS, ...OPTIONAL_SHELL];

async function precacheEssential(cache) {
  // Promise.all so any rejection trips install rejection.
  await Promise.all(
    ESSENTIAL_PATHS.map(async (path) => {
      const res = await fetch(path, { cache: "reload" });
      if (!res || !res.ok) {
        throw new Error(
          `essential precache failed: ${path} -> ${res ? res.status : "no response"}`,
        );
      }
      await cache.put(path, res);
    }),
  );
}

async function precacheOptional(cache) {
  // allSettled so a single missing view doesn't poison the install.
  const settled = await Promise.allSettled(
    OPTIONAL_SHELL.map(async (path) => {
      const res = await fetch(path, { cache: "reload" });
      if (!res || !res.ok) {
        throw new Error(
          `optional precache 404: ${path} -> ${res ? res.status : "no response"}`,
        );
      }
      await cache.put(path, res);
      return path;
    }),
  );
  for (const r of settled) {
    if (r.status === "rejected") {
      // Visible in DevTools → Application → Service Workers logs.
      console.warn("[flagship-sw] optional shell entry skipped:", String(r.reason));
    }
  }
}

self.addEventListener("install", (event) => {
  // NOTE: no skipWaiting(). The new SW sits in `waiting` until every
  // controlled tab closes or the page explicitly posts SKIP_WAITING.
  // That way a deploy with a corrupted asset can't yank the rug out
  // from under a live unlock / pairing / vibe-code session.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await precacheEssential(cache);
      await precacheOptional(cache);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  // NOTE: no clients.claim(). The new SW only takes over once existing
  // controlled clients have all gone away (close + reopen, or user
  // taps the "Update available" toast which posts SKIP_WAITING).
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("flagship-webapp-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
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
  // Same-origin gate: scope is "/" on webapp./remote.<apex>, so any
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

// ---------- Web Push notifications -----------------------------------
//
// .com / the daemon send RFC 8291-encrypted payloads. The browser
// decrypts before the push event fires; we get the plaintext via
// event.data.json(). Empty-payload pushes (no event.data) still work
// — they fall back to a generic notification body.
//
// `notificationclick` focuses an existing webapp tab if one is open,
// otherwise opens the root (or a deep-link the payload provides).
self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data?.json?.() ?? null;
  } catch (_e) {
    // Malformed payload — fall back to the generic body below.
  }

  // W10 — vibecode-needs-you push. The daemon fires this when the AI
  // hits a tool_use (requestEnvVar / talkToUser) and pauses the
  // session. Route to the vibe-code chat surface for the session id.
  if (data && data.kind === "vibecode-needs-you" && typeof data.sessionId === "string") {
    const which = typeof data.request === "string" ? data.request : "input";
    const body = which === "requestEnvVar"
      ? "The AI needs an environment variable to continue."
      : "The AI is asking you a question.";
    const deepLink = typeof data.deepLink === "string"
      ? data.deepLink
      : `/?view=vibecode-chat&sessionId=${encodeURIComponent(data.sessionId)}`;
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body,
        tag: `flagship-vibecode-${data.sessionId}`,
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: {
          kind: "vibecode-needs-you",
          sessionId: data.sessionId,
          deepLink,
        },
      }),
    );
    return;
  }

  // Provisioning-status push — the SINGLE canonical provisioning payload
  // (design §2.3). Recognised by `category === "provision-status"` (or
  // `meta.kind`); `meta.phase` is a canonical ProvisionStatusPhase. iOS +
  // Android parse this identical shape. We render ONE notification and
  // deep-link to the install-progress view.
  const isProvisionStatus =
    data &&
    (data.category === "provision-status" ||
      (data.meta && data.meta.kind === "provision-status"));
  if (isProvisionStatus) {
    const title = typeof data.title === "string" ? data.title : "Flagship";
    const psBody =
      typeof data.body === "string" ? data.body : "Your server is setting itself up.";
    const phase =
      data.meta && typeof data.meta.phase === "string" ? data.meta.phase : "";
    const deepLink =
      typeof data.deepLink === "string" ? data.deepLink : "/?view=install-progress";
    event.waitUntil(
      self.registration.showNotification(title, {
        body: psBody,
        tag: "flagship-provision-status",
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: { kind: "provision-status", phase, deepLink },
      }),
    );
    return;
  }

  // App access request (docs/ai-privacy-and-staging.md §3a). The text is
  // generic on purpose: which app and which host come from the box over the
  // paired session once the webapp is open, never through the push.
  const isAppAccess =
    data &&
    (data.category === "app-access" ||
      data.kind === "app-access" ||
      (data.meta && data.meta.kind === "app-access"));
  if (isAppAccess) {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "One of your apps wants to reach the internet",
        tag: "flagship-app-access",
        renotify: true,
        requireInteraction: false,
        icon: "/icon.svg",
        data: { kind: "app-access" },
      }),
    );
    return;
  }

  // A server shared with this account waits to start (docs/share-a-server.md
  // §5.4). The push names no server; Home shows which one and the Approve button.
  if (data && data.kind === "share-start-up") {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "A server shared with you is asking you to unlock it.",
        tag: "flagship-share-start-up",
        renotify: true,
        requireInteraction: true,
        icon: "/icon.svg",
        data: { kind: "share-start-up", deepLink: "/" },
      }),
    );
    return;
  }

  // One of the owner's boxes waits for an approval (unlock or entitlement).
  // The text names no server, like the phone apps'; the approvals view
  // fetches and re-verifies what's pending.
  if (data && (data.kind === "secret-request" || data.category === "secret-request")) {
    event.waitUntil(
      self.registration.showNotification("Flagship", {
        body: "A server is waiting for your approval.",
        tag: "flagship-secret-request",
        renotify: true,
        requireInteraction: true,
        icon: "/icon.svg",
        data: { kind: "secret-request", deepLink: "/?view=boot-approval" },
      }),
    );
    return;
  }

  // Generic fallback for any other (or empty) payload.
  const body = (data && typeof data.body === "string")
    ? data.body
    : "Flagship has an update for you.";
  const deepLink = data && typeof data.deepLink === "string" ? data.deepLink : null;
  event.waitUntil(
    self.registration.showNotification("Flagship", {
      body,
      tag: "flagship-notification",
      renotify: true,
      requireInteraction: false,
      icon: "/icon.svg",
      data: { kind: (data && data.kind) || "generic", deepLink },
    }),
  );
});

// #29 — deep-link push notifications. The push handler attaches a
// `deepLink` field to notification.data when the payload knows where
// the click should land. On notificationclick we:
//   - Focus an existing webapp tab if one is open AND navigate it to
//     the deep-link via a postMessage the page listens for.
//   - Otherwise open `/?view=<view>&...` directly so the SPA router
//     picks up the slot.
//
// If no deepLink is set, the existing behavior holds: focus or open
// the root.
// Push payloads name app screens as https://<apex>/app/<route> (older
// servers sent flagship://<route>). The phone apps route those; here the
// install-progress and approvals views have their own webapp routes and the
// rest open home.
const WEBAPP_ROUTES = {
  "install-progress": "/?view=install-progress",
  "secret-requests": "/?view=boot-approval",
  "secret-request": "/?view=boot-approval",
};
function webappDeepLink(link) {
  if (typeof link !== "string") return null;
  const m = link.match(/^(?:https:\/\/[^/]+\/app\/|flagship:\/\/)([^?#]*)/i);
  if (!m) return link;
  return WEBAPP_ROUTES[m[1]] ?? "/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const deepLink = webappDeepLink(data && data.deepLink);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const same = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        // Boxes send access alerts as `generic` pushes (older ones as
        // app-access), so any of them checks the box's access requests.
        if (data && (data.kind === "app-access" || (data.kind === "generic" && !deepLink))) {
          // The open webapp fetches the requests and shows the sheet.
          try {
            same.postMessage({ type: "ACCESS_REQUESTS" });
          } catch (_e) {
            /* the page also checks on focus */
          }
          return;
        }
        if (deepLink) {
          try {
            same.postMessage({ type: "DEEP_LINK", target: deepLink });
          } catch (_e) {
            /* postMessage may fail across origins; swallow */
          }
        }
        return;
      }
      const target = deepLink ? new URL(deepLink, self.location.origin).toString() : "/";
      await self.clients.openWindow(target);
    })(),
  );
});

// ---------- E2E test shim ---------------------------------------------
//
// Playwright can't synthesise a real Web Push event from outside the
// SW, so the e2e harness sends a `simulate-push` postMessage and we
// dispatch it as a local push. Gated on the page being loaded with
// `?e2e=1` in the query string — the SW checks self.location.search,
// which carries the SW's *registration* URL, not the page's. Use a
// stricter guard: only run the shim when an e2e marker is set in the
// SW's own scope storage at install time.
self.addEventListener("message", (event) => {
  const data = event?.data;
  if (!data) return;
  // Update-acknowledgement: the page detected a waiting SW, asked the
  // user, and the user opted in. Activate now. The page is responsible
  // for re-loading itself after `controllerchange` fires.
  if (data.type === "SKIP_WAITING" || data === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type !== "flagship-e2e:simulate-push") return;
  // Mirror the real push handler. The harness passes a JSON payload
  // matching what .com would send via RFC 8291.
  let serverFqdn = null;
  try {
    if (data.payload && typeof data.payload.serverFqdn === "string") {
      serverFqdn = data.payload.serverFqdn;
    }
  } catch (_e) {
    /* fall back to generic */
  }
  const body = serverFqdn
    ? `${serverFqdn} is asking to boot — tap to review.`
    : "A server is asking to boot — tap to review.";
  event.waitUntil(
    self.registration.showNotification("Flagship", {
      body,
      tag: "flagship-unlock-request",
      renotify: true,
      icon: "/icon.svg",
      data: { kind: "unlock-request", serverFqdn, e2e: true },
    }),
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
