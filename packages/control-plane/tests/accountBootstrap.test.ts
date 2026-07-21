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

/**
 * The harness-side stand-in for "dump D1 and grep it".
 *
 * Per-record assertions only prove the record you thought to look at is
 * clean. A presentation name leaking into an audit row, an install event, a
 * provisioning record, or any table nobody remembered would sail past them.
 * This walks EVERY store the aggregate exposes and asserts the chosen names
 * appear nowhere at all.
 */
describe("account bootstrap — no plaintext name anywhere in storage", () => {
  async function dumpAll(storage: InMemoryStorage): Promise<string> {
    const parts: string[] = [];
    for (const [name, store] of Object.entries(storage as unknown as Record<string, unknown>)) {
      if (!store || typeof store !== "object") continue;
      // Reach past the store wrapper into whatever it is actually holding, so
      // a leak hides in no private Map.
      for (const value of Object.values(store as Record<string, unknown>)) {
        if (value instanceof Map) {
          parts.push(name, JSON.stringify([...value.entries()]));
        } else if (Array.isArray(value)) {
          parts.push(name, JSON.stringify(value));
        }
      }
    }
    return parts.join("\n");
  }

  it("keeps the account name and the device name out of every table", async () => {
    const storage = new InMemoryStorage();
    await storage.usernameOffers.record(username, "signup-device", now);
    const response = await handleAccountBootstrap({
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    }, body());
    expect(response.status).toBe(200);

    const dump = await dumpAll(storage);
    // Sanity: the sweep is actually reading rows, so an empty dump can't pass.
    expect(dump).toContain(deviceId);
    expect(dump).toContain(username);
    // The two names the caller chose. Neither is a column anywhere.
    expect(dump).not.toContain("Johnson Family");
    expect(dump).not.toContain("Erica");
    // Nor does the response echo them back.
    expect(JSON.stringify(response.body)).not.toContain("Johnson Family");
    expect(JSON.stringify(response.body)).not.toContain("Erica");
  });
});

/**
 * The clean-schema cutover (migration 0083) drops the whole device layer —
 * identities, grants, profiles, push — but deliberately KEEPS `usernames`.
 * That leaves an account whose name is taken and whose owner has no device
 * record. If bootstrap refuses that state, the name is permanently unusable
 * by the only person entitled to it.
 */
describe("account bootstrap — re-establishing a device layer the cutover dropped", () => {
  it("lets the owner rebuild it, proven by a matching IRK and admin root", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({
      username,
      irkPubHex: hex(irk.publicKey),
      adminRootPubHex: hex(admin.publicKey),
      claimedAt: now,
    } as never);
    // No identity, no grant, no profiles — the post-migration state.
    expect(await storage.deviceIdentities.listForAccount(username)).toEqual([]);

    const response = await handleAccountBootstrap({
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    }, body());

    expect(response.status).toBe(200);
    // The device layer every dropped feature hangs off is back.
    expect(await storage.deviceIdentities.get(username, deviceId)).toBeDefined();
    expect(await storage.deviceCapabilityGrants.getActiveForUserDevice(username, deviceId)).toBeDefined();
    expect(await storage.accountProfiles.get(username)).toBeDefined();
    expect(await storage.deviceSelfProfiles.get(username, deviceId)).toBeDefined();
  });

  it("refuses anyone whose IRK does not match the surviving account", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({
      username,
      irkPubHex: hex(keypair(200).publicKey), // somebody else's account
      adminRootPubHex: hex(admin.publicKey),
      claimedAt: now,
    } as never);

    const response = await handleAccountBootstrap({
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    }, body());

    // The offer gate rejects it before provisioning is even consulted.
    expect(response.status).toBe(403);
    // Nothing was created for the impostor.
    expect(await storage.deviceIdentities.listForAccount(username)).toEqual([]);
  });

  it("refuses a matching IRK whose admin root differs", async () => {
    const storage = new InMemoryStorage();
    await storage.usernames.put({
      username,
      irkPubHex: hex(irk.publicKey),
      adminRootPubHex: hex(keypair(210).publicKey),
      claimedAt: now,
    } as never);

    const response = await handleAccountBootstrap({
      provisioning: storage.accountProvisioning,
      usernames: storage.usernames,
      offers: storage.usernameOffers,
      now: () => now,
    }, body());

    // The offer gate passes (the IRK matches) — provisioning is what
    // refuses, proving the admin-root half of the check is load-bearing.
    expect(response.status).toBe(409);
    expect(await storage.deviceIdentities.listForAccount(username)).toEqual([]);
  });
});
