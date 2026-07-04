/**
 * The five live-enforcement control checks (docs/ui-test-gym.md).
 *
 * Each check builds the SAME signed envelopes the apps/box use (real
 * @flagship/protocol crypto), drives the control over an INJECTED transport, and
 * reports per-assertion whether the control fired. The transport injection is the
 * unit-test seam: a stubbed box that enforces yields `enforced`; a stub that
 * serves the request ungated yields `bypassed`; a transport that throws yields
 * `skipped` (never a pass).
 *
 * Controls 1–3 are driven over the real wire against the box/.com. Controls 4–5
 * additionally depend on a box PINNED WITH AN ADMIN MASTER ROOT (control 4) or the
 * broker-side re-home marker deposit (control 5) — capabilities the gym can't
 * provision on a legacy demo box today — so their AUTHORITY BOUNDARY is proven
 * DETERMINISTICALLY here against the same protocol predicates the box uses, with
 * the live wire step recorded as a `deferred.todo`.
 */

import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  requireMasterAdmin,
  type MasterAdminDecision,
  serviceInviteId,
  serviceInviteSecretHash,
  sealInviteBundle,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signSetDeadManPolicy,
  signDebugAccessGrant,
  verifyDebugAccessGrant,
  signRehomeAuthorization,
  verifyRehomeAuthorization,
  type Keypair,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
  type SetDeadManPolicy,
  type DebugAccessGrant,
  type RehomeAuthorization,
} from "@flagship/protocol";
import {
  EnforcementSkip,
  runCheck,
  type Assertion,
  type CheckOutcome,
  type HttpFn,
  type RawFn,
  type WireResponse,
} from "./types.js";

export interface EnforcementKeys {
  /** The box's config-pinned MEMBERSHIP owner IRK (== the .com-registered IRK). */
  readonly ownerIrk: Keypair;
  /** A fresh, unrelated device key — a non-owner (the negative signer). */
  readonly attacker: Keypair;
  /** A visitor account identity (redeems the invite). */
  readonly friendAid: Keypair;
  /** The invite author identity + its device + the household key. */
  readonly author: { readonly aid: Keypair; readonly device: Keypair; readonly householdKey: Uint8Array };
  /** A hypothetical transfer acquirer (control 5 deterministic proof). */
  readonly acquirerIrk: Keypair;
  /** A hypothetical pinned admin MASTER ROOT (controls 2 & 4 deterministic proof). */
  readonly adminRoot: Keypair;
}

export interface EnforcementTarget {
  readonly control: string; // e.g. gym.flagshipserver.com
  readonly servicesApex: string; // e.g. gym.flagship.services
  readonly user: string;
  readonly fqdn: string; // home.<user>.<servicesApex>
  readonly serviceSlug: string; // the restricted service label
  readonly serviceRef: string; // <user>--<slug>
}

export interface EnforcementContext {
  readonly http: HttpFn;
  readonly raw: RawFn;
  readonly now: () => number;
  readonly target: EnforcementTarget;
  readonly keys: EnforcementKeys;
}

const ZERO_SIG = "00".repeat(64);

/** The rejection reason of a master-admin decision (union-narrowing helper). */
function reasonOf(d: MasterAdminDecision): string {
  return d.ok ? "authorized" : d.reason;
}

// ── wire-shape helpers (the restricted-mode "is it gated?" discriminators) ────

/** The traefik/whoami app body — proof the container served REAL content. */
function isAppContent(text: string): boolean {
  return /Hostname:|RemoteAddr:|GET \/ HTTP/i.test(text);
}
/** The box's knock page (a restricted 200 that is NOT the app). */
function isKnockPage(text: string): boolean {
  return /Access is restricted/i.test(text);
}
/** The control fired: a 403, or the knock page (never the app content). */
function isGated(r: WireResponse): boolean {
  if (r.status === 403) return true;
  return r.status === 200 && isKnockPage(r.text) && !isAppContent(r.text);
}
/** The bypass class: the restricted app served REAL content, ungated. */
function isBypassServed(r: WireResponse): boolean {
  return r.status === 200 && isAppContent(r.text) && !isKnockPage(r.text);
}
function snippet(r: WireResponse): string {
  return `${r.status} ${r.text.slice(0, 40).replace(/\s+/g, " ")}`;
}
function gateAssertion(label: string, r: WireResponse): Assertion {
  const ok = isGated(r) && !isBypassServed(r);
  return { label, ok, detail: ok ? `gated (${snippet(r)})` : `SERVED UNGATED (${snippet(r)})` };
}

// ── control 1 — restricted-mode on the REAL request path (GAP-1) ──────────────

/**
 * A restricted service must be gated NOT just on the tier-1 wildcard Host but on
 * the SNI-selected app — so the tier-2 leader-routed share URL and a spoofed/absent
 * Host (curl --resolve class) also knock/403. This is the GAP-1 bypass proof: the
 * pre-fix box re-derived the service from `req.headers.host` and served the tier-2
 * URL / absent-Host request UNGATED (200 app content).
 *
 * Precondition (orchestrator): the service is installed AND set restricted. If the
 * probes can't reach a serving-or-gated box at all, the check SKIPS (not a pass).
 */
export async function checkRestrictedMode(ctx: EnforcementContext): Promise<CheckOutcome> {
  const { http, raw, target } = ctx;
  const { serviceSlug: slug, fqdn, user, servicesApex } = target;
  const tier1 = `https://${slug}.${fqdn}/`;
  const tier2 = `https://${slug}.${user}.${servicesApex}/`;
  const sni = `${slug}.${fqdn}`;
  return runCheck(
    {
      id: "restricted-mode-real-path",
      control: "1. Restricted-mode on the real request path (GAP-1)",
      title: "a restricted service is gated on tier-1 Host, tier-2 leader-routed URL, and spoofed/absent Host",
    },
    async () => {
      const t1html = await http(tier1, { headers: { accept: "text/html" } });
      // If tier-1 itself neither gates nor serves, the service isn't up → skip.
      if (!isGated(t1html) && !isBypassServed(t1html)) {
        throw new EnforcementSkip(`tier-1 probe inconclusive (${snippet(t1html)}) — service not serving/restricted`);
      }
      const t1json = await http(tier1, { headers: { accept: "application/json" } });
      const t2 = await http(tier2, { headers: { accept: "text/html" } });
      const rawAbsent = await raw({ sni, host: null, path: "/" });
      const rawSpoof = await raw({ sni, host: `${slug}.${user}.${servicesApex}`, path: "/" });
      return [
        gateAssertion("(a) tier-1 wildcard Host (browser) is gated", t1html),
        {
          label: "(a) tier-1 non-browser request is a hard 403",
          ok: t1json.status === 403,
          detail: `${t1json.status}`,
        },
        gateAssertion("(b) tier-2 leader-routed share URL is gated", t2),
        gateAssertion("(c) raw request with ABSENT Host (SNI-only) is gated", rawAbsent),
        gateAssertion("(c) raw request with SPOOFED tier-2 Host is gated", rawSpoof),
      ];
    },
  );
}

// ── control 2 — admin gate rejects a non-admin on the real path ───────────────

/**
 * A sensitive box order (dead-man policy — a real gated op that leaves NO lasting
 * state when `enabled:false`) is authorized ONLY by the pinned owner IRK on a
 * legacy box; a non-owner / forged signature is rejected (401/403).
 *
 * The admin-ROOT case ("a membership-IRK-signed order is rejected when a root is
 * pinned; an admin-root order is accepted") needs a box provisioned with a pinned
 * admin master root — which the gym's legacy demo boxes don't have — so that
 * authority boundary is proven deterministically here via `requireMasterAdmin`,
 * with the live pin recorded as a TODO.
 */
export async function checkAdminGate(ctx: EnforcementContext): Promise<CheckOutcome> {
  const { http, target, keys, now } = ctx;
  const url = `https://${target.fqdn}/api/deadman/policy`;
  const policy: SetDeadManPolicy = {
    serverId: target.fqdn,
    enabled: false, // NEVER arms — proves the control path, leaves no lockout
    windowMs: 24 * 60 * 60 * 1000,
    graceMs: 60 * 60 * 1000,
    lockoutMode: "off",
    issuedAt: now(),
  };
  const post = (sig: string) =>
    http(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: policy, signature: sig }),
    });
  const adminRootHex = bytesToHex(keys.adminRoot.publicKey);
  const ownerHex = bytesToHex(keys.ownerIrk.publicKey);
  return runCheck(
    {
      id: "admin-gate-nonadmin-rejected",
      control: "2. Admin gate rejects a non-admin on the real path",
      title: "the pinned owner IRK authorizes a sensitive op; a non-owner / forged signature is rejected",
      deferred: {
        reason:
          "the admin-ROOT boundary (membership-IRK order REJECTED under a pinned root; admin-root order ACCEPTED) needs a box with a pinned admin master root, which the gym's legacy demo boxes lack",
        todo:
          "once the gym can reburn a box with a pinned adminRootPub: sign the dead-man policy with a membership IRK → expect 401/403; sign with the admin master root → expect 200",
        deterministic: true,
      },
    },
    async () => {
      const owner = await post(bytesToHex(signSetDeadManPolicy(policy, keys.ownerIrk)));
      const nonOwner = await post(bytesToHex(signSetDeadManPolicy(policy, keys.attacker)));
      const forged = await post(ZERO_SIG);
      // Deterministic admin-root authority boundary (no box needed):
      const membershipUnderRoot = requireMasterAdmin(ownerHex, target.user, adminRootHex, [], now());
      const rootUnderRoot = requireMasterAdmin(adminRootHex, target.user, adminRootHex, [], now());
      return [
        { label: "owner-IRK-signed sensitive op is ACCEPTED (legacy path)", ok: owner.status === 200, detail: `${owner.status}` },
        {
          label: "a NON-owner (membership) signature is rejected",
          ok: nonOwner.status === 401 || nonOwner.status === 403,
          detail: `${nonOwner.status}`,
        },
        { label: "a forged signature is rejected", ok: forged.status === 401 || forged.status === 403, detail: `${forged.status}` },
        {
          label: "[deterministic] a membership IRK is NOT master admin under a pinned root",
          ok: membershipUnderRoot.ok === false,
          detail: reasonOf(membershipUnderRoot),
        },
        {
          label: "[deterministic] the admin master root IS authorized under a pinned root",
          ok: rootUnderRoot.ok === true,
          detail: reasonOf(rootUnderRoot),
        },
      ];
    },
  );
}

// ── control 3 — revocation reaches the box ────────────────────────────────────

/**
 * Revoking a service invite on `.com` must DENY the revoked identity on the box's
 * next real request (the box relays a redeem to `.com`, which sees the row
 * revoked). A control (un-revoked) invite still redeems, proving the deny is due
 * to the revocation and not a broken path.
 */
export async function checkRevocationReachesBox(ctx: EnforcementContext): Promise<CheckOutcome> {
  const { http, target, keys, now } = ctx;
  const { control, fqdn, user, serviceRef } = target;
  const authorAidPub = keys.author.aid.publicKey;
  const authorDevPub = keys.author.device.publicKey;

  const mint = async (secret: Uint8Array): Promise<string> => {
    const secretHash = serviceInviteSecretHash(secret);
    const inviteId = serviceInviteId(authorAidPub, authorDevPub, now() % 1_000_000);
    const bundle = sealInviteBundle({ name: "enforce-e2e" }, keys.author.householdKey, inviteId);
    const create: CreateServiceInvite = {
      inviteId,
      authorAID: authorAidPub,
      serviceRef,
      secretHash,
      encryptedBundle: bundle,
      issuedAt: now(),
    };
    const sig = bytesToHex(signCreateServiceInvite(create, keys.ownerIrk));
    const r = await http(`https://${control}/api/users/${user}/service-invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { ...create, authorAID: bytesToHex(authorAidPub) }, signature: sig }),
    });
    if (r.status !== 200) throw new EnforcementSkip(`invite mint failed (${snippet(r)})`);
    return inviteId;
  };
  const redeem = (secret: Uint8Array): Promise<WireResponse> => {
    const redeemedAt = now();
    const req: RedeemServiceInvite = {
      secretHash: serviceInviteSecretHash(secret),
      visitorAID: keys.friendAid.publicKey,
      redeemedAt,
    };
    const aidSig = bytesToHex(signRedeemServiceInvite(req, keys.friendAid));
    return http(`https://${fqdn}/api/service-invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: bytesToHex(secret),
        visitorAID: bytesToHex(keys.friendAid.publicKey),
        aidSig,
        redeemedAt,
      }),
    });
  };

  return runCheck(
    {
      id: "revocation-reaches-box",
      control: "3. Revocation reaches the box",
      title: "revoking an invite on .com denies the revoked identity on the box's next real redeem",
    },
    async () => {
      // Baseline: an un-revoked invite redeems (the box→.com redeem path works).
      const okSecret = randomBytes(32);
      await mint(okSecret);
      const baseline = await redeem(okSecret);
      // The revoked invite.
      const revSecret = randomBytes(32);
      const revInviteId = await mint(revSecret);
      const revoke: RevokeServiceInvite = { inviteId: revInviteId, issuedAt: now() };
      const revSig = bytesToHex(signRevokeServiceInvite(revoke, keys.ownerIrk));
      const revResp = await http(`https://${control}/api/users/${user}/service-invites/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: revoke, signature: revSig }),
      });
      if (revResp.status !== 200) throw new EnforcementSkip(`invite revoke failed (${snippet(revResp)})`);
      const afterRevoke = await redeem(revSecret);
      return [
        {
          label: "baseline: an un-revoked invite redeems against the box",
          ok: baseline.status === 200,
          detail: `${baseline.status}`,
        },
        {
          label: "the REVOKED invite is DENIED at the box (revocation reached it)",
          ok: afterRevoke.status !== 200,
          detail: afterRevoke.status === 200 ? "REDEEMED DESPITE REVOKE" : `denied ${afterRevoke.status}`,
        },
      ];
    },
  );
}

// ── control 4 — debug-access requires the admin authority ─────────────────────

/**
 * A verified debug grant opens a passworded `debug` sudoer + password-auth SSH — a
 * LAN/console root shell. On a box with a pinned admin master root it must require
 * the ADMIN ROOT (a membership-IRK-only grant is rejected), exactly like
 * wipe/transfer/decommission. The gym can't pin a root on a legacy demo box AND
 * can't SSH the box's LAN from CI, so the authority boundary is proven
 * deterministically here (membership-IRK grant fails `requireMasterAdmin` under a
 * pinned root; the admin root passes; a forged grant fails verification), with the
 * live LAN-SSH-on-a-pinned-box step recorded as a TODO.
 */
export async function checkDebugAccessAuthority(ctx: EnforcementContext): Promise<CheckOutcome> {
  const { target, keys, now } = ctx;
  const adminRootHex = bytesToHex(keys.adminRoot.publicKey);
  const ownerHex = bytesToHex(keys.ownerIrk.publicKey);
  return runCheck(
    {
      id: "debug-access-admin-authority",
      control: "4. Debug-access requires the admin authority",
      title: "a membership-IRK-only debug grant is refused under a pinned admin root; the admin root authorizes",
      deferred: {
        reason:
          "requires a box reburned with a pinned admin master root AND LAN SSH to the box (neither is provisionable on a legacy gym demo box from CI)",
        todo:
          "on a pinned-root box: deliver a membership-IRK-signed debug grant → assert NO `debug` user / SSH refused over LAN; deliver an admin-root-signed grant → assert `debug:flagship` LAN SSH works",
        deterministic: true,
      },
    },
    async () => {
      const grant: DebugAccessGrant = { serverDomain: target.fqdn, sshAuthorizedKey: "", issuedAt: now() };
      const ownerSig = signDebugAccessGrant(grant, keys.ownerIrk);
      const forgedSig = hexToBytes(ZERO_SIG);
      const membershipUnderRoot = requireMasterAdmin(ownerHex, target.user, adminRootHex, [], now());
      const rootUnderRoot = requireMasterAdmin(adminRootHex, target.user, adminRootHex, [], now());
      return [
        {
          label: "the grant is validly OWNER-signed (verifies under the membership IRK)",
          ok: verifyDebugAccessGrant(grant, ownerSig, keys.ownerIrk.publicKey) === true,
          detail: "owner sig verifies",
        },
        {
          label: "a membership IRK is NOT the admin authority under a pinned root (grant refused)",
          ok: membershipUnderRoot.ok === false,
          detail: reasonOf(membershipUnderRoot),
        },
        {
          label: "the admin master root IS the authority under a pinned root (grant accepted)",
          ok: rootUnderRoot.ok === true,
          detail: reasonOf(rootUnderRoot),
        },
        {
          label: "a forged debug grant signature fails verification",
          ok: verifyDebugAccessGrant(grant, forgedSig, keys.ownerIrk.publicKey) === false,
          detail: "forged rejected",
        },
      ];
    },
  );
}

// ── control 5 — transfer re-home requires the giver signature (GAP-3) ──────────

/**
 * On the legacy (no-admin-root) transfer path the box must re-home ONLY on a
 * giver-owner-IRK-signed `RehomeAuthorization` bound to {old, new, acquirer,
 * issuedAt}. An absent / forged / wrong-domain / wrong-acquirer / non-giver
 * authorization is refused — a rogue `.com` can't move a legacy box into an
 * attacker namespace. The box-side refusal (writing `awaiting-owner-auth` instead
 * of the re-home marker) is exercised in the daemon's own tests; here the AUTHORITY
 * the box checks is proven deterministically via `verifyRehomeAuthorization`, with
 * the live broker-deposit → box-refuses step recorded as a TODO.
 */
export async function checkTransferRehomeAuthority(ctx: EnforcementContext): Promise<CheckOutcome> {
  const { target, keys, now } = ctx;
  const giverPub = keys.ownerIrk.publicKey; // the box's pinned (giver) owner IRK
  return runCheck(
    {
      id: "transfer-rehome-giver-signature",
      control: "5. Transfer re-home requires the giver signature (GAP-3)",
      title: "a legacy re-home with no/forged/tampered authorization is refused against the pinned giver IRK",
      deferred: {
        reason:
          "the live wire proof needs the .com transfer broker to serve a re-home marker for the box's old canonical, then observing the box refuse to re-home — a destructive, poll-window-bound flow not run in the standing gate",
        todo:
          "deposit a transfer with an ABSENT/forged RehomeAuthorization to .com for the box's old FQDN → assert the box never registers the acquirer FQDN (stays on the giver canonical); then a valid giver-signed authorization → assert it re-homes",
        deterministic: true,
      },
    },
    async () => {
      const auth: RehomeAuthorization = {
        oldServerDomain: target.fqdn,
        newServerDomain: `home.acquirer.${target.servicesApex}`,
        acquirerIrkPub: keys.acquirerIrk.publicKey,
        issuedAt: now(),
      };
      const giverSig = signRehomeAuthorization(auth, keys.ownerIrk);
      const forgedSig = hexToBytes(ZERO_SIG);
      const nonGiverSig = signRehomeAuthorization(auth, keys.attacker);
      const tamperedDomain: RehomeAuthorization = { ...auth, newServerDomain: `home.attacker.${target.servicesApex}` };
      const tamperedAcquirer: RehomeAuthorization = { ...auth, acquirerIrkPub: keys.attacker.publicKey };
      return [
        {
          label: "a valid giver-owner-IRK-signed authorization is ACCEPTED",
          ok: verifyRehomeAuthorization(auth, giverSig, giverPub) === true,
          detail: "giver sig verifies",
        },
        {
          label: "an ABSENT/forged authorization is REFUSED",
          ok: verifyRehomeAuthorization(auth, forgedSig, giverPub) === false,
          detail: "forged refused",
        },
        {
          label: "a non-giver signer is REFUSED under the pinned giver IRK",
          ok: verifyRehomeAuthorization(auth, nonGiverSig, giverPub) === false,
          detail: "non-giver refused",
        },
        {
          label: "a tampered NEW-domain is REFUSED (the signature binds the domain)",
          ok: verifyRehomeAuthorization(tamperedDomain, giverSig, giverPub) === false,
          detail: "domain-tamper refused",
        },
        {
          label: "a tampered ACQUIRER pubkey is REFUSED (the signature binds the acquirer)",
          ok: verifyRehomeAuthorization(tamperedAcquirer, giverSig, giverPub) === false,
          detail: "acquirer-tamper refused",
        },
      ];
    },
  );
}

/** Every enforcement control, in task order. */
export async function runEnforcementChecks(ctx: EnforcementContext): Promise<CheckOutcome[]> {
  return [
    await checkRestrictedMode(ctx),
    await checkAdminGate(ctx),
    await checkRevocationReachesBox(ctx),
    await checkDebugAccessAuthority(ctx),
    await checkTransferRehomeAuthority(ctx),
  ];
}
