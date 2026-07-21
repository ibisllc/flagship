import { describe, expect, it } from "vitest";
import {
  buildAccountDirectoryKeyGrant,
  openAccountDirectoryKeyGrant,
  sealDirectoryKey,
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  ed,
  openSealedFromEd25519Recipient,
  type AccountDirectoryKeyGrant,
  type Keypair,
} from "../src/index.js";
import { hex } from "../src/canonicalBase.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Fixed material → cross-platform vector. The admin holds this UMK and derives
// the profile/directory keys from it; the recipient RESTRICTED device holds
// only its own Ed25519 identity seed (never the UMK), so it can only recover a
// directory key through a sealed grant.
const UMK = Uint8Array.from({ length: 32 }, (_, i) => i);
const RECIPIENT_SEED = new Uint8Array(32).fill(9);
const recipientPub = ed.getPublicKey(RECIPIENT_SEED);
const recipientDeviceId = "00112233445566778899aabbccddeeff";
const accountId = "jolly-ranger";
const now = 1_900_000_000_000;
const issuedAt = now;
const expiresAt = now + 60_000;

function adminKey(): Keypair {
  const privateKey = new Uint8Array(32).fill(0x40);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

describe("account directory key delivery", () => {
  it("round-trips: admin seals+signs, restricted device verifies+unseals the exact key", () => {
    const admin = adminKey();
    for (const keyKind of ["account-profile", "device-directory"] as const) {
      const key = keyKind === "account-profile"
        ? deriveAccountProfileKey(UMK)
        : deriveDeviceDirectoryKey(UMK);
      const { grant, signature } = buildAccountDirectoryKeyGrant({
        accountId,
        recipientDeviceId,
        keyKind,
        key,
        recipientDevicePub: recipientPub,
        adminRoot: admin,
        adminRootPubHex: hex(admin.publicKey),
        issuedAt,
        expiresAt,
      });
      // The sealed blob is 32(eph) + 12(nonce) + 32(key) + 16(tag) = 92 bytes.
      expect(grant.sealedKeyHex.length).toBe(92 * 2);
      const opened = openAccountDirectoryKeyGrant({
        grant,
        signature,
        adminRootPub: admin.publicKey,
        expectedAccountId: accountId,
        expectedRecipientDeviceId: recipientDeviceId,
        recipientDeviceSeed: RECIPIENT_SEED,
        now,
      });
      expect(opened).not.toBeNull();
      expect(hex(opened!)).toBe(hex(key));
    }
  });

  it("supports a custodian-backed unseal (seed never surfaces)", () => {
    const admin = adminKey();
    const key = deriveAccountProfileKey(UMK);
    const { grant, signature } = buildAccountDirectoryKeyGrant({
      accountId, recipientDeviceId, keyKind: "account-profile", key,
      recipientDevicePub: recipientPub, adminRoot: admin,
      adminRootPubHex: hex(admin.publicKey), issuedAt, expiresAt,
    });
    const opened = openAccountDirectoryKeyGrant({
      grant,
      signature,
      adminRootPub: admin.publicKey,
      expectedAccountId: accountId,
      expectedRecipientDeviceId: recipientDeviceId,
      unseal: (blob) => openSealedFromEd25519Recipient(blob, RECIPIENT_SEED),
    });
    expect(hex(opened!)).toBe(hex(key));
  });

  // ── Negative matrix: every one must fail CLOSED (null). ──────────────────
  function freshGrant() {
    const admin = adminKey();
    const key = deriveDeviceDirectoryKey(UMK);
    const built = buildAccountDirectoryKeyGrant({
      accountId, recipientDeviceId, keyKind: "device-directory", key,
      recipientDevicePub: recipientPub, adminRoot: admin,
      adminRootPubHex: hex(admin.publicKey), issuedAt, expiresAt,
    });
    return { admin, key, ...built };
  }

  it("rejects the WRONG recipient device (sealed to another device's key)", () => {
    const { admin, signature, grant } = freshGrant();
    const wrongSeed = new Uint8Array(32).fill(13);
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: admin.publicKey,
      expectedAccountId: accountId, expectedRecipientDeviceId: recipientDeviceId,
      recipientDeviceSeed: wrongSeed, now,
    })).toBeNull();
  });

  it("rejects a grant addressed to a DIFFERENT device id (binding mismatch)", () => {
    const { admin, signature, grant } = freshGrant();
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: admin.publicKey,
      expectedAccountId: accountId,
      expectedRecipientDeviceId: "ffeeddccbbaa99887766554433221100",
      recipientDeviceSeed: RECIPIENT_SEED, now,
    })).toBeNull();
  });

  it("rejects a grant scoped to a DIFFERENT account", () => {
    const { admin, signature, grant } = freshGrant();
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: admin.publicKey,
      expectedAccountId: "someone-else", expectedRecipientDeviceId: recipientDeviceId,
      recipientDeviceSeed: RECIPIENT_SEED, now,
    })).toBeNull();
  });

  it("rejects a tampered sealed key (signature no longer verifies)", () => {
    const { admin, signature, grant } = freshGrant();
    const flipped = [...grant.sealedKeyHex];
    // Flip the low nibble of the last ciphertext byte.
    flipped[flipped.length - 1] = flipped[flipped.length - 1] === "0" ? "1" : "0";
    const tampered: AccountDirectoryKeyGrant = { ...grant, sealedKeyHex: flipped.join("") };
    expect(openAccountDirectoryKeyGrant({
      grant: tampered, signature, adminRootPub: admin.publicKey,
      expectedAccountId: accountId, expectedRecipientDeviceId: recipientDeviceId,
      recipientDeviceSeed: RECIPIENT_SEED, now,
    })).toBeNull();
  });

  it("rejects a signature by anything but the pinned admin root (forged authority)", () => {
    const { signature, grant } = freshGrant();
    const impostor = new Uint8Array(32).fill(0x99);
    const impostorPub = ed.getPublicKey(impostor);
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: impostorPub,
      expectedAccountId: accountId, expectedRecipientDeviceId: recipientDeviceId,
      recipientDeviceSeed: RECIPIENT_SEED, now,
    })).toBeNull();
  });

  it("rejects an expired grant (replay past its window)", () => {
    const { admin, signature, grant } = freshGrant();
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: admin.publicKey,
      expectedAccountId: accountId, expectedRecipientDeviceId: recipientDeviceId,
      recipientDeviceSeed: RECIPIENT_SEED, now: expiresAt + 1,
    })).toBeNull();
  });

  it("rejects a grant presented before its issuedAt", () => {
    const { admin, signature, grant } = freshGrant();
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: admin.publicKey,
      expectedAccountId: accountId, expectedRecipientDeviceId: recipientDeviceId,
      recipientDeviceSeed: RECIPIENT_SEED, now: issuedAt - 1,
    })).toBeNull();
  });

  it("fails closed when neither seed nor custodian unseal is supplied", () => {
    const { admin, signature, grant } = freshGrant();
    expect(openAccountDirectoryKeyGrant({
      grant, signature, adminRootPub: admin.publicKey,
      expectedAccountId: accountId, expectedRecipientDeviceId: recipientDeviceId,
    })).toBeNull();
  });

  // ── Golden vector: the SEAL input/output is randomized (ephemeral key), so
  // we pin the OPEN direction — a fixed sealed blob opens to the fixed key.
  // TS, Swift and Kotlin all load this file and MUST agree byte-for-byte. ──
  it("matches the pinned OPEN golden vector (shared by TS/Swift/Kotlin)", () => {
    const path = resolve(__dirname, "..", "..", "..", "test-vectors", "directory-key-delivery.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      recipientSeedHex: string;
      recipientPubHex: string;
      adminRootPubHex: string;
      vectors: Array<{
        name: string;
        grant: AccountDirectoryKeyGrant;
        signatureHex: string;
        expectedKeyHex: string;
      }>;
    };
    expect(file.recipientPubHex).toBe(hex(recipientPub));
    const seed = Uint8Array.from(
      file.recipientSeedHex.match(/../g)!.map((b) => Number.parseInt(b, 16)),
    );
    const adminRootPub = Uint8Array.from(
      file.adminRootPubHex.match(/../g)!.map((b) => Number.parseInt(b, 16)),
    );
    expect(file.vectors.length).toBeGreaterThan(0);
    for (const v of file.vectors) {
      const opened = openAccountDirectoryKeyGrant({
        grant: v.grant,
        signature: v.signatureHex,
        adminRootPub,
        expectedAccountId: v.grant.accountId,
        expectedRecipientDeviceId: v.grant.recipientDeviceId,
        recipientDeviceSeed: seed,
      });
      expect(opened, `vector ${v.name} must open`).not.toBeNull();
      expect(hex(opened!)).toBe(v.expectedKeyHex);
    }
  });
});
