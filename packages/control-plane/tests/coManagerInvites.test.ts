/**
 * Co-manager invites on `.com` (owner decision 2026-10-16,
 * docs/service-access-gating.md "Co-manager invites").
 *
 * A co-manager signs the create with its per-share member key, which `.com`
 * can't tie to the account (it never learns who shares with whom). The shared
 * box vouches for it: its STK signs flagship/service-invite-co-manager/v1 over
 * the create's signature. `.com` keeps the row at tier `co-manager` with the
 * member key, tells the admins as for any member invite, and lets that key
 * withdraw it. Nothing else about the share is stored.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveIRK,
  deriveShareInviteBundleKey,
  deriveShareMemberKey,
  ed,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signCreateServiceInvite,
  signRevokeServiceInvite,
  signServiceInviteCoManagerRelay,
  type CreateServiceInvite,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleCreateServiceInvite, handleRevokeServiceInvite } from "../src/serviceInvites.js";

const NOW = 1_770_000_000_000;
const USER = "alice";
const DOMAIN = "home.alice.flagship.services";
const ownerUmk = { seed: new Uint8Array(32).fill(41) };
const aid = deriveAccountId(ownerUmk);
const irk = deriveIRK(ownerUmk);
const coUmk = { seed: new Uint8Array(32).fill(77) };
const SHARE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const member = deriveShareMemberKey(coUmk, SHARE_ID);

function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const stk = key(60);
const otherStk = key(61);
const adminRoot = key(51);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function seed() {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USER,
    irkPubHex: hex(irk.publicKey),
    aidPubHex: hex(aid.publicKey),
    adminRootPubHex: hex(adminRoot.publicKey),
    claimedAt: 1,
  });
  await s.servers.put({ serverDomain: DOMAIN, username: USER, identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  await s.servers.put({ serverDomain: "box.mallory.flagship.services", username: "mallory", identityPubKeyHex: hex(otherStk.publicKey), registeredAt: 1 });
  const notified: string[] = [];
  const deps = {
    invites: s.serviceInvites,
    usernames: s.usernames,
    servers: s.servers,
    grants: s.deviceCapabilityGrants,
    identities: s.deviceIdentities,
    auditEvents: s.auditEvents,
    notifyAdmins: async (u: string) => {
      notified.push(u);
    },
    now: () => NOW,
  };
  return { s, deps, notified };
}

function coCreate(
  opts: { signer?: Keypair; relayStk?: Keypair; serverDomain?: string; creatorPubHex?: string; relayAt?: number; approvalMode?: string } = {},
) {
  const inviteId = randomServiceInviteId();
  const secretHash = serviceInviteSecretHash(crypto.getRandomValues(new Uint8Array(32)));
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: aid.publicKey,
    serviceRef: "alice--chess",
    secretHash,
    encryptedBundle: sealInviteBundle({ name: "Alex" }, deriveShareInviteBundleKey(coUmk, SHARE_ID), inviteId),
    issuedAt: NOW,
  };
  const signature = hex(signCreateServiceInvite(create, opts.signer ?? member));
  const creatorPubHex = opts.creatorPubHex ?? hex(member.publicKey);
  const serverDomain = opts.serverDomain ?? DOMAIN;
  const relayAt = opts.relayAt ?? NOW;
  const relaySig = hex(
    signServiceInviteCoManagerRelay(
      { username: USER, serverDomain, inviteId, serviceRef: create.serviceRef, creatorPubHex, createSigHex: signature, issuedAt: relayAt },
      opts.relayStk ?? stk,
    ),
  );
  return {
    inviteId,
    body: {
      request: {
        inviteId,
        authorAID: hex(aid.publicKey),
        serviceRef: create.serviceRef,
        secretHash,
        encryptedBundle: create.encryptedBundle,
        issuedAt: NOW,
        creatorPubHex,
        ...(opts.approvalMode ? { approvalMode: opts.approvalMode } : {}),
      },
      signature,
      relay: { serverDomain, issuedAt: relayAt, signature: relaySig },
    },
  };
}

describe("co-manager invite create", () => {
  it("keeps the invite at tier co-manager with the member key, and tells the admins", async () => {
    const { deps, s, notified } = await seed();
    const { inviteId, body } = coCreate();
    const r = await handleCreateServiceInvite(deps, USER, body);
    expect(r.status).toBe(200);
    expect((r.body as { tier: string }).tier).toBe("co-manager");
    const rec = await s.serviceInvites.get(inviteId);
    expect([rec?.creatorTier, rec?.creatorPubHex, rec?.creatorDeviceId]).toEqual(["co-manager", hex(member.publicKey), null]);
    expect(notified).toEqual([USER]);
    // Stored like any invite: nothing about the share or the co-manager's account.
    expect(JSON.stringify(rec)).not.toContain(SHARE_ID);
  });

  it("refuses a relay signed by another account's server", async () => {
    const { deps } = await seed();
    const { body } = coCreate({ relayStk: otherStk, serverDomain: "box.mallory.flagship.services" });
    expect((await handleCreateServiceInvite(deps, USER, body)).status).toBe(403);
  });

  it("refuses a relay whose STK isn't the named server's", async () => {
    const { deps } = await seed();
    const { body } = coCreate({ relayStk: otherStk });
    expect((await handleCreateServiceInvite(deps, USER, body)).status).toBe(403);
  });

  it("refuses a create the named member key didn't sign", async () => {
    const { deps } = await seed();
    const { body } = coCreate({ signer: deriveShareMemberKey(coUmk, "ffeeddccbbaa99887766554433221100") });
    expect((await handleCreateServiceInvite(deps, USER, body)).status).toBe(403);
  });

  it("refuses a relay that names another creator key than the one it was signed for", async () => {
    const { deps } = await seed();
    const { body } = coCreate();
    body.request.creatorPubHex = hex(key(9).publicKey);
    expect((await handleCreateServiceInvite(deps, USER, body)).status).toBe(403);
  });

  it("refuses a stale relay and a manual-approve one", async () => {
    const { deps } = await seed();
    expect((await handleCreateServiceInvite(deps, USER, coCreate({ relayAt: NOW - 10 * 60_000 }).body)).status).toBe(403);
    expect((await handleCreateServiceInvite(deps, USER, coCreate({ approvalMode: "manual" }).body)).status).toBe(400);
  });

  it("refuses a relay from a revoked server", async () => {
    const { deps, s } = await seed();
    const rec = await s.servers.get(DOMAIN);
    await s.servers.put({ ...rec!, revokedAt: NOW - 1 });
    expect((await handleCreateServiceInvite(deps, USER, coCreate().body)).status).toBe(403);
  });

  it("a member-key create without the box's relay is refused", async () => {
    const { deps } = await seed();
    const { body } = coCreate();
    const { relay: _drop, ...bare } = body;
    expect((await handleCreateServiceInvite(deps, USER, bare)).status).toBe(403);
  });
});

describe("co-manager invite withdraw", () => {
  it("the member key withdraws its own invite and the signed revoke is kept", async () => {
    const { deps, s } = await seed();
    const { inviteId, body } = coCreate();
    await handleCreateServiceInvite(deps, USER, body);
    const revoke = { inviteId, issuedAt: NOW };
    const sig = hex(signRevokeServiceInvite(revoke, member));
    const r = await handleRevokeServiceInvite(deps, USER, { request: revoke, signature: sig });
    expect(r.status).toBe(200);
    const rec = await s.serviceInvites.get(inviteId);
    expect(rec?.revokedAt).toBe(NOW);
    expect([rec?.revokeSig, rec?.revokeSignerPubHex]).toEqual([sig, hex(member.publicKey)]);
  });

  it("another co-manager key can't withdraw it", async () => {
    const { deps } = await seed();
    const { inviteId, body } = coCreate();
    await handleCreateServiceInvite(deps, USER, body);
    const revoke = { inviteId, issuedAt: NOW };
    const other = deriveShareMemberKey({ seed: new Uint8Array(32).fill(78) }, SHARE_ID);
    expect((await handleRevokeServiceInvite(deps, USER, { request: revoke, signature: hex(signRevokeServiceInvite(revoke, other)) })).status).toBe(403);
  });

  it("an admin still withdraws a co-manager's invite", async () => {
    const { deps } = await seed();
    const { inviteId, body } = coCreate();
    await handleCreateServiceInvite(deps, USER, body);
    const revoke = { inviteId, issuedAt: NOW };
    expect((await handleRevokeServiceInvite(deps, USER, { request: revoke, signature: hex(signRevokeServiceInvite(revoke, adminRoot)) })).status).toBe(200);
  });
});
