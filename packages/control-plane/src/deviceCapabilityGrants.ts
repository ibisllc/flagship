/**
 * v2 device-addressing — public + per-device handlers (S3.3).
 *
 * Two pure handlers (mint / revoke) for the
 * `device_capability_grants` table, plus the `requireDeviceScope`
 * helper every downstream "is this device allowed to do X?" call site
 * is meant to consume.
 *
 * Wire contract:
 *   POST /api/users/:u/device-grants          → handleMintDeviceGrant
 *   POST /api/users/:u/device-grants/revoke   → handleRevokeDeviceGrant
 *
 * `requireDeviceScope` answers the central question every
 * privileged-op call site needs:
 *   "given this signer pubkey + this user + this requested scope,
 *    is the operation allowed?"
 *
 * It returns a discriminated `{ ok: true } | { ok: false; reason }` so
 * the caller can fold the reason into its own 403 message without this
 * file knowing the response shape. The user-IRK fast path (legacy
 * single-IRK accounts) is checked first; only when the signer is NOT
 * the user IRK do we walk the device_capability_grants table. See
 * docs/v2-device-addressing-and-real-ticket.md §3.2 for the chain.
 */

import {
  DEVICE_SCOPES,
  isSensitiveScope,
  verifyDeviceCapabilityGrant,
  verifyRevokeDeviceCapabilityGrant,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type RevokeDeviceCapabilityGrant,
  type RevokeDeviceCapabilityGrantReason,
} from "@flagship/protocol";
import type {
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
  DeviceIdentityStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes, bytesToHex } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface DeviceCapabilityGrantsDeps {
  storage: DeviceCapabilityGrantStorage;
  identities: DeviceIdentityStorage;
  usernames: UsernameStorage;
  now?: () => number;
}

// ──────────────────────────────────────────────────────────────────────
// Body shapes (mirrors the on-the-wire JSON the phone / CLI POSTs)
// ──────────────────────────────────────────────────────────────────────

interface MintBody {
  grant?: {
    grantId?: string;
    username?: string;
    deviceId?: string;
    devicePubKey?: string;
    scopes?: unknown;
    issuedAt?: number;
    expiresAt?: number;
  };
  signature?: string;
}

interface RevokeBody {
  request?: {
    grantId?: string;
    username?: string;
    reason?: string;
    issuedAt?: number;
  };
  signature?: string;
}

const VALID_SCOPES = new Set<string>(DEVICE_SCOPES);
const VALID_REVOKE_REASONS: ReadonlySet<RevokeDeviceCapabilityGrantReason> =
  new Set<RevokeDeviceCapabilityGrantReason>([
    "lost",
    "stolen",
    "decommissioned",
    "replaced",
  ]);

function parseScopes(raw: unknown): DeviceScope[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DeviceScope[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || !VALID_SCOPES.has(s)) return null;
    out.push(s as DeviceScope);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/device-grants
// ──────────────────────────────────────────────────────────────────────

export async function handleMintDeviceGrant(
  deps: DeviceCapabilityGrantsDeps,
  body: MintBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const g = body?.grant;
  if (
    !g ||
    typeof g.grantId !== "string" ||
    g.grantId.length === 0 ||
    typeof g.username !== "string" ||
    g.username.length === 0 ||
    typeof g.deviceId !== "string" ||
    typeof g.devicePubKey !== "string" ||
    !HEX64.test(g.devicePubKey) ||
    typeof g.issuedAt !== "number" ||
    typeof g.expiresAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  const scopes = parseScopes(g.scopes);
  if (!scopes || scopes.length === 0) {
    return malformed("scopes must be a non-empty array of known DeviceScope strings");
  }

  const usernameNorm = g.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  // Slice D §3.3 — the grant-signer discriminator, GATED by the clean-slate
  // transition. When the account has pinned an ADMIN MASTER ROOT, an
  // `admin`-scope (SENSITIVE) grant MUST be signed by that admin root (not the
  // membership IRK — otherwise a UMK holder or a compromised `.com` could forge
  // admin authority); it is verified under `admin_root_pub_hex` and stamped
  // `signer_root='admin-root'`. A legacy account with NO admin root keeps the
  // pre-D behavior unchanged (IRK-verified, stamped `'membership'`) so existing
  // flows don't break — the authority split only exists once a root is pinned.
  const wantsSensitive = scopes.some((s) => isSensitiveScope(s));
  const useAdminRoot = wantsSensitive && userRec.adminRootPubHex != null;
  const signerRoot: "membership" | "admin-root" = useAdminRoot ? "admin-root" : "membership";
  const authorityHex = useAdminRoot ? userRec.adminRootPubHex! : userRec.irkPubHex;

  let authorityPub: Uint8Array;
  let devicePub: Uint8Array;
  let sig: Uint8Array;
  try {
    authorityPub = hexToBytes(authorityHex);
    devicePub = hexToBytes(g.devicePubKey);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const grant: DeviceCapabilityGrant = {
    grantId: g.grantId,
    username: usernameNorm,
    deviceId: g.deviceId,
    devicePubKey: devicePub,
    scopes,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
  };

  // The protocol's verify rejects malformed envelopes (bad label, '|',
  // out-of-range expiry) by throwing inside the canonical-bytes pass;
  // the public `verifyDeviceCapabilityGrant` catches that into `false`.
  // We surface a single 403 either way (the caller doesn't get to
  // distinguish "bad signature" from "bad envelope"). An `admin`-scope grant
  // is verified under the ADMIN MASTER ROOT here (§3.3).
  if (!verifyDeviceCapabilityGrant(grant, sig, authorityPub)) {
    return forbidden("invalid signature");
  }

  if (grant.expiresAt <= now) return malformed("grant already expired");

  const devicePubHex = bytesToHex(devicePub).toLowerCase();
  const identity = await deps.identities.get(usernameNorm, grant.deviceId);
  if (identity) {
    if (identity.revokedAt !== null || identity.devicePubHex !== devicePubHex) {
      return forbidden("invalid device identity");
    }
  } else {
    const bound = await deps.identities.put({
      accountId: usernameNorm,
      deviceId: grant.deviceId,
      devicePubHex,
      platformClass: null,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    if (!bound.ok) return conflict(bound.reason);
  }

  const putResult = await deps.storage.put({
    grantId: grant.grantId,
    username: usernameNorm,
    deviceId: grant.deviceId,
    devicePubHex,
    scopesJson: JSON.stringify(scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: bytesToHex(sig),
    revokedAt: null,
    signerRoot,
  });
  if (!putResult.ok) {
    return conflict(putResult.reason);
  }

  return ok({
    ok: true,
    grantId: grant.grantId,
    username: usernameNorm,
    deviceId: grant.deviceId,
    devicePubKey: bytesToHex(devicePub).toLowerCase(),
    scopes,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/users/:u/device-grants/revoke
// ──────────────────────────────────────────────────────────────────────

// NOTE (task #39): revoking a grant is now operationally meaningful —
// `serverRevocation.ts` authorizes the device-signed server-revoke path
// via `requireDeviceScope`, which re-checks `revokedAt` (and expiry) on
// every call. Flipping a grant's `revokedAt` here therefore immediately
// stops that device from revoking servers. The pinning test in
// `deviceCapabilityGrants.test.ts` ("requireDeviceScope production
// consumers") asserts the EXACT known-consumer set, so a NEW
// grant-accepting handler still fails the pin and forces the author to
// either prove the revocation path is covered or consciously update the
// list.
export async function handleRevokeDeviceGrant(
  deps: DeviceCapabilityGrantsDeps,
  body: RevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const r = body?.request;
  if (
    !r ||
    typeof r.grantId !== "string" ||
    r.grantId.length === 0 ||
    typeof r.username !== "string" ||
    r.username.length === 0 ||
    typeof r.reason !== "string" ||
    !VALID_REVOKE_REASONS.has(r.reason as RevokeDeviceCapabilityGrantReason) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const usernameNorm = r.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return notFound("username not registered");

  const existing = await deps.storage.get(r.grantId);
  if (!existing) return notFound("unknown grantId");
  if (existing.username.toLowerCase() !== usernameNorm) {
    return malformed("username does not match grant");
  }

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const envelope: RevokeDeviceCapabilityGrant = {
    grantId: r.grantId,
    username: usernameNorm,
    reason: r.reason as RevokeDeviceCapabilityGrantReason,
    issuedAt: r.issuedAt,
  };
  if (!verifyRevokeDeviceCapabilityGrant(envelope, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  if (existing.revokedAt !== null) {
    return ok({ ok: true, grantId: r.grantId, revokedAt: existing.revokedAt });
  }

  await deps.storage.revoke(r.grantId, now);
  return ok({ ok: true, grantId: r.grantId, revokedAt: now });
}

// ──────────────────────────────────────────────────────────────────────
// requireDeviceScope
// ──────────────────────────────────────────────────────────────────────

/**
 * Authoritative "may signer do operation X under username U?" check.
 *
 * Three branches:
 *   1. signerPubHex == user's IRK pub → allow (legacy single-IRK).
 *   2. signerPubHex matches an ACTIVE DeviceCapabilityGrant for U →
 *      re-verify the grant's signature, check expiry + scope coverage.
 *   3. otherwise → deny.
 *
 * The signature re-verification is defense-in-depth: the row was
 * already verified at mint time, but D1 corruption / a stale read /
 * a future migration drift would leave a record that doesn't actually
 * verify under the user's IRK. We re-verify so a downstream "this
 * device has install-service" never trusts a row whose canonical-bytes
 * shape doesn't match its stored signature.
 *
 * `reason` strings are deliberately specific — callers fold them into
 * their own 403 messages. They're NOT a security oracle: every failure
 * branch logs a single audit event with the original signerPubHex +
 * scope, so a curious attacker can't enumerate the state space by
 * watching message variants.
 */
export async function requireDeviceScope(
  deps: DeviceCapabilityGrantsDeps,
  signerPubHex: string,
  username: string,
  scope: DeviceScope,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = (deps.now ?? (() => Date.now()))();
  const userNorm = username.toLowerCase();
  const userRec = await deps.usernames.get(userNorm);
  if (!userRec) return { ok: false, reason: "username not registered" };

  // Look up the most-recent ACTIVE grant for this device pubkey. The
  // storage layer's getByDevicePub returns at most one row (the most-
  // recent active match); a re-labeled device that still has an old
  // revoked row never surfaces here.
  const grantRec = await deps.storage.getByDevicePub(signerPubHex.toLowerCase());
  if (!grantRec) return { ok: false, reason: "no active device grant" };
  if (grantRec.revokedAt !== null) return { ok: false, reason: "no active device grant" };
  const identity = await deps.identities.get(userNorm, grantRec.deviceId);
  if (!identity || identity.revokedAt !== null || identity.devicePubHex !== grantRec.devicePubHex.toLowerCase()) {
    return { ok: false, reason: "device identity inactive" };
  }

  if (grantRec.username.toLowerCase() !== userNorm) {
    return { ok: false, reason: "username mismatch" };
  }

  if (now >= grantRec.expiresAt) {
    return { ok: false, reason: "grant expired" };
  }

  // Defense-in-depth: re-verify the stored signature under the user's
  // IRK. The mint path already did this; we do it again here because
  // every privileged operation flows through here and the row could
  // have been corrupted / mis-migrated in storage since.
  let irkPub: Uint8Array;
  let devicePub: Uint8Array;
  let sig: Uint8Array;
  let scopes: DeviceScope[] | null;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
    devicePub = hexToBytes(grantRec.devicePubHex);
    sig = hexToBytes(grantRec.signatureHex);
    scopes = parseScopes(JSON.parse(grantRec.scopesJson));
  } catch {
    return { ok: false, reason: "grant row corrupted" };
  }
  if (!scopes) return { ok: false, reason: "grant row corrupted" };

  const grant: DeviceCapabilityGrant = {
    grantId: grantRec.grantId,
    username: grantRec.username,
    deviceId: grantRec.deviceId,
    devicePubKey: devicePub,
    scopes,
    issuedAt: grantRec.issuedAt,
    expiresAt: grantRec.expiresAt,
  };
  if (!verifyDeviceCapabilityGrant(grant, sig, irkPub)) {
    return { ok: false, reason: "grant signature failed verification" };
  }

  if (!scopes.includes(scope)) {
    return { ok: false, reason: `missing scope: ${scope}` };
  }

  return { ok: true };
}

export const _internalParseScopes = parseScopes;
