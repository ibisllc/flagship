import { verifyPutSealedLuksKey, type PutSealedLuksKey } from "@flagship/protocol";
import type { LuksKeyStorage, ServerStorage, UsernameStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/**
 * The disk key `.com` holds sealed for the account (never readable here).
 *
 * `POST   /api/server/:host/sealed-luks-key`   server identity-signed
 * `GET    /api/server/:host/sealed-luks-key`   public (sealed against the account key)
 *
 * The :host parameter must equal the `serverId` field inside the signed
 * request — defense in depth against a bug that mis-routes between hosts.
 *
 * A box unlocks from the box-sealed lease (secretMailbox.ts lease-v2, the
 * boot worker's /api/boot/lease) or the phone relay. The plaintext lease
 * (auto-unlock-lease/v1 and its /unlock-key/consume release) is gone: `.com`
 * never stores a key it can read.
 */
export interface LuksKeyDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  luksKeys: LuksKeyStorage;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

export async function handlePutSealedLuksKey(
  deps: LuksKeyDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.sealedKey !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.serverId !== host) {
    return forbidden("serverId / host mismatch");
  }
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    sealedKey = hexToBytes(r.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: PutSealedLuksKey = {
    serverId: host,
    sealedKey,
    issuedAt: r.issuedAt,
  };
  if (!verifyPutSealedLuksKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return forbidden("invalid signature");
  }

  await deps.luksKeys.putSealed({
    serverDomain: host,
    sealedKeyHex: r.sealedKey,
    sealedAt: now(),
  });
  return { status: 200, body: { ok: true } };
}

/**
 * #48 — public-read decision (M4).
 *
 * This endpoint is intentionally UNAUTHENTICATED. The audit raised
 * the concern that returning the sealed LUKS key ciphertext to any
 * caller enables an attacker to enumerate which serverDomains have
 * a deposit on file. After deliberation in the Thread-G design pass:
 *
 * DECISION: accept the metadata leak. Reasoning:
 *   - The CONTENT is sealed against BAK, which lives only on the
 *     user's phone (or webapp peer device). Without BAK, the
 *     ciphertext is unusable — no offline attack works against
 *     well-chosen BAK material.
 *   - The bootstrap flow needs to fetch this WITHOUT authentication,
 *     because at boot the daemon has only the disk's pubkey material,
 *     not an IRK-bound session.
 *   - Per-IP rate limit (apps/com /rateLimit binding, #9) bounds the
 *     enumeration cost.
 *
 * PATH TO CLOSURE if we ever decide to gate further:
 *   - Require an IRK-signed fetch envelope, which would mean the boot
 *     stage needs to carry the IRK pubkey + a fresh signature from
 *     the phone via the LUKS unlock approval flow.
 *   - That couples boot-time unlock with phone reachability more
 *     tightly than the current design wants.
 *   - DO NOT add the gate without revisiting the boot-stage protocol.
 *
 * In short: this endpoint is public-by-design and reviewed.
 */
export async function handleGetSealedLuksKey(
  deps: LuksKeyDeps,
  host: string,
): Promise<HandlerResponse> {
  const rec = await deps.luksKeys.getSealed(host);
  if (!rec) return notFound("no sealed key on file");
  return {
    status: 200,
    body: {
      serverDomain: rec.serverDomain,
      sealedKey: rec.sealedKeyHex,
      sealedAt: rec.sealedAt,
    },
  };
}
