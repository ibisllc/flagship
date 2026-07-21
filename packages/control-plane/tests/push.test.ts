import { describe, expect, it } from "vitest";
import {
  deriveDeviceDirectoryKey,
  ed,
  encryptDeviceProfile,
  signDeviceAdmit,
  signDeviceCapabilityGrant,
  signDeviceSelfProfile,
  signPushTokenRegister,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handlePushRegister, handleVouchedDeviceAdmit, QUARANTINE_MS } from "../src/push.js";

const deviceId = "01".repeat(16);
const pushPublicKey = new Uint8Array(32).fill(7);

function keypair(fill: number): Keypair {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function harness() {
  const storage = new InMemoryStorage();
  const device = keypair(3);
  const irk = keypair(2);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.deviceIdentities.put({
    accountId: "alice",
    deviceId,
    devicePubHex: hex(device.publicKey),
    platformClass: "ios",
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
  });
  return { storage, device, irk };
}

function signedBody(device: Keypair, issuedAt: number) {
  const claim = {
    username: "alice",
    deviceId,
    platform: "apns" as const,
    providerToken: "provider-token",
    pushX25519Pub: pushPublicKey,
    issuedAt,
  };
  return {
    request: { ...claim, pushX25519Pub: hex(pushPublicKey) },
    signature: hex(signPushTokenRegister(claim, device)),
  };
}

describe("account-scoped push registration", () => {
  it("binds the provider token to an active opaque device identity", async () => {
    const { storage, device } = await harness();
    const response = await handlePushRegister({
      pushTokens: storage.pushTokens,
      deviceIdentities: storage.deviceIdentities,
      usernames: storage.usernames,
      now: () => 100,
    }, signedBody(device, 100));
    expect(response.status).toBe(200);
    const [record] = await storage.pushTokens.listByUser("alice");
    expect(record?.deviceId).toBe(deviceId);
    expect(record).not.toHaveProperty("label");
  });

  it("rejects a registration signed by any key other than the bound device", async () => {
    const { storage } = await harness();
    const response = await handlePushRegister({
      pushTokens: storage.pushTokens,
      deviceIdentities: storage.deviceIdentities,
      usernames: storage.usernames,
      now: () => 100,
    }, signedBody(keypair(9), 100));
    expect(response.status).toBe(403);
  });

  it("rejects a missing or revoked device identity", async () => {
    const { storage, device } = await harness();
    await storage.deviceIdentities.revoke("alice", deviceId, 50);
    const response = await handlePushRegister({
      pushTokens: storage.pushTokens,
      deviceIdentities: storage.deviceIdentities,
      usernames: storage.usernames,
      now: () => 100,
    }, signedBody(device, 100));
    expect(response.status).toBe(403);
  });

  it("applies quarantine without placing a presentation name in storage", async () => {
    const { storage, device } = await harness();
    const response = await handlePushRegister({
      pushTokens: storage.pushTokens,
      deviceIdentities: storage.deviceIdentities,
      usernames: storage.usernames,
      now: () => 100,
    }, signedBody(device, 100), { quarantine: true });
    expect(response.body).toMatchObject({ quarantineUntil: 100 + QUARANTINE_MS });
    expect(JSON.stringify(await storage.pushTokens.listByUser("alice"))).not.toContain("iPhone");
  });

  it("atomically admits an opaque device bootstrap and resumes an identical retry", async () => {
    const { storage, irk } = await harness();
    const joinedDeviceId = "02".repeat(16);
    const joined = keypair(8);
    const issuedAt = 100;
    const admit = {
      username: "alice",
      deviceId: joinedDeviceId,
      newDevicePubHex: hex(joined.publicKey),
      issuedAt,
    };
    const grant = {
      grantId: "grant-joined",
      username: "alice",
      deviceId: joinedDeviceId,
      devicePubKey: joined.publicKey,
      scopes: ["view-directory"] as const,
      issuedAt,
      expiresAt: issuedAt + 86_400_000,
    };
    const encrypted = encryptDeviceProfile("Reviewer’s iPhone", deriveDeviceDirectoryKey(new Uint8Array(32).fill(4)), {
      accountId: "alice",
      deviceId: joinedDeviceId,
      revision: 1,
      keyVersion: 1,
      nonce: new Uint8Array(12).fill(5),
    });
    const unsignedProfile = {
      ...encrypted,
      deviceId: joinedDeviceId,
      issuedAt,
      signerPubHex: hex(joined.publicKey),
    };
    const pushClaim = {
      username: "alice",
      deviceId: joinedDeviceId,
      platform: "apns" as const,
      providerToken: "joined-provider-token",
      pushX25519Pub: pushPublicKey,
      issuedAt,
    };
    const body = {
      admit,
      admitSig: hex(signDeviceAdmit(admit, irk)),
      grant: {
        grantId: grant.grantId,
        username: grant.username,
        deviceId: grant.deviceId,
        devicePubHex: hex(joined.publicKey),
        scopes: [...grant.scopes],
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        signerRoot: "membership" as const,
      },
      grantSignature: hex(signDeviceCapabilityGrant({ ...grant, scopes: [...grant.scopes] }, irk)),
      profile: { ...unsignedProfile, signatureHex: signDeviceSelfProfile(unsignedProfile, joined) },
      request: { ...pushClaim, pushX25519Pub: hex(pushPublicKey) },
      signature: hex(signPushTokenRegister(pushClaim, joined)),
    };
    const deps = {
      pushTokens: storage.pushTokens,
      deviceIdentities: storage.deviceIdentities,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
      deviceSelfProfiles: storage.deviceSelfProfiles,
      usernames: storage.usernames,
      now: () => issuedAt,
    };

    const first = await handleVouchedDeviceAdmit(deps, "alice", body);
    const retry = await handleVouchedDeviceAdmit(deps, "alice", body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect((await storage.deviceIdentities.listForAccount("alice")).filter((row) => row.deviceId === joinedDeviceId)).toHaveLength(1);
    expect(await storage.deviceSelfProfiles.get("alice", joinedDeviceId)).toMatchObject({ revision: 1 });
    expect((await storage.pushTokens.listByUser("alice")).filter((row) => row.deviceId === joinedDeviceId)).toHaveLength(1);
  });
});
