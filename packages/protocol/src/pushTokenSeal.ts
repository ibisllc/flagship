/**
 * Sealed push tokens (docs/voici-calls.md "Who may call a page, and ringing a caller back"; "The sealed-token push
 * relay"): an app never gives `.com` a raw push token. It seals the token, with fresh randomness every time, to the
 * push relay's key (the Rust relay on Fly, `rust/crates/flagship-relay/src/push.rs`); `.com` stores only the sealed
 * blob and hands it to the relay with a content-free payload; the relay opens it and talks to APNs, FCM or the
 * UnifiedPush / Web Push endpoint. `.com` sees which account or conversation a push is for, never a token; the relay
 * sees tokens, never accounts or conversations.
 *
 *   sealed   flagship/hybrid-seal/v1, purpose "flagship/push-token/v1", context ["flagship/push-token/v1"],
 *            to the relay's push key (X-Wing), senderKeyId 32 fresh random bytes, issuedAt the seal's UTC day (ms)
 *   plain    canonical JSON, exactly one of:
 *              {v:1, platform:"apns" | "apns-voip", token (hex 64..200), env:"production" | "sandbox", topic}
 *              {v:1, platform:"fcm", token (1..4096 chars of [A-Za-z0-9_:-])}
 *              {v:1, platform:"unifiedpush", endpoint (https URL ≤ 2048)}
 *              {v:1, platform:"webpush", endpoint (https URL ≤ 2048), p256dh (b64url of 65 bytes), auth (b64url of 16)}
 *            topic: the app's bundle id (apns) or "<bundle id>.voip" (apns-voip), [A-Za-z0-9.-]{1,200}
 *
 * The relay's key is pinned in the apps and on voi.ci (PUSH_RELAY_SEAL_KEY below, empty until the key is made at
 * deploy): `.com` hands it out nowhere, so it can't swap in a key of its own and read the tokens.
 */
import { hybridOpen, hybridSealWithRandomness, HYBRID_SEAL_RANDOMNESS_LEN, parseHybridSealPublicKey } from "./pqHybrid.js";
import type { Bytes } from "./types.js";
import { b64Decode, b64Encode, canonicalJsonBytes } from "./webEnvelope.js";

export const TAG_PUSH_TOKEN = "flagship/push-token/v1";
/** Largest sealed token `.com` takes (the plaintext is at most a few KiB). */
export const PUSH_TOKEN_SEALED_MAX = 8 * 1024;
export const SEALED_PUSH_PLATFORMS = ["apns", "apns-voip", "fcm", "unifiedpush", "webpush"] as const;
export type SealedPushPlatform = (typeof SEALED_PUSH_PLATFORMS)[number];

/**
 * The relay's push key, pinned (X-Wing public key, hex). Empty until the owner makes the key at deploy
 * (docs/runbooks/push-relay-key.md); while empty the apps keep registering raw tokens and `.com` keeps its own
 * senders (the PUSH_RELAY switch is off).
 */
export const PUSH_RELAY_SEAL_KEY: { pub: string; keyId: string } = Object.freeze({ pub: "", keyId: "" });

export type PushTokenPlain =
  | { v: 1; platform: "apns" | "apns-voip"; token: string; env: "production" | "sandbox"; topic: string }
  | { v: 1; platform: "fcm"; token: string }
  | { v: 1; platform: "unifiedpush"; endpoint: string }
  | { v: 1; platform: "webpush"; endpoint: string; p256dh: string; auth: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (r: Record<string, unknown>, keys: string[]) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));
const TOPIC = /^[A-Za-z0-9.-]{1,200}$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const FCM_TOKEN = /^[A-Za-z0-9_:-]{1,4096}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const b64uLen = (s: unknown): number => {
  if (typeof s !== "string" || !B64U.test(s) || s.length % 4 === 1) return -1;
  return Math.floor((s.length * 3) / 4);
};
function httpsUrl(s: unknown): boolean {
  if (typeof s !== "string" || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hash === "" && u.href === s;
  } catch {
    return false;
  }
}

/** Strict shape of a token's plaintext; null when it isn't one. */
export function parsePushTokenPlain(v: unknown): PushTokenPlain | null {
  if (!isObj(v) || v.v !== 1) return null;
  switch (v.platform) {
    case "apns":
    case "apns-voip":
      if (!exactKeys(v, ["v", "platform", "token", "env", "topic"]) || typeof v.token !== "string" || !APNS_TOKEN.test(v.token)) return null;
      if ((v.env !== "production" && v.env !== "sandbox") || typeof v.topic !== "string" || !TOPIC.test(v.topic)) return null;
      if (v.platform === "apns-voip" ? !v.topic.endsWith(".voip") : v.topic.endsWith(".voip")) return null;
      return v as PushTokenPlain;
    case "fcm":
      return exactKeys(v, ["v", "platform", "token"]) && typeof v.token === "string" && FCM_TOKEN.test(v.token) ? (v as PushTokenPlain) : null;
    case "unifiedpush":
      return exactKeys(v, ["v", "platform", "endpoint"]) && httpsUrl(v.endpoint) ? (v as PushTokenPlain) : null;
    case "webpush":
      return exactKeys(v, ["v", "platform", "endpoint", "p256dh", "auth"]) && httpsUrl(v.endpoint) && b64uLen(v.p256dh) === 65 && b64uLen(v.auth) === 16 ? (v as PushTokenPlain) : null;
    default:
      return null;
  }
}

const DAY_MS = 86_400_000;

/**
 * Seals a token to the relay's key. `randomness` = 32 bytes of sender key id then 64 of encapsulation randomness,
 * fresh every call (two seals of one token never match); fixed only in vectors.
 */
export function sealPushToken(relayPub: Bytes, plain: PushTokenPlain, now: number, randomness: Bytes = crypto.getRandomValues(new Uint8Array(32 + HYBRID_SEAL_RANDOMNESS_LEN))): Bytes {
  if (!parsePushTokenPlain(plain)) throw new Error(`${TAG_PUSH_TOKEN}: bad token`);
  if (randomness.length !== 32 + HYBRID_SEAL_RANDOMNESS_LEN) throw new Error(`${TAG_PUSH_TOKEN}: bad randomness`);
  return hybridSealWithRandomness(
    parseHybridSealPublicKey(relayPub),
    { purpose: TAG_PUSH_TOKEN, senderKeyId: randomness.slice(0, 32), issuedAt: Math.floor(now / DAY_MS) * DAY_MS },
    [new TextEncoder().encode(TAG_PUSH_TOKEN)],
    canonicalJsonBytes(plain),
    randomness.slice(32),
  );
}

/** The relay's side: the token, or null for anything that doesn't open or isn't exactly a token. */
export function openPushToken(relaySeed: Bytes, sealed: Bytes): PushTokenPlain | null {
  if (sealed.length > PUSH_TOKEN_SEALED_MAX) return null;
  try {
    const { plaintext } = hybridOpen(relaySeed, TAG_PUSH_TOKEN, [new TextEncoder().encode(TAG_PUSH_TOKEN)], sealed);
    return parsePushTokenPlain(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
  } catch {
    return null;
  }
}

/** What `.com` checks of a sealed token it stores: base64, a size bound. It can't open it. */
export function parseSealedPushToken(b64: unknown): Bytes | null {
  if (typeof b64 !== "string" || b64.length > Math.ceil(PUSH_TOKEN_SEALED_MAX / 3) * 4) return null;
  try {
    const b = b64Decode(b64);
    return b && b.length > 0 && b64Encode(b) === b64 ? b : null;
  } catch {
    return null;
  }
}

// ── .com → relay: a delivery request (docs/voici-calls.md "The sealed-token push relay") ─────────────────────

export const TAG_PUSH_RELAY_DELIVER = "flagship/push-relay-deliver/v1";
export const PUSH_RELAY_SKEW_MS = 5 * 60_000;
export const PUSH_RELAY_MAX_ITEMS = 100;
/** A content-free payload: at most 16 string fields of at most 2 KiB together (a sealed ring hint fits). */
export const PUSH_PAYLOAD_MAX_BYTES = 3 * 1024;

export interface PushRelayItem {
  sealed: string;
  /** String fields only; no field may carry message text (the callers send ids and sealed blobs). */
  payload: Record<string, string>;
  /** "call" rings (APNs VoIP / FCM high priority); "alert" a normal visible push; "silent" wakes the app. */
  kind: "call" | "alert" | "silent";
  expiresAt: number;
}

export interface PushRelayDeliver {
  v: 1;
  issuedAt: number;
  nonce: string;
  items: PushRelayItem[];
}

/** Bytes the relay's MAC covers: `flagship/push-relay-deliver/v1|<issuedAt>|<nonce>|<sha256 hex of the body>`. */
export function pushRelayMacInput(issuedAt: number, nonce: string, bodySha256Hex: string): Bytes {
  return new TextEncoder().encode([TAG_PUSH_RELAY_DELIVER, String(issuedAt), nonce, bodySha256Hex].join("|"));
}

/** Strict shape of a delivery body; null when it isn't one. */
export function parsePushRelayDeliver(v: unknown): PushRelayDeliver | null {
  if (!isObj(v) || !exactKeys(v, ["v", "issuedAt", "nonce", "items"]) || v.v !== 1 || !Number.isSafeInteger(v.issuedAt) || typeof v.nonce !== "string" || !/^[0-9a-f]{32}$/.test(v.nonce)) return null;
  if (!Array.isArray(v.items) || v.items.length === 0 || v.items.length > PUSH_RELAY_MAX_ITEMS) return null;
  for (const it of v.items) {
    if (!isObj(it) || !exactKeys(it, ["sealed", "payload", "kind", "expiresAt"]) || !parseSealedPushToken(it.sealed)) return null;
    if (it.kind !== "call" && it.kind !== "alert" && it.kind !== "silent") return null;
    if (!Number.isSafeInteger(it.expiresAt) || !isObj(it.payload)) return null;
    const payload = it.payload as Record<string, unknown>;
    const ks = Object.keys(payload);
    if (ks.length > 16 || ks.some((k) => !/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/.test(k) || typeof payload[k] !== "string")) return null;
    if (new TextEncoder().encode(JSON.stringify(it.payload)).length > PUSH_PAYLOAD_MAX_BYTES) return null;
  }
  return v as unknown as PushRelayDeliver;
}

