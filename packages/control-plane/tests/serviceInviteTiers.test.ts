/**
 * Who can invite (owner decision 2026-10-15, docs/service-access-gating.md "Who
 * can invite"): only admins grant higher access; any device of the account may
 * invite at Member, and admins are told.
 *
 * On an admin-pinned account `.com` accepts an invite create from the admin
 * root / an admin-granted device (tier `admin`) OR from the account's
 * membership key, AID or IRK (tier `member`); it records the tier, the key and
 * the device id, pushes the admin devices (member tier only) and logs it.
 * Revoke: an admin, or the key that created that member invite.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  ed,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signCreateServiceInvite,
  signDeviceCapabilityGrant,
  signRevokeServiceInvite,
  signServiceInviteListQuery,
  type CreateServiceInvite,
  type DeviceCapabilityGrant,
  type Keypair,
  type ServiceInviteListQuery,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleCreateServiceInvite,
  handleListServiceInvites,
  handleRevokeServiceInvite,
} from "../src/serviceInvites.js";
import {
  adminDeviceIds,
  buildNotifyAdminDevices,
  INVITE_CREATED_CATEGORY,
  type InviteNoticeForward,
} from "../src/inviteNotice.js";
import { apnsAlertFor } from "../src/pushBridge.js";

const NOW = 1_770_000_000_000;
const USER = "alice";
const umk = { seed: new Uint8Array(32).fill(41) };
const irk = deriveIRK(umk);
const aid = deriveAccountId(umk);
const household = deriveHouseholdKey(umk);

function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const adminRoot = key(51);
const adminDevice = key(52);
const stranger = key(53);
const ADMIN_DEVICE_ID = "a1".repeat(16);
const PHONE_ID = "b2".repeat(16);

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function seed(opts: { pinned?: boolean } = {}) {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USER,
    irkPubHex: hex(irk.publicKey),
    aidPubHex: hex(aid.publicKey),
    claimedAt: 1,
    ...(opts.pinned === false ? {} : { adminRootPubHex: hex(adminRoot.publicKey) }),
  });
  const grant: DeviceCapabilityGrant = {
    grantId: "g-admin",
    username: USER,
    deviceId: ADMIN_DEVICE_ID,
    devicePubKey: adminDevice.publicKey,
    scopes: ["admin", "view-directory"],
    issuedAt: NOW - 1000,
    expiresAt: NOW + 10_000_000,
  };
  await s.deviceCapabilityGrants.put({
    grantId: grant.grantId,
    username: USER,
    deviceId: grant.deviceId,
    devicePubHex: hex(adminDevice.publicKey),
    scopesJson: JSON.stringify(grant.scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(grant, adminRoot)),
    revokedAt: null,
    signerRoot: "admin-root",
  });
  for (const [deviceId, pub] of [[ADMIN_DEVICE_ID, adminDevice.publicKey], [PHONE_ID, key(54).publicKey]] as const) {
    await s.deviceIdentities.put({ accountId: USER, deviceId, devicePubHex: hex(pub), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
    await s.pushTokens.put({
      tokenId: `tok-${deviceId.slice(0, 4)}`,
      username: USER,
      deviceId,
      platform: "apns",
      providerToken: `apns-${deviceId.slice(0, 4)}`,
      pushX25519PubHex: "00".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 1,
      lastSeenAt: 1,
    });
  }
  const pushes: InviteNoticeForward[] = [];
  const notifyAdmins = buildNotifyAdminDevices({
    usernames: s.usernames,
    grants: s.deviceCapabilityGrants,
    pushTokens: s.pushTokens,
    forward: async (a) => {
      pushes.push(a);
    },
    apex: "flagshipserver.com",
    now: () => NOW,
  });
  const deps = {
    invites: s.serviceInvites,
    usernames: s.usernames,
    grants: s.deviceCapabilityGrants,
    identities: s.deviceIdentities,
    auditEvents: s.auditEvents,
    notifyAdmins,
    now: () => NOW,
  };
  return { s, deps, pushes };
}

function createBody(signer: Keypair, extra: { deviceId?: string; serviceRef?: string } = {}) {
  const inviteId = randomServiceInviteId();
  const secretHash = serviceInviteSecretHash(crypto.getRandomValues(new Uint8Array(32)));
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: aid.publicKey,
    serviceRef: extra.serviceRef ?? "alice--notes",
    secretHash,
    encryptedBundle: sealInviteBundle({ name: "Sam" }, household, inviteId),
    issuedAt: NOW,
  };
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
        ...(extra.deviceId ? { deviceId: extra.deviceId } : {}),
      },
      signature: hex(signCreateServiceInvite(create, signer)),
    },
  };
}

function revokeBody(inviteId: string, signer: Keypair) {
  const revoke = { inviteId, issuedAt: NOW };
  return { request: revoke, signature: hex(signRevokeServiceInvite(revoke, signer)) };
}

describe("invite create — two tiers on an admin-pinned account", () => {
  it("the admin root creates an ADMIN invite: no push, no activity row", async () => {
    const { deps, pushes, s } = await seed();
    const { inviteId, body } = createBody(adminRoot);
    const r = await handleCreateServiceInvite(deps, USER, body);
    expect(r.status).toBe(200);
    expect((r.body as { tier: string }).tier).toBe("admin");
    const rec = await s.serviceInvites.get(inviteId);
    expect(rec?.creatorTier).toBe("admin");
    expect(rec?.creatorPubHex).toBe(hex(adminRoot.publicKey));
    expect(pushes).toHaveLength(0);
    expect(await s.auditEvents.list(USER, 0, 50)).toHaveLength(0);
  });

  it("an admin-granted device creates an ADMIN invite", async () => {
    const { deps, s } = await seed();
    const { inviteId, body } = createBody(adminDevice, { deviceId: ADMIN_DEVICE_ID });
    const r = await handleCreateServiceInvite(deps, USER, body);
    expect(r.status).toBe(200);
    expect((await s.serviceInvites.get(inviteId))?.creatorTier).toBe("admin");
  });

  for (const [name, signer] of [["IRK", irk], ["AID", aid]] as const) {
    it(`the membership ${name} creates a MEMBER invite, records the device, and tells the admins`, async () => {
      const { deps, pushes, s } = await seed();
      const { inviteId, body } = createBody(signer, { deviceId: PHONE_ID });
      const r = await handleCreateServiceInvite(deps, USER, body);
      expect(r.status).toBe(200);
      expect((r.body as { tier: string }).tier).toBe("member");
      const rec = await s.serviceInvites.get(inviteId);
      expect(rec?.creatorTier).toBe("member");
      expect(rec?.creatorPubHex).toBe(hex(signer.publicKey));
      expect(rec?.creatorDeviceId).toBe(PHONE_ID);
      // The push reaches the admin device only, and says nothing about the invite.
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.category).toBe(INVITE_CREATED_CATEGORY);
      expect(pushes[0]!.targets.map((t) => t.providerToken)).toEqual([`apns-${ADMIN_DEVICE_ID.slice(0, 4)}`]);
      expect(pushes[0]!.displayData).toEqual({ kind: "invite-created", deepLink: "https://flagshipserver.com/app/account/activity" });
      const wire = JSON.stringify(pushes[0]) + new TextDecoder().decode(pushes[0]!.webpushPayloadBytes);
      for (const leak of ["notes", "Sam", USER, PHONE_ID, inviteId]) expect(wire).not.toContain(leak);
      const audit = await s.auditEvents.list(USER, 0, 50);
      expect(audit.map((e) => e.eventKind)).toEqual(["invite-created"]);
      expect(audit[0]!.detail).toBe("A device on your account invited someone to one of your apps.");
    });
  }

  it("the APNs alert for the category is the content-free line", () => {
    expect(apnsAlertFor(INVITE_CREATED_CATEGORY).body).toBe("A device on your account invited someone to one of your apps.");
  });

  it("refuses a stranger's key (403) and a malformed device id (400)", async () => {
    const { deps, pushes } = await seed();
    expect((await handleCreateServiceInvite(deps, USER, createBody(stranger).body)).status).toBe(403);
    const bad = createBody(irk);
    (bad.body.request as Record<string, unknown>).deviceId = "PHONE";
    expect((await handleCreateServiceInvite(deps, USER, bad.body)).status).toBe(400);
    expect(pushes).toHaveLength(0);
  });

  it("keeps the invite but drops an unknown or revoked device id", async () => {
    const { deps, s } = await seed();
    const unknown = createBody(irk, { deviceId: "cc".repeat(16) });
    expect((await handleCreateServiceInvite(deps, USER, unknown.body)).status).toBe(200);
    expect((await s.serviceInvites.get(unknown.inviteId))?.creatorDeviceId).toBeNull();
    await s.deviceIdentities.revoke(USER, PHONE_ID, NOW);
    const revoked = createBody(irk, { deviceId: PHONE_ID });
    expect((await handleCreateServiceInvite(deps, USER, revoked.body)).status).toBe(200);
    expect((await s.serviceInvites.get(revoked.inviteId))?.creatorDeviceId).toBeNull();
  });

  it("a failing push never fails the invite", async () => {
    const { deps } = await seed();
    const r = await handleCreateServiceInvite({ ...deps, notifyAdmins: async () => { throw new Error("apns down"); } }, USER, createBody(irk).body);
    expect(r.status).toBe(200);
  });

  it("an account with NO admin root: the account key is the authority (admin tier, no notice)", async () => {
    const { deps, pushes, s } = await seed({ pinned: false });
    const { inviteId, body } = createBody(irk);
    const r = await handleCreateServiceInvite(deps, USER, body);
    expect(r.status).toBe(200);
    expect((await s.serviceInvites.get(inviteId))?.creatorTier).toBe("admin");
    expect(pushes).toHaveLength(0);
  });
});

describe("invite revoke — admin, or the key that created that invite", () => {
  it("the creating membership key withdraws its own member invite", async () => {
    const { deps } = await seed();
    const { inviteId, body } = createBody(aid);
    await handleCreateServiceInvite(deps, USER, body);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, aid))).status).toBe(200);
  });

  it("a different membership key can't revoke it, an admin can", async () => {
    const { deps } = await seed();
    const { inviteId, body } = createBody(aid);
    await handleCreateServiceInvite(deps, USER, body);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, irk))).status).toBe(403);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, stranger))).status).toBe(403);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, adminRoot))).status).toBe(200);
  });

  it("a membership key can't revoke an ADMIN invite", async () => {
    const { deps } = await seed();
    const { inviteId, body } = createBody(adminRoot);
    await handleCreateServiceInvite(deps, USER, body);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, irk))).status).toBe(403);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, aid))).status).toBe(403);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, adminDevice))).status).toBe(200);
  });

  it("the creator key stops counting once it is no longer the account's", async () => {
    const { deps, s } = await seed();
    const { inviteId, body } = createBody(irk);
    await handleCreateServiceInvite(deps, USER, body);
    expect(await s.usernames.swapIrkPub(USER, hex(irk.publicKey), hex(key(60).publicKey), NOW)).toBe(true);
    expect((await handleRevokeServiceInvite(deps, USER, revokeBody(inviteId, irk))).status).toBe(403);
  });
});

describe("invite list — who invited", () => {
  it("each invite carries its creator tier and device id (never a name)", async () => {
    const { deps } = await seed();
    const member = createBody(irk, { deviceId: PHONE_ID });
    const admin = createBody(adminRoot);
    await handleCreateServiceInvite(deps, USER, member.body);
    await handleCreateServiceInvite(deps, USER, admin.body);
    const query: ServiceInviteListQuery = { username: USER, authorAID: hex(aid.publicKey), scope: "list", cursor: 0, issuedAt: NOW };
    const r = await handleListServiceInvites(deps, USER, {
      authorAID: query.authorAID,
      scope: "list",
      cursor: "0",
      issuedAt: String(NOW),
      sig: hex(signServiceInviteListQuery(query, aid)),
    });
    expect(r.status).toBe(200);
    const rows = (r.body as { invites: Array<{ inviteId: string; creatorTier: string; creatorDeviceId: string | null }> }).invites;
    const byId = Object.fromEntries(rows.map((x) => [x.inviteId, x]));
    expect(byId[member.inviteId]).toMatchObject({ creatorTier: "member", creatorDeviceId: PHONE_ID });
    expect(byId[admin.inviteId]).toMatchObject({ creatorTier: "admin", creatorDeviceId: null });
  });
});

describe("adminDeviceIds", () => {
  it("names only devices with a live admin-root-signed admin grant", async () => {
    const { s } = await seed();
    expect([...(await adminDeviceIds(s.deviceCapabilityGrants, USER, hex(adminRoot.publicKey), NOW))]).toEqual([ADMIN_DEVICE_ID]);
    expect((await adminDeviceIds(s.deviceCapabilityGrants, USER, hex(stranger.publicKey), NOW)).size).toBe(0);
    expect((await adminDeviceIds(s.deviceCapabilityGrants, USER, hex(adminRoot.publicKey), NOW + 20_000_000)).size).toBe(0);
  });
});
