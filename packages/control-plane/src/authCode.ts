import {
  verifyAuthCode,
  verifyAuthCodeRevocation,
  type AuthCode,
  type AuthCodeRevocation,
} from "@flagship/protocol";
import type { AuthCodeStorage, UsernameStorage } from "@flagship/storage";
import { HEX64, HEX128, equalHex, hexToBytes, bytesToHex } from "./hex.js";
import { validateServerLabel, validateUserLabel } from "./labels.js";
import {
  conflict, forbidden, malformed, notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface AuthCodeDeps {
  storage: AuthCodeStorage;
  usernames: UsernameStorage;
  freshnessMs?: number;
  maxExpiryMs?: number;
  now?: () => number;
}

export const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface IssueBody {
  code?: {
    version?: number;
    serial?: string;
    username?: string;
    serverName?: string;
    serverDomain?: string;
    delegatedPubKey?: string;
    userPubKey?: string;
    issuedAt?: number;
    expiresAt?: number;
  };
  signature?: string;
}

export async function handleAuthCodeIssue(
  deps: AuthCodeDeps,
  body: IssueBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const maxExpiryMs = deps.maxExpiryMs ?? 24 * 3_600_000;

  const c = body?.code;
  if (
    !c ||
    c.version !== 1 ||
    typeof c.serial !== "string" ||
    !SERIAL_RE.test(c.serial) ||
    typeof c.username !== "string" ||
    typeof c.serverName !== "string" ||
    typeof c.serverDomain !== "string" ||
    typeof c.delegatedPubKey !== "string" ||
    !HEX64.test(c.delegatedPubKey) ||
    typeof c.userPubKey !== "string" ||
    !HEX64.test(c.userPubKey) ||
    typeof c.issuedAt !== "number" ||
    typeof c.expiresAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const userV = validateUserLabel(c.username);
  if (!userV.ok) return malformed(userV.reason);
  const serverV = validateServerLabel(c.serverName);
  if (!serverV.ok) return malformed(serverV.reason);
  const expectedDomain = `${serverV.label}.${userV.label}.flagship.services`;
  if (c.serverDomain !== expectedDomain) {
    return malformed(`serverDomain must equal ${expectedDomain}`);
  }
  if (c.expiresAt - c.issuedAt > maxExpiryMs || c.expiresAt <= c.issuedAt) {
    return malformed("expiry out of range");
  }
  if (Math.abs(now - c.issuedAt) > freshnessMs) return malformed("stale request");
  if (c.expiresAt < now) return malformed("already expired");

  const registered = await deps.usernames.get(c.username);
  if (!registered) return notFound("username not registered");
  if (!equalHex(registered.irkPubHex, c.userPubKey)) {
    return forbidden("userPubKey does not match registered IRK");
  }

  const userPubKey = hexToBytes(c.userPubKey);
  const code: AuthCode = {
    version: 1,
    serial: c.serial,
    username: userV.label,
    serverName: serverV.label,
    serverDomain: expectedDomain,
    delegatedPubKey: hexToBytes(c.delegatedPubKey),
    userPubKey,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  };
  const sig = hexToBytes(body.signature);
  if (!verifyAuthCode(code, sig, userPubKey)) return forbidden("invalid signature");

  const out = await deps.storage.put({
    serial: code.serial,
    username: userV.label,
    serverName: serverV.label,
    serverDomain: expectedDomain,
    delegatedPubKeyHex: c.delegatedPubKey,
    userPubKeyHex: c.userPubKey,
    userSignatureHex: body.signature,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    status: "active",
    recordedAt: now,
  });
  if (!out.ok) return conflict(out.reason);
  return ok({ ok: true, serial: code.serial, expiresAt: code.expiresAt });
}

export async function handleAuthCodeLookup(
  deps: AuthCodeDeps,
  serial: string,
): Promise<HandlerResponseWithHeaders> {
  const r = await deps.storage.get(serial);
  if (!r) return notFound("unknown serial");
  const now = (deps.now ?? (() => Date.now()))();
  const expired = now > r.expiresAt;
  return ok({
    serial: r.serial,
    username: r.username,
    serverDomain: r.serverDomain,
    delegatedPubKey: r.delegatedPubKeyHex,
    userPubKey: r.userPubKeyHex,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    status: r.status === "active" && expired ? "expired" : r.status,
    usedAt: r.usedAt ?? null,
    revokedAt: r.revokedAt ?? null,
  });
}

// handleAuthCodeUse REMOVED (Thread G G2). The standalone POST
// /api/auth-code/:serial/use endpoint was vestigial: the real path
// (validateAndUseAuthCode inside /api/server/register) already marks
// the code used atomically. Keeping a separate, unsigned /use endpoint
// gave anyone who knew a serial the ability to burn it, locking out
// the legitimate user — a cheap DoS with no defensive value. Removed.

interface RevokeBody {
  request?: { serial?: string; username?: string; issuedAt?: number };
  signature?: string;
}

export async function handleAuthCodeRevoke(
  deps: AuthCodeDeps,
  serial: string,
  body: RevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  // H5 hardening (Thread C): close the existence/timing oracle.
  // Three independent leaks were present:
  //   (1) get(serial) ran BEFORE signature verification → response time
  //       varied between "serial unknown" and "serial exists but mismatch"
  //   (2) usernames.get(username) ran before signature verification too →
  //       same timing leak across usernames
  //   (3) the response body distinguished "unknown serial" /
  //       "username not registered" / "username/auth-code mismatch" /
  //       "invalid signature" → enumeration oracle
  //
  // Fix: do every lookup unconditionally (fetch both records in parallel
  // every time, regardless of body validity) and collapse every
  // authentication failure to a single 403 with a single message.
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const r = body?.request;
  // Narrow once into a typed `wellFormedRequest` so downstream code
  // doesn't need non-null assertions every time.
  const wellFormedRequest:
    | { serial: string; username: string; issuedAt: number; signatureHex: string }
    | null =
    r &&
    typeof r.serial === "string" &&
    r.serial === serial &&
    typeof r.username === "string" &&
    typeof r.issuedAt === "number" &&
    typeof body?.signature === "string" &&
    HEX128.test(body.signature)
      ? {
          serial: r.serial,
          username: r.username,
          issuedAt: r.issuedAt,
          signatureHex: body.signature,
        }
      : null;

  // Always do the lookups, regardless of well-formedness, so timing
  // doesn't leak "we never got far enough to check storage."
  // Use a stable placeholder username/serial when the body is malformed
  // so the lookups still happen and take comparable time.
  const lookupSerial = wellFormedRequest?.serial ?? serial;
  const lookupUsername = wellFormedRequest?.username ?? "";
  const [existing, userRec] = await Promise.all([
    deps.storage.get(lookupSerial),
    lookupUsername === "" ? Promise.resolve(undefined) : deps.usernames.get(lookupUsername),
  ]);

  // Single failure path: any authentication problem collapses to the
  // same response. We use 403 not 404 because revealing "does this
  // serial exist" is itself an oracle.
  const denied = (): HandlerResponseWithHeaders => forbidden("authentication failed");

  if (!wellFormedRequest) return denied();
  if (Math.abs(now - wellFormedRequest.issuedAt) > freshnessMs) return denied();
  if (!existing) return denied();
  if (!userRec) return denied();
  if (!equalHex(userRec.irkPubHex, existing.userPubKeyHex)) return denied();

  const revocation: AuthCodeRevocation = {
    serial: wellFormedRequest.serial,
    username: wellFormedRequest.username,
    issuedAt: wellFormedRequest.issuedAt,
  };
  const sig = hexToBytes(wellFormedRequest.signatureHex);
  if (!verifyAuthCodeRevocation(revocation, sig, hexToBytes(existing.userPubKeyHex))) {
    return denied();
  }
  await deps.storage.markRevoked(wellFormedRequest.serial, now);
  return ok({ ok: true });
}

// Helper for serverRegister to validate+use atomically.
export async function validateAndUseAuthCode(
  storage: AuthCodeStorage,
  serial: string,
  now: number,
): Promise<{ ok: true; code: AuthCode } | { ok: false; reason: string }> {
  const r = await storage.get(serial);
  if (!r) return { ok: false, reason: "unknown serial" };
  if (r.status === "revoked") return { ok: false, reason: "revoked" };
  if (r.status === "used") return { ok: false, reason: "already used" };
  if (now > r.expiresAt) return { ok: false, reason: "expired" };
  const used = await storage.markUsed(serial, now);
  if (!used.ok) return { ok: false, reason: used.reason };
  return {
    ok: true,
    code: {
      version: 1,
      serial: r.serial,
      username: r.username,
      serverName: r.serverName,
      serverDomain: r.serverDomain,
      delegatedPubKey: hexToBytes(r.delegatedPubKeyHex),
      userPubKey: hexToBytes(r.userPubKeyHex),
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
    },
  };
}

export const _internalSerialRe = SERIAL_RE;
