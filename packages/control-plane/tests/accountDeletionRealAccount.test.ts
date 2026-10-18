import { describe, expect, it } from "vitest";
import {
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  ed,
  encryptAccountProfile,
  encryptDeviceProfile,
  signAccountDirectoryRequest,
  signAccountProfile,
  signAccountSelfDelete,
  signClaimUsername,
  signDeviceCapabilityGrant,
  signDeviceSelfProfile,
  signServersSelfDelete,
  type AccountDirectoryRequest,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleAccountBootstrap } from "../src/accountBootstrap.js";
import {
  OTHER_DEVICES_REMAIN,
  OTHER_DEVICES_REMAIN_CODE,
  handleAccountDeletionBundle,
  type AccountDeletionDeps,
} from "../src/accountDeletion.js";
import { handleGetAccountDirectory, handleRevokeAccountDevice } from "../src/accountDirectory.js";
import { handleMintDeviceGrant } from "../src/deviceCapabilityGrants.js";

// An account opened the way every current app opens one (accountBootstrap):
// the founding device has a device row and an admin grant, and the order is
// signed with the pinned admin root, exactly what Android, iOS and the webapp
// send. The old test seeded a bare username row, which no app can produce.

const NOW = 1_900_000_000_000;
const username = "jolly-ranger";
const deviceId = "00112233445566778899aabbccddeeff";
const secondDeviceId = "ffeeddccbbaa99887766554433221100";
const umk = Uint8Array.from({ length: 32 }, (_, i) => i);
const keypair = (offset: number): Keypair => {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (offset + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const irk = keypair(1);
const aid = keypair(32);
const admin = keypair(64);
const device = keypair(96);
const second = keypair(130);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function openAccount(storage: InMemoryStorage): Promise<void> {
  await storage.usernameOffers.record(username, "signup-device", NOW);
  const grant: DeviceCapabilityGrant = {
    grantId: "primary-grant",
    username,
    deviceId,
    devicePubKey: device.publicKey,
    scopes: ["browse", "install-service", "vibe-code", "add-device", "manage-services", "revoke-others", "admin", "view-directory"],
    issuedAt: NOW,
    expiresAt: NOW + 90 * 24 * 3_600_000,
  };
  const encAccount = encryptAccountProfile("Family", deriveAccountProfileKey(umk), {
    accountId: username, revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(0xa1),
  });
  const accountUnsigned = { ...encAccount, issuedAt: NOW, signerPubHex: hex(admin.publicKey) };
  const encDevice = encryptDeviceProfile("Pixel", deriveDeviceDirectoryKey(umk), {
    accountId: username, deviceId, revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(0xb2),
  });
  const deviceUnsigned = { ...encDevice, deviceId, issuedAt: NOW, signerPubHex: hex(device.publicKey) };
  const res = await handleAccountBootstrap(
    { provisioning: storage.accountProvisioning, usernames: storage.usernames, offers: storage.usernameOffers, now: () => NOW },
    {
      claim: {
        request: { username, irkPub: hex(irk.publicKey), issuedAt: NOW },
        signature: hex(signClaimUsername({ username, irkPub: irk.publicKey, issuedAt: NOW }, irk)),
      },
      aidPub: hex(aid.publicKey),
      adminRootPub: hex(admin.publicKey),
      device: { deviceId, devicePubHex: hex(device.publicKey), platformClass: "android" },
      grant: { ...grant, devicePubHex: hex(device.publicKey), signatureHex: hex(signDeviceCapabilityGrant(grant, admin)), devicePubKey: undefined },
      accountProfile: { ...accountUnsigned, signatureHex: signAccountProfile(accountUnsigned, admin) },
      deviceProfile: { ...deviceUnsigned, signatureHex: signDeviceSelfProfile(deviceUnsigned, device) },
    },
  );
  expect(res.status).toBe(200);
}

async function addSecondDevice(storage: InMemoryStorage, scopes: DeviceCapabilityGrant["scopes"] = ["browse", "view-directory"]) {
  const grant: DeviceCapabilityGrant = {
    grantId: "second-grant",
    username,
    deviceId: secondDeviceId,
    devicePubKey: second.publicKey,
    scopes,
    issuedAt: NOW,
    expiresAt: NOW + 1_000_000,
  };
  const res = await handleMintDeviceGrant(
    { storage: storage.deviceCapabilityGrants, identities: storage.deviceIdentities, usernames: storage.usernames, now: () => NOW },
    {
      grant: { ...grant, devicePubKey: hex(second.publicKey), scopes },
      signature: hex(signDeviceCapabilityGrant(grant, irk)),
    },
  );
  expect(res.status).toBe(200);
}

function deps(storage: InMemoryStorage): AccountDeletionDeps {
  return {
    usernames: storage.usernames,
    servers: storage.servers,
    routing: storage.routing,
    authCodes: storage.authCodes,
    deviceCapabilityGrants: storage.deviceCapabilityGrants,
    deviceIdentities: storage.deviceIdentities,
    auditEvents: storage.auditEvents,
    secretMailbox: storage.secretMailbox,
    now: () => NOW,
  };
}

function deleteBody(withServers = false) {
  const request = { username, issuedAt: NOW };
  return {
    accountSelfDelete: { request, signature: hex(signAccountSelfDelete(request, admin)) },
    ...(withServers ? { serversSelfDelete: { request, signature: hex(signServersSelfDelete(request, admin)) } } : {}),
  };
}

let seq = 0;
async function listTrustedDevices(storage: InMemoryStorage, caller: Keypair, callerId: string) {
  const nonces = new Set<string>();
  const directoryDeps = {
    usernames: storage.usernames,
    identities: storage.deviceIdentities,
    grants: storage.deviceCapabilityGrants,
    accountProfiles: storage.accountProfiles,
    selfProfiles: storage.deviceSelfProfiles,
    managedProfiles: storage.deviceManagedProfiles,
    keyGrants: storage.accountDirectoryKeyGrants,
    pushTokens: storage.pushTokens,
    nonces: { async claim(v: string) { if (nonces.has(v)) return false; nonces.add(v); return true; } },
    now: () => NOW,
  };
  seq += 1;
  const request: AccountDirectoryRequest = {
    accountId: username, deviceId: callerId, signerPubHex: hex(caller.publicKey), method: "GET",
    path: `/api/accounts/${username}/directory`, requestId: seq.toString(16).padStart(32, "0"), issuedAt: NOW,
  };
  const res = await handleGetAccountDirectory(directoryDeps as never, username, {
    request, signature: signAccountDirectoryRequest(request, caller),
  });
  return { res, directoryDeps };
}

describe("account self-delete on an account opened by a current app", () => {
  it("lists the founding device in Trusted devices", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    const { res } = await listTrustedDevices(storage, device, deviceId);
    expect(res.status).toBe(200);
    const body = res.body as { devices: Array<{ deviceId: string; revokedAt: number | null }> };
    expect(body.devices.filter((d) => d.revokedAt === null).map((d) => d.deviceId)).toEqual([deviceId]);
  });

  it("deletes a fresh single-device account (the founding device is not 'another device')", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    const res = await handleAccountDeletionBundle(deps(storage), deleteBody());
    expect(res.status).toBe(200);
    expect(await storage.usernames.get(username)).toBeUndefined();
  });

  it("deletes with the servers-wipe order bundled", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    const res = await handleAccountDeletionBundle(deps(storage), deleteBody(true));
    expect(res.status).toBe(200);
  });

  it("retires the account's devices, so a re-claimed name starts with none", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    await handleAccountDeletionBundle(deps(storage), deleteBody());
    const rows = await storage.deviceIdentities.listForAccount(username);
    expect(rows.filter((d) => d.revokedAt === null)).toEqual([]);
  });

  it("still refuses while a second live device is on the account, with a plain sentence", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    await addSecondDevice(storage);
    const res = await handleAccountDeletionBundle(deps(storage), deleteBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: OTHER_DEVICES_REMAIN, code: OTHER_DEVICES_REMAIN_CODE, otherDevices: 1 });
    expect(OTHER_DEVICES_REMAIN).toContain("Trusted devices");
    expect(await storage.usernames.get(username)).toBeDefined();
  });

  it("the device that blocks the delete is the one Trusted devices lists", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    await addSecondDevice(storage);
    const { res } = await listTrustedDevices(storage, device, deviceId);
    const live = (res.body as { devices: Array<{ deviceId: string; revokedAt: number | null }> }).devices
      .filter((d) => d.revokedAt === null).map((d) => d.deviceId).sort();
    expect(live).toEqual([deviceId, secondDeviceId].sort());
  });

  it("deletes once the second device is removed in Trusted devices", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    await addSecondDevice(storage);
    const { directoryDeps } = await listTrustedDevices(storage, device, deviceId);
    seq += 1;
    const path = `/api/accounts/${username}/devices/${secondDeviceId}`;
    const request: AccountDirectoryRequest = {
      accountId: username, deviceId, signerPubHex: hex(device.publicKey), method: "DELETE",
      path, requestId: seq.toString(16).padStart(32, "0"), issuedAt: NOW,
    };
    const removed = await handleRevokeAccountDevice(directoryDeps as never, username, secondDeviceId, {
      request, signature: signAccountDirectoryRequest(request, device),
    });
    expect(removed.status).toBe(200);
    const res = await handleAccountDeletionBundle(deps(storage), deleteBody());
    expect(res.status).toBe(200);
  });

  it("refuses for a device row that has no grant (it still shows in Trusted devices)", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    await storage.deviceIdentities.put({
      accountId: username, deviceId: secondDeviceId, devicePubHex: hex(second.publicKey),
      platformClass: "ios", createdAt: NOW, lastSeenAt: NOW, revokedAt: null,
    });
    const res = await handleAccountDeletionBundle(deps(storage), deleteBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: OTHER_DEVICES_REMAIN_CODE });
  });

  it("an admin-root order from the IRK alone is still refused (the guard is not weakened)", async () => {
    const storage = new InMemoryStorage();
    await openAccount(storage);
    const request = { username, issuedAt: NOW };
    const res = await handleAccountDeletionBundle(deps(storage), {
      accountSelfDelete: { request, signature: hex(signAccountSelfDelete(request, irk)) },
    });
    expect(res.status).toBe(403);
    expect(await storage.usernames.get(username)).toBeDefined();
  });
});
