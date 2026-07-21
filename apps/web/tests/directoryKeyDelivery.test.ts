import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  decryptProfile,
  encryptProfile,
} from "../public/webapp/lib/accountMetadata.js";

const load = () =>
  import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "directoryKeyDelivery.js")).href);

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}
function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const VECTORS = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "..", "test-vectors", "directory-key-delivery.json"), "utf8"),
) as {
  recipientSeedHex: string;
  adminRootPubHex: string;
  accountId: string;
  recipientDeviceId: string;
  vectors: Array<{
    name: string;
    grant: {
      accountId: string;
      recipientDeviceId: string;
      keyKind: "account-profile" | "device-directory";
      sealedKeyHex: string;
      issuedAt: number;
      expiresAt: number;
      signerPubHex: string;
    };
    signatureHex: string;
    expectedKeyHex: string;
  }>;
};

describe("web directory-key delivery consumption", () => {
  it("verifies admin-root sig + binding, unseals to the shared golden key (TS parity)", async () => {
    const { openAccountDirectoryKeyGrant } = await load();
    const seed = hexToBytes(VECTORS.recipientSeedHex);
    const adminRootPub = hexToBytes(VECTORS.adminRootPubHex);
    expect(VECTORS.vectors.length).toBeGreaterThan(0);
    for (const v of VECTORS.vectors) {
      const key = await openAccountDirectoryKeyGrant({
        grant: v.grant,
        signatureHex: v.signatureHex,
        adminRootPub,
        expectedAccountId: v.grant.accountId,
        expectedRecipientDeviceId: v.grant.recipientDeviceId,
        recipientDeviceSeed: seed,
      });
      expect(key, `vector ${v.name} must open`).not.toBeNull();
      expect(bytesToHex(key!)).toBe(v.expectedKeyHex);
    }
  });

  it("installs the delivered key to decrypt the real account name", async () => {
    const { openAccountDirectoryKeyGrant } = await load();
    // Reconstruct the admin's UMK from the vector file to make a matching
    // ciphertext, then prove the delivered key decrypts it.
    const umkSeed = hexToBytes(JSON.parse(
      readFileSync(resolve(__dirname, "..", "..", "..", "test-vectors", "directory-key-delivery.json"), "utf8"),
    ).umkSeedHex);
    const profileKey = await deriveAccountProfileKey(umkSeed);
    const enc = await encryptProfile("Johnson Family", profileKey, {
      accountId: VECTORS.accountId, recordType: "account-profile", revision: 1, keyVersion: 1,
      nonce: new Uint8Array(12).fill(5),
    });
    const v = VECTORS.vectors.find((x) => x.name === "account-profile")!;
    const key = await openAccountDirectoryKeyGrant({
      grant: v.grant,
      signatureHex: v.signatureHex,
      adminRootPub: hexToBytes(VECTORS.adminRootPubHex),
      expectedAccountId: v.grant.accountId,
      expectedRecipientDeviceId: v.grant.recipientDeviceId,
      recipientDeviceSeed: hexToBytes(VECTORS.recipientSeedHex),
    });
    expect(bytesToHex(key!)).toBe(v.expectedKeyHex);
    const name = await decryptProfile(
      { ...enc, accountId: VECTORS.accountId, recordType: "account-profile", revision: 1, keyVersion: 1 },
      key!,
    );
    expect(name).toBe("Johnson Family");
  });

  // ── Negative matrix — every one must return null (fail closed). ──────────
  async function open(overrides: Record<string, unknown>) {
    const { openAccountDirectoryKeyGrant } = await load();
    const v = VECTORS.vectors[0]!;
    return openAccountDirectoryKeyGrant({
      grant: v.grant,
      signatureHex: v.signatureHex,
      adminRootPub: hexToBytes(VECTORS.adminRootPubHex),
      expectedAccountId: v.grant.accountId,
      expectedRecipientDeviceId: v.grant.recipientDeviceId,
      recipientDeviceSeed: hexToBytes(VECTORS.recipientSeedHex),
      ...overrides,
    });
  }

  it("rejects the wrong recipient device seed", async () => {
    expect(await open({ recipientDeviceSeed: new Uint8Array(32).fill(13) })).toBeNull();
  });
  it("rejects a mismatched expected device id", async () => {
    expect(await open({ expectedRecipientDeviceId: "ffeeddccbbaa99887766554433221100" })).toBeNull();
  });
  it("rejects a mismatched account", async () => {
    expect(await open({ expectedAccountId: "someone-else" })).toBeNull();
  });
  it("rejects a forged admin-root pub", async () => {
    expect(await open({ adminRootPub: new Uint8Array(32).fill(0x99) })).toBeNull();
  });
  it("rejects a tampered sealed key", async () => {
    const v = VECTORS.vectors[0]!;
    const flipped = [...v.grant.sealedKeyHex];
    flipped[flipped.length - 1] = flipped[flipped.length - 1] === "0" ? "1" : "0";
    expect(await open({ grant: { ...v.grant, sealedKeyHex: flipped.join("") } })).toBeNull();
  });
  it("rejects an expired grant", async () => {
    const v = VECTORS.vectors[0]!;
    expect(await open({ now: v.grant.expiresAt + 1 })).toBeNull();
  });
});
