/**
 * APNs / FCM / Web Push forwarders. Built as a `forwardToProviders`
 * impl plugged into the existing /api/push/relay handler.
 *
 * Platform notes:
 *   - iOS uses APNs (HTTP/2 token-auth, ES256-signed JWT).
 *   - Android uses FCM (HTTP v1 with OAuth2 service-account).
 *   - Webapp uses Web Push (RFC 8030/8292). Same wire shape as the
 *     mobile flows — Worker mints a short-lived VAPID JWT, POSTs to
 *     the per-subscription endpoint URL, browser receives the push
 *     in its service worker.
 *
 * Webapp v1 sends *empty-payload* pushes: the SW shows a generic
 * notification, the user opens the webapp to see which server is
 * asking. This sidesteps the RFC 8291 payload-encryption layer for
 * the first cut. Encrypted payloads are the right next step but the
 * empty-payload path matches our threat model (we don't want
 * server-identifying info in the push payload anyway).
 *
 * Worker secrets:
 *   APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY_PEM, APNS_BUNDLE_ID, APNS_HOST
 *   FCM_SERVICE_ACCOUNT_JSON, FCM_PROJECT_ID
 *   WEBPUSH_VAPID_PRIVATE_KEY_PEM (PKCS8 ES256)
 *   WEBPUSH_VAPID_PUBLIC_KEY_B64URL (uncompressed P-256, base64url)
 *   WEBPUSH_CONTACT (mailto:harry@flagship.services)
 *
 * Web Crypto + the Worker's native fetch are the only runtime deps —
 * no `apns2` / `firebase-admin` / `web-push` SDKs (those drag in
 * 5MB+ each).
 */

import type { FetchLike } from "@flagship/llm-providers";

export interface PushBridgeConfig {
  apns?: {
    keyId: string;
    teamId: string;
    privateKeyPem: string;
    bundleId: string;
    host?: string;
  };
  fcm?: {
    serviceAccountJson: string;
    projectId: string;
  };
  webpush?: {
    /** PKCS8 ES256 private key the Worker uses to sign VAPID JWTs. */
    vapidPrivateKeyPem: string;
    /** Uncompressed P-256 public key (65 bytes), base64url-encoded. */
    vapidPublicKeyB64Url: string;
    /** mailto: URI required by VAPID `sub` claim. */
    contact: string;
  };
  fetchImpl?: FetchLike;
  /** Wall-clock for token caching. Tests inject. */
  now?: () => number;
}

export interface PushTarget {
  tokenId: string;
  platform: "apns" | "fcm" | "webpush";
  providerToken: string;
}

export interface PushFanoutResult {
  ok: boolean;
  sent: number;
  failed: number;
}

/**
 * Build a `forwardToProviders` impl bound to the supplied credentials.
 * The function is what `handlePushRelay` calls — opaque sealed payload
 * goes in, fanout count out.
 *
 * Failure semantics: at-least-one-success returns ok:true. All
 * failures returns ok:false with the failed count. Per-target errors
 * are not surfaced to the caller — push errors should not leak token
 * registration state.
 */
export function buildPushForwarder(cfg: PushBridgeConfig) {
  const fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = cfg.now ?? (() => Date.now());
  const apnsState: { token?: string; mintedAt?: number } = {};
  const fcmState: { token?: string; expiresAt?: number } = {};

  return async function forwardToProviders(args: {
    targets: PushTarget[];
    category: string;
    sealedPayloadHex: string;
  }): Promise<PushFanoutResult> {
    let sent = 0;
    let failed = 0;
    await Promise.all(
      args.targets.map(async (t) => {
        try {
          if (t.platform === "apns" && cfg.apns) {
            await sendApns({
              cfg: cfg.apns,
              providerToken: t.providerToken,
              category: args.category,
              sealedPayloadHex: args.sealedPayloadHex,
              fetchImpl,
              now,
              state: apnsState,
            });
            sent++;
            return;
          }
          if (t.platform === "fcm" && cfg.fcm) {
            await sendFcm({
              cfg: cfg.fcm,
              providerToken: t.providerToken,
              category: args.category,
              sealedPayloadHex: args.sealedPayloadHex,
              fetchImpl,
              now,
              state: fcmState,
            });
            sent++;
            return;
          }
          if (t.platform === "webpush" && cfg.webpush) {
            await sendWebpush({
              cfg: cfg.webpush,
              providerToken: t.providerToken,
              fetchImpl,
              now,
            });
            sent++;
            return;
          }
          // unconfigured platforms count as failed.
          failed++;
        } catch {
          failed++;
        }
      }),
    );
    return { ok: sent > 0, sent, failed };
  };
}

// ────────────────────────────────────────────────────────────────────
// APNs
// ────────────────────────────────────────────────────────────────────

const APNS_TOKEN_TTL_MS = 50 * 60_000; // refresh well under Apple's 60-min cap

async function sendApns(args: {
  cfg: NonNullable<PushBridgeConfig["apns"]>;
  providerToken: string;
  category: string;
  sealedPayloadHex: string;
  fetchImpl: FetchLike;
  now: () => number;
  state: { token?: string; mintedAt?: number };
}): Promise<void> {
  const { cfg, state, now } = args;
  if (!state.token || (state.mintedAt && now() - state.mintedAt > APNS_TOKEN_TTL_MS)) {
    state.token = await mintApnsJwt(cfg, now);
    state.mintedAt = now();
  }
  const url = `https://${cfg.host ?? "api.push.apple.com"}/3/device/${args.providerToken}`;
  const body = JSON.stringify({
    aps: {
      "mutable-content": 1,
      category: args.category,
      // No alert body — the OS extension decrypts before display.
      "thread-id": args.category,
    },
    "flagship-sealed": args.sealedPayloadHex,
  });
  const r = await args.fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `bearer ${state.token}`,
      "apns-push-type": "alert",
      "apns-topic": cfg.bundleId,
      "content-type": "application/json",
    },
    body,
  });
  if (!r.ok) throw new Error(`apns ${r.status}: ${await r.text()}`);
}

async function mintApnsJwt(
  cfg: NonNullable<PushBridgeConfig["apns"]>,
  now: () => number,
): Promise<string> {
  const header = { alg: "ES256", kid: cfg.keyId };
  const payload = { iss: cfg.teamId, iat: Math.floor(now() / 1000) };
  const headerB64 = base64UrlEncodeStr(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await es256Sign(signingInput, cfg.privateKeyPem);
  return `${signingInput}.${sig}`;
}

// ────────────────────────────────────────────────────────────────────
// FCM (HTTP v1)
// ────────────────────────────────────────────────────────────────────

async function sendFcm(args: {
  cfg: NonNullable<PushBridgeConfig["fcm"]>;
  providerToken: string;
  category: string;
  sealedPayloadHex: string;
  fetchImpl: FetchLike;
  now: () => number;
  state: { token?: string; expiresAt?: number };
}): Promise<void> {
  const { cfg, state, now } = args;
  if (!state.token || !state.expiresAt || now() > state.expiresAt) {
    const minted = await mintFcmAccessToken(cfg, args.fetchImpl, now);
    state.token = minted.token;
    // Refresh 5 minutes before nominal expiry.
    state.expiresAt = now() + (minted.expiresInSec - 300) * 1000;
  }
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`;
  const body = JSON.stringify({
    message: {
      token: args.providerToken,
      data: {
        category: args.category,
        sealed: args.sealedPayloadHex,
      },
      android: { priority: "HIGH" },
      apns: { headers: { "apns-priority": "10" } },
    },
  });
  const r = await args.fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
    },
    body,
  });
  if (!r.ok) throw new Error(`fcm ${r.status}: ${await r.text()}`);
}

async function mintFcmAccessToken(
  cfg: NonNullable<PushBridgeConfig["fcm"]>,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<{ token: string; expiresInSec: number }> {
  const sa = JSON.parse(cfg.serviceAccountJson) as {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: tokenUri,
    iat,
    exp: iat + 3600,
  };
  const headerB64 = base64UrlEncodeStr(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await rs256Sign(signingInput, sa.private_key);
  const jwt = `${signingInput}.${sig}`;
  const r = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!r.ok) throw new Error(`fcm token ${r.status}: ${await r.text()}`);
  const tok = (await r.json()) as { access_token: string; expires_in: number };
  return { token: tok.access_token, expiresInSec: tok.expires_in };
}

// ────────────────────────────────────────────────────────────────────
// Web Push (RFC 8030 + VAPID per RFC 8292)
// ────────────────────────────────────────────────────────────────────

/**
 * VAPID JWTs are scoped to a single push-service origin and are
 * cheap to mint (one ES256 sign), so we re-mint per send rather
 * than caching. Spec allows up to 24h validity but we use 12h to be
 * conservative against clock skew.
 */
const VAPID_JWT_TTL_SEC = 12 * 60 * 60;

/** TTL the push service holds the message for if the device is offline. */
const WEBPUSH_DEFAULT_TTL_SEC = 60 * 60; // 1 hour

/**
 * The webapp registered a `PushSubscription` whose `.endpoint` is the
 * URL we POST to. `providerToken` carries the JSON-stringified
 * subscription `{endpoint, keys: {p256dh, auth}}`. For empty-payload
 * pushes only the endpoint matters; the keys are kept for future
 * payload-encryption (RFC 8291) without re-registering the user.
 */
async function sendWebpush(args: {
  cfg: NonNullable<PushBridgeConfig["webpush"]>;
  providerToken: string;
  fetchImpl: FetchLike;
  now: () => number;
}): Promise<void> {
  let sub: { endpoint?: unknown };
  try {
    sub = JSON.parse(args.providerToken);
  } catch {
    throw new Error("webpush providerToken is not valid JSON");
  }
  if (typeof sub.endpoint !== "string" || !/^https?:\/\//.test(sub.endpoint)) {
    throw new Error("webpush providerToken missing valid endpoint URL");
  }
  const endpointUrl = new URL(sub.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await mintVapidJwt({
    audience,
    contact: args.cfg.contact,
    privateKeyPem: args.cfg.vapidPrivateKeyPem,
    now: args.now,
  });

  // Empty-payload push: no body, no Content-Encoding, no Crypto-Key
  // beyond what VAPID requires. The browser receives a `push` event
  // with `event.data === null` and the SW shows a generic notification.
  const r = await args.fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${jwt}, k=${args.cfg.vapidPublicKeyB64Url}`,
      ttl: String(WEBPUSH_DEFAULT_TTL_SEC),
      "content-length": "0",
    },
  });
  // 201 Created (push queued) is the success case. 410 Gone means
  // the subscription was revoked client-side; surface that so the
  // caller can prune the dead token. Other 4xx/5xx are treated as
  // failures (counted against `failed` upstream).
  if (r.status === 410 || r.status === 404) {
    throw new Error("webpush 410: subscription gone (prune)");
  }
  if (!r.ok) throw new Error(`webpush ${r.status}: ${await r.text()}`);
}

async function mintVapidJwt(args: {
  audience: string;
  contact: string;
  privateKeyPem: string;
  now: () => number;
}): Promise<string> {
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    aud: args.audience,
    exp: Math.floor(args.now() / 1000) + VAPID_JWT_TTL_SEC,
    sub: args.contact,
  };
  const headerB64 = base64UrlEncodeStr(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await es256Sign(signingInput, args.privateKeyPem);
  return `${signingInput}.${sig}`;
}

// ────────────────────────────────────────────────────────────────────
// JWT signing helpers (Web Crypto)
// ────────────────────────────────────────────────────────────────────

async function es256Sign(input: string, pkcs8Pem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input),
  );
  return base64UrlEncodeBytes(new Uint8Array(sigBuf));
}

async function rs256Sign(input: string, pkcs8Pem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return base64UrlEncodeBytes(new Uint8Array(sigBuf));
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncodeStr(s: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(s));
}

function base64UrlEncodeBytes(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
