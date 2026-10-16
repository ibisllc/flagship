/**
 * `.com` service-access capability-invite handlers (docs/service-access-gating.md,
 * "## v2 hardening").
 *
 * Five surfaces over the `service_invites` directory:
 *   - create        POST /api/users/:u/service-invites           (admin, or any device at Member)
 *   - redeem        POST /api/service-invites/redeem             (friend AID-signed)
 *   - revoke        POST /api/users/:u/service-invites/revoke     (admin, or the invite's creator key)
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
 *
 * Who may invite (owner decision 2026-10-15, docs/service-access-gating.md,
 * "Account members, ranks and who may change them"): on an account with a
 * pinned admin root a create signed by the admin root (or an admin-granted
 * device) is an ADMIN invite; one signed by a non-admin device's own account
 * device key (the request names its `deviceId`, and the signature proves it)
 * is a MEMBER invite: `.com` records the tier and the device, pushes the admin
 * devices a content-free notice and logs it to the account activity. The AID
 * and IRK, which every device holds, no longer create invites there. The box
 * reads the tier from the signing key itself, caps a member invite's joins at
 * Member and lets people in only while the creating device may still invite
 * in that app, so `.com`'s record is never what keeps a rank down. A revoke is
 * kept with its signature so the box can verify it before pruning anyone.
 *
 * Co-manager invites (owner decision 2026-10-16, docs "Co-manager invites"):
 * someone another account shares a server with at "Can manage" invites at
 * Member, signing the create with their per-share member key. `.com` never
 * learns who shares with whom, so it can't tie that key to the account
 * itself: the shared box vouches for it with an STK-signed
 * `flagship/service-invite-co-manager/v1` naming the key and the create's
 * signature. The row's tier is `co-manager` and its creator key the member
 * key, which may withdraw it. `.com` stores nothing else about the share.
 */

import {
  verifyCreateServiceInvite,
  verifyRedeemServiceInvite,
  verifyRevokeServiceInvite,
  verifyServiceInviteCoManagerRelay,
  verifyServiceInviteCreateQuery,
  verifyServiceInviteListQuery,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type ServiceInviteCreateQuery,
  type ServiceInviteListQuery,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  DeviceCapabilityGrantStorage,
  DeviceIdentityStorage,
  ServerStorage,
  ServiceInviteApprovalMode,
  ServiceInviteCreatorTier,
  ServiceInviteStorage,
  UsernameStorage,
  UsernameRecord,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes } from "./hex.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { recordAuditEvent } from "./auditEvents.js";
import { INVITE_CREATED_TEXT } from "./inviteNotice.js";
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
  /**
   * The account's devices: a create may name the device that made it
   * (`request.deviceId`), kept only when it is a live device of the account.
   * Absent ⇒ the named id is not recorded.
   */
  identities?: Pick<DeviceIdentityStorage, "get" | "getByPub">;
  /** Push the account's admin devices the content-free member-invite notice. */
  notifyAdmins?: (username: string) => Promise<unknown>;
  /** Account activity: a member invite is logged there (content-free). */
  auditEvents?: AuditEventStorage;
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

/**
 * Device-key invite authority (one of the documented exceptions in
 * scripts/admin-authority-guard.sh): a create the admin gate refused may be
 * signed by the account device key of the device it names, while that device
 * is active. Returns the device and the key it verified under, or null. The box
 * caps its joins at Member and checks the device may still invite there.
 */
async function deviceInviteSigner(
  deps: ServiceInviteDeps,
  username: string,
  deviceId: unknown,
  verify: (pub: Uint8Array) => boolean,
): Promise<{ deviceId: string; pubHex: string } | null> {
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId) || !deps.identities) return null;
  const device = await deps.identities.get(username, deviceId);
  if (!device || device.revokedAt !== null) return null;
  try {
    if (!verify(hexToBytes(device.devicePubHex))) return null;
  } catch {
    return null;
  }
  return { deviceId: device.deviceId, pubHex: device.devicePubHex.toLowerCase() };
}

const DEVICE_ID_RE = /^[0-9a-f]{32}$/;

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
    /**
     * The account device that made it. A non-admin device signs with this
     * device's key, so the signature proves it; next to an admin-root
     * signature it is attribution only.
     */
    deviceId?: unknown;
    /** A co-manager's create: the member key it is signed with (64 hex), named by the relay. */
    creatorPubHex?: unknown;
  };
  signature?: unknown;
  /** A co-manager's create, relayed by the shared box (its STK signs `flagship/service-invite-co-manager/v1`). */
  relay?: { serverDomain?: unknown; issuedAt?: unknown; signature?: unknown };
}

/**
 * A co-manager's create, vouched for by the shared box: the relay names a
 * live server of this account and verifies under its STK, it binds this very
 * create (inviteId, app, creator key, create signature), and the create
 * verifies under the creator key. Returns the creator key, or a refusal.
 */
async function coManagerRelaySigner(
  deps: ServiceInviteDeps,
  username: string,
  body: CreateBody,
  create: CreateServiceInvite,
  sig: Uint8Array,
  now: number,
  freshnessMs: number,
): Promise<{ ok: true; pubHex: string } | { ok: false; res: HandlerResponseWithHeaders }> {
  const relay = body.relay!;
  const creator = body.request?.creatorPubHex;
  if (
    typeof creator !== "string" ||
    !HEX64.test(creator) ||
    typeof relay.serverDomain !== "string" ||
    relay.serverDomain.length === 0 ||
    relay.serverDomain.length > 253 ||
    typeof relay.issuedAt !== "number" ||
    !Number.isSafeInteger(relay.issuedAt) ||
    typeof relay.signature !== "string" ||
    !HEX128.test(relay.signature)
  ) {
    return { ok: false, res: malformed("malformed co-manager relay") };
  }
  if (Math.abs(now - relay.issuedAt) > freshnessMs) return { ok: false, res: forbidden("stale request") };
  const stkPub = await resolveServerStk(deps, username, relay.serverDomain.toLowerCase());
  if (!stkPub) return { ok: false, res: forbidden("invalid signature") };
  const pubHex = creator.toLowerCase();
  const relayOk = verifyServiceInviteCoManagerRelay(
    {
      username,
      serverDomain: relay.serverDomain.toLowerCase(),
      inviteId: create.inviteId,
      serviceRef: create.serviceRef,
      creatorPubHex: pubHex,
      createSigHex: String(body.signature).toLowerCase(),
      issuedAt: relay.issuedAt,
    },
    hexToBytes(relay.signature),
    stkPub,
  );
  if (!relayOk || !verifyCreateServiceInvite(create, sig, hexToBytes(pubHex))) {
    return { ok: false, res: forbidden("invalid signature") };
  }
  return { ok: true, pubHex };
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
  if (r.deviceId !== undefined && (typeof r.deviceId !== "string" || !DEVICE_ID_RE.test(r.deviceId))) {
    return malformed("deviceId must be 32 lowercase hex");
  }

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
  let tier: ServiceInviteCreatorTier;
  let creatorPubHex: string;
  let creatorDeviceId: string | undefined;
  // A co-manager's create comes only through the shared box's relay (the
  // documented exception in scripts/admin-authority-guard.sh): Member tier.
  const relayed = body.relay !== undefined && body.relay !== null;
  if (relayed && typeof body.relay !== "object") return malformed("malformed co-manager relay");
  if (relayed && approvalMode === "manual") return malformed("a co-manager's invite lets people in when they open it");
  // Who may invite: the admin gate first (admin root / admin-granted device;
  // on an account with no admin root, the account's own AID or IRK, as
  // before). A create the gate refused may still come from a device's own
  // account device key: a MEMBER invite on an admin-pinned account.
  const createAuthz = relayed
    ? null
    : await authorizeSensitiveComOp(
        { grants: deps.grants, now: deps.now },
        {
          username: userV.label,
          userRec,
          verifyWith: (pub) => verifyCreateServiceInvite(create, sig, hexToBytes(pub)),
          alsoAcceptAid: true,
          now,
        },
      );
  if (relayed) {
    const co = await coManagerRelaySigner(deps, userV.label, body, create, sig, now, freshnessMs);
    if (!co.ok) return co.res;
    tier = "co-manager";
    creatorPubHex = co.pubHex;
  } else if (createAuthz?.ok) {
    tier = "admin";
    creatorPubHex = createAuthz.signerPubHex.toLowerCase();
    // An admin-granted device signed with its own key: that names it. The
    // admin root names no device, so the id the request gives is kept as
    // attribution, when it is a live device of the account.
    const signer = deps.identities ? await deps.identities.getByPub(userV.label, creatorPubHex) : undefined;
    if (signer && signer.revokedAt === null) creatorDeviceId = signer.deviceId;
    else if (typeof r.deviceId === "string" && deps.identities) {
      const named = await deps.identities.get(userV.label, r.deviceId);
      if (named && named.revokedAt === null) creatorDeviceId = named.deviceId;
    }
  } else {
    const device = await deviceInviteSigner(deps, userV.label, r.deviceId, (pub) =>
      verifyCreateServiceInvite(create, sig, pub),
    );
    if (!device) return forbidden("invalid signature");
    tier = userRec.adminRootPubHex ? "member" : "admin";
    creatorPubHex = device.pubHex;
    creatorDeviceId = device.deviceId;
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
    creatorTier: tier,
    creatorPubHex,
    ...(creatorDeviceId ? { creatorDeviceId } : {}),
  });
  if (!res.ok) return conflict(res.reason);
  if (tier !== "admin") await tellAdmins(deps, userV.label, now, creatorDeviceId);
  return ok({ created: true, inviteId: r.inviteId, tier });
}

/** A member invite: log it to the account activity and push the admin devices. Best-effort. */
async function tellAdmins(deps: ServiceInviteDeps, username: string, now: number, deviceId?: string): Promise<void> {
  if (deps.auditEvents) {
    try {
      await recordAuditEvent(
        { auditEvents: deps.auditEvents },
        {
          username,
          eventKind: "invite-created",
          detail: INVITE_CREATED_TEXT,
          devicePrefix: deviceId ? deviceId.slice(0, 8) : "",
          postedAt: now,
        },
      );
    } catch {
      /* an audit write never fails the invite */
    }
  }
  if (deps.notifyAdmins) {
    try {
      await deps.notifyAdmins(username);
    } catch {
      /* a failed push never fails the invite */
    }
  }
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
      creatorPubHex: existing.creatorPubHex,
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
    creatorPubHex: res.record.creatorPubHex,
  });
}

/**
 * The creator-key withdraw (documented in scripts/admin-authority-guard.sh):
 * a MEMBER invite may be revoked by the very device key that created it, and
 * only while that device is still an active device of the account. Returns the
 * key it verified under, or null. (Whether the device may still withdraw in
 * that app is the box's call: it verifies the kept revoke itself.)
 */
async function revokedByCreator(
  deps: ServiceInviteDeps,
  username: string,
  invite: { creatorTier: ServiceInviteCreatorTier | null; creatorPubHex: string | null },
  verify: (pub: Uint8Array) => boolean,
): Promise<string | null> {
  const creator =
    invite.creatorTier === "member" || invite.creatorTier === "co-manager" ? invite.creatorPubHex?.toLowerCase() : undefined;
  if (!creator) return null;
  // A co-manager withdraws their own invite with the member key it was made
  // with. Withdrawing only ever takes access away, so `.com` needn't know
  // whether the share still stands (the box checks that before pruning).
  if (invite.creatorTier === "co-manager") {
    try {
      return verify(hexToBytes(creator)) ? creator : null;
    } catch {
      return null;
    }
  }
  if (!deps.identities) return null;
  const device = await deps.identities.getByPub(username, creator);
  if (!device || device.revokedAt !== null) return null;
  try {
    return verify(hexToBytes(creator)) ? creator : null;
  } catch {
    return null;
  }
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
  // Revoke: an admin (the gate; on an account with no admin root, the
  // account key as before), or the key that created this member invite (a
  // device may withdraw its own invite), while it is still the account's.
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
  const signerPubHex = revokeAuthz.ok
    ? revokeAuthz.signerPubHex.toLowerCase()
    : await revokedByCreator(deps, userV.label, existing, (pub) => verifyRevokeServiceInvite(revoke, sig, pub));
  if (!signerPubHex) return forbidden("invalid signature");

  await deps.invites.revoke(r.inviteId, now, {
    signature: body.signature.toLowerCase(),
    issuedAt: r.issuedAt,
    signerPubHex,
  });
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
    creatorTier: i.creatorTier,
    creatorDeviceId: i.creatorDeviceId,
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
      // The signed revoke the box verifies before it prunes anyone (null on
      // rows revoked before migration 0102: the box ignores those).
      revoke:
        r.revokeSig !== null && r.revokeIssuedAt !== null ? { inviteId: r.inviteId, issuedAt: r.revokeIssuedAt } : null,
      revokeSig: r.revokeSig,
      revokerPubHex: r.revokeSignerPubHex,
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

  return ok({ create: createCarrier(existing), createSig: existing.createSig, creatorPubHex: existing.creatorPubHex });
}
