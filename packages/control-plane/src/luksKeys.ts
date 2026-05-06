import {
  verifyConsumeUnlockKey,
  verifyDepositUnlockKey,
  verifyPutSealedLuksKey,
  type ConsumeUnlockKey,
  type DepositUnlockKey,
  type PutSealedLuksKey,
} from "@flagship/protocol";
import type { LuksKeyStorage, ServerStorage, UsernameStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

/**
 * LUKS unlock-on-boot endpoints.
 *
 * `POST /api/server/:host/sealed-luks-key`     server identity-signed
 * `GET  /api/server/:host/sealed-luks-key`     public (sealed against BAK)
 * `POST /api/server/:host/unlock-key`          IRK-signed (phone deposits)
 * `POST /api/server/:host/unlock-key/consume`  server identity-signed (one-shot)
 *
 * The :host parameter must equal the `serverId` field inside the signed
 * request — defense in depth against a bug that mis-routes between hosts.
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
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  let sealedKey: Uint8Array;
  let sig: Uint8Array;
  try {
    sealedKey = hexToBytes(r.sealedKey);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: PutSealedLuksKey = {
    serverId: host,
    sealedKey,
    issuedAt: r.issuedAt,
  };
  if (!verifyPutSealedLuksKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.luksKeys.putSealed({
    serverDomain: host,
    sealedKeyHex: r.sealedKey,
    sealedAt: now(),
  });
  return { status: 200, body: { ok: true } };
}

export async function handleGetSealedLuksKey(
  deps: LuksKeyDeps,
  host: string,
): Promise<HandlerResponse> {
  const rec = await deps.luksKeys.getSealed(host);
  if (!rec) return { status: 404, body: { error: "no sealed key on file" } };
  return {
    status: 200,
    body: {
      serverDomain: rec.serverDomain,
      sealedKey: rec.sealedKeyHex,
      sealedAt: rec.sealedAt,
    },
  };
}

export async function handleDepositUnlockKey(
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
    typeof r.unlockKey !== "string" ||
    typeof r.expiresAt !== "number" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  if (r.expiresAt <= now()) {
    return { status: 400, body: { error: "expiresAt already past" } };
  }

  // Look up the user's IRK pubkey via the server's username.
  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return { status: 404, body: { error: "unknown user" } };

  let unlockKey: Uint8Array;
  let sig: Uint8Array;
  try {
    unlockKey = hexToBytes(r.unlockKey);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: DepositUnlockKey = {
    serverId: host,
    unlockKey,
    expiresAt: r.expiresAt,
    issuedAt: r.issuedAt,
  };
  if (!verifyDepositUnlockKey(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.luksKeys.putUnlock({
    serverDomain: host,
    unlockKeyHex: r.unlockKey,
    depositedAt: now(),
    expiresAt: r.expiresAt,
  });
  return { status: 200, body: { ok: true } };
}

export async function handleConsumeUnlockKey(
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
    typeof r.nonce !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    nonce = hexToBytes(r.nonce);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  if (nonce.length !== 32) {
    return { status: 400, body: { error: "nonce must be 32 bytes" } };
  }
  const claim: ConsumeUnlockKey = {
    serverId: host,
    nonce,
    issuedAt: r.issuedAt,
  };
  if (!verifyConsumeUnlockKey(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const dep = await deps.luksKeys.consumeUnlock(host, now());
  if (!dep) {
    return { status: 404, body: { error: "no pending unlock-key deposit" } };
  }
  return {
    status: 200,
    body: {
      unlockKey: dep.unlockKeyHex,
      depositedAt: dep.depositedAt,
      expiresAt: dep.expiresAt,
    },
  };
}
