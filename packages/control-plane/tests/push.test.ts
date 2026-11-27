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
import { handlePushRegister, handleVouchedDeviceAdmit, platformClassForPush, QUARANTINE_MS } from "../src/push.js";

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

  it("two registrations of the same token racing leave one row and answer the same token id", async () => {
    const { storage, device } = await harness();
    const deps = { pushTokens: storage.pushTokens, deviceIdentities: storage.deviceIdentities, usernames: storage.usernames, now: () => 100 };
    const [a, b] = await Promise.all([handlePushRegister(deps, signedBody(device, 100)), handlePushRegister(deps, signedBody(device, 100))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await storage.pushTokens.listByUser("alice");
    expect(rows).toHaveLength(1);
    expect((a.body as { tokenId: string }).tokenId).toBe(rows[0]!.tokenId);
    expect((b.body as { tokenId: string }).tokenId).toBe(rows[0]!.tokenId);
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

  it("accepts the account IRK's signature for a live device (the iOS and Android store builds sign with it)", async () => {
    const { storage, irk } = await harness();
    const deps = { pushTokens: storage.pushTokens, deviceIdentities: storage.deviceIdentities, usernames: storage.usernames, now: () => 100 };
    expect((await handlePushRegister(deps, signedBody(irk, 100))).status).toBe(200);
    expect((await storage.pushTokens.listByUser("alice"))[0]?.deviceId).toBe(deviceId);
    await storage.deviceIdentities.revoke("alice", deviceId, 150);
    expect((await handlePushRegister(deps, signedBody(irk, 200))).status).toBe(403);
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
    // The device's platform, not its push service: an "apns" join is an iPhone or iPad in the lists.
    expect((await storage.deviceIdentities.get("alice", joinedDeviceId))?.platformClass).toBe("ios");
  });

  it("maps each push service to the device platform the Trusted devices lists know", () => {
    expect(platformClassForPush("apns")).toBe("ios");
    expect(platformClassForPush("fcm")).toBe("android");
    expect(platformClassForPush("unifiedpush")).toBe("android");
    expect(platformClassForPush("webpush")).toBe("web");
    expect(platformClassForPush(undefined)).toBeNull();
    expect(platformClassForPush("carrier-pigeon")).toBeNull();
  });
});

describe("handlePushRelay app-access", () => {
  it("relays a box-signed app-access alert and still refuses unknown categories", async () => {
    const { signPushRelayRequest } = await import("@flagship/protocol");
    const { handlePushRelay } = await import("../src/push.js");
    const stk = keypair(9);
    const now = 1_800_000_000_000;
    const deps = {
      pushTokens: { listByUser: async () => [] },
      servers: { listForUser: async () => [{ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 }] },
      now: () => now,
    } as never;
    const request = { targetUsername: "alice", category: "app-access" as const, sealedPayloadHex: "00".repeat(32), issuedAt: now };
    const ok = await handlePushRelay(deps, { request, signature: hex(signPushRelayRequest(request, stk)) });
    expect(ok.status).toBe(200);
    const bad = await handlePushRelay(deps, { request: { ...request, category: "app-access-x" }, signature: "00".repeat(64) });
    expect(bad.status).toBe(400);
  });
});

describe("device admit on an account that pins an admin root", () => {
  const MEMBER = ["browse", "install-service", "vibe-code", "view-directory"] as const;

  async function pinned(extra: { isDemo?: boolean } = {}) {
    const storage = new InMemoryStorage();
    const irk = keypair(2);
    const adminRoot = keypair(9);
    await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), adminRootPubHex: hex(adminRoot.publicKey), claimedAt: 1 });
    if (extra.isDemo) await storage.usernames.setDemo("alice", true);
    return { storage, irk, adminRoot };
  }

  function admitBody(irk: Keypair, signer: Keypair, signerRoot: string, scopes: readonly string[], fill = 8) {
    const joinedDeviceId = fill.toString(16).padStart(2, "0").repeat(16);
    const joined = keypair(fill);
    const issuedAt = 100;
    const admit = { username: "alice", deviceId: joinedDeviceId, newDevicePubHex: hex(joined.publicKey), issuedAt };
    const grant = {
      grantId: `grant-${fill}`,
      username: "alice",
      deviceId: joinedDeviceId,
      devicePubKey: joined.publicKey,
      scopes: [...scopes] as never[],
      issuedAt,
      expiresAt: issuedAt + 86_400_000,
    };
    const encrypted = encryptDeviceProfile("Phone", deriveDeviceDirectoryKey(new Uint8Array(32).fill(4)), {
      accountId: "alice", deviceId: joinedDeviceId, revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(5),
    });
    const unsignedProfile = { ...encrypted, deviceId: joinedDeviceId, issuedAt, signerPubHex: hex(joined.publicKey) };
    const pushClaim = {
      username: "alice", deviceId: joinedDeviceId, platform: "apns" as const, providerToken: `token-${fill}`, pushX25519Pub: pushPublicKey, issuedAt,
    };
    return {
      admit,
      admitSig: hex(signDeviceAdmit(admit, irk)),
      grant: {
        grantId: grant.grantId, username: "alice", deviceId: joinedDeviceId, devicePubHex: hex(joined.publicKey),
        scopes: [...scopes], issuedAt, expiresAt: grant.expiresAt, signerRoot,
      },
      grantSignature: hex(signDeviceCapabilityGrant(grant, signer)),
      profile: { ...unsignedProfile, signatureHex: signDeviceSelfProfile(unsignedProfile, joined) },
      request: { ...pushClaim, pushX25519Pub: hex(pushPublicKey) },
      signature: hex(signPushTokenRegister(pushClaim, joined)),
    };
  }

  function admitDeps(storage: InMemoryStorage) {
    return {
      pushTokens: storage.pushTokens,
      deviceIdentities: storage.deviceIdentities,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
      deviceSelfProfiles: storage.deviceSelfProfiles,
      usernames: storage.usernames,
      now: () => 100,
    };
  }

  it("takes the member grant every app's Add a device signs with the account key", async () => {
    const { storage, irk } = await pinned();
    const r = await handleVouchedDeviceAdmit(admitDeps(storage), "alice", admitBody(irk, irk, "membership", MEMBER));
    expect(r.status).toBe(200);
  });

  it("takes a promoted device's grant signed by the admin root", async () => {
    const { storage, irk, adminRoot } = await pinned();
    const all = ["browse", "install-service", "vibe-code", "add-device", "manage-services", "revoke-others", "admin", "view-directory"];
    const r = await handleVouchedDeviceAdmit(admitDeps(storage), "alice", admitBody(irk, adminRoot, "admin-root", all));
    expect(r.status).toBe(200);
  });

  for (const extra of ["revoke-others", "add-device", "manage-services", "admin"]) {
    it(`refuses an account-key grant that also carries ${extra}, and stores nothing`, async () => {
      const { storage, irk } = await pinned();
      const r = await handleVouchedDeviceAdmit(admitDeps(storage), "alice", admitBody(irk, irk, "membership", [...MEMBER, extra]));
      expect(r.status).toBe(403);
      expect((r.body as { code?: string }).code).toBe("admin-key-required");
      expect(await storage.deviceIdentities.listForAccount("alice")).toHaveLength(0);
      expect(await storage.deviceCapabilityGrants.listForUser("alice")).toHaveLength(0);
    });
  }

  it("refuses a grant naming an unknown signer", async () => {
    const { storage, irk } = await pinned();
    const r = await handleVouchedDeviceAdmit(admitDeps(storage), "alice", admitBody(irk, irk, "irk", MEMBER));
    expect(r.status).toBe(403);
  });

  it("a demo account keeps the old rule", async () => {
    const { storage, irk } = await pinned({ isDemo: true });
    const r = await handleVouchedDeviceAdmit(admitDeps(storage), "alice", admitBody(irk, irk, "membership", [...MEMBER, "revoke-others"]));
    expect(r.status).toBe(200);
  });
});
