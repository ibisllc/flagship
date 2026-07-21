import { describe, expect, it } from "vitest";
import {
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  ed,
  encryptAccountProfile,
  encryptDeviceProfile,
  signAccountDirectoryRequest,
  signAccountDirectoryKeyGrant,
  signAccountProfile,
  signDeviceCapabilityGrant,
  signDeviceManagedProfile,
  signDeviceSelfProfile,
  type AccountDirectoryRequest,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import {
  InMemoryAccountProfileStorage,
  InMemoryAccountDirectoryKeyGrantStorage,
  InMemoryDeviceCapabilityGrantStorage,
  InMemoryDeviceIdentityStorage,
  InMemoryDeviceManagedProfileStorage,
  InMemoryDeviceSelfProfileStorage,
  InMemoryUsernameStorage,
  InMemoryPushTokenStorage,
} from "@flagship/storage";
import {
  handleDeleteDeviceManagedProfile,
  handleGetAccountDirectory,
  handleGetAccountProfile,
  handlePutAccountProfile,
  handlePutAccountDirectoryKeyGrant,
  handlePutDeviceManagedProfile,
  handlePutDeviceSelfProfile,
  handleRevokeAccountDevice,
  type AccountDirectoryDeps,
  type DirectoryAuthorization,
} from "../src/accountDirectory.js";

const accountId = "jolly-ranger";
const deviceId = "00112233445566778899aabbccddeeff";
const otherDeviceId = "ffeeddccbbaa99887766554433221100";
const now = 1_900_000_000_000;
const umk = Uint8Array.from({ length: 32 }, (_, i) => i);
const nonce = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);

function key(seedByte: number): Keypair {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (seedByte + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function harness() {
  const irk = key(1);
  const admin = key(64);
  const device = key(96);
  const other = key(128);
  const usernames = new InMemoryUsernameStorage();
  const identities = new InMemoryDeviceIdentityStorage();
  const grants = new InMemoryDeviceCapabilityGrantStorage();
  await usernames.put({
    username: accountId,
    irkPubHex: hex(irk.publicKey),
    adminRootPubHex: hex(admin.publicKey),
    claimedAt: 1,
  });
  await identities.put({
    accountId,
    deviceId,
    devicePubHex: hex(device.publicKey),
    platformClass: "ios",
    createdAt: 10,
    lastSeenAt: 20,
    revokedAt: null,
  });
  await identities.put({
    accountId,
    deviceId: otherDeviceId,
    devicePubHex: hex(other.publicKey),
    platformClass: "web",
    createdAt: 11,
    lastSeenAt: 21,
    revokedAt: null,
  });
  const adminGrant: DeviceCapabilityGrant = {
    grantId: "admin-device",
    username: accountId,
    deviceId,
    devicePubKey: device.publicKey,
    scopes: ["admin", "view-directory"],
    issuedAt: now - 1_000,
    expiresAt: now + 100_000,
  };
  await grants.put({
    grantId: adminGrant.grantId,
    username: accountId,
    deviceId,
    devicePubHex: hex(device.publicKey),
    scopesJson: JSON.stringify(adminGrant.scopes),
    issuedAt: adminGrant.issuedAt,
    expiresAt: adminGrant.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(adminGrant, admin)),
    revokedAt: null,
    signerRoot: "admin-root",
  });
  const viewGrant: DeviceCapabilityGrant = {
    grantId: "view-device",
    username: accountId,
    deviceId: otherDeviceId,
    devicePubKey: other.publicKey,
    scopes: ["view-directory"],
    issuedAt: now - 1_000,
    expiresAt: now + 100_000,
  };
  await grants.put({
    grantId: viewGrant.grantId,
    username: accountId,
    deviceId: otherDeviceId,
    devicePubHex: hex(other.publicKey),
    scopesJson: JSON.stringify(viewGrant.scopes),
    issuedAt: viewGrant.issuedAt,
    expiresAt: viewGrant.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(viewGrant, irk)),
    revokedAt: null,
    signerRoot: "membership",
  });
  const claimed = new Set<string>();
  const deps: AccountDirectoryDeps = {
    usernames,
    identities,
    grants,
    accountProfiles: new InMemoryAccountProfileStorage(),
    selfProfiles: new InMemoryDeviceSelfProfileStorage(),
    managedProfiles: new InMemoryDeviceManagedProfileStorage(),
    keyGrants: new InMemoryAccountDirectoryKeyGrantStorage(),
    pushTokens: new InMemoryPushTokenStorage(),
    nonces: {
      async claim(value) {
        if (claimed.has(value)) return false;
        claimed.add(value);
        return true;
      },
    },
    now: () => now,
  };
  return { deps, irk, admin, device, other };
}

let requestSequence = 0;
function auth(path: string, method: string, id: string, signer: Keypair): DirectoryAuthorization {
  requestSequence += 1;
  const request: AccountDirectoryRequest = {
    accountId,
    deviceId: id,
    signerPubHex: hex(signer.publicKey),
    method,
    path,
    requestId: requestSequence.toString(16).padStart(32, "0"),
    issuedAt: now,
  };
  return { request, signature: signAccountDirectoryRequest(request, signer) };
}

describe("private account directory", () => {
  it("returns one generic denial and no account data to anonymous callers", async () => {
    const { deps } = await harness();
    const known = await handleGetAccountDirectory(deps, accountId, undefined);
    const unknown = await handleGetAccountDirectory(deps, "unknown-account", undefined);
    expect(known).toEqual({ status: 403, body: { error: "not authorized" } });
    expect(unknown).toEqual(known);
  });

  it("requires a fresh, single-use active-device signature and view-directory scope", async () => {
    const { deps, other } = await harness();
    const path = `/api/accounts/${accountId}/directory`;
    const signed = auth(path, "GET", otherDeviceId, other);
    const response = await handleGetAccountDirectory(deps, accountId, signed);
    expect(response.status).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("private, no-store");
    const body = response.body as { devices: Array<{ deviceId: string; supportCode: string }>; grants: unknown[] };
    expect(body.devices).toHaveLength(2);
    expect(body.devices[0]?.supportCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(JSON.stringify(body)).not.toContain("Erica");
    expect((await handleGetAccountDirectory(deps, accountId, signed)).status).toBe(403);
    await deps.identities.revoke(accountId, otherDeviceId, now);
    expect((await handleGetAccountDirectory(deps, accountId, auth(path, "GET", otherDeviceId, other))).status).toBe(403);
  });

  it("allows only administrators to publish the encrypted account profile with CAS", async () => {
    const { deps, admin, device, other } = await harness();
    const encrypted = encryptAccountProfile("Johnson Family", deriveAccountProfileKey(umk), {
      accountId, revision: 1, keyVersion: 1, nonce,
    });
    const unsigned = { ...encrypted, issuedAt: now, signerPubHex: hex(admin.publicKey) };
    const profile = { ...unsigned, signatureHex: signAccountProfile(unsigned, admin) };
    const path = `/api/accounts/${accountId}/profile`;
    expect((await handlePutAccountProfile(
      deps, accountId, auth(path, "PUT", otherDeviceId, other), { profile, expectedRevision: 0 },
    )).status).toBe(403);
    expect((await handlePutAccountProfile(
      deps, accountId, auth(path, "PUT", deviceId, device), { profile, expectedRevision: 0 },
    )).status).toBe(200);
    expect((await handlePutAccountProfile(
      deps, accountId, auth(path, "PUT", deviceId, device), { profile, expectedRevision: 0 },
    )).status).toBe(409);
    expect((await handleGetAccountProfile(
      deps, accountId, auth(path, "GET", otherDeviceId, other),
    )).status).toBe(200);
  });

  it("keeps self suggestions separate from administrator-managed locked records", async () => {
    const { deps, admin, device, other } = await harness();
    const selfEncrypted = encryptDeviceProfile("Erica", deriveDeviceDirectoryKey(umk), {
      accountId, deviceId, revision: 1, keyVersion: 1, nonce,
    });
    const selfUnsigned = {
      ...selfEncrypted, deviceId, issuedAt: now, signerPubHex: hex(device.publicKey),
    };
    const selfProfile = { ...selfUnsigned, signatureHex: signDeviceSelfProfile(selfUnsigned, device) };
    const selfPath = `/api/accounts/${accountId}/devices/${deviceId}/profile`;
    expect((await handlePutDeviceSelfProfile(
      deps, accountId, deviceId, auth(selfPath, "PUT", otherDeviceId, other), { profile: selfProfile, expectedRevision: 0 },
    )).status).toBe(403);
    expect((await handlePutDeviceSelfProfile(
      deps, accountId, deviceId, auth(selfPath, "PUT", deviceId, device), { profile: selfProfile, expectedRevision: 0 },
    )).status).toBe(200);

    const managedEncrypted = encryptDeviceProfile("Marketing (Erica)", deriveDeviceDirectoryKey(umk), {
      accountId, deviceId, revision: 1, keyVersion: 1, managed: true, nonce,
    });
    const managedUnsigned = {
      ...managedEncrypted, deviceId, locked: true, issuedAt: now, signerPubHex: hex(admin.publicKey),
    };
    const managedProfile = {
      ...managedUnsigned,
      signatureHex: signDeviceManagedProfile(managedUnsigned, admin),
    };
    const managedPath = `/api/accounts/${accountId}/devices/${deviceId}/managed-profile`;
    expect((await handlePutDeviceManagedProfile(
      deps, accountId, deviceId, auth(managedPath, "PUT", deviceId, device), { profile: managedProfile, expectedRevision: 0 },
    )).status).toBe(200);

    const selfRevisionTwoUnsigned = { ...selfUnsigned, revision: 2 };
    const selfRevisionTwo = {
      ...selfRevisionTwoUnsigned,
      signatureHex: signDeviceSelfProfile(selfRevisionTwoUnsigned, device),
    };
    expect((await handlePutDeviceSelfProfile(
      deps, accountId, deviceId, auth(selfPath, "PUT", deviceId, device), { profile: selfRevisionTwo, expectedRevision: 1 },
    )).status).toBe(200);
    expect((await deps.managedProfiles.get(accountId, deviceId))?.locked).toBe(true);
    expect((await handleDeleteDeviceManagedProfile(
      deps, accountId, deviceId, auth(managedPath, "DELETE", otherDeviceId, other), { expectedRevision: 1 },
    )).status).toBe(403);
    expect((await handleDeleteDeviceManagedProfile(
      deps, accountId, deviceId, auth(managedPath, "DELETE", deviceId, device), { expectedRevision: 1 },
    )).status).toBe(200);
  });

  it("accepts only admin-root-signed targeted profile key grants", async () => {
    const { deps, admin, device, other } = await harness();
    const grant = {
      accountId,
      recipientDeviceId: otherDeviceId,
      keyKind: "account-profile" as const,
      sealedKeyHex: "001122",
      issuedAt: now,
      expiresAt: now + 60_000,
      signerPubHex: hex(admin.publicKey),
    };
    const signature = signAccountDirectoryKeyGrant(grant, admin);
    const path = `/api/accounts/${accountId}/devices/${otherDeviceId}/directory-key-grant`;
    expect((await handlePutAccountDirectoryKeyGrant(
      deps, accountId, otherDeviceId, auth(path, "PUT", otherDeviceId, other), { grant, signature },
    )).status).toBe(403);
    expect((await handlePutAccountDirectoryKeyGrant(
      deps, accountId, otherDeviceId, auth(path, "PUT", deviceId, device), { grant, signature },
    )).status).toBe(200);
    const profilePath = `/api/accounts/${accountId}/profile`;
    const response = await handleGetAccountProfile(
      deps, accountId, auth(profilePath, "GET", otherDeviceId, other),
    );
    const body = response.body as { keyGrants: Array<{ sealedKeyHex: string }> };
    expect(body.keyGrants).toHaveLength(1);
    expect(body.keyGrants[0]?.sealedKeyHex).toBe("001122");
  });

  it("revokes an opaque device identity, its grant, and its push transport", async () => {
    const { deps, device, other } = await harness();
    await deps.pushTokens.put({
      tokenId: "11".repeat(16), username: accountId, deviceId: otherDeviceId,
      platform: "webpush", providerToken: "opaque-provider-token",
      pushX25519PubHex: "22".repeat(32), registrationSignatureHex: "33".repeat(64),
      registeredAt: now, lastSeenAt: now,
    });
    const path = `/api/accounts/${accountId}/devices/${otherDeviceId}`;
    const response = await handleRevokeAccountDevice(
      deps, accountId, otherDeviceId, auth(path, "DELETE", deviceId, device),
    );
    expect(response.status).toBe(200);
    expect((await deps.identities.get(accountId, otherDeviceId))?.revokedAt).toBe(now);
    expect(await deps.grants.getActiveForUserDevice(accountId, otherDeviceId)).toBeUndefined();
    expect(await deps.pushTokens.listByUser(accountId)).toHaveLength(0);
  });
});
