import { describe, expect, it } from "vitest";
import {
  decryptProfile,
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  encryptProfile,
  validateProfileDisplayName,
} from "../public/webapp/lib/accountMetadata.js";
import { deriveAccountDeviceSeedFromSeed } from "../public/webapp/keystore.js";

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const umk = Uint8Array.from({ length: 32 }, (_, i) => i);
const nonce = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);

describe("web account metadata parity", () => {
  it("matches the protocol key and ciphertext vectors", async () => {
    const accountKey = await deriveAccountProfileKey(umk);
    expect(hex(accountKey)).toBe("6704c17878d90b3c9767fecbcbc969c55c4683674c76a6e5f7143fc2f2b5b674");
    expect(hex(await deriveDeviceDirectoryKey(umk))).toBe("0f64692831c58829479951cca532646137a61c168b9ec9f079bb121694ba0d7f");
    expect(hex(await deriveAccountDeviceSeedFromSeed(
      umk, "jolly-ranger", "00112233445566778899aabbccddeeff",
    ))).toBe("19ee5d26fa101529c8596a83fd8341a4b74847fc0b996bf061f7a43bc6734e9d");
    const coordinates = {
      accountId: "jolly-ranger",
      recordType: "account-profile",
      revision: 1,
      keyVersion: 1,
      nonce,
    };
    const encrypted = await encryptProfile(" Johnson Family ", accountKey, coordinates);
    expect(encrypted).toEqual({
      nonceHex: "a0a1a2a3a4a5a6a7a8a9aaab",
      ciphertextHex: "a33dbbf36474c8cc0eacb0333f89e5d3c9067a7e37cc4f6c105e74901e86d71ac10dbb14587035116edd016459679ca1dfdffeb23e71bf15f9b95238",
    });
    expect(await decryptProfile({ ...coordinates, ...encrypted }, accountKey)).toBe("Johnson Family");
  });

  it("rejects cross-account and record-type swaps", async () => {
    const key = await deriveDeviceDirectoryKey(umk);
    const coordinates = {
      accountId: "jolly-ranger",
      deviceId: "00112233445566778899aabbccddeeff",
      recordType: "device-self-profile",
      revision: 1,
      keyVersion: 1,
      nonce,
    };
    const encrypted = await encryptProfile("Erica", key, coordinates);
    await expect(decryptProfile({ ...coordinates, ...encrypted, accountId: "other-account" }, key)).rejects.toThrow();
    await expect(decryptProfile({ ...coordinates, ...encrypted, recordType: "device-managed-profile" }, key)).rejects.toThrow();
  });

  it("validates presentation text locally", () => {
    expect(validateProfileDisplayName(" Jose\u0301 👨‍👩‍👧 ")).toBe("José 👨‍👩‍👧");
    expect(() => validateProfileDisplayName("unsafe\nname")).toThrow();
    expect(() => validateProfileDisplayName("unsafe\u202ename")).toThrow();
  });
});
