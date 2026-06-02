/**
 * Per-box cert routing revocation (per-user-cert design §5.1–5.2, task #27).
 *
 * Revocation of a box from the user's shared `[<user>, *.<user>]` cert is
 * enforced at the ROUTING layer (per-box STK / RCK), never the cert itself.
 * Two IRK-signed paths, both authorized by the account root (the trust-root
 * device that mints the cert):
 *
 *   POST /api/users/:u/cert-revoke/soft  → handleSoftRevoke
 *   POST /api/users/:u/cert-revoke/hard  → handleHardRevoke
 *
 * SOFT (Disconnect) — eject the box from the cert-recipient set + drop its
 * routing (STK/RCK). NO re-mint: the rest of the fleet keeps the live cert.
 * Sound ONLY if the box's cert key was WIPED (clean decommission). An
 * un-wiped box keeps a *usable* cert key until expiry → off-path MITM risk
 * if its disk is later recovered, so `wiped:false` is refused here (400) and
 * the caller is told to hard-revoke instead (§5.1/§5.3 sharpening).
 *
 * HARD (compromise / key-intact departure) — the ORDERED sequence in
 * `hardRevokeSteps()`. Because every hard re-mint shares the same SAN set, a
 * flapping or attacked box could weaponize repeated hard-revokes into a
 * Let's Encrypt duplicate-cert DoS (5-dup / 7-day per identical SAN set,
 * §5.4). We DEBOUNCE per user: a second hard revoke inside `debounceMs`
 * (default 60s) is refused with 429 rather than driving another re-mint.
 *
 * STORAGE-FREE by design. The only storage-interface dep is `usernames`,
 * used solely to fetch the account's current IRK pubkey to verify the
 * signature (identical to every sibling handler in this package). The
 * debounce state is an INJECTABLE in-deps `Map<string,number>` so this
 * module never touches `packages/storage`. In production the Worker wires
 * `lastHardRevokeAt` to a durable store (a D1 row / KV / DO) so the debounce
 * holds across isolate restarts; for handlers/tests an in-memory Map is the
 * whole contract.
 */

import {
  verifyCertSoftRevoke,
  verifyCertHardRevoke,
  type CertSoftRevoke,
  type CertHardRevoke,
} from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";
import { HEX128, hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface CertRevocationDeps {
  /** Account directory — the ONLY storage interface here, used to fetch the
   *  IRK pubkey that authorizes the revoke. No cert/revocation state lives in
   *  storage; this module stays `packages/storage`-free. */
  usernames: UsernameStorage;
  /**
   * Debounce state for hard re-mints, keyed by normalized username → the ms
   * timestamp of the last accepted hard revoke. INJECTABLE: production wires
   * it to a durable store (D1 / KV / Durable Object) so the debounce survives
   * isolate restarts; tests pass a plain `Map`.
   */
  lastHardRevokeAt: Map<string, number>;
  /** Debounce window in ms; a second hard revoke inside it returns 429. */
  debounceMs?: number;
  now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 60_000;

/**
 * The §5.2 ordering invariant for a HARD revoke. The sequence is
 * load-bearing: routing is cut FIRST (instant at `.com`, so a compromised
 * box stops serving immediately), any renewal delegation is revoked, the box
 * is removed from the trust-root's authorized cert-recipient set, THEN the
 * cert is re-minted to the remaining fleet, and finally the old cert is
 * CA-revoked (best-effort — browsers soft-fail OCSP, so short-lived certs are
 * the real blast-radius bound; CA-revoke is the belt to that suspenders).
 */
export function hardRevokeSteps(): string[] {
  return [
    "routing-revoke",
    "delegation-revoke",
    "eject-from-recipient-set",
    "re-mint",
    "ca-revoke",
  ];
}

// ── wire bodies ───────────────────────────────────────────────────────────

interface SoftRevokeBody {
  username?: unknown;
  serverDomain?: unknown;
  wiped?: unknown;
  issuedAt?: unknown;
  signature?: unknown; // 64-byte hex (Ed25519 over canonical bytes, IRK)
}

interface HardRevokeBody {
  username?: unknown;
  serverDomain?: unknown;
  issuedAt?: unknown;
  signature?: unknown; // 64-byte hex (Ed25519 over canonical bytes, IRK)
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/cert-revoke/soft
// ──────────────────────────────────────────────────────────────────────

export async function handleSoftRevoke(
  deps: CertRevocationDeps,
  body: SoftRevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (
    !body ||
    typeof body.username !== "string" ||
    body.username.length === 0 ||
    typeof body.serverDomain !== "string" ||
    body.serverDomain.length === 0 ||
    typeof body.wiped !== "boolean" ||
    typeof body.issuedAt !== "number" ||
    typeof body.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = body.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const envelope: CertSoftRevoke = {
    username: usernameNorm,
    serverDomain: body.serverDomain,
    wiped: body.wiped,
    issuedAt: body.issuedAt,
  };
  // A malformed envelope (separator / control char in a field) folds to a
  // single 403 alongside a genuinely bad signature — no oracle.
  if (!verifyCertSoftRevoke(envelope, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  // Soft is only sound if the cert key is gone. An un-wiped box keeps a usable
  // key until expiry → must be HARD-revoked (re-mint + CA-revoke) instead.
  if (!body.wiped) {
    return {
      status: 400,
      body: {
        error: "box not wiped — use hard revoke",
        useHardRevoke: true,
      },
    };
  }

  // Eject from the cert-recipient set + drop routing (STK/RCK). No re-mint.
  return ok({
    ok: true,
    action: "decommissioned",
    username: usernameNorm,
    serverDomain: body.serverDomain,
    reMint: false,
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/cert-revoke/hard
// ──────────────────────────────────────────────────────────────────────

export async function handleHardRevoke(
  deps: CertRevocationDeps,
  body: HardRevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  if (
    !body ||
    typeof body.username !== "string" ||
    body.username.length === 0 ||
    typeof body.serverDomain !== "string" ||
    body.serverDomain.length === 0 ||
    typeof body.issuedAt !== "number" ||
    typeof body.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = body.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const envelope: CertHardRevoke = {
    username: usernameNorm,
    serverDomain: body.serverDomain,
    issuedAt: body.issuedAt,
  };
  if (!verifyCertHardRevoke(envelope, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  // Debounce per user: a hard revoke triggers a re-mint (shared SAN set), so
  // rapid repeats would burn LE duplicate-cert slots. Refuse a second hard
  // revoke inside the window rather than re-minting again. Verify AFTER the
  // signature so an unauthenticated request can't probe the debounce state.
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const last = deps.lastHardRevokeAt.get(usernameNorm);
  if (last !== undefined && now - last < debounceMs) {
    return {
      status: 429,
      body: {
        error: "hard revoke debounced",
        retryAfterMs: debounceMs - (now - last),
      },
    };
  }

  deps.lastHardRevokeAt.set(usernameNorm, now);

  return ok({
    ok: true,
    action: "hard-revoked",
    username: usernameNorm,
    serverDomain: body.serverDomain,
    steps: hardRevokeSteps(),
  });
}
