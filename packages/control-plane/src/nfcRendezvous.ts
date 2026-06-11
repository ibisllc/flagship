/**
 * C3 — NFC rendezvous (cloud-side drop-box for the tap-to-pair flow).
 *
 * Two endpoints, both unauthenticated at this layer because the blob
 * carried over them is AES-GCM AEAD-sealed under the K_session both
 * sides independently derived from the NFC tap's ECDH. The cloud is a
 * pure opaque drop-box; anyone who guesses both a live rendezvousId
 * AND the blob format can deposit garbage, but the box will fail to
 * decrypt non-genuine deposits under its independently-derived key.
 *
 *   POST /api/nfc/rendezvous/:rendezvousId/wifi
 *     Body: { sealedHex: string; nonceHex: string }
 *     Phone deposits the protocol deposit blob (ePhonePub(32) ||
 *     AEAD ciphertext — see buildWifiDepositBlob in
 *     @flagship/protocol/nfcPair.ts; opaque at this layer). Idempotent
 *     overwrite on retry (e.g. typo'd password + re-tap).
 *
 *   GET  /api/nfc/rendezvous/:rendezvousId/wifi
 *     Box polls the slot. One-shot: a successful read deletes the
 *     blob, so a stale slot doesn't linger.
 *
 * Edge protections (applied by the route layer, NOT this handler):
 *   - per-IP + per-rendezvousId rate limiting
 *   - 8 KB body cap on POST (sealed WiFi config is well under 1 KB)
 *
 * See docs/v1-operational-tasks.md § N-CLOUD and
 *     packages/storage/migrations/0040_nfc_rendezvous.sql
 */

import type { NfcRendezvousStorage } from "@flagship/storage";
import { malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/** Phone-deposit body shape — anything else is rejected at the edge. */
interface DepositBody {
  sealedHex?: unknown;
  nonceHex?: unknown;
}

export interface NfcRendezvousDeps {
  rendezvous: NfcRendezvousStorage;
  /** Per-slot TTL on deposit. Default 15 min. */
  ttlMs?: number;
  now?: () => number;
}

const HEX_RE = /^[0-9a-f]+$/i;
/** Matches the shape of PairHint.cloudRendezvousId path segments. The
 *  daemon's buildPairHint emits `<base>/<suffix6>` today but the slot
 *  key can be any url-safe identifier; constrain the surface to keep
 *  the table key set bounded. */
const RENDEZVOUS_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 8 KB sealed blob = 16384 hex chars. Real WiFi-config sealed
 *  payloads are well under 1 KB; this is the abuse cap, not the
 *  expected size. */
const MAX_SEALED_HEX_LEN = 8192 * 2;
/** AES-GCM nonces are 12 bytes = 24 hex chars; reject anything else
 *  outright so a deposit with the wrong nonce shape can't waste a slot
 *  the legitimate phone-side would otherwise overwrite. */
const NONCE_HEX_LEN = 24;
const DEFAULT_TTL_MS = 15 * 60_000;

function isHexString(v: unknown, maxLen: number): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > maxLen) return false;
  if (v.length % 2 !== 0) return false;
  return HEX_RE.test(v);
}

export async function handleNfcRendezvousDeposit(
  deps: NfcRendezvousDeps,
  rendezvousId: string,
  body: DepositBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (typeof rendezvousId !== "string" || !RENDEZVOUS_ID_RE.test(rendezvousId)) {
    return malformed("malformed rendezvousId");
  }
  if (!body || typeof body !== "object") {
    return malformed("malformed body");
  }
  if (!isHexString(body.sealedHex, MAX_SEALED_HEX_LEN)) {
    return malformed("sealedHex must be non-empty hex within 8 KB");
  }
  if (
    typeof body.nonceHex !== "string" ||
    body.nonceHex.length !== NONCE_HEX_LEN ||
    !HEX_RE.test(body.nonceHex)
  ) {
    return malformed("nonceHex must be 24 hex chars (12-byte AEAD nonce)");
  }

  const now = (deps.now ?? (() => Date.now()))();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = now + ttlMs;

  await deps.rendezvous.put({
    rendezvousId,
    sealedHex: body.sealedHex.toLowerCase(),
    nonceHex: body.nonceHex.toLowerCase(),
    depositedAt: now,
    expiresAt,
  });

  return ok({ ok: true, expiresAt });
}

export async function handleNfcRendezvousConsume(
  deps: NfcRendezvousDeps,
  rendezvousId: string,
): Promise<HandlerResponseWithHeaders> {
  if (typeof rendezvousId !== "string" || !RENDEZVOUS_ID_RE.test(rendezvousId)) {
    return malformed("malformed rendezvousId");
  }
  const now = (deps.now ?? (() => Date.now()))();
  const rec = await deps.rendezvous.consume(rendezvousId, now);
  if (!rec) return notFound("no pending rendezvous");
  return ok({
    rendezvousId: rec.rendezvousId,
    sealedHex: rec.sealedHex,
    nonceHex: rec.nonceHex,
    depositedAt: rec.depositedAt,
  });
}
