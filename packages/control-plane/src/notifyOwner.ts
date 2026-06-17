/**
 * `POST /api/internal/notify-owner` — the identity-plane half of the
 * boot worker's NOTIFY PIPE.
 *
 * The dedicated boot worker (boot.flagshipserver.com) holds NO push
 * secrets. When a box announces it needs approval, the boot worker calls
 * THIS endpoint over an authenticated server-to-server channel. The
 * identity plane is the only place push secrets (APNs/FCM/VAPID) live, so
 * it does the actual fan-out.
 *
 * Trust posture (mirrors handlePostSecretRequest):
 *   - The shared secret authenticates the CALLER (the boot worker), not
 *     the request content.
 *   - The `signedRequest` is RE-VERIFIED here against this directory's
 *     bound STK for the serverDomain. We do NOT trust the boot worker's
 *     echo — a compromised boot worker still cannot make the phone seal
 *     for a box it doesn't own (the STK must match the registered
 *     server, exactly as the direct /secret-request path requires).
 *   - The owning account is resolved from the directory; only ITS push
 *     tokens are woken.
 *   - Per-account rate limit + per-(serverDomain, nonce) dedup bound a
 *     noisy or hostile boot worker.
 */

import { verifySecretRequest, type SecretPurpose, type SecretRequest } from "@flagship/protocol";
import type {
  SecretMailboxPurpose,
  SecretMailboxStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, equalHex, equalToken, hexToBytes } from "./hex.js";
import { conflict, forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

const DEFAULT_MAX_AGE = 5 * 60_000;
const DEFAULT_MAILBOX_TTL = 5 * 60_000;
const DEFAULT_PUSH_DEDUP_MS = 60_000;
/** Per-account cap on notify-driven pushes within the rate window. */
const DEFAULT_RATE_MAX = 10;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const HEX_NONCE = /^[0-9a-f]{64}$/;

const PURPOSES: ReadonlySet<SecretMailboxPurpose> = new Set<SecretMailboxPurpose>([
  "unlock-key",
  "entitlement",
]);

export interface NotifyOwnerDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  secretMailbox: SecretMailboxStorage;
  /** The shared secret the boot worker sends in `x-boot-notify-secret`.
   *  Absent ⇒ the endpoint is disabled (503). */
  notifySharedSecret?: string;
  /** Push fan-out — same closure shape as the relay handlers. Absent ⇒
   *  no push (the endpoint still parks the row + returns ok). */
  pushUserDevices?: (username: string, category: string, payload?: Uint8Array) => Promise<void>;
  maxAgeMs?: number;
  mailboxTtlMs?: number;
  /** Skip pushing if a push for this (serverDomain, nonce) fired within
   *  this window — per-nonce dedup. */
  pushDedupMs?: number;
  /** Per-account in-window push cap. */
  rateMax?: number;
  rateWindowMs?: number;
  now?: () => number;
}

/** Module-scoped per-account rate ledger (best-effort; resets per
 *  isolate). The hard dedup lives in the mailbox row's lastPushAt; this
 *  is a cheap extra ceiling on a hostile boot worker hammering one
 *  account with fresh nonces. */
const rateLedger = new Map<string, number[]>();

export async function handleNotifyOwner(
  deps: NotifyOwnerDeps,
  headerSecret: string | null | undefined,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const ttlMs = deps.mailboxTtlMs ?? DEFAULT_MAILBOX_TTL;
  const pushDedupMs = deps.pushDedupMs ?? DEFAULT_PUSH_DEDUP_MS;
  const rateMax = deps.rateMax ?? DEFAULT_RATE_MAX;
  const rateWindowMs = deps.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;

  if (!deps.notifySharedSecret) {
    return { status: 503, body: { error: "notify-owner not configured" } };
  }
  if (typeof headerSecret !== "string" || !equalToken(headerSecret, deps.notifySharedSecret)) {
    return { status: 401, body: { error: "bad notify secret" } };
  }

  const b = body as {
    serverDomain?: unknown;
    purpose?: unknown;
    signedRequest?: { request?: Record<string, unknown>; signature?: unknown; deviceInfo?: unknown };
  };
  if (typeof b?.serverDomain !== "string" || typeof b?.purpose !== "string") {
    return malformed("malformed body");
  }
  if (!PURPOSES.has(b.purpose as SecretMailboxPurpose)) {
    return malformed("unknown purpose");
  }
  const sr = b.signedRequest ?? {};
  const r = sr.request ?? {};
  if (
    typeof r.serverDomain !== "string" ||
    typeof r.stkPub !== "string" ||
    typeof r.purpose !== "string" ||
    typeof r.nonce !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof sr.signature !== "string"
  ) {
    return malformed("malformed signedRequest");
  }
  if (r.serverDomain !== b.serverDomain) {
    return malformed("serverDomain mismatch");
  }
  if (r.purpose !== b.purpose) {
    return malformed("purpose mismatch");
  }
  if (!HEX_NONCE.test(r.nonce.toLowerCase())) {
    return malformed("nonce must be 32 bytes hex");
  }
  if (!HEX64.test(r.stkPub.toLowerCase())) {
    return malformed("stkPub must be 32 bytes hex");
  }
  if (!HEX128.test(sr.signature.toLowerCase())) {
    return malformed("signature must be 64 bytes hex");
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  const reg = await deps.servers.get(b.serverDomain);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");

  // RE-VERIFY against the directory — the boot worker's echo is NOT
  // trusted. The posting STK must be the directory-bound STK for this
  // domain, and the signature must verify under it.
  if (!equalHex(r.stkPub, reg.identityPubKeyHex)) {
    return forbidden("stkPub does not match the registered server");
  }
  let stkPub: Uint8Array;
  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    stkPub = hexToBytes(r.stkPub);
    nonce = hexToBytes(r.nonce);
    sig = hexToBytes(sr.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: SecretRequest = {
    serverDomain: b.serverDomain,
    stkPub,
    purpose: r.purpose as SecretPurpose,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifySecretRequest(claim, sig, stkPub)) {
    return forbidden("invalid signature");
  }

  // Per-account rate ceiling.
  if (!rateAllow(rateLedger, reg.username.toLowerCase(), now(), rateMax, rateWindowMs)) {
    return { status: 429, body: { error: "rate limited" } };
  }

  // Park / refresh a pending mailbox row keyed by (serverDomain, nonce).
  // This both surfaces the request to the phone's existing
  // /api/secret-requests listing AND carries the per-nonce dedup state
  // (lastPushAt). A duplicate nonce is not an error — it means the box
  // re-announced; we collapse to the existing row.
  const nonceHex = r.nonce.toLowerCase();
  let deviceInfoJson: string | null = null;
  if (sr.deviceInfo !== undefined && sr.deviceInfo !== null) {
    if (typeof sr.deviceInfo === "object" && JSON.stringify(sr.deviceInfo).length <= 4096) {
      deviceInfoJson = JSON.stringify(sr.deviceInfo);
    }
  }
  const put = await deps.secretMailbox.putRequest({
    serverDomain: b.serverDomain,
    username: reg.username,
    requestNonceHex: nonceHex,
    stkPubHex: r.stkPub.toLowerCase(),
    purpose: r.purpose as SecretMailboxPurpose,
    requestIssuedAt: r.issuedAt,
    requestSignatureHex: sr.signature.toLowerCase(),
    deviceInfoJson,
    postedAt: now(),
    expiresAt: now() + ttlMs,
    lastPushAt: 0,
    responseSealedHex: null,
    responseIssuedAt: null,
    respondedAt: null,
    consumedAt: null,
  });
  if (!put.ok && put.reason !== "duplicate nonce") {
    return conflict(put.reason);
  }
  if (!put.ok) {
    // Existing row — dedup the push by lastPushAt.
    const existing = await deps.secretMailbox.getRequest(b.serverDomain, nonceHex);
    if (existing && existing.expiresAt > now() && now() - existing.lastPushAt < pushDedupMs) {
      return { status: 200, body: { ok: true, requestNonceHex: nonceHex, deduped: true } };
    }
  }

  // Fire the push. Mark lastPushAt first so a concurrent re-notify within
  // the window dedups even if the push round-trip is slow.
  if (deps.pushUserDevices) {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        kind: "secret-request",
        serverFqdn: b.serverDomain,
        purpose: b.purpose,
        requestNonceHex: nonceHex,
        signedRequest: { request: r, signature: sr.signature, ...(deviceInfoJson ? { deviceInfo: JSON.parse(deviceInfoJson) } : {}) },
      }),
    );
    await deps.secretMailbox.touchLastPushAt(b.serverDomain, nonceHex, now());
    void deps.pushUserDevices(reg.username, "secret-request", payload).catch(() => {});
  } else {
    await deps.secretMailbox.touchLastPushAt(b.serverDomain, nonceHex, now());
  }

  return { status: 200, body: { ok: true, requestNonceHex: nonceHex, expiresAt: now() + ttlMs } };
}

function rateAllow(
  ledger: Map<string, number[]>,
  key: string,
  now: number,
  max: number,
  windowMs: number,
): boolean {
  const arr = (ledger.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    ledger.set(key, arr);
    return false;
  }
  arr.push(now);
  ledger.set(key, arr);
  return true;
}

/** Test hook — reset the per-isolate rate ledger between cases. */
export function _resetNotifyOwnerRateLedger(): void {
  rateLedger.clear();
}
