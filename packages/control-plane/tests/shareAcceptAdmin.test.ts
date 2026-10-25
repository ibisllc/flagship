// .com's half of "only an admin device of the joining account accepts a
// share" (docs/share-a-server.md §5.1): the CA attestation of a per-share admin
// key an account's sensitive key asked for, and the demo account's signer.
// AT-LNK-10: no stable account key is ever attested.
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_KEY_ATTESTATION_TTL_MS,
  deriveShareAdminKey,
  ed,
  parseAccountKeyAttestation,
  signShareKeyAttestationRequest,
  verifyCaSignedAccountKeyAttestation,
  verifyShareKeyAttestationRequest,
  type ShareKeyAttestationRequest,
} from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import { deriveDemoAdminRoot } from "../src/demoIdentity.js";
import { demoShareKeyAttestationRequest } from "../src/demoUsers.js";
import { handleShareKeyAttestation } from "../src/pubkeyCert.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

const kp = (fill: number) => {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const caKp = kp(0xca);
const ca = { keypair: caKp, issuer: "test-ca" };
const chain = { authorizedCaKeys: () => [bytesToHex(caKp.publicKey)] };
const irk = kp(0x11);
const admin = kp(0x22);
const NOW = 1_800_000_000_000;
const SHARE_KEY = bytesToHex(deriveShareAdminKey({ seed: new Uint8Array(32).fill(0x5b) }, "ab".repeat(16)).publicKey);

async function usernames() {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: "bob", irkPubHex: bytesToHex(irk.publicKey), adminRootPubHex: bytesToHex(admin.publicKey), claimedAt: 1 });
  await s.usernames.put({ username: "legacy", irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1 });
  return s;
}

function signed(username: string, key: { privateKey: Uint8Array; publicKey: Uint8Array }, over: Partial<ShareKeyAttestationRequest> = {}) {
  const request: ShareKeyAttestationRequest = { username, keyPubHex: SHARE_KEY, issuedAt: NOW, ...over };
  return { request, signature: bytesToHex(signShareKeyAttestationRequest(request, key)) };
}

describe("POST /api/users/:u/share-key-attestation", () => {
  it("attests the per-share key an admin root asked for, naming no account and no account key", async () => {
    const s = await usernames();
    const r = await handleShareKeyAttestation({ ca, usernames: s.usernames, now: () => NOW }, "Bob", signed("bob", admin));
    expect(r.status).toBe(200);
    const a = parseAccountKeyAttestation((r.body as { attestation: unknown }).attestation)!;
    expect(a).toMatchObject({ keyKind: "share", keyPubHex: SHARE_KEY, issuedAt: NOW, expiresAt: NOW + ACCOUNT_KEY_ATTESTATION_TTL_MS });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("bob");
    expect(text).not.toContain(bytesToHex(admin.publicKey));
    expect(text).not.toContain(bytesToHex(irk.publicKey));
    expect(verifyCaSignedAccountKeyAttestation(a, chain, NOW + 1)).toEqual({ ok: true });
    expect(r.headers?.["cache-control"]).toBe("private, no-store");
  });

  it("refuses the IRK of an account that pins an admin root (a non-admin device)", async () => {
    const s = await usernames();
    const r = await handleShareKeyAttestation({ ca, usernames: s.usernames, now: () => NOW }, "bob", signed("bob", irk));
    expect(r.status).toBe(403);
    expect((r.body as { code: string }).code).toBe("accept-not-admin");
  });

  it("takes the IRK of an account with no admin root (authorizeSensitiveComOp's rule)", async () => {
    const s = await usernames();
    const r = await handleShareKeyAttestation({ ca, usernames: s.usernames, now: () => NOW }, "legacy", signed("legacy", irk));
    expect(r.status).toBe(200);
    expect((r.body as { attestation: { keyKind: string; keyPubHex: string } }).attestation).toMatchObject({ keyKind: "share", keyPubHex: SHARE_KEY });
  });

  it("refuses a stranger's key, another account's request, a stale request and malformed bodies", async () => {
    const s = await usernames();
    const d = { ca, usernames: s.usernames, now: () => NOW };
    expect((await handleShareKeyAttestation(d, "bob", signed("bob", kp(0x33)))).status).toBe(403);
    expect((await handleShareKeyAttestation(d, "bob", signed("legacy", admin))).status).toBe(400);
    expect((await handleShareKeyAttestation(d, "bob", signed("bob", admin, { issuedAt: NOW - 10 * 60_000 }))).status).toBe(403);
    const ok = signed("bob", admin);
    expect((await handleShareKeyAttestation(d, "bob", { ...ok, request: { ...ok.request, keyPubHex: "AB".repeat(32) } })).status).toBe(400);
    expect((await handleShareKeyAttestation(d, "bob", { request: signed("bob", admin).request, signature: "ab" })).status).toBe(400);
    expect((await handleShareKeyAttestation(d, "bob", undefined)).status).toBe(400);
    expect((await handleShareKeyAttestation(d, "nobody", signed("nobody", admin))).status).toBe(404);
  });
});

describe("POST /api/dev/sample-user/:u/share-key-attestation", () => {
  const KEK = new Uint8Array(32).fill(9);
  const USER = "playstore-test-0725";
  const root = deriveDemoAdminRoot(KEK, USER);
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
    await s.usernames.put({ username: USER, irkPubHex: bytesToHex(irk.publicKey), adminRootPubHex: bytesToHex(root.publicKey), claimedAt: 1 });
    return s;
  }

  it("signs the demo account's request with its derived admin root, and .com attests the share key", async () => {
    const s = await demos();
    const r = await demoShareKeyAttestationRequest({ storage: s.demoUsers, demoIrkKek: KEK, now: () => NOW }, USER, { keyPubHex: SHARE_KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(verifyShareKeyAttestationRequest(r.request, hexToBytes(r.signature), root.publicKey)).toBe(true);
    const a = await handleShareKeyAttestation({ ca, usernames: s.usernames, now: () => NOW }, USER, { request: r.request, signature: r.signature });
    expect(a.status).toBe(200);
    expect((a.body as { attestation: { keyPubHex: string } }).attestation.keyPubHex).toBe(SHARE_KEY);
  });

  it("signs nothing for a real account or a malformed key", async () => {
    const s = await demos();
    const d = { storage: s.demoUsers, demoIrkKek: KEK };
    const bad = async (u: string, body: unknown) => {
      const r = await demoShareKeyAttestationRequest(d, u, body as never);
      return r.ok ? 200 : r.response.status;
    };
    expect(await bad("bob", { keyPubHex: SHARE_KEY })).toBe(404);
    expect(await bad(USER, { keyPubHex: "AB".repeat(32) })).toBe(400);
    expect(await bad(USER, { keyPubHex: "ab" })).toBe(400);
    expect(await bad(USER, undefined)).toBe(400);
  });
});
