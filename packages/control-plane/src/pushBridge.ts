/**
 * APNs (HTTP/2 token-auth) + FCM (HTTP v1 with OAuth2 service-account)
 * push forwarders. Built as a `forwardToProviders` impl plugged into
 * the existing /api/push/relay handler.
 *
 * The Worker holds the credentials in environment secrets:
 *
 *   APNS_KEY_ID          (10-char Apple key id)
 *   APNS_TEAM_ID         (10-char Apple team id)
 *   APNS_PRIVATE_KEY_PEM (PKCS8 ES256 — the .p8 file content)
 *   APNS_BUNDLE_ID       (e.g. "com.flagship.app")
 *   APNS_HOST            ("api.push.apple.com" or "api.sandbox.push.apple.com")
 *
 *   FCM_SERVICE_ACCOUNT_JSON  (full JSON of a service account with
 *                              `firebase.messaging.v1.sender` permission)
 *   FCM_PROJECT_ID            (Firebase project id)
 *
 * These let .com mint short-lived JWT/OAuth tokens on demand and
 * forward sealed payloads. The notification body stays opaque to
 * Apple / Google: only the `category` and the sealed-bytes hex live
 * in the wire payload.
 *
 * Web Crypto + the Worker's native fetch are the only runtime deps —
 * no `apns2` / `firebase-admin` SDKs (those drag in 5MB+ each).
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
          // webpush + unconfigured platforms count as failed.
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
