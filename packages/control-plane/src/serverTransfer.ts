/**
 * Transfer-a-box broker — a cross-account ownership handoff brokered by `.com`.
 * docs/account-deletion-and-name-reclaim.md §4.
 *
 *   POST /api/server/:domain/transfer/offer          giver, IRK mailbox-auth
 *   POST /api/server/:domain/transfer/claim          acquirer, signed ServerTransferClaim (v2)
 *   GET  /api/server/:domain/transfer/claim          giver, IRK mailbox-auth (re-seal poll)
 *   POST /api/server/:domain/transfer/admin-handoff  giver, admin-root-signed AdminRootTransfer
 *                                                    (Slice D §9.8 — the sig IS the auth)
 *
 * Three envelopes, two parties:
 *   - The GIVER (current owner) deposits a `ServerTransferOffer` (giver-IRK-
 *     signed, names the box + a one-time short-TTL nonce, NOT the acquirer).
 *     This is what the QR carries.
 *   - The ACQUIRER POSTs a `ServerTransferClaim` (acquirer-IRK-signed, binds
 *     their username + IRK pub to the offer's nonce).
 *   - On a valid claim `.com` performs the NAMESPACE MIGRATION — re-homes the
 *     `servers` + `routing` records to the acquirer's namespace
 *     (`<server>.<oldowner>` → `<server>.<acquirer>`) and publishes the new
 *     per-box DNS, then marks the offer claimed (one-time) and audits.
 *
 * ⚠️ The broker move is the `.com` HALF. Two steps are deliberately OUT of the
 * broker (each needs a box-side pass + a reburn to validate e2e, see §4):
 *   1. Box-side: re-issue the LE cert for the NEW SANs (per-box ACME on the new
 *      podCanonical) + pick up a fresh acquirer-minted RootEntitlement.
 *   2. Disk-key re-seal: only the GIVER's phone can unseal the LUKS key (the box
 *      never holds the giver IRK). So the giver's phone polls the GET claim
 *      endpoint, learns the acquirer IRK, and deposits a NEW box-sealed lease
 *      sealed to it via the existing `handlePostBoxSealedLease` lane.
 *
 * Security posture:
 *   - The offer is verified under the box's CURRENT registered owner IRK
 *     (via servers.get → usernames.get) — only the real owner can offer.
 *   - The offer-deposit is gated by IRK mailbox-auth bound to the giver account
 *     (reuses the secret-mailbox `DeviceEndpointClaim` credential).
 *   - The claim is verified under the acquirer's REGISTERED IRK
 *     (usernames.get(acquirerUsername)); the claim's acquirerIrkPub MUST equal
 *     that registered IRK — a claim can't bind ownership to an unregistered key.
 *   - One offer per box (re-issue replaces); claim is an atomic one-time CAS.
 */

import {
  verifyAdminRootTransfer,
  verifyDeviceEndpointClaim,
  verifyServerTransferOffer,
  verifyServerTransferClaim,
  type AdminRootTransfer,
  type DeviceEndpointClaim,
  type ServerTransferOffer,
  type ServerTransferClaim,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  DeviceCapabilityGrantStorage,
  RoutingStorage,
  ServerStorage,
  ServerTransferStorage,
  UsernameStorage,
} from "@flagship/storage";
import type { DnsUpsertClient } from "./serverRegister.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { HEX64, HEX128, equalHex, hexToBytes } from "./hex.js";
import {
  conflict, forbidden, gone, malformed, notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface ServerTransferDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  routing: RoutingStorage;
  serverTransfers: ServerTransferStorage;
  auditEvents?: AuditEventStorage;
  /** Slice D — device-grant store for the master-admin authority gate (§2 rows
   *  28 [giver] + 29 [acquirer's admin root]). Optional: absent ⇒ only the bare
   *  admin root satisfies the open gate. */
  grants?: DeviceCapabilityGrantStorage;
  /** Per-box DNS publisher for the acquirer's new FQDN (same shape as
   *  registration). Absent ⇒ the migration completes without re-publishing
   *  DNS (best-effort, mirroring registration's dnsError path). */
  dns?: {
    client: DnsUpsertClient;
    servicesIpv4: string;
    servicesIpv6?: string;
  };
  /** Data-plane apex (`flagship.services` prod, `gym.flagship.services` test).
   *  Used to re-home the FQDN. Defaults to the prod literal. */
  apex?: string;
  /** Offer freshness/auth window (ms). Default 5 min. */
  maxAgeMs?: number;
  /** Offer TTL (ms) — how long a captured QR is claimable. Default 15 min. */
  offerTtlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;
const DEFAULT_OFFER_TTL = 15 * 60_000;
const HEX_NONCE = /^[0-9a-f]{64}$/; // 32 bytes hex

type AuthResult =
  | { ok: true; username: string }
  | { ok: false; response: HandlerResponseWithHeaders };

/**
 * IRK-signed mailbox-auth — the phone signs a `DeviceEndpointClaim` binding
 * (username, phoneIrkPub) with the user's IRK; `.com` verifies against the
 * account's registered IRK so the lane is served only to the account's own
 * phone. Identical credential to `secretMailbox.authPhoneMailbox` (not exported
 * there). Returns the authed (lowercased) username.
 */
async function authPhoneMailbox(
  deps: ServerTransferDeps,
  body: unknown,
): Promise<AuthResult> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const b = body as { auth?: Record<string, unknown>; authSignature?: unknown };
  const a = b?.auth ?? {};
  if (
    typeof a.username !== "string" ||
    typeof a.endpointLabel !== "string" ||
    typeof a.phoneIrkPub !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof a.expiresAt !== "number" ||
    typeof a.nonce !== "string" ||
    typeof b?.authSignature !== "string"
  ) {
    return { ok: false, response: malformed("malformed mailbox auth") };
  }
  if (!HEX64.test(a.phoneIrkPub.toLowerCase())) {
    return { ok: false, response: malformed("phoneIrkPub must be 32 bytes hex") };
  }
  if (!HEX_NONCE.test(a.nonce.toLowerCase())) {
    return { ok: false, response: malformed("auth nonce must be 32 bytes hex") };
  }
  if (!HEX128.test(b.authSignature.toLowerCase())) {
    return { ok: false, response: malformed("authSignature must be 64 bytes hex") };
  }
  if (Math.abs(now() - a.issuedAt) > maxAgeMs) {
    return { ok: false, response: forbidden("stale mailbox auth") };
  }
  if (a.expiresAt <= now()) {
    return { ok: false, response: forbidden("mailbox auth expired") };
  }
  const usernameNorm = a.username.toLowerCase();
  const userRec = await deps.usernames.get(usernameNorm);
  if (!userRec) return { ok: false, response: notFound("unknown user") };
  if (!equalHex(a.phoneIrkPub, userRec.irkPubHex)) {
    return { ok: false, response: forbidden("phoneIrkPub does not match account IRK") };
  }
  let phoneIrkPub: Uint8Array;
  let nonce: Uint8Array;
  let sig: Uint8Array;
  try {
    phoneIrkPub = hexToBytes(a.phoneIrkPub);
    nonce = hexToBytes(a.nonce);
    sig = hexToBytes(b.authSignature);
  } catch {
    return { ok: false, response: malformed("invalid hex") };
  }
  const claim: DeviceEndpointClaim = {
    username: a.username,
    endpointLabel: a.endpointLabel,
    phoneIrkPub,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    nonce,
  };
  if (!verifyDeviceEndpointClaim(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { ok: false, response: forbidden("invalid mailbox auth signature") };
  }
  return { ok: true, username: usernameNorm };
}

/** Split `<server>.<user>.<apex>` into its labels, or null on shape mismatch. */
function splitPodCanonical(
  domain: string,
  apex: string,
): { server: string; user: string } | null {
  const lower = domain.toLowerCase();
  const suffix = `.${apex.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return null;
  const head = lower.slice(0, -suffix.length);
  const parts = head.split(".");
  if (parts.length !== 2) return null; // exactly <server>.<user>
  const server = parts[0]!;
  const user = parts[1]!;
  if (!/^[a-z0-9-]{1,63}$/.test(server)) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(user)) return null;
  return { server, user };
}

// ──────────────────────────────────────────────────────────────────────
// 1. POST /api/server/:domain/transfer/offer  (giver, IRK mailbox-auth)
//
// The giver deposits a one-time, short-TTL `ServerTransferOffer` for the box.
// `.com` verifies the offer signature under the box's CURRENT registered owner
// IRK (servers.get → usernames.get) and that the authed phone owns that
// account. Stored keyed by domain — a re-issued offer replaces.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostTransferOffer(
  deps: ServerTransferDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const b = body as { offer?: Record<string, unknown>; offerSignature?: unknown };
  const o = b?.offer ?? {};
  if (
    typeof o.serverDomain !== "string" ||
    typeof o.transferNonce !== "string" ||
    typeof o.issuedAt !== "number" ||
    typeof o.expiresAt !== "number" ||
    typeof b?.offerSignature !== "string"
  ) {
    return malformed("malformed offer");
  }
  if (o.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!HEX_NONCE.test(o.transferNonce.toLowerCase())) {
    return malformed("transferNonce must be 32 bytes hex");
  }
  if (!HEX128.test(b.offerSignature.toLowerCase())) {
    return malformed("offerSignature must be 64 bytes hex");
  }
  if (Math.abs(now() - o.issuedAt) > (deps.maxAgeMs ?? DEFAULT_MAX_AGE)) {
    return forbidden("stale offer");
  }

  // Verify the offer under the box's CURRENT registered owner IRK.
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (reg.username.toLowerCase() !== auth.username) {
    return forbidden("server belongs to a different account");
  }
  const owner = await deps.usernames.get(reg.username.toLowerCase());
  if (!owner) return notFound("unknown owner");

  const offer: ServerTransferOffer = {
    serverDomain: o.serverDomain,
    transferNonce: o.transferNonce,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
  };
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(b.offerSignature);
  } catch {
    return malformed("invalid hex");
  }
  // Slice D §2 row 28 — SENSITIVE: the giver's master-admin authority (legacy
  // owner-IRK when no admin root is pinned).
  const offerAuthz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: reg.username.toLowerCase(),
      userRec: owner,
      verifyWith: (pub) => verifyServerTransferOffer(offer, sigBytes, hexToBytes(pub)),
    },
  );
  if (!offerAuthz.ok) {
    return forbidden("invalid offer signature");
  }

  const ttlMs = deps.offerTtlMs ?? DEFAULT_OFFER_TTL;
  const expiresAt = now() + ttlMs;
  await deps.serverTransfers.putOffer({
    serverDomain: host,
    giverUsername: reg.username.toLowerCase(),
    transferNonce: o.transferNonce.toLowerCase(),
    giverIrkPubHex: owner.irkPubHex.toLowerCase(),
    issuedAt: o.issuedAt,
    expiresAt,
    offerSignatureHex: b.offerSignature.toLowerCase(),
    claimedAt: null,
    acquirerUsername: null,
    acquirerIrkPubHex: null,
    claimIssuedAt: null,
    claimSignatureHex: null,
    diskKeyHandoffHex: null,
    diskKeyHandoffAt: null,
    acquirerAdminRootPubHex: null,
    adminHandoffOldRootHex: null,
    adminHandoffNewRootHex: null,
    adminHandoffIssuedAt: null,
    adminHandoffSigHex: null,
  });

  if (deps.auditEvents) {
    try {
      await deps.auditEvents.append({
        username: reg.username.toLowerCase(),
        eventKind: "server-transfer-offered",
        detail: `Offered ${host} for transfer`,
        devicePrefix: "",
        postedAt: now(),
      });
    } catch {
      /* swallow — an audit hiccup must never fail the offer */
    }
  }

  return ok({ ok: true, expiresAt });
}

// ──────────────────────────────────────────────────────────────────────
// 2. POST /api/server/:domain/transfer/claim  (acquirer, signed claim)
//
// The acquirer's phone POSTs a signed `ServerTransferClaim`. `.com` verifies:
//   - a LIVE (stored, unexpired, unclaimed) offer whose nonce matches;
//   - the claim sig under the acquirer's REGISTERED IRK (usernames.get);
//   - the claim's acquirerIrkPub == that registered IRK.
// On success it performs the NAMESPACE MIGRATION and marks the offer claimed.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostTransferClaim(
  deps: ServerTransferDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = deps.now ?? (() => Date.now());
  const b = body as { claim?: Record<string, unknown>; claimSignature?: unknown };
  const c = b?.claim ?? {};
  if (
    typeof c.serverDomain !== "string" ||
    typeof c.transferNonce !== "string" ||
    typeof c.acquirerUsername !== "string" ||
    typeof c.acquirerIrkPub !== "string" ||
    typeof c.acquirerAdminRootPub !== "string" ||
    typeof c.issuedAt !== "number" ||
    typeof b?.claimSignature !== "string"
  ) {
    return malformed("malformed claim");
  }
  if (c.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!HEX_NONCE.test(c.transferNonce.toLowerCase())) {
    return malformed("transferNonce must be 32 bytes hex");
  }
  if (!HEX64.test(c.acquirerIrkPub.toLowerCase())) {
    return malformed("acquirerIrkPub must be 32 bytes hex");
  }
  // Claim canonical v2 (Slice D §9.8) — the acquirer's admin master root rides
  // INSIDE the signed claim ("" = the acquirer account has no admin root), so a
  // rogue `.com` cannot swap the anchor the giver's handoff proof will commit to.
  if (c.acquirerAdminRootPub !== "" && !HEX64.test(c.acquirerAdminRootPub.toLowerCase())) {
    return malformed("acquirerAdminRootPub must be empty or 32 bytes hex");
  }
  if (!HEX128.test(b.claimSignature.toLowerCase())) {
    return malformed("claimSignature must be 64 bytes hex");
  }
  if (Math.abs(now() - c.issuedAt) > (deps.maxAgeMs ?? DEFAULT_MAX_AGE)) {
    return forbidden("stale claim");
  }

  // The offer must be live (stored, unexpired, unclaimed) before we even verify
  // the claim — gives a clean 404/410 rather than a generic forbidden.
  const offerRow = await deps.serverTransfers.getOffer(host, now());
  if (!offerRow) return notFound("no live transfer offer");
  if (offerRow.claimedAt !== null) return gone("offer already claimed");
  if (offerRow.transferNonce !== c.transferNonce.toLowerCase()) {
    return forbidden("transferNonce mismatch");
  }

  // The box must still exist + be owned by the offer's giver (no transfer of a
  // revoked / already-moved box).
  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  if (reg.username.toLowerCase() !== offerRow.giverUsername) {
    return forbidden("server no longer owned by the offering account");
  }

  // Verify the claim under the acquirer's REGISTERED IRK — and that the claim's
  // bound IRK equals it (ownership can only re-bind to a registered key).
  const acquirerNorm = c.acquirerUsername.toLowerCase();
  if (acquirerNorm === offerRow.giverUsername) {
    return forbidden("cannot transfer a box to its current owner");
  }
  const acquirer = await deps.usernames.get(acquirerNorm);
  if (!acquirer) return notFound("unknown acquirer account");
  if (!equalHex(c.acquirerIrkPub, acquirer.irkPubHex)) {
    return forbidden("acquirerIrkPub does not match the acquirer's registered IRK");
  }

  const claim: ServerTransferClaim = {
    serverDomain: c.serverDomain,
    transferNonce: c.transferNonce,
    acquirerUsername: c.acquirerUsername,
    acquirerIrkPub: hexToBytes(c.acquirerIrkPub),
    acquirerAdminRootPubHex: c.acquirerAdminRootPub,
    issuedAt: c.issuedAt,
  };
  let claimSig: Uint8Array;
  try {
    claimSig = hexToBytes(b.claimSignature);
  } catch {
    return malformed("invalid hex");
  }
  // Slice D §2 row 29 — SENSITIVE: the ACQUIRER's master-admin authority (a box
  // re-homes only under the acquirer's admin root; legacy acquirer-IRK when no
  // admin root is pinned). The `acquirerIrkPub` re-home target is bound to the
  // acquirer's registered membership IRK above — that binding is unchanged.
  const claimAuthz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: acquirerNorm,
      userRec: acquirer,
      verifyWith: (pub) => verifyServerTransferClaim(claim, claimSig, hexToBytes(pub)),
    },
  );
  if (!claimAuthz.ok) {
    return forbidden("invalid claim signature");
  }

  // Atomic one-time claim (CAS on claimed_at IS NULL). A racing second claim
  // loses here.
  const claimed = await deps.serverTransfers.claim(
    host,
    c.transferNonce.toLowerCase(),
    acquirerNorm,
    acquirer.irkPubHex.toLowerCase(),
    c.acquirerAdminRootPub.toLowerCase(),
    c.issuedAt,
    b.claimSignature.toLowerCase(),
    now(),
  );
  if (!claimed.ok) {
    if (claimed.reason === "already claimed") return gone("offer already claimed");
    if (claimed.reason === "expired") return gone("offer expired");
    if (claimed.reason === "no offer") return notFound("no live transfer offer");
    return forbidden(claimed.reason);
  }

  // ── NAMESPACE MIGRATION (`.com` half) ────────────────────────────────
  // Re-home the box from `<server>.<giver>` to `<server>.<acquirer>`: a new
  // FQDN (the box's identity is bound to the owner namespace at every layer —
  // FQDN, cert SANs, podCanonical, DNS, routing). The box keeps its SAME
  // identity key, so the new servers + routing records carry it forward; only
  // the namespace moves. Best-effort past the servers/routing move (a DNS or
  // audit hiccup must not undo the committed ownership change).
  const apex = deps.apex ?? "flagship.services";
  const parts = splitPodCanonical(host, apex);
  const newDomain = parts ? `${parts.server}.${acquirerNorm}.${apex}` : null;
  const migration: { newDomain: string | null; dnsError?: string; routingError?: string } = {
    newDomain,
  };

  if (newDomain && newDomain !== host) {
    // 1) Move the servers record (new PK domain, new owner; same identity key).
    try {
      await deps.servers.put({
        serverDomain: newDomain,
        username: acquirerNorm,
        identityPubKeyHex: reg.identityPubKeyHex,
        registeredAt: reg.registeredAt,
      });
      // Revoke the old domain row so the leftover entry can't route / be reused
      // under the giver. (The box itself stops answering on the old FQDN once it
      // re-homes — box-side handoff.)
      await deps.servers.revoke(host, "transferred", now());
    } catch (e) {
      migration.routingError = String((e as Error).message ?? e);
    }

    // 2) Move the routing record: register the new subdomain with the SAME RCK
    //    + target as the old (the box identity is unchanged), then release the
    //    old. register() refuses a different RCK, but the new subdomain is
    //    fresh, so it succeeds. Best-effort.
    try {
      const oldRouting = parts ? await deps.routing.get(`${parts.server}.${parts.user}`) : undefined;
      if (oldRouting) {
        await deps.routing.register({
          subdomain: `${parts!.server}.${acquirerNorm}`,
          username: acquirerNorm,
          rckPubKeyHex: oldRouting.rckPubKeyHex,
          currentTargetHex: oldRouting.currentTargetHex,
          registeredAt: oldRouting.registeredAt,
          lastTargetUpdate: now(),
          lastTargetNonce: oldRouting.lastTargetNonce,
        });
        await deps.routing.release(`${parts!.server}.${parts!.user}`);
      }
    } catch (e) {
      migration.routingError = (migration.routingError ? migration.routingError + "; " : "") +
        String((e as Error).message ?? e);
    }

    // 3) Publish the acquirer's per-box DNS (apex + wildcard), same as
    //    registration. Best-effort.
    if (deps.dns) {
      try {
        const names = [newDomain, `*.${newDomain}`];
        for (const name of names) {
          await deps.dns.client.upsert({ name, type: "A", content: deps.dns.servicesIpv4 });
          if (deps.dns.servicesIpv6) {
            await deps.dns.client.upsert({ name, type: "AAAA", content: deps.dns.servicesIpv6 });
          }
        }
      } catch (e) {
        migration.dnsError = String((e as Error).message ?? e);
      }
    }
  }

  // Audit on BOTH account feeds (giver loses, acquirer gains).
  if (deps.auditEvents) {
    for (const [u, detail] of [
      [offerRow.giverUsername, `Transferred ${host} to ${acquirerNorm}`],
      [acquirerNorm, `Received ${newDomain ?? host} from ${offerRow.giverUsername}`],
    ] as const) {
      try {
        await deps.auditEvents.append({
          username: u,
          eventKind: "server-transfer-claimed",
          detail,
          devicePrefix: "",
          postedAt: now(),
        });
      } catch {
        /* swallow */
      }
    }
  }

  return ok({
    ok: true,
    serverDomain: host,
    newServerDomain: newDomain,
    acquirerUsername: acquirerNorm,
    dnsError: migration.dnsError,
    routingError: migration.routingError,
  });
}

// ──────────────────────────────────────────────────────────────────────
// 3. GET /api/server/:domain/transfer/claim  (giver, IRK mailbox-auth)
//
// The GIVER's phone polls for "did someone claim my offer?" — and learns the
// acquirer IRK so it can re-seal the LUKS disk key for the new owner (only the
// giver's phone holds the giver IRK to unseal it). Auth is IRK mailbox-auth
// bound to the giver account; we serve the claim ONLY to the offer's giver.
// Returns 404 while unclaimed.
// ──────────────────────────────────────────────────────────────────────

export async function handleGetTransferClaim(
  deps: ServerTransferDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const row = await deps.serverTransfers.getOffer(host, now());
  if (!row) return notFound("no transfer offer");
  // Only the offer's giver may read the claim (the re-seal is their step).
  if (row.giverUsername !== auth.username) {
    return forbidden("offer belongs to a different account");
  }
  if (row.claimedAt === null) return notFound("offer not yet claimed");

  const apex = deps.apex ?? "flagship.services";
  const parts = splitPodCanonical(host, apex);
  const newDomain =
    parts && row.acquirerUsername ? `${parts.server}.${row.acquirerUsername}.${apex}` : null;

  return ok({
    serverDomain: host,
    newServerDomain: newDomain,
    claimedAt: row.claimedAt,
    acquirerUsername: row.acquirerUsername,
    // The acquirer IRK the giver's phone re-seals the disk key for.
    acquirerIrkPub: row.acquirerIrkPubHex,
    // Slice D §9.8 — the acquirer's admin master root the CLAIM committed to
    // ("" = the acquirer has no admin root; null = pre-v2 legacy claim). The
    // giver's phone folds it into the giver-root-signed AdminRootTransfer.
    acquirerAdminRootPub: row.acquirerAdminRootPubHex,
  });
}

// ──────────────────────────────────────────────────────────────────────
// 4. GET /api/server/:domain/rehome  (box, PUBLIC consume-once-style read)
//
// The BOX (which knows its OLD canonical FQDN = its FLAGSHIP_SUBDOMAIN) polls
// this to learn "did my owner change?". After a successful claim the transfer
// row — keyed by the OLD domain — holds the acquirer's username + IRK pub. The
// box reads those, re-derives its new canonical (`<server>.<acquirer>.<apex>`),
// and re-homes (cert SANs + entitlement). Public because the payload is already
// public identity (the acquirer's username + their registered IRK pub are CT-/
// directory-visible); the box does NOT trust this as a key authority — it
// re-verifies a fresh acquirer-IRK-signed entitlement and the giver-signed
// re-sealed disk-key lease before serving, exactly like first-boot. 404 when the
// box was never transferred (the common case) so the poller stays cheap.
// ──────────────────────────────────────────────────────────────────────

export async function handleGetTransferRehome(
  deps: ServerTransferDeps,
  host: string,
): Promise<HandlerResponseWithHeaders> {
  const now = deps.now ?? (() => Date.now());
  const row = await deps.serverTransfers.getOffer(host, now());
  if (!row || row.claimedAt === null || !row.acquirerUsername || !row.acquirerIrkPubHex) {
    return notFound("no completed transfer for this server");
  }
  const apex = deps.apex ?? "flagship.services";
  const parts = splitPodCanonical(host, apex);
  const newServerDomain = parts ? `${parts.server}.${row.acquirerUsername}.${apex}` : null;
  return ok({
    rehomed: true,
    serverDomain: host,
    newServerDomain,
    acquirerUsername: row.acquirerUsername,
    acquirerIrkPub: row.acquirerIrkPubHex,
    claimedAt: row.claimedAt,
    // Slice D §9.8 — advisory echo of the claim's admin anchor (the box never
    // acts on it directly; it acts only on the verified adminHandoff below).
    ...(row.acquirerAdminRootPubHex !== null
      ? { acquirerAdminRootPub: row.acquirerAdminRootPubHex }
      : {}),
    // TODO(v1-sec GAP 3, control-plane follow-up): relay the LEGACY
    // giver-owner-IRK re-home authorization here as
    //   rehomeAuth: { issuedAt, signatureHex }
    // (a `flagship/server-rehome-auth/v1` signature over
    //  {oldServerDomain, newServerDomain, acquirerIrkPub, issuedAt}). A box with
    // NO pinned admin root now REFUSES to re-home without it (fail-closed —
    // never on `.com`'s unsigned word). This needs: a giver-phone deposit
    // endpoint (mirroring the disk-key/admin-handoff deposits below) that stores
    // the giver-IRK signature on the offer row, and echoing it in this response.
    // Until wired, legacy (non-admin-tier) transfers stall at re-home — the
    // intended safe default for the hardening branch.
    //
    // The GIVER-admin-root-signed handoff proof, once deposited. A box with a
    // pinned admin root REFUSES to re-home until this verifies against its
    // pinned anchor — `.com` relays the proof but cannot forge it.
    ...(row.adminHandoffSigHex !== null &&
    row.adminHandoffOldRootHex !== null &&
    row.adminHandoffNewRootHex !== null &&
    row.adminHandoffIssuedAt !== null
      ? {
          adminHandoff: {
            giverUsername: row.giverUsername,
            acquirerUsername: row.acquirerUsername,
            oldAdminRootPub: row.adminHandoffOldRootHex,
            newAdminRootPub: row.adminHandoffNewRootHex,
            transferNonce: row.transferNonce,
            issuedAt: row.adminHandoffIssuedAt,
            signatureHex: row.adminHandoffSigHex,
          },
        }
      : {}),
  });
}

// ──────────────────────────────────────────────────────────────────────
// 5. POST /api/server/:domain/transfer/disk-key  (giver, IRK mailbox-auth)
//
// Layer B — the giver-phone disk-key re-seal deposit. Only the GIVER's phone
// can unseal the box's LUKS disk key (it holds the giver IRK; the box holds
// only the sealed blob). After the acquirer claims, the giver's phone unseals
// the current disk key, RE-SEALS it to the ACQUIRER IRK (learned from
// claim-poll), and deposits the sealed blob here. `.com` stays content-blind —
// only the acquirer's IRK can open it. We accept it ONLY on a CLAIMED row whose
// giver-account is the authed phone (the re-seal is the giver's step).
// ──────────────────────────────────────────────────────────────────────

export async function handlePostTransferDiskKey(
  deps: ServerTransferDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const b = body as { sealedDiskKey?: unknown };
  if (typeof b?.sealedDiskKey !== "string") {
    return malformed("sealedDiskKey required");
  }
  const sealedHex = b.sealedDiskKey.toLowerCase();
  if (!/^[0-9a-f]+$/.test(sealedHex) || sealedHex.length < 88 || sealedHex.length > 65536) {
    // ≥44 bytes (eph_pub + nonce) → ≥88 hex; bounded.
    return malformed("sealedDiskKey must be a sealed blob within bounds");
  }

  const row = await deps.serverTransfers.getOffer(host, now());
  if (!row || row.claimedAt === null) return notFound("no claimed transfer for this server");
  if (row.giverUsername !== auth.username) {
    return forbidden("only the offering account may deposit the re-sealed key");
  }

  const stored = await deps.serverTransfers.putDiskKeyHandoff(host, sealedHex, now());
  if (!stored) return notFound("no claimed transfer for this server");
  return ok({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// 6. POST /api/server/:domain/transfer/disk-key-claim  (acquirer, IRK mailbox-auth)
//
// Layer B — the acquirer's phone picks up the giver's re-sealed disk key,
// opens it with the acquirer IRK, and (client-side) completes the standard
// box-sealed-lease deposit. Served ONLY to the acquirer bound on the claimed
// row. Returns the sealed-to-acquirer-IRK blob; 404 until the giver deposits.
// POST (not GET) — the IRK mailbox-auth rides the body, mirroring claim-poll.
// ──────────────────────────────────────────────────────────────────────

export async function handleGetTransferDiskKey(
  deps: ServerTransferDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const auth = await authPhoneMailbox(deps, body);
  if (!auth.ok) return auth.response;

  const now = deps.now ?? (() => Date.now());
  const row = await deps.serverTransfers.getOffer(host, now());
  if (!row || row.claimedAt === null) return notFound("no claimed transfer for this server");
  if (row.acquirerUsername !== auth.username) {
    return forbidden("only the acquiring account may read the re-sealed key");
  }
  if (!row.diskKeyHandoffHex) return notFound("re-sealed disk key not yet deposited");
  return ok({ sealedDiskKey: row.diskKeyHandoffHex });
}

// ──────────────────────────────────────────────────────────────────────
// 7. POST /api/server/:domain/transfer/admin-handoff  (giver's phone)
//
// Slice D §9.8 — the giver deposits the ADMIN-ROOT handoff proof: a
// `flagship/admin-root-transfer/v1` envelope signed by the GIVER's admin
// master root, committing (this box, this offer's nonce, giver root →
// acquirer root). The box will ONLY re-pin its authority anchor on this
// proof, verified against the root it already pins — never on `.com`'s word.
//
// This endpoint carries NO additional auth gate (no mailbox-auth): the
// admin-root signature IS the authorization — only the giver's admin master
// root can produce it, and `.com` cannot forge it. `.com`'s verify below
// (against the giver account's registered `admin_root_pub_hex`) is a
// sanity/garbage filter so junk never occupies the relay slot; the box
// re-verifies against its PINNED root regardless, so a compromised `.com`
// gains nothing by skipping or corrupting this check.
//
// Idempotent: a re-deposit replaces (the giver's phone may retry).
// ──────────────────────────────────────────────────────────────────────

export async function handlePostTransferAdminHandoff(
  deps: ServerTransferDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = deps.now ?? (() => Date.now());
  const b = body as { handoff?: Record<string, unknown>; signatureHex?: unknown };
  const h = b?.handoff ?? {};
  if (
    typeof h.serverDomain !== "string" ||
    typeof h.giverUsername !== "string" ||
    typeof h.acquirerUsername !== "string" ||
    typeof h.oldAdminRootPub !== "string" ||
    typeof h.newAdminRootPub !== "string" ||
    typeof h.transferNonce !== "string" ||
    typeof h.issuedAt !== "number" ||
    typeof b?.signatureHex !== "string"
  ) {
    return malformed("malformed admin handoff");
  }
  if (h.serverDomain !== host) {
    return forbidden("serverDomain / host mismatch");
  }
  if (!HEX64.test(h.oldAdminRootPub.toLowerCase())) {
    return malformed("oldAdminRootPub must be 32 bytes hex");
  }
  if (h.newAdminRootPub !== "" && !HEX64.test(h.newAdminRootPub.toLowerCase())) {
    return malformed("newAdminRootPub must be empty or 32 bytes hex");
  }
  if (!HEX_NONCE.test(h.transferNonce.toLowerCase())) {
    return malformed("transferNonce must be 32 bytes hex");
  }
  if (!HEX128.test(b.signatureHex.toLowerCase())) {
    return malformed("signatureHex must be 64 bytes hex");
  }

  const row = await deps.serverTransfers.getOffer(host, now());
  if (!row || row.claimedAt === null) return notFound("no claimed transfer for this server");
  if (row.transferNonce !== h.transferNonce.toLowerCase()) {
    return conflict("transferNonce does not match the claimed transfer");
  }
  if (row.acquirerUsername !== h.acquirerUsername.toLowerCase()) {
    return conflict("acquirerUsername does not match the claimed transfer");
  }
  if (row.giverUsername !== h.giverUsername.toLowerCase()) {
    return conflict("giverUsername does not match the offering account");
  }
  // The handoff's target root must be EXACTLY the anchor the acquirer's SIGNED
  // claim committed to (both may be "") — the giver can't aim the box at a
  // third-party root, and `.com` can't have swapped the claim's anchor without
  // breaking the acquirer's v2 claim signature.
  if (row.acquirerAdminRootPubHex === null) {
    return conflict("claim carried no admin anchor (pre-v2 legacy claim)");
  }
  if (row.acquirerAdminRootPubHex !== h.newAdminRootPub.toLowerCase()) {
    return conflict("newAdminRootPub does not match the claim's admin anchor");
  }

  const giver = await deps.usernames.get(row.giverUsername);
  if (!giver) return notFound("unknown giver account");
  if (!giver.adminRootPubHex) {
    return conflict("account has no admin root");
  }
  if (giver.adminRootPubHex.toLowerCase() !== h.oldAdminRootPub.toLowerCase()) {
    return conflict("oldAdminRootPub does not match the giver account's admin root");
  }

  const transfer: AdminRootTransfer = {
    serverDomain: h.serverDomain,
    giverUsername: h.giverUsername,
    acquirerUsername: h.acquirerUsername,
    oldAdminRootPubHex: h.oldAdminRootPub,
    newAdminRootPubHex: h.newAdminRootPub,
    transferNonce: h.transferNonce,
    issuedAt: h.issuedAt,
  };
  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(b.signatureHex);
  } catch {
    return malformed("invalid hex");
  }
  if (!verifyAdminRootTransfer(transfer, sigBytes, hexToBytes(giver.adminRootPubHex))) {
    return forbidden("invalid admin-handoff signature");
  }

  const stored = await deps.serverTransfers.putAdminHandoff(host, {
    oldRootHex: h.oldAdminRootPub.toLowerCase(),
    newRootHex: h.newAdminRootPub.toLowerCase(),
    issuedAt: h.issuedAt,
    sigHex: b.signatureHex.toLowerCase(),
  });
  if (!stored) return notFound("no claimed transfer for this server");
  return ok({ ok: true });
}
