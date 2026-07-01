/**
 * `.com` service-access capability-invite handlers (docs/service-access-gating.md,
 * "## v2 hardening").
 *
 * Five surfaces over the `service_invites` directory:
 *   - create        POST /api/users/:u/service-invites           (author IRK/AID-signed)
 *   - redeem        POST /api/service-invites/redeem             (friend AID-signed)
 *   - revoke        POST /api/users/:u/service-invites/revoke     (author IRK/AID-signed)
 *   - list          GET  /api/users/:u/service-invites            (owner-SIGNED — v2 §C2)
 *   - revoked-since GET  /api/users/:u/service-invites/revoked-since (owner-SIGNED)
 *
 * Identity model (the spec's "Identity / stability"): the bound principal is the
 * STABLE **AID** (`deriveAccountId(UMK)`), which survives the friend's IRK
 * rotations. The author authenticates create / revoke / the listings against
 * the account's registered **AID OR IRK** — DUAL-ACCEPT during the client
 * transition (clients sign with the IRK today and will move to the AID; the AID
 * is the right long-term principal because the IRK rotates, which would break
 * the box-as-authority create-sig check). `.com` is an untrusted carrier: it
 * stores only the `secretHash`, the household-key-sealed bundle (ciphertext), and
 * — v2 — the author's create SIGNATURE, so the redeem can hand the box the signed
 * create and the box verifies the owner's authority ITSELF (demoting `.com` to a
 * blind store + first-bind arbiter). `.com` still enforces maxN / expiry /
 * first-bind atomically and runs the manual-approve pending state.
 */

import {
  verifyCreateServiceInvite,
  verifyRedeemServiceInvite,
  verifyRevokeServiceInvite,
  verifyServiceInviteCreateQuery,
  verifyServiceInviteListQuery,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type ServiceInviteCreateQuery,
  type ServiceInviteListQuery,
} from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  ServerStorage,
  ServiceInviteApprovalMode,
  ServiceInviteStorage,
  UsernameStorage,
  UsernameRecord,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes } from "./hex.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { validateUserLabel } from "./labels.js";
import {
  conflict,
  forbidden,
  gone,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

const HEX_RE = /^[0-9a-f]*$/i;

export interface ServiceInviteDeps {
  invites: ServiceInviteStorage;
  usernames: UsernameStorage;
  /**
   * Server directory — OPTIONAL. When present, the revoked-since poll accepts a
   * BOX STK-signed query (the box holds no owner key, so it can't owner-sign):
   * `.com` verifies the STK against the registered server's identity pubkey +
   * that the server belongs to this username. Absent ⇒ revoked-since is
   * owner-signed only (the box poller won't authenticate).
   */
  servers?: ServerStorage;
  /**
   * Slice D — D-2 OVERRIDE: service-collaborator membership mutation (invite
   * CREATE + REVOKE) is now SENSITIVE (admin-only). Device-grant store for the
   * master-admin authority gate. Optional: absent ⇒ only the bare admin root
   * satisfies the open gate. (Reading membership + redeeming an invite stay
   * non-sensitive — those paths are unchanged.)
   */
  grants?: DeviceCapabilityGrantStorage;
  now?: () => number;
  /** Replay window for the signed create / revoke / list envelopes. Default 5 min. */
  freshnessMs?: number;
}

/**
 * DUAL-ACCEPT author auth: try the account's registered AID first (the stable,
 * non-rotating principal — the v2 target), then fall back to the registered IRK
 * (what current clients sign with). Returns true if EITHER verifies. The AID is
 * preferred so a create signed by the stable key keeps verifying across an IRK
 * rotation (and so the box-as-authority check can verify the same sig).
 */
function verifyAccountSigned(
  userRec: UsernameRecord,
  verify: (pub: Uint8Array) => boolean,
): boolean {
  if (userRec.aidPubHex) {
    try {
      if (verify(hexToBytes(userRec.aidPubHex))) return true;
    } catch {
      /* fall through to IRK */
    }
  }
  try {
    return verify(hexToBytes(userRec.irkPubHex));
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// create — POST /api/users/:u/service-invites
// body { request: CreateServiceInvite(JSON, incl. optional maxRedemptions /
//        expiresAt / approvalMode), signature }
// ──────────────────────────────────────────────────────────────────────

interface CreateBody {
  request?: {
    inviteId?: unknown;
    authorAID?: unknown;
    serviceRef?: unknown;
    secretHash?: unknown;
    encryptedBundle?: unknown;
    issuedAt?: unknown;
    maxRedemptions?: unknown;
    expiresAt?: unknown;
    approvalMode?: unknown;
  };
  signature?: unknown;
}

function parseApprovalMode(raw: unknown): ServiceInviteApprovalMode | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "auto" || raw === "manual") return raw;
  return { error: "approvalMode must be 'auto' or 'manual'" };
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
  // v2 optional caps. maxRedemptions + expiresAt ARE part of the create's
  // canonical bytes (the author commits to them; absent ⇒ a v1 single-use,
  // never-expires invite). approvalMode is a `.com`-side policy field declared
  // by the author (not in the signed bytes — it governs the redeem flow, not
  // the box-verified grant).
  let maxRedemptions: number | undefined;
  if (r.maxRedemptions !== undefined) {
    if (typeof r.maxRedemptions !== "number" || !Number.isInteger(r.maxRedemptions) || r.maxRedemptions < 0) {
      return malformed("maxRedemptions must be a non-negative integer");
    }
    maxRedemptions = r.maxRedemptions;
  }
  let expiresAt: number | undefined;
  if (r.expiresAt !== undefined) {
    if (typeof r.expiresAt !== "number" || !Number.isInteger(r.expiresAt) || r.expiresAt < 0) {
      return malformed("expiresAt must be a non-negative integer");
    }
    expiresAt = r.expiresAt;
  }
  const approvalMode = parseApprovalMode(r.approvalMode);
  if (typeof approvalMode === "object") return malformed(approvalMode.error);

  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  const create: CreateServiceInvite = {
    inviteId: r.inviteId,
    authorAID: hexToBytes(r.authorAID),
    serviceRef: r.serviceRef,
    secretHash: r.secretHash,
    encryptedBundle: r.encryptedBundle,
    issuedAt: r.issuedAt,
    ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  // Slice D — D-2: membership CREATE is SENSITIVE. Gate on master-admin
  // authority; the legacy (no-admin-root) path keeps the DUAL-ACCEPT AID-OR-IRK
  // verify unchanged (only THIS account's key can create invites under it).
  const createAuthz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: userV.label,
      userRec,
      verifyWith: (pub) => verifyCreateServiceInvite(create, sig, hexToBytes(pub)),
      alsoAcceptAid: true,
      now,
    },
  );
  if (!createAuthz.ok) {
    return forbidden("invalid signature");
  }

  const res = await deps.invites.create({
    inviteId: r.inviteId,
    authorAID: r.authorAID,
    serviceRef: r.serviceRef,
    encryptedBundle: r.encryptedBundle,
    secretHash: r.secretHash,
    createdAt: now,
    // Persist the create signature + its signed issuedAt so a later redeem can
    // hand the box the EXACT signed create to verify (box-as-authority).
    createSig: body.signature.toLowerCase(),
    createIssuedAt: r.issuedAt,
    ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(approvalMode !== undefined ? { approvalMode } : {}),
  });
  if (!res.ok) return conflict(res.reason);
  return ok({ created: true, inviteId: r.inviteId });
}

// ──────────────────────────────────────────────────────────────────────
// redeem — POST /api/service-invites/redeem
// body { secret? (raw hex), secretHash?, visitorAID, aidSig, redeemedAt }
//
// AUTO-approve → binds + returns the signed create so the box verifies the
// owner's authority itself before allow-listing. MANUAL-approve → returns
// {pending:true, ...} (NO bind yet); the friend's app emits an AcceptServiceInvite
// and the author finalizes the bind on their OWN box (no `.com` bind for manual).
// ──────────────────────────────────────────────────────────────────────

interface RedeemBody {
  secretHash?: unknown;
  visitorAID?: unknown;
  aidSig?: unknown;
  redeemedAt?: unknown;
}

/** The signed-create bundle the box re-verifies (box-as-authority). */
function createCarrier(rec: {
  inviteId: string;
  authorAID: string;
  serviceRef: string;
  secretHash: string;
  encryptedBundle: string;
  createIssuedAt: number | null;
  maxRedemptions: number | null;
  expiresAt: number | null;
}): {
  inviteId: string;
  authorAID: string;
  serviceRef: string;
  secretHash: string;
  encryptedBundle: string;
  issuedAt: number;
  maxRedemptions?: number;
  expiresAt?: number;
} {
  return {
    inviteId: rec.inviteId,
    authorAID: rec.authorAID,
    serviceRef: rec.serviceRef,
    secretHash: rec.secretHash,
    encryptedBundle: rec.encryptedBundle,
    issuedAt: rec.createIssuedAt ?? 0,
    ...(rec.maxRedemptions !== null ? { maxRedemptions: rec.maxRedemptions } : {}),
    ...(rec.expiresAt !== null ? { expiresAt: rec.expiresAt } : {}),
  };
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
  // AID signature: proves the redeemer controls `visitorAID` (so a mere
  // secret-holder can't bind a victim's AID). Verified BEFORE touching state.
  if (!verifyRedeemServiceInvite(redeem, hexToBytes(b.aidSig), hexToBytes(b.visitorAID))) {
    return forbidden("invalid AID signature");
  }

  // Look the invite up FIRST so we can branch on approvalMode (manual ⇒ no
  // bind) and check revoked/expired before mutating anything.
  const existing = await deps.invites.getBySecretHash(b.secretHash);
  if (!existing) return notFound("unknown invite");
  if (existing.revokedAt !== null) return forbidden("invite revoked");
  if (existing.expiresAt !== null && now > existing.expiresAt) {
    return gone("invite expired");
  }

  const carrier = createCarrier(existing);

  // MANUAL-approve: do NOT bind here. The author finalizes the bind on their own
  // box via the AcceptServiceInvite loop. Return the signed create so the
  // friend's app can present the service + (via the box) the box can verify.
  if (existing.approvalMode === "manual") {
    return ok({
      pending: true,
      approvalMode: "manual" as const,
      serviceRef: existing.serviceRef,
      create: carrier,
      createSig: existing.createSig,
    });
  }

  // AUTO-approve: bind atomically (first-bind / same-AID idempotent / cap).
  const res = await deps.invites.redeem(b.secretHash, b.visitorAID, now);
  if (!res.ok) {
    if (res.reason === "unknown secret") return notFound("unknown invite");
    if (res.reason === "already bound") return conflict("already bound to another account");
    if (res.reason === "max redemptions reached") return conflict("invite is full");
    if (res.reason === "revoked") return forbidden("invite revoked");
    if (res.reason === "expired") return gone("invite expired");
    return malformed(res.reason);
  }
  // Return the bind + the signed create so the box verifies the owner's
  // authority ITSELF before allow-listing (it does not trust `.com`'s serviceRef
  // / boundAID alone). The bundle ciphertext is included for the author surface.
  return ok({
    redeemed: true,
    approvalMode: "auto" as const,
    firstBind: res.firstBind,
    inviteId: res.record.inviteId,
    serviceRef: res.record.serviceRef,
    authorAID: res.record.authorAID,
    boundAID: res.record.boundAID,
    encryptedBundle: res.record.encryptedBundle,
    create: carrier,
    createSig: res.record.createSig,
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

  // The invite must exist (defense in depth) + the revoke must verify against
  // this account's registered AID OR IRK (dual-accept).
  const existing = await deps.invites.get(r.inviteId);
  if (!existing) return notFound("unknown invite");

  const revoke: RevokeServiceInvite = { inviteId: r.inviteId, issuedAt: r.issuedAt };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid signature hex");
  }
  // Slice D — D-2: membership REVOKE is SENSITIVE. Gate on master-admin
  // authority; the legacy (no-admin-root) path keeps the DUAL-ACCEPT verify.
  const revokeAuthz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: userV.label,
      userRec,
      verifyWith: (pub) => verifyRevokeServiceInvite(revoke, sig, hexToBytes(pub)),
      alsoAcceptAid: true,
      now,
    },
  );
  if (!revokeAuthz.ok) {
    return forbidden("invalid signature");
  }

  await deps.invites.revoke(r.inviteId, now);
  return ok({ revoked: true, inviteId: r.inviteId });
}

// ──────────────────────────────────────────────────────────────────────
// list — GET /api/users/:u/service-invites
//   ?authorAID=<hex>&scope=list&cursor=0&issuedAt=<ms>&sig=<hex>
//
// v2 §C2: OWNER-SIGNED. The v1 list was an open graph dump (anyone with a
// username + a 64-hex authorAID got the whole invite graph). The owner now
// signs a ServiceInviteListQuery (scope "list"), verified against the account's
// registered AID OR IRK before the listing is returned. Metadata only (NO
// secret — secrets are never stored).
// ──────────────────────────────────────────────────────────────────────

export interface ServiceInviteListAuth {
  authorAID: string | null;
  scope: string | null;
  cursor: string | null;
  issuedAt: string | null;
  sig: string | null;
  /**
   * BOX-poll path (revoked-since only): the box's own FQDN. When present, the
   * query may be STK-signed (verified against the registered server's identity
   * pubkey) instead of owner-signed — the box holds no owner key.
   */
  serverDomain?: string | null;
}

/** Parse + verify the signed list/revoked-since query. Returns the validated
 *  query on success, or a typed error response on failure. */
async function authorizeListQuery(
  deps: ServiceInviteDeps,
  username: string,
  scope: "list" | "revoked-since",
  auth: ServiceInviteListAuth,
): Promise<
  | { ok: true; query: ServiceInviteListQuery; cursor: number }
  | { ok: false; res: HandlerResponseWithHeaders }
> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const userV = validateUserLabel(username);
  if (!userV.ok) return { ok: false, res: malformed(userV.reason) };
  if (!auth || typeof auth !== "object") {
    return { ok: false, res: malformed("signed query params required") };
  }
  if (typeof auth.authorAID !== "string" || !HEX64.test(auth.authorAID)) {
    return { ok: false, res: malformed("authorAID query param (64-hex) required") };
  }
  if (auth.scope !== scope) {
    return { ok: false, res: malformed(`scope must be '${scope}'`) };
  }
  if (typeof auth.sig !== "string" || !HEX128.test(auth.sig)) {
    return { ok: false, res: malformed("sig query param (128-hex) required") };
  }
  const issuedAt = Number(auth.issuedAt);
  if (!Number.isFinite(issuedAt)) {
    return { ok: false, res: malformed("issuedAt query param required") };
  }
  const cursorRaw = auth.cursor ?? "0";
  const cursor = Number(cursorRaw);
  if (!Number.isFinite(cursor) || cursor < 0) {
    return { ok: false, res: malformed("cursor must be a non-negative number") };
  }
  if (Math.abs(now - issuedAt) > freshnessMs) {
    return { ok: false, res: forbidden("stale request") };
  }

  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return { ok: false, res: notFound("username not registered") };

  const query: ServiceInviteListQuery = {
    username: userV.label,
    authorAID: auth.authorAID.toLowerCase(),
    scope,
    cursor: scope === "list" ? 0 : cursor,
    issuedAt,
  };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(auth.sig);
  } catch {
    return { ok: false, res: malformed("invalid signature hex") };
  }
  // Owner-signed path (clients / UI): verify against the account AID OR IRK.
  if (verifyAccountSigned(userRec, (pub) => verifyServiceInviteListQuery(query, sig, pub))) {
    return { ok: true, query, cursor: query.cursor };
  }
  // BOX-poll path (revoked-since): the box holds no owner key, so it STK-signs.
  // Accept it iff `serverDomain` resolves to a non-revoked server owned by THIS
  // username and the STK sig verifies against that server's identity pubkey.
  if (
    scope === "revoked-since" &&
    deps.servers &&
    typeof auth.serverDomain === "string" &&
    auth.serverDomain.length > 0
  ) {
    const stkPub = await resolveServerStk(deps, userV.label, auth.serverDomain);
    if (stkPub && verifyServiceInviteListQuery(query, sig, stkPub)) {
      return { ok: true, query, cursor: query.cursor };
    }
  }
  return { ok: false, res: forbidden("invalid signature") };
}

/**
 * Resolve a box's STK pubkey for a BOX-signed query: `serverDomain` must be a
 * non-revoked server owned by `username`. Returns the server's identity pubkey
 * (the STK the box signs with) or null when the server is absent / foreign /
 * revoked / has unreadable key material. The box holds no owner key, so this is
 * how `.com` authenticates a box poll (revoked-since) / fetch (create).
 */
async function resolveServerStk(
  deps: ServiceInviteDeps,
  username: string,
  serverDomain: string,
): Promise<Uint8Array | null> {
  if (!deps.servers) return null;
  const server = await deps.servers.get(serverDomain);
  if (!server || server.username.toLowerCase() !== username || server.revokedAt !== undefined) {
    return null;
  }
  try {
    return hexToBytes(server.identityPubKeyHex);
  } catch {
    return null;
  }
}

export async function handleListServiceInvites(
  deps: ServiceInviteDeps,
  username: string,
  auth: ServiceInviteListAuth,
): Promise<HandlerResponseWithHeaders> {
  const authd = await authorizeListQuery(deps, username, "list", auth);
  if (!authd.ok) return authd.res;

  const invites = (await deps.invites.listForAuthor(authd.query.authorAID)).map((i) => ({
    inviteId: i.inviteId,
    serviceRef: i.serviceRef,
    encryptedBundle: i.encryptedBundle,
    boundAID: i.boundAID,
    boundAt: i.boundAt,
    boundAIDs: i.boundAIDs,
    createdAt: i.createdAt,
    revokedAt: i.revokedAt,
    maxRedemptions: i.maxRedemptions,
    expiresAt: i.expiresAt,
    redemptions: i.redemptions,
    approvalMode: i.approvalMode,
  }));
  return ok({ invites });
}

// ──────────────────────────────────────────────────────────────────────
// revoked-since — GET /api/users/:u/service-invites/revoked-since
//   ?authorAID=<hex>&scope=revoked-since&cursor=<ms>&issuedAt=<ms>&sig=<hex>
//
// v2 box-as-authority: the box POLLS this on a heartbeat cadence and prunes the
// returned AIDs, so a `.com` revoke is SUFFICIENT (multi-box self-heals). Same
// owner-signed gate as the list. Returns { revoked:[{inviteId, boundAIDs,
// serviceRef, revokedAt}], cursor } — `cursor` is the max revokedAt observed so
// the box advances its watermark.
// ──────────────────────────────────────────────────────────────────────

export async function handleRevokedSinceServiceInvites(
  deps: ServiceInviteDeps,
  username: string,
  auth: ServiceInviteListAuth,
): Promise<HandlerResponseWithHeaders> {
  const authd = await authorizeListQuery(deps, username, "revoked-since", auth);
  if (!authd.ok) return authd.res;

  const revoked = await deps.invites.revokedSince(authd.query.authorAID, authd.cursor);
  const nextCursor = revoked.reduce((max, r) => (r.revokedAt > max ? r.revokedAt : max), authd.cursor);
  return ok({
    revoked: revoked.map((r) => ({
      inviteId: r.inviteId,
      serviceRef: r.serviceRef,
      boundAIDs: r.boundAIDs,
      revokedAt: r.revokedAt,
    })),
    cursor: nextCursor,
  });
}

// ──────────────────────────────────────────────────────────────────────
// create fetch — GET /api/users/:u/service-invites/:inviteId/create
//   ?serverDomain=<fqdn>&issuedAt=<ms>&sig=<hex>
//
// v2 box-as-authority + any-device manual-finalize: when the AUTHOR finalizes a
// manual-approve invite, their box verifies the OWNER's signed create — and
// FETCHES it here instead of the author carrying it in a per-device cache. The
// box authenticates with its STK (it holds no owner key); `.com` verifies the
// STK against the registered server + that the server belongs to this username,
// then returns the author's signed `{create, createSig}` (NOT a secret — the
// create is the author's own signed object, which the box re-verifies). 404 on
// an unknown invite OR a v1 row with no stored signature.
// ──────────────────────────────────────────────────────────────────────

export interface ServiceInviteCreateFetchAuth {
  serverDomain: string | null;
  issuedAt: string | null;
  sig: string | null;
}

export async function handleFetchServiceInviteCreate(
  deps: ServiceInviteDeps,
  username: string,
  inviteId: string,
  auth: ServiceInviteCreateFetchAuth,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const userV = validateUserLabel(username);
  if (!userV.ok) return malformed(userV.reason);
  if (typeof inviteId !== "string" || inviteId.length === 0 || inviteId.length > 256) {
    return malformed("inviteId required");
  }
  if (!auth || typeof auth !== "object") return malformed("signed query params required");
  if (typeof auth.serverDomain !== "string" || auth.serverDomain.length === 0) {
    return malformed("serverDomain query param required");
  }
  if (typeof auth.sig !== "string" || !HEX128.test(auth.sig)) {
    return malformed("sig query param (128-hex) required");
  }
  const issuedAt = Number(auth.issuedAt);
  if (!Number.isFinite(issuedAt)) return malformed("issuedAt query param required");
  if (Math.abs(now - issuedAt) > freshnessMs) return forbidden("stale request");

  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  // BOX-STK-signed only (the author's box fetches; a client never does). Verify
  // the STK against the registered server owned by this username.
  const stkPub = await resolveServerStk(deps, userV.label, auth.serverDomain);
  if (!stkPub) return forbidden("invalid signature");
  const query: ServiceInviteCreateQuery = {
    username: userV.label,
    inviteId: inviteId.toLowerCase(),
    serverDomain: auth.serverDomain,
    issuedAt,
  };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(auth.sig);
  } catch {
    return malformed("invalid signature hex");
  }
  if (!verifyServiceInviteCreateQuery(query, sig, stkPub)) {
    return forbidden("invalid signature");
  }

  const existing = await deps.invites.get(query.inviteId);
  if (!existing) return notFound("unknown invite");
  // A v1 row with no persisted signature can't be box-verified — surface 404 so
  // the box falls back (the author can re-issue). The signed create is REQUIRED.
  if (!existing.createSig) return notFound("invite has no signed create");

  return ok({ create: createCarrier(existing), createSig: existing.createSig });
}
