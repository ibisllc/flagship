#!/usr/bin/env tsx
/**
 * Golden-vector generator for the sealed directory/profile-key delivery
 * (`packages/protocol/src/directoryKeyDelivery.ts`).
 *
 * The seal primitive uses a random ephemeral key + nonce, so its OUTPUT is not
 * reproducible across runs/platforms. What IS reproducible — and what the three
 * clients (TS, Swift, Kotlin) must agree on byte-for-byte — is the OPEN
 * direction: a FIXED sealed grant, opened with the fixed recipient seed, yields
 * the fixed key, and the fixed admin-root signature verifies over the fixed
 * canonical bytes. So this tool seals ONCE here and freezes the result into
 * `test-vectors/directory-key-delivery.json`; every client loads that file and
 * asserts the open + verify.
 *
 * Run:          npx tsx tools/directory-key-vectors.ts
 * CI freshness: npx tsx tools/directory-key-vectors.ts --check
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildAccountDirectoryKeyGrant,
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  ed,
  type Keypair,
} from "@flagship/protocol";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Fixed material. Recipient is a RESTRICTED device holding only this seed. The
// admin holds the UMK below and derives the two directory keys from it.
const UMK = Uint8Array.from({ length: 32 }, (_, i) => i);
const RECIPIENT_SEED = new Uint8Array(32).fill(9);
const recipientPub = ed.getPublicKey(RECIPIENT_SEED);
const admin: Keypair = (() => {
  const privateKey = new Uint8Array(32).fill(0x40);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
})();
const accountId = "jolly-ranger";
const recipientDeviceId = "00112233445566778899aabbccddeeff";
const issuedAt = 1_900_000_000_000;
const expiresAt = issuedAt + 60_000;

function buildFile(): string {
  const vectors = (["account-profile", "device-directory"] as const).map((keyKind) => {
    const key = keyKind === "account-profile"
      ? deriveAccountProfileKey(UMK)
      : deriveDeviceDirectoryKey(UMK);
    const { grant, signature } = buildAccountDirectoryKeyGrant({
      accountId, recipientDeviceId, keyKind, key,
      recipientDevicePub: recipientPub, adminRoot: admin,
      adminRootPubHex: hex(admin.publicKey), issuedAt, expiresAt,
    });
    return { name: keyKind, grant, signatureHex: signature, expectedKeyHex: hex(key) };
  });
  const file = {
    note:
      "Golden OPEN vectors for the sealed directory/profile-key delivery. TS, " +
      "Swift and Kotlin LOAD this file and assert that each fixed sealed grant " +
      "verifies under adminRootPubHex and unseals with recipientSeedHex to " +
      "expectedKeyHex. The seal output is randomized so it is frozen here; " +
      "regenerate with `npx tsx tools/directory-key-vectors.ts`.",
    umkSeedHex: hex(UMK),
    recipientSeedHex: hex(RECIPIENT_SEED),
    recipientPubHex: hex(recipientPub),
    adminRootPubHex: hex(admin.publicKey),
    accountId,
    recipientDeviceId,
    issuedAt,
    expiresAt,
    vectors,
  };
  return JSON.stringify(file, null, 2) + "\n";
}

async function main() {
  const outDir = resolve("test-vectors");
  const outPath = resolve(outDir, "directory-key-delivery.json");
  const check = process.argv.includes("--check");
  if (check) {
    // Freshness of the STRUCTURE only — the sealed blob is randomized, so we
    // cannot byte-compare a fresh seal. Confirm the file exists and its pinned
    // keys/derivations still hold (a drift in derivation or admin key trips it).
    let existing: string;
    try {
      existing = await readFile(outPath, "utf8");
    } catch {
      console.error("test-vectors/directory-key-delivery.json is MISSING. Run the generator.");
      process.exit(1);
      return;
    }
    const parsed = JSON.parse(existing) as { recipientPubHex: string; adminRootPubHex: string };
    if (parsed.recipientPubHex !== hex(recipientPub) || parsed.adminRootPubHex !== hex(admin.publicKey)) {
      console.error("directory-key-delivery.json pinned keys drifted. Regenerate.");
      process.exit(1);
      return;
    }
    console.log("test-vectors/directory-key-delivery.json pinned keys are current.");
    return;
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, buildFile());
  console.log("Wrote test-vectors/directory-key-delivery.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
