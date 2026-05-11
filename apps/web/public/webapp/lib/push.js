// Web Push subscription helper for the webapp.
//
// Sister implementations on iOS (APNs) + Android (FCM) live in
// apps/mobile/. The wire shape on .com is unified: all three
// platforms POST /api/push/register with platform=apns|fcm|webpush
// and an opaque providerToken — for webpush we serialize the
// PushSubscription's {endpoint, keys} as JSON.
//
// Empty-payload pushes for v1: the SW shows a generic notification
// and the user opens the webapp to see which server is asking.
// RFC 8291 payload encryption can land later without re-registering.

import { bytesToHex, hexToBytes, signWithIrk } from "../keystore.js";
import { getSession } from "./state.js";

const APEX = "https://flagshipserver.com";

/**
 * Returns the VAPID public key (base64url) the webapp uses to call
 * `pushManager.subscribe`. Fetched from .com so the key can rotate
 * without a webapp deploy. Cached in localStorage to avoid a round
 * trip on every settings open; cache is invalidated by the value
 * itself changing (we always re-fetch and overwrite).
 */
export async function fetchVapidPublicKey() {
  const r = await fetch(`${APEX}/api/push/vapid-public-key`);
  if (!r.ok) throw new Error(`vapid key fetch failed: ${r.status}`);
  const body = await r.json();
  if (typeof body.key !== "string") {
    throw new Error("vapid key response missing 'key' field");
  }
  localStorage.setItem("flagship.vapidPublicKey", body.key);
  return body.key;
}

/** True iff the browser supports the bits we need. */
export function webPushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Current permission state — "default" | "granted" | "denied". */
export function notificationPermission() {
  return webPushSupported() ? Notification.permission : "denied";
}

/**
 * Subscribe to Web Push and register the subscription with .com so
 * the Worker can fan out notifications to this device. Returns
 * `{ tokenId }` on success.
 *
 * Caller is expected to be inside a user gesture (Notification
 * permission prompt is gated on that in most browsers).
 */
export async function subscribeToWebPush() {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  if (!session.username) throw new Error("username required");
  if (!webPushSupported()) throw new Error("Web Push not supported in this browser");

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(`notification permission: ${perm}`);

  const reg = await navigator.serviceWorker.ready;
  const vapidPubB64Url = await fetchVapidPublicKey();

  // PushManager wants the application server key as a Uint8Array
  // (raw uncompressed P-256 public key, 65 bytes).
  const vapidPubBytes = base64UrlToBytes(vapidPubB64Url);

  // Re-use an existing subscription if one is present and matches
  // our VAPID key. Browsers throw `InvalidStateError` on subscribe
  // when there's already a subscription with a *different* key.
  const existing = await reg.pushManager.getSubscription();
  if (existing && !sameKey(existing.options?.applicationServerKey, vapidPubBytes)) {
    await existing.unsubscribe();
  }
  const sub = existing ?? (await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPubBytes,
  }));

  const providerToken = JSON.stringify({
    endpoint: sub.endpoint,
    keys: subKeysToHexJson(sub),
  });
  return registerWithCom({ session, providerToken });
}

/**
 * Unsubscribe locally + tell .com to drop the token. The .com side
 * needs the tokenId; we fetch it from local storage if we kept it,
 * otherwise we just drop the push subscription and accept that the
 * row on .com lingers until garbage collection.
 */
export async function unsubscribeFromWebPush() {
  if (!webPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  const tokenId = localStorage.getItem("flagship.pushTokenId");
  if (tokenId) {
    const session = getSession();
    if (session.umk) {
      const issuedAt = Date.now();
      const canonical = canonicalRevoke({ tokenId, issuedAt });
      const sig = await signWithIrk(session.umk, canonical);
      await fetch(`${APEX}/api/push/${encodeURIComponent(tokenId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: { tokenId, issuedAt },
          signature: bytesToHex(sig),
        }),
      }).catch(() => { /* best-effort */ });
    }
    localStorage.removeItem("flagship.pushTokenId");
  }
}

// ---- internals ----

async function registerWithCom({ session, providerToken }) {
  const issuedAt = Date.now();
  // The /api/push/register handler expects an X25519 pubkey for
  // future sealed-payload routing. For empty-payload v1 we still
  // need to provide one so the row is well-formed; generate an
  // ephemeral one. (Encrypted payloads will land that key into
  // RFC 8291 use later.)
  const pushX25519Pub = randBytes(32);

  const canonical = canonicalRegister({
    username: session.username,
    platform: "webpush",
    providerToken,
    pushX25519Pub,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);
  const r = await fetch(`${APEX}/api/push/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: {
        username: session.username,
        platform: "webpush",
        providerToken,
        pushX25519Pub: bytesToHex(pushX25519Pub),
        issuedAt,
      },
      signature: bytesToHex(sig),
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`push/register failed: ${r.status} ${txt}`.trim());
  }
  const body = await r.json();
  if (typeof body.tokenId === "string") {
    localStorage.setItem("flagship.pushTokenId", body.tokenId);
  }
  return { tokenId: body.tokenId };
}

// Pinned to the canonical-bytes shapes in @flagship/protocol.
function canonicalRegister({ username, platform, providerToken, pushX25519Pub, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/push-token-register/v1",
      username,
      platform,
      providerToken,
      bytesToHex(pushX25519Pub),
      issuedAt,
    ].join("|"),
  );
}

function canonicalRevoke({ tokenId, issuedAt }) {
  return new TextEncoder().encode(
    ["flagship/push-token-revoke/v1", tokenId, issuedAt].join("|"),
  );
}

function subKeysToHexJson(sub) {
  // PushSubscription.getKey returns ArrayBuffer | null. Encode as
  // base64url for transport (the spec format) — .com forwards
  // bytes-as-bytes when we eventually wire encrypted payloads.
  const out = {};
  for (const name of ["p256dh", "auth"]) {
    const buf = sub.getKey?.(name);
    if (buf) out[name] = bytesToBase64Url(new Uint8Array(buf));
  }
  return out;
}

function sameKey(a, b) {
  if (!a) return false;
  const ab = a instanceof Uint8Array ? a : new Uint8Array(a);
  if (ab.length !== b.length) return false;
  for (let i = 0; i < ab.length; i++) if (ab[i] !== b[i]) return false;
  return true;
}

function base64UrlToBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// hexToBytes is imported but not used directly in this module — kept
// for potential future use (e.g., decoding rotated VAPID keys).
void hexToBytes;
