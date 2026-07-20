import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  decryptAccountProfile,
  decryptDeviceProfile,
  deviceSupportCode,
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  encryptAccountProfile,
  encryptDeviceProfile,
  generateDeviceId,
  signAccountProfile,
  signAccountDirectoryKeyGrant,
  signAccountDirectoryRequest,
  signDeviceManagedProfile,
  signDeviceSelfProfile,
  validateProfileDisplayName,
  verifyAccountProfile,
  verifyAccountDirectoryKeyGrant,
  verifyAccountDirectoryRequest,
  verifyDeviceManagedProfile,
  verifyDeviceSelfProfile,
  type AccountProfileEnvelope,
  type DeviceManagedProfileEnvelope,
  type DeviceSelfProfileEnvelope,
} from "../src/accountMetadata.js";

const umk = Uint8Array.from({ length: 32 }, (_, i) => i);
const adminSeed = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const deviceSeed = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const admin = { privateKey: adminSeed, publicKey: ed.getPublicKey(adminSeed) };
const device = { privateKey: deviceSeed, publicKey: ed.getPublicKey(deviceSeed) };
const accountId = "jolly-ranger";
const deviceId = "00112233445566778899aabbccddeeff";
const nonce = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
const hex = (value: Uint8Array) => [...value].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("account metadata keys", () => {
  it("derives stable, domain-separated keys", () => {
    expect(hex(deriveAccountProfileKey(umk))).toBe("6704c17878d90b3c9767fecbcbc969c55c4683674c76a6e5f7143fc2f2b5b674");
    expect(hex(deriveDeviceDirectoryKey(umk))).toBe("0f64692831c58829479951cca532646137a61c168b9ec9f079bb121694ba0d7f");
    expect(deriveAccountProfileKey(umk)).not.toEqual(deriveDeviceDirectoryKey(umk));
  });

  it("mints a 128-bit account-scoped opaque identifier", () => {
    expect(generateDeviceId((out) => {
      out.set(Uint8Array.from({ length: 16 }, (_, i) => i));
      return out;
    })).toBe("000102030405060708090a0b0c0d0e0f");
  });

  it("derives a stable opaque support code from account-scoped identity", () => {
    expect(deviceSupportCode(accountId, deviceId, hex(device.publicKey))).toBe("4Y5E-AWQA");
    expect(deviceSupportCode("other-account", deviceId, hex(device.publicKey))).not.toBe("4Y5E-AWQA");
  });
});

describe("directory authorization", () => {
  it("binds signed requests to the account, device, signer, method, path, nonce, and time", () => {
    const request = {
      accountId,
      deviceId,
      signerPubHex: hex(device.publicKey),
      method: "GET",
      path: `/api/accounts/${accountId}/directory`,
      requestId: "ffeeddccbbaa99887766554433221100",
      issuedAt: 1_900_000_000_000,
    };
    const signature = signAccountDirectoryRequest(request, device);
    expect(verifyAccountDirectoryRequest(request, signature, device.publicKey)).toBe(true);
    expect(verifyAccountDirectoryRequest({ ...request, path: `/api/accounts/${accountId}/profile` }, signature, device.publicKey)).toBe(false);
    expect(verifyAccountDirectoryRequest({ ...request, requestId: deviceId }, signature, device.publicKey)).toBe(false);
  });

  it("pins targeted profile-key grants to their purpose and recipient", () => {
    const grant = {
      accountId,
      recipientDeviceId: deviceId,
      keyKind: "device-directory" as const,
      sealedKeyHex: "deadbeef",
      issuedAt: 1_900_000_000_000,
      expiresAt: 1_900_003_600_000,
      signerPubHex: hex(admin.publicKey),
    };
    const signature = signAccountDirectoryKeyGrant(grant, admin);
    expect(verifyAccountDirectoryKeyGrant(grant, signature, admin.publicKey)).toBe(true);
    expect(verifyAccountDirectoryKeyGrant({ ...grant, keyKind: "account-profile" }, signature, admin.publicKey)).toBe(false);
  });
});

describe("profile encryption", () => {
  it("round-trips an account profile and pins the vector", () => {
    const key = deriveAccountProfileKey(umk);
    const encrypted = encryptAccountProfile(" Johnson Family ", key, {
      accountId,
      revision: 1,
      keyVersion: 1,
      nonce,
    });
    expect(encrypted).toEqual({
      accountId,
      revision: 1,
      keyVersion: 1,
      nonceHex: "a0a1a2a3a4a5a6a7a8a9aaab",
      ciphertextHex: "a33dbbf36474c8cc0eacb0333f89e5d3c9067a7e37cc4f6c105e74901e86d71ac10dbb14587035116edd016459679ca1dfdffeb23e71bf15f9b95238",
    });
    expect(decryptAccountProfile(encrypted, key)).toEqual({ version: 1, displayName: "Johnson Family" });
  });

  it("binds device ciphertext to account, device, record type, revision, and key version", () => {
    const key = deriveDeviceDirectoryKey(umk);
    const encrypted = encryptDeviceProfile("Erica", key, {
      accountId,
      deviceId,
      revision: 3,
      keyVersion: 2,
      nonce,
    });
    const envelope = { ...encrypted, deviceId };
    expect(decryptDeviceProfile(envelope, key)).toEqual({ version: 1, displayName: "Erica" });
    expect(() => decryptDeviceProfile({ ...envelope, accountId: "other-account" }, key)).toThrow();
    expect(() => decryptDeviceProfile({ ...envelope, deviceId: "ffeeddccbbaa99887766554433221100" }, key)).toThrow();
    expect(() => decryptDeviceProfile({ ...envelope, revision: 4 }, key)).toThrow();
    expect(() => decryptDeviceProfile(envelope, key, true)).toThrow();
  });

  it("rejects nonce and ciphertext tampering", () => {
    const key = deriveAccountProfileKey(umk);
    const encrypted = encryptAccountProfile("Johnson Family", key, { accountId, revision: 1, keyVersion: 1, nonce });
    expect(() => decryptAccountProfile({ ...encrypted, nonceHex: `b${encrypted.nonceHex.slice(1)}` }, key)).toThrow();
    expect(() => decryptAccountProfile({ ...encrypted, ciphertextHex: `0${encrypted.ciphertextHex.slice(1)}` }, key)).toThrow();
  });
});

describe("profile signatures", () => {
  it("separates account, self, and managed purposes", () => {
    const accountEncrypted = encryptAccountProfile("Johnson Family", deriveAccountProfileKey(umk), {
      accountId, revision: 1, keyVersion: 1, nonce,
    });
    const accountUnsigned = { ...accountEncrypted, issuedAt: 1_900_000_000_000, signerPubHex: hex(admin.publicKey) };
    const accountEnvelope: AccountProfileEnvelope = {
      ...accountUnsigned,
      signatureHex: signAccountProfile(accountUnsigned, admin),
    };
    expect(verifyAccountProfile(accountEnvelope, admin.publicKey)).toBe(true);
    expect(verifyAccountProfile({ ...accountEnvelope, revision: 2 }, admin.publicKey)).toBe(false);

    const selfEncrypted = encryptDeviceProfile("Erica", deriveDeviceDirectoryKey(umk), {
      accountId, deviceId, revision: 1, keyVersion: 1, nonce,
    });
    const selfUnsigned = { ...selfEncrypted, deviceId, issuedAt: 1_900_000_000_001, signerPubHex: hex(device.publicKey) };
    const selfEnvelope: DeviceSelfProfileEnvelope = {
      ...selfUnsigned,
      signatureHex: signDeviceSelfProfile(selfUnsigned, device),
    };
    expect(verifyDeviceSelfProfile(selfEnvelope, device.publicKey)).toBe(true);

    const managedEncrypted = encryptDeviceProfile("Marketing (Erica)", deriveDeviceDirectoryKey(umk), {
      accountId, deviceId, revision: 1, keyVersion: 1, managed: true, nonce,
    });
    const managedUnsigned = {
      ...managedEncrypted,
      deviceId,
      locked: true,
      issuedAt: 1_900_000_000_002,
      signerPubHex: hex(admin.publicKey),
    };
    const managedEnvelope: DeviceManagedProfileEnvelope = {
      ...managedUnsigned,
      signatureHex: signDeviceManagedProfile(managedUnsigned, admin),
    };
    expect(verifyDeviceManagedProfile(managedEnvelope, admin.publicKey)).toBe(true);
    expect(verifyDeviceManagedProfile({ ...managedEnvelope, locked: false }, admin.publicKey)).toBe(false);
    expect(verifyDeviceSelfProfile({ ...selfEnvelope, signatureHex: managedEnvelope.signatureHex }, admin.publicKey)).toBe(false);
  });
});

describe("display-name validation", () => {
  it("normalizes NFC, trims, and permits international names and emoji", () => {
    expect(validateProfileDisplayName("  Jose\u0301 👨‍👩‍👧  ")).toBe("José 👨‍👩‍👧");
  });

  it.each(["", "name\nnext", "name\u202e", "x\u0000y", "\ud800"])("rejects unsafe input %#", (value) => {
    expect(() => validateProfileDisplayName(value)).toThrow();
  });

  it("enforces grapheme and byte bounds", () => {
    expect(() => validateProfileDisplayName("a".repeat(65))).toThrow(/grapheme/);
    expect(() => validateProfileDisplayName("👨‍👩‍👧".repeat(64))).toThrow(/UTF-8/);
  });
});
