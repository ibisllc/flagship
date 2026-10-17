// .com's half of "only an admin device of the joining account accepts a
// share" (docs/share-a-server.md §5.1): the CA attestation of an account's
// sensitive key, and the demo account's signer.
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_KEY_ATTESTATION_TTL_MS,
  ed,
  parseAccountKeyAttestation,
  verifyCaSignedAccountKeyAttestation,
  verifyServerShareAcceptAdmin,
  type ServerShareAcceptAdmin,
} from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import { deriveDemoAdminRoot } from "../src/demoIdentity.js";
import { handleDemoShareAccept } from "../src/demoUsers.js";
import { handleAccountKeyAttestation } from "../src/pubkeyCert.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

const caSeed = new Uint8Array(32).fill(0xca);
const ca = { keypair: { privateKey: caSeed, publicKey: ed.getPublicKey(caSeed) }, issuer: "test-ca" };
const chain = { authorizedCaKeys: () => [bytesToHex(ca.keypair.publicKey)] };
const IRK = "11".repeat(32);
const ADMIN = "22".repeat(32);
const NOW = 1_800_000_000_000;

async function usernames() {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: "bob", irkPubHex: IRK, adminRootPubHex: ADMIN, claimedAt: 1 });
  await s.usernames.put({ username: "legacy", irkPubHex: IRK, claimedAt: 1 });
  return s;
}

describe("GET /api/users/:u/account-key-attestation", () => {
  it("attests the admin root of an account that pins one, naming no account", async () => {
    const s = await usernames();
    const r = await handleAccountKeyAttestation({ ca, usernames: s.usernames, now: () => NOW }, "Bob");
    expect(r.status).toBe(200);
    const a = parseAccountKeyAttestation((r.body as { attestation: unknown }).attestation)!;
    expect(a).toMatchObject({ keyKind: "admin-root", keyPubHex: ADMIN, issuedAt: NOW, expiresAt: NOW + ACCOUNT_KEY_ATTESTATION_TTL_MS });
    expect(JSON.stringify(r.body)).not.toContain("bob");
    expect(verifyCaSignedAccountKeyAttestation(a, chain, NOW + 1)).toEqual({ ok: true });
    expect(r.headers?.["cache-control"]).toBe("private, no-store");
  });

  it("falls back to the IRK for an account with no admin root (authorizeSensitiveComOp's rule)", async () => {
    const s = await usernames();
    const r = await handleAccountKeyAttestation({ ca, usernames: s.usernames, now: () => NOW }, "legacy");
    expect((r.body as { attestation: { keyKind: string; keyPubHex: string } }).attestation).toMatchObject({ keyKind: "irk", keyPubHex: IRK });
  });

  it("404s an unknown account", async () => {
    const s = await usernames();
    expect((await handleAccountKeyAttestation({ ca, usernames: s.usernames }, "nobody")).status).toBe(404);
  });
});

describe("POST /api/dev/sample-user/:u/share-accept", () => {
  const KEK = new Uint8Array(32).fill(9);
  const USER = "playstore-test-0725";
  const root = deriveDemoAdminRoot(KEK, USER);
  const admit: ServerShareAcceptAdmin = {
    serverDomain: "home.harry.flagship.services",
    shareId: "ab".repeat(16),
    memberPubHex: "cd".repeat(32),
    acceptedAt: NOW,
    keyKind: "admin-root",
    keyPubHex: bytesToHex(root.publicKey),
  };
  async function demos() {
    const s = new InMemoryStorage();
    await s.demoUsers.insert({
      username: USER,
      idempotencyKey: "demo-test",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cpx11",
      activeServerId: null,
      activeServerIp: null,
      image: "debian-12",
      activeServerFqdn: null,
      lastActivityAt: 1,
      state: "ready",
      createdAt: 1,
      provisionPhase: null,
      provisionPhaseAt: null,
      provisionLastError: null,
    } as DemoUserRecord);
    return s;
  }

  it("signs the demo account's acceptance with its admin root", async () => {
    const s = await demos();
    const r = await handleDemoShareAccept({ storage: s.demoUsers, demoIrkKek: KEK }, USER, { admit });
    expect(r.status).toBe(200);
    const sig = hexToBytes((r.body as { signature: string }).signature);
    expect(verifyServerShareAcceptAdmin(admit, sig, root.publicKey)).toBe(true);
  });

  it("signs nothing for a real account, another root, or a malformed envelope", async () => {
    const s = await demos();
    const d = { storage: s.demoUsers, demoIrkKek: KEK };
    expect((await handleDemoShareAccept(d, "bob", { admit })).status).toBe(404);
    expect((await handleDemoShareAccept(d, USER, { admit: { ...admit, keyPubHex: "ee".repeat(32) } })).status).toBe(400);
    expect((await handleDemoShareAccept(d, USER, { admit: { ...admit, keyKind: "irk" } })).status).toBe(400);
    expect((await handleDemoShareAccept(d, USER, { admit: { ...admit, shareId: "x" } })).status).toBe(400);
    expect((await handleDemoShareAccept(d, USER, undefined)).status).toBe(400);
  });
});
