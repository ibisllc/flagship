import { describe, expect, it } from "vitest";
import {
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  ed,
  encryptAccountProfile,
  encryptDeviceProfile,
  signAccountProfile,
  signClaimUsername,
  signDeviceCapabilityGrant,
  signDeviceSelfProfile,
  type DeviceCapabilityGrant,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleAccountBootstrap } from "../src/accountBootstrap.js";

const now = 1_900_000_000_000;
const username = "jolly-ranger";
const deviceId = "00112233445566778899aabbccddeeff";
const umk = Uint8Array.from({ length: 32 }, (_, i) => i);
const keypair = (offset: number) => {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => offset + i);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const irk = keypair(1);
const aid = keypair(32);
const admin = keypair(64);
const device = keypair(96);
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function body() {
  const claim = { username, irkPub: irk.publicKey, issuedAt: now };
  const grant: DeviceCapabilityGrant = {
    grantId: "bootstrap-primary-grant",
    username,
    deviceId,
    devicePubKey: device.publicKey,
    scopes: ["browse", "add-device", "admin", "view-directory"],
    issuedAt: now,
    expiresAt: now + 90 * 24 * 3_600_000,
  };
  const encryptedAccount = encryptAccountProfile("Johnson Family", deriveAccountProfileKey(umk), {
    accountId: username, revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(0xa1),
  });
  const accountUnsigned = { ...encryptedAccount, issuedAt: now, signerPubHex: hex(admin.publicKey) };
  const encryptedDevice = encryptDeviceProfile("Erica", deriveDeviceDirectoryKey(umk), {
    accountId: username, deviceId, revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(0xb2),
  });
  const deviceUnsigned = { ...encryptedDevice, deviceId, issuedAt: now, signerPubHex: hex(device.publicKey) };
  return {
    claim: {
      request: { username, irkPub: hex(irk.publicKey), issuedAt: now },
      signature: hex(signClaimUsername(claim, irk)),
    },
    aidPub: hex(aid.publicKey),
    adminRootPub: hex(admin.publicKey),
    device: { deviceId, devicePubHex: hex(device.publicKey), platformClass: "web" },
    grant: { ...grant, devicePubHex: hex(device.publicKey), signatureHex: hex(signDeviceCapabilityGrant(grant, admin)), devicePubKey: undefined },
    accountProfile: { ...accountUnsigned, signatureHex: signAccountProfile(accountUnsigned, admin) },
    deviceProfile: { ...deviceUnsigned, signatureHex: signDeviceSelfProfile(deviceUnsigned, device) },
  };
}

describe("account bootstrap", () => {
  it("atomically creates the routing identity, machine identity, grant, and encrypted profiles", async () => {
    const storage = new InMemoryStorage();
    await storage.usernameOffers.record(username, "signup-device", now);
    const response = await handleAccountBootstrap({
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    }, body());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ username, deviceId, created: true });
    expect(await storage.usernames.get(username)).toBeDefined();
    expect(await storage.deviceIdentities.get(username, deviceId)).toBeDefined();
    expect(await storage.accountProfiles.get(username)).toBeDefined();
    expect(await storage.deviceSelfProfiles.get(username, deviceId)).toBeDefined();
    expect(JSON.stringify(await storage.accountProfiles.get(username))).not.toContain("Johnson Family");
  });

  it("is idempotent for the exact signed bootstrap after the offer is consumed", async () => {
    const storage = new InMemoryStorage();
    await storage.usernameOffers.record(username, "signup-device", now);
    const deps = {
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    };
    expect((await handleAccountBootstrap(deps, body())).body).toMatchObject({ created: true });
    expect((await handleAccountBootstrap(deps, body())).body).toMatchObject({ created: false });
    expect(await storage.deviceIdentities.listForAccount(username)).toHaveLength(1);
  });

  it("rejects tampering without creating publicly resolvable identity", async () => {
    const storage = new InMemoryStorage();
    await storage.usernameOffers.record(username, "signup-device", now);
    const tampered = body();
    tampered.device.deviceId = "ffeeddccbbaa99887766554433221100";
    const response = await handleAccountBootstrap({
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    }, tampered);
    expect(response.status).toBe(400);
    expect(await storage.usernames.get(username)).toBeUndefined();
  });
});
