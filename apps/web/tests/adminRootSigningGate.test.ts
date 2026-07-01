// Slice D — Phase 2 (webapp): the admin-master-root signing gate.
//
// Covers docs/device-admin-tier-spec.md §8.1/§8.3:
//   1. the admin master root is a valid, FRESH RANDOM Ed25519 keypair (NOT
//      UMK-derived — a different key from the membership IRK of the same UMK);
//   2. `signWithAdminRoot` produces a signature that verifies under
//      `adminRootPubHex` and NOT under the IRK;
//   3. the signing GATE (`makeSensitiveSigner`): a SENSITIVE-tagged order signs
//      with the admin root WHEN a root is present, a non-sensitive/mailbox-auth
//      order stays on the legacy signer, and an account with NO admin root
//      signs everything with the legacy signer (owner IRK).
//
// Storage (generate/load/escrow) round-trips through IndexedDB, which the repo's
// vitest env doesn't wire up — those are exercised on-device; here we drive the
// pure crypto + routing seams (injectable, no IndexedDB).

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}
const loadKeystore = () => load("keystore.js");
const loadAdminRoot = () => load("lib/adminRoot.js");

const te = (s: string) => new TextEncoder().encode(s);

const DECOMMISSION = "flagship/server-decommission/v1|foo.bar.flagship.services|00|1|keep|0|abc|1700000000000";
const RELEASE = "flagship/release-server-name/v1|alice|foo.bar|1700000000000";
const INVITE_CREATE = "flagship/service-invite/create/v1|iid|aidhex|svc|hash|bundle|1700000000000";
// The mailbox-auth credential co-signed alongside decommission/transfer/set-leader.
const MAILBOX_AUTH = "flagship/device-endpoint-claim/v1|alice|webapp|deadbeef|1|2|nonce";

describe("admin master root — key model", () => {
  it("derives a valid Ed25519 keypair from a random seed and signs verifiably", async () => {
    const ks = await loadKeystore();
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const pubHex = await ks.adminRootPubHex(adminSeed);
    expect(pubHex).toMatch(/^[0-9a-f]{64}$/);

    const msg = te(DECOMMISSION);
    const sig = await ks.signWithAdminRoot(adminSeed, msg);
    expect(sig).toHaveLength(64);
    expect(await ks.verifyWithEd25519Pub(ks.hexToBytes(pubHex), sig, msg)).toBe(true);
  });

  it("is NOT UMK-derived — a different key from the IRK of the same seed", async () => {
    const ks = await loadKeystore();
    const seed = new Uint8Array(32).fill(9);
    const adminPubHex = await ks.adminRootPubHex(seed); // seed used as the admin root seed
    const irk = await ks.deriveIrkFromSeed(seed); // membership IRK = HKDF(seed)
    expect(adminPubHex).not.toBe(ks.bytesToHex(irk.publicKey));
  });
});

describe("makeSensitiveSigner — the signing gate", () => {
  it("signs a SENSITIVE order with the admin root when the account has one", async () => {
    const ks = await loadKeystore();
    const { makeSensitiveSigner } = await loadAdminRoot();

    const umk = new Uint8Array(32).fill(3);
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const adminPub = ks.hexToBytes(await ks.adminRootPubHex(adminSeed));
    const irk = await ks.deriveIrkFromSeed(umk);
    const legacy = (u: Uint8Array, b: Uint8Array) => ks.signWithIrk(u, b);

    const sign = makeSensitiveSigner(adminSeed, legacy);
    for (const tag of [DECOMMISSION, RELEASE, INVITE_CREATE]) {
      const bytes = te(tag);
      const sig = await sign(umk, bytes);
      // ADMIN root signed it — verifies under the admin pub, NOT the IRK.
      expect(await ks.verifyWithEd25519Pub(adminPub, sig, bytes)).toBe(true);
      expect(await ks.verifyWithEd25519Pub(irk.publicKey, sig, bytes)).toBe(false);
    }
  });

  it("keeps a co-signed mailbox-auth on the owner IRK even when a root is present", async () => {
    const ks = await loadKeystore();
    const { makeSensitiveSigner } = await loadAdminRoot();

    const umk = new Uint8Array(32).fill(3);
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const adminPub = ks.hexToBytes(await ks.adminRootPubHex(adminSeed));
    const irk = await ks.deriveIrkFromSeed(umk);

    const sign = makeSensitiveSigner(adminSeed, (u: Uint8Array, b: Uint8Array) => ks.signWithIrk(u, b));
    const bytes = te(MAILBOX_AUTH);
    const sig = await sign(umk, bytes);
    // device-endpoint-claim is NOT sensitive → IRK signed it (the deposit lane
    // needs a membership-IRK auth), NOT the admin root.
    expect(await ks.verifyWithEd25519Pub(irk.publicKey, sig, bytes)).toBe(true);
    expect(await ks.verifyWithEd25519Pub(adminPub, sig, bytes)).toBe(false);
  });

  it("falls back to the owner IRK for a SENSITIVE order when there is NO admin root", async () => {
    const ks = await loadKeystore();
    const { makeSensitiveSigner } = await loadAdminRoot();

    const umk = new Uint8Array(32).fill(3);
    const irk = await ks.deriveIrkFromSeed(umk);

    // null admin root ⇒ legacy path (pre-wipe / non-admin device).
    const sign = makeSensitiveSigner(null, (u: Uint8Array, b: Uint8Array) => ks.signWithIrk(u, b));
    const bytes = te(DECOMMISSION);
    const sig = await sign(umk, bytes);
    expect(await ks.verifyWithEd25519Pub(irk.publicKey, sig, bytes)).toBe(true);
  });

  it("routes an AID-legacy signer identically (service-invite gate)", async () => {
    const ks = await loadKeystore();
    const { makeSensitiveSigner } = await loadAdminRoot();

    const umk = new Uint8Array(32).fill(5);
    const adminSeed = crypto.getRandomValues(new Uint8Array(32));
    const adminPub = ks.hexToBytes(await ks.adminRootPubHex(adminSeed));
    const aid = await ks.deriveAccountIdFromSeed(umk);

    // legacy = the account AID signer (service-invite create/revoke path).
    const legacyAid = (u: Uint8Array, b: Uint8Array) => ks.signWithAccountId(u, b);

    // With a root: invite-create routes to the admin root, NOT the AID.
    const withRoot = makeSensitiveSigner(adminSeed, legacyAid);
    const bytes = te(INVITE_CREATE);
    const sig = await withRoot(umk, bytes);
    expect(await ks.verifyWithEd25519Pub(adminPub, sig, bytes)).toBe(true);
    expect(await ks.verifyWithEd25519Pub(aid.publicKey, sig, bytes)).toBe(false);

    // Without a root: it falls back to the AID (the legacy dual-accept key).
    const noRoot = makeSensitiveSigner(null, legacyAid);
    const sig2 = await noRoot(umk, bytes);
    expect(await ks.verifyWithEd25519Pub(aid.publicKey, sig2, bytes)).toBe(true);
  });

  it("publishes adminRootPub in the username claim when the account has a root", async () => {
    const { claimUsername } = await load("lib/openAccount.js");
    const bodies: any[] = [];
    const fetchMock = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response("", { status: 200 });
    };
    const irkPub = new Uint8Array(32).fill(2);
    const sign = async () => new Uint8Array(64);
    const ADMIN_PUB = "aa".repeat(32);

    await claimUsername("alice", irkPub, sign, {
      fetch: fetchMock as any,
      adminRootPubHex: ADMIN_PUB,
    });
    expect(bodies[0].adminRootPub).toBe(ADMIN_PUB);

    // Legacy (no admin root) — the field is OMITTED, byte-identical to pre-D.
    bodies.length = 0;
    await claimUsername("alice", irkPub, sign, { fetch: fetchMock as any });
    expect(bodies[0]).not.toHaveProperty("adminRootPub");
  });

  it("canonicalTag reads the tag token before the first separator", async () => {
    const { canonicalTag, SENSITIVE_TAGS } = await loadAdminRoot();
    expect(canonicalTag(te(DECOMMISSION))).toBe("flagship/server-decommission/v1");
    expect(canonicalTag(te(MAILBOX_AUTH))).toBe("flagship/device-endpoint-claim/v1");
    expect(SENSITIVE_TAGS.has("flagship/server-decommission/v1")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/device-endpoint-claim/v1")).toBe(false);
  });
});
