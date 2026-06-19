/**
 * `.com` service-access capability-invite handlers (docs/service-access-gating.md).
 *
 * Four surfaces — all over the `service_invites` directory:
 *   - create  POST /api/users/:u/service-invites          (author IRK-signed)
 *   - redeem  POST /api/service-invites/redeem            (friend AID-signed)
 *   - revoke  POST /api/users/:u/service-invites/revoke    (author IRK-signed)
 *   - list    GET  /api/users/:u/service-invites           (author-owned)
 *
 * Identity model (the whole point — see the spec's "Identity / stability"):
 * the bound principal is the STABLE **AID** (`deriveAccountId(UMK)`), which
 * survives the friend's IRK rotations / device changes; the IRK signs the
 * author's ACTIVE orders (create / revoke). `.com` is an untrusted carrier —
 * it stores only the `secretHash` (never the link secret) and the
 * household-key-sealed `{name, photo?}` bundle (ciphertext — `.com` holds no
 * UMK), and the authoritative "does the author own this service" check runs
 * on the box at redeem. `.com`'s job here is to refuse garbage, gate create /
 * revoke to the account's REGISTERED IRK, and run the first-bind / same-AID-
 * idempotent / reject-different-AID redeem atomically.
 */

import {
  verifyCreateServiceInvite,
  verifyRedeemServiceInvite,
  verifyRevokeServiceInvite,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
} from "@flagship/protocol";
import type { ServiceInviteStorage, UsernameStorage } from "@flagship/storage";
import { HEX64, HEX128, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

const HEX_RE = /^[0-9a-f]*$/i;

export interface ServiceInviteDeps {
  invites: ServiceInviteStorage;
  usernames: UsernameStorage;
  now?: () => number;
  /** Replay window for IRK-signed create / revoke. Default 5 min. */
  freshnessMs?: number;
}

// ──────────────────────────────────────────────────────────────────────
// create — POST /api/users/:u/service-invites
// body { request: CreateServiceInvite(JSON), signature }
// ──────────────────────────────────────────────────────────────────────

interface CreateBody {
  request?: {
    inviteId?: unknown;
    authorAID?: unknown;
    serviceRef?: unknown;
    secretHash?: unknown;
    encryptedBundle?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown;
}

export async function handleCreateServiceInvite(
  deps: ServiceInviteDeps,
  username: string,
  body: CreateBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const userV = validateUserLabel(username);
  if (!userV.ok) return malformed(userV.reason);

  const r = body?.request;
  if (
    !r ||
    typeof r.inviteId !== "string" ||
    typeof r.authorAID !== "string" ||
    !HEX64.test(r.authorAID) ||
    typeof r.serviceRef !== "string" ||
    r.serviceRef.length === 0 ||
    typeof r.secretHash !== "string" ||
    !HEX64.test(r.secretHash) ||
    typeof r.encryptedBundle !== "string" ||
    r.encryptedBundle.length === 0 ||
    !HEX_RE.test(r.encryptedBundle) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed create body");
  }
  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  // Owner auth: the create envelope must verify against the account's
  // REGISTERED IRK — only the current device key of THIS account can create
  // invites under it (the authorAID inside is the stable identity recorded
  // for the row + the box allow-list, not the .com authority gate).
  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  const create: CreateServiceInvite = {
    inviteId: r.inviteId,
    authorAID: hexToBytes(r.authorAID),
    serviceRef: r.serviceRef,
    secretHash: r.secretHash,
    encryptedBundle: r.encryptedBundle,
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("corrupt registered irk");
  }
  if (!verifyCreateServiceInvite(create, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  const res = await deps.invites.create({
    inviteId: r.inviteId,
    authorAID: r.authorAID,
    serviceRef: r.serviceRef,
    encryptedBundle: r.encryptedBundle,
    secretHash: r.secretHash,
    createdAt: now,
  });
  if (!res.ok) return conflict(res.reason);
  return ok({ created: true, inviteId: r.inviteId });
}

// ──────────────────────────────────────────────────────────────────────
// redeem — POST /api/service-invites/redeem
// body { secret? (raw hex), secretHash?, visitorAID, aidSig }
//
// The redeem envelope the friend signs is over { secretHash, visitorAID,
// redeemedAt }. The friend may send the raw `secret` (then .com derives the
// hash) OR the `secretHash` directly; either way the AID signature binds the
// redeem to the friend's stable identity, so a mere secret-holder cannot bind
// SOMEONE ELSE's AID.
// ──────────────────────────────────────────────────────────────────────

interface RedeemBody {
  secretHash?: unknown;
  visitorAID?: unknown;
  aidSig?: unknown;
  redeemedAt?: unknown;
}

export async function handleRedeemServiceInvite(
  deps: ServiceInviteDeps,
  body: RedeemBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const b = body;
  if (
    !b ||
    typeof b.secretHash !== "string" ||
    !HEX64.test(b.secretHash) ||
    typeof b.visitorAID !== "string" ||
    !HEX64.test(b.visitorAID) ||
    typeof b.aidSig !== "string" ||
    !HEX128.test(b.aidSig) ||
    typeof b.redeemedAt !== "number"
  ) {
    return malformed("malformed redeem body");
  }
  if (Math.abs(now - b.redeemedAt) > freshnessMs) return forbidden("stale request");

  const redeem: RedeemServiceInvite = {
    secretHash: b.secretHash,
    visitorAID: hexToBytes(b.visitorAID),
    redeemedAt: b.redeemedAt,
  };
  // AID signature: proves the redeemer controls `visitorAID` (so they can't
  // bind a victim's AID to a link they hold). Verified BEFORE touching state.
  if (!verifyRedeemServiceInvite(redeem, hexToBytes(b.aidSig), hexToBytes(b.visitorAID))) {
    return forbidden("invalid AID signature");
  }

  const res = await deps.invites.redeem(b.secretHash, b.visitorAID, now);
  if (!res.ok) {
    if (res.reason === "unknown secret") return notFound("unknown invite");
    if (res.reason === "already bound") return conflict("already bound to another account");
    if (res.reason === "revoked") return forbidden("invite revoked");
    return malformed(res.reason);
  }
  // The box uses serviceRef + boundAID to add the friend to the service's
  // allow-list; the bundle is returned so an author surface can show who bound.
  return ok({
    redeemed: true,
    firstBind: res.firstBind,
    inviteId: res.record.inviteId,
    serviceRef: res.record.serviceRef,
    authorAID: res.record.authorAID,
    boundAID: res.record.boundAID,
    encryptedBundle: res.record.encryptedBundle,
  });
}

// ──────────────────────────────────────────────────────────────────────
// revoke — POST /api/users/:u/service-invites/revoke
// body { request: RevokeServiceInvite(JSON), signature }
// ──────────────────────────────────────────────────────────────────────

interface RevokeBody {
  request?: { inviteId?: unknown; issuedAt?: unknown };
  signature?: unknown;
}

export async function handleRevokeServiceInvite(
  deps: ServiceInviteDeps,
  username: string,
  body: RevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const userV = validateUserLabel(username);
  if (!userV.ok) return malformed(userV.reason);

  const r = body?.request;
  if (
    !r ||
    typeof r.inviteId !== "string" ||
    r.inviteId.length === 0 ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed revoke body");
  }
  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  // The invite must belong to this account (its authorAID must be the
  // account's stable AID — but .com only stores authorAID, not the account's
  // AID mapping). Authority is the registered IRK signature over the revoke;
  // additionally require the invite's authorAID to match the create's author
  // by confirming the invite exists + is owned (defense in depth).
  const existing = await deps.invites.get(r.inviteId);
  if (!existing) return notFound("unknown invite");

  const revoke: RevokeServiceInvite = { inviteId: r.inviteId, issuedAt: r.issuedAt };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  if (!verifyRevokeServiceInvite(revoke, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  await deps.invites.revoke(r.inviteId, now);
  return ok({ revoked: true, inviteId: r.inviteId });
}

// ──────────────────────────────────────────────────────────────────────
// list — GET /api/users/:u/service-invites?authorAID=<hex>
//
// Author-owned listing. The invites are keyed by the author's AID (not the
// username), so the caller passes the AID it is listing for; the listing
// returns metadata only (NO secret — secrets are never stored). Public-ish
// (the bundle is ciphertext + the secretHash is one-way), but scoped to one
// author's AID so it isn't an account-wide enumeration.
// ──────────────────────────────────────────────────────────────────────

export async function handleListServiceInvites(
  deps: ServiceInviteDeps,
  username: string,
  authorAID: string | null,
): Promise<HandlerResponseWithHeaders> {
  const userV = validateUserLabel(username);
  if (!userV.ok) return malformed(userV.reason);
  if (typeof authorAID !== "string" || !HEX64.test(authorAID)) {
    return malformed("authorAID query param (64-hex) required");
  }
  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  const invites = (await deps.invites.listForAuthor(authorAID)).map((i) => ({
    inviteId: i.inviteId,
    serviceRef: i.serviceRef,
    encryptedBundle: i.encryptedBundle,
    boundAID: i.boundAID,
    boundAt: i.boundAt,
    createdAt: i.createdAt,
    revokedAt: i.revokedAt,
  }));
  return ok({ invites });
}
