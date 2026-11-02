/**
 * The gym's Messages abuse key (docs/voici-and-messages.md §9.3), deterministic test material like the gym trust
 * material on the `gym` branch (packages/control-plane/src/gymTrustMaterial.ts): never used outside the gym.
 *
 * `.com` loads its abuse keys only from the bundled `.maintainers/abuse-keys/list.json`, and only entries signed by
 * a ca-track holder of the pinned chain (apps/com/src/abuseKeys.ts). There is no runtime seam, so a run cannot hand
 * the gym a throwaway key: the entry below has to be committed to the `gym` branch's list.json (signed by the gym's
 * ca-track key K, whose seed is public test material) and the gym Worker redeployed. Until then the gym `.com` answers
 * every attestation request 503 `no-abuse-key`, and the voici group skips what needs a visitor attestation.
 *
 *   npx tsx tools/live-e2e/lib/gymAbuseKey.ts     prints the signed entry to put in the gym branch's list.json
 */
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { ed, hybridSealKeygen, signAbuseKeyEntry, verifyAbuseKeyEntry, type AbuseKeyEntry } from "@flagship/protocol";

/** The gym ca-track key K (gymTrustMaterial.ts: seed = ASCII "gymtrusttestkeygmtrusttestkey00", public test material). */
export const GYM_K_SEED = Uint8Array.from(Buffer.from("6779796d7472757374746573746b6579676d7472757374746573746b65793030", "hex"));
export const GYM_K_PUB = "2e6585d75f992a0fc097e05ee6e11e8ccc31e229394d3aec238e68a81b7ba930";

/** The gym abuse key's X-Wing seed: SHA-256 of a fixed label. Test material, like K. */
export const GYM_ABUSE_SEED = sha256(new TextEncoder().encode("flagship/gym-abuse-key/v1|epoch-1"));
export const GYM_ABUSE_EPOCH = 1;
const NOT_BEFORE = Date.parse("2026-11-01T00:00:00Z");
const NOT_AFTER = Date.parse("2027-11-01T00:00:00Z");

export function gymAbuseKeyEntry(): AbuseKeyEntry & { signature: string } {
  const entry: AbuseKeyEntry = {
    epoch: GYM_ABUSE_EPOCH,
    xwingPub: bytesToHex(hybridSealKeygen(GYM_ABUSE_SEED).publicKey),
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  };
  return { ...entry, signature: signAbuseKeyEntry(entry, GYM_K_SEED) };
}

/** True when the K constants agree and the entry verifies under K. */
export function gymAbuseKeySelfCheck(): boolean {
  const e = gymAbuseKeyEntry();
  return bytesToHex(ed.getPublicKey(GYM_K_SEED)) === GYM_K_PUB && verifyAbuseKeyEntry(e, e.signature, [GYM_K_PUB]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify({ version: 1, entries: [gymAbuseKeyEntry()] }, null, 2)}\n`);
}
