/**
 * Architecture v2 milestone 2 on `.com`: the phone-held identities' key bindings (account IRK,
 * admin root, device), their place in the device-grant book, and the owner-signed assurance
 * policy chain, including the test-only strict path that proves enforcement end to end: once the
 * owner's hybrid-signed change turns an installation strict, the box's classical-only
 * daemon-status report is refused.
 */
import { describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  assurancePolicyDigest,
  bootKeyBindingToWire,
  canonicalAssurancePolicyChange,
  canonicalDaemonStatusReport,
  canonicalPqKeyBinding,
  ed,
  hybridSigKeygen,
  hybridSign,
  messagePurpose,
  signBootKeyBinding,
  signBootKeyBindingV2,
  signDaemonStatusReport,
  signDeviceCapabilityGrant,
  type AssurancePolicyChange,
  type DaemonStatusReport,
  type PqBindingRole,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetAccountPqKeyBindings,
  handleGetAssurancePolicy,
  handlePostAssurancePolicyChange,
  handlePutAccountPqKeyBinding,
} from "../src/accountPqTrust.js";
import { handleListAccountDeviceGrants } from "../src/deviceCapabilityGrants.js";
import { handlePutBootKey } from "../src/bootKeys.js";
import { handlePutPqKeyBinding } from "../src/pqKeyBindings.js";
import { handlePostDaemonStatus } from "../src/podInventory.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const T = 1_790_000_000_000;
const U = "alice";
const S = "home.alice.flagship.services";
const seed = (n: number) => new Uint8Array(32).fill(n);

/** An Ed25519 identity with its own ML-DSA seed. */
function identity(edN: number, pqN: number) {
  const pub = hex(ed.getPublicKey(seed(edN)));
  const sk = Uint8Array.from([...seed(edN), ...seed(pqN)]);
  return {
    pub,
    mldsa: hex(hybridSigKeygen(seed(edN), seed(pqN)).publicKey.subarray(32)),
    edSign: (m: Uint8Array) => ed.sign(m, seed(edN)),
    hybrid: (m: Uint8Array) => hex(hybridSign(sk, messagePurpose(m), m)),
  };
}
const irk = identity(1, 101);
const admin = identity(2, 102);
const dev = identity(3, 103);
const stk = identity(4, 104);
const DEVICE_ID = "d1".repeat(16);

function binding(id: ReturnType<typeof identity>, role: PqBindingRole, subjectId: string, issuedAt = T, mldsa = id.mldsa) {
  const st = { role, subjectId, ed25519PubHex: id.pub, mldsaPubHex: mldsa, issuedAt };
  return { v: 1 as const, ...st, signature: id.hybrid(canonicalPqKeyBinding(st)) };
}

async function world() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: U, irkPubHex: irk.pub, claimedAt: T, adminRootPubHex: admin.pub });
  await storage.deviceIdentities.put({ accountId: U, deviceId: DEVICE_ID, devicePubHex: dev.pub, platformClass: "ios", createdAt: T, lastSeenAt: T, revokedAt: null });
  const grant = { grantId: "11111111-1111-4111-8111-111111111111", username: U, deviceId: DEVICE_ID, devicePubKey: ed.getPublicKey(seed(3)), scopes: ["browse", "admin"] as const, issuedAt: T - 1000, expiresAt: T + 90 * 86_400_000 };
  const g = { ...grant, scopes: [...grant.scopes] };
  const sig = signDeviceCapabilityGrant(g, { privateKey: seed(2), publicKey: ed.getPublicKey(seed(2)) } as never);
  await storage.deviceCapabilityGrants.put({ grantId: g.grantId, username: U, deviceId: DEVICE_ID, devicePubHex: dev.pub, scopesJson: JSON.stringify(g.scopes), issuedAt: g.issuedAt, expiresAt: g.expiresAt, signatureHex: hex(sig), revokedAt: null, signerRoot: "admin-root" });
  await storage.servers.put({ serverDomain: S, username: U, identityPubKeyHex: stk.pub, registeredAt: T });
  const now = () => T;
  const deps = { usernames: storage.usernames, identities: storage.deviceIdentities, grants: storage.deviceCapabilityGrants, servers: storage.servers, pqTrust: storage.pqTrust, recovery: storage.webauthnRecovery, now };
  return { storage, deps, now };
}

describe("account identity bindings", () => {
  it("stores each identity's binding only under the key .com already trusts for it", async () => {
    const w = await world();
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(irk, "account-irk", U))).status).toBe(200);
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(admin, "admin-root", U))).status).toBe(200);
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(dev, "device", DEVICE_ID))).status).toBe(200);
    // Another key under a trusted identity, an unknown device, the box role, another account.
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(dev, "account-irk", U))).body).toEqual({ error: "binding-key-mismatch" });
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(dev, "device", "e2".repeat(16)))).status).toBe(404);
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(stk, "box-stk", S))).status).toBe(403);
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(irk, "account-irk", "bob"))).status).toBe(403);
    expect((await handlePutAccountPqKeyBinding(w.deps, U, { junk: true })).status).toBe(400);
  });

  it("keeps the first ML-DSA key per Ed25519 key, so a recovered root cannot rebind", async () => {
    const w = await world();
    await handlePutAccountPqKeyBinding(w.deps, U, binding(irk, "account-irk", U));
    const other = identity(1, 99);
    expect(await handlePutAccountPqKeyBinding(w.deps, U, binding(other, "account-irk", U, T + 1))).toEqual({ status: 409, body: { error: "pq-key-changed" } });
    expect(await handlePutAccountPqKeyBinding(w.deps, U, binding(irk, "account-irk", U))).toEqual({ status: 409, body: { error: "stale" } });
  });

  it("accepts a re-paired IRK's binding only once the re-pair has swapped the IRK", async () => {
    const w = await world();
    await handlePutAccountPqKeyBinding(w.deps, U, binding(irk, "account-irk", U));
    const next = identity(5, 105);
    // Pending re-pair: the account's current IRK is still the old one.
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(next, "account-irk", U, T + 5))).body).toEqual({ error: "binding-key-mismatch" });
    expect(await w.storage.usernames.swapIrkPub(U, irk.pub, next.pub, T)).toBe(true);
    const before = (await handleGetAccountPqKeyBindings(w.deps, U)).body as { accountIrk: unknown };
    expect(before.accountIrk).toBeNull();
    expect((await handlePutAccountPqKeyBinding(w.deps, U, binding(next, "account-irk", U, T + 5))).status).toBe(200);
  });

  it("serves current bindings, and puts them in the device-grant book", async () => {
    const w = await world();
    const [bi, ba, bd] = [binding(irk, "account-irk", U), binding(admin, "admin-root", U), binding(dev, "device", DEVICE_ID)];
    for (const b of [bi, ba, bd]) await handlePutAccountPqKeyBinding(w.deps, U, b);
    const got = (await handleGetAccountPqKeyBindings(w.deps, U)).body as Record<string, unknown>;
    expect(got).toEqual({ username: U, accountIrk: bi, adminRoot: ba, devices: [bd] });
    const book = (await handleListAccountDeviceGrants({ storage: w.storage.deviceCapabilityGrants, identities: w.storage.deviceIdentities, usernames: w.storage.usernames, pqTrust: w.storage.pqTrust }, U)).body as {
      grants: Array<Record<string, unknown>>;
      pqKeyBindings: Record<string, unknown>;
    };
    expect(book.grants[0]!.pqKeyBinding).toEqual(bd);
    expect(book.pqKeyBindings).toEqual({ accountIrk: bi, adminRoot: ba });
    await w.storage.deviceIdentities.revoke(U, DEVICE_ID, T);
    expect(((await handleGetAccountPqKeyBindings(w.deps, U)).body as { devices: unknown[] }).devices).toEqual([]);
  });
});

function change(over: Partial<AssurancePolicyChange> = {}): AssurancePolicyChange {
  return {
    account: U,
    scope: { kind: "installation", id: S },
    prior: "compatibility",
    next: "strict",
    generation: 1,
    prevDigest: GENESIS_DIGEST,
    affectedPeersDigest: "aa".repeat(32),
    acknowledgedLoss: [],
    signerKind: "admin-device",
    signerKeyId: dev.pub,
    suite: "hybrid-ed25519-mldsa65/v1",
    issuedAt: T,
    ...over,
  };
}
const signed = (c: AssurancePolicyChange, by = dev) => ({
  change: c,
  signature:
    c.suite === "ed25519/v1"
      ? { suite: c.suite, signature: hex(by.edSign(canonicalAssurancePolicyChange(c))) }
      : { suite: c.suite, signature: by.hybrid(canonicalAssurancePolicyChange(c)) },
});

/** The box's binding, boot-key hybrid, the admin device's binding and a signed recovery record. */
async function prepare(w: Awaited<ReturnType<typeof world>>) {
  const pq = { servers: w.storage.servers, pqTrust: w.storage.pqTrust, now: w.now };
  expect((await handlePutPqKeyBinding(pq, S, binding(stk, "box-stk", S))).status).toBe(200);
  const b = { serverDomain: S, bootPubHex: hex(ed.getPublicKey(seed(9))), issuedAt: T };
  const boot = bootKeyBindingToWire(b, signBootKeyBinding(b, stk.edSign), signBootKeyBindingV2(b, (m) => Buffer.from(stk.hybrid(m), "hex")));
  expect((await handlePutBootKey({ servers: w.storage.servers, serverBootKeys: w.storage.serverBootKeys, pqTrust: w.storage.pqTrust, now: w.now }, S, boot)).status).toBe(200);
  await handlePutAccountPqKeyBinding(w.deps, U, binding(dev, "device", DEVICE_ID));
  await w.storage.webauthnRecovery.upsert({
    username: U, credentialIdHex: "ab", wrappedUmkB64: "x", irkPubHex: irk.pub, createdAt: T, updatedAt: T,
    signed: { digestHex: "cd".repeat(32), generation: 1, signedClaimJson: "{}", signatureHex: "ef".repeat(64) },
  } as never);
}

describe("owner-signed assurance policy", () => {
  it("refuses strict before the scope is prepared, or from a classical signer", async () => {
    const w = await world();
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change()))).body).toEqual({ error: "no-binding" });
    await prepare(w);
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ suite: "ed25519/v1" })))).body).toEqual({ error: "classical-signer-refused" });
    await w.storage.webauthnRecovery.upsert({ username: U, credentialIdHex: "ab", wrappedUmkB64: "x", irkPubHex: irk.pub, createdAt: T, updatedAt: T } as never);
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change()))).body).toEqual({ error: "not-prepared" });
  });

  it("refuses signers that are not the owner's admin authority", async () => {
    const w = await world();
    await prepare(w);
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ signerKind: "box", signerKeyId: stk.pub }), stk))).body).toEqual({ error: "not-owner-authority" });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ signerKind: "admin-device", signerKeyId: irk.pub }), irk))).body).toEqual({ error: "signer-not-active" });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ account: "bob" })))).status).toBe(403);
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ scope: { kind: "installation", id: "x.bob.flagship.services" } })))).status).toBe(403);
    const forged = signed(change());
    forged.signature.signature = signed(change({ issuedAt: T + 1 })).signature.signature;
    expect((await handlePostAssurancePolicyChange(w.deps, U, forged)).body).toEqual({ error: "bad-signature" });
  });

  it("chains changes, refuses forks and stale generations, and enforces strict on the box's reports", async () => {
    const w = await world();
    await prepare(w);
    const one = change();
    const r1 = await handlePostAssurancePolicyChange(w.deps, U, signed(one));
    expect(r1.status).toBe(200);
    expect((r1.body as { state: { profile: string; rollout: string } }).state).toMatchObject({ profile: "strict", rollout: "enforced", generation: 1 });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(one))).body).toEqual({ error: "stale-generation" });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ issuedAt: T + 7 })))).body).toEqual({ error: "fork" });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(change({ generation: 3, prevDigest: assurancePolicyDigest(one) })))).body).toEqual({ error: "stale-generation" });

    // The box's classical-only report is now refused; its hybrid one passes.
    const report: DaemonStatusReport = { serverDomain: S, certSha256: null, certValidUntil: null, certIssuer: null, appsServed: [], nonce: "ab", issuedAt: T };
    const status = { daemonStatus: w.storage.daemonStatus, servers: w.storage.servers, routing: w.storage.routing, pqTrust: w.storage.pqTrust, now: w.now };
    const classical = hex(signDaemonStatusReport(report, stk.edSign));
    expect((await handlePostDaemonStatus(status, { request: { ...report }, signature: classical })).body).toMatchObject({ error: "signature refused: strict-requires-hybrid" });
    const pqSignature = { suite: "hybrid-ed25519-mldsa65/v1", signature: stk.hybrid(canonicalDaemonStatusReport(report)) };
    expect((await handlePostDaemonStatus(status, { request: { ...report }, signature: classical, pqSignature })).status).toBe(200);

    // Leaving strict needs a strict signer and the acknowledged loss.
    const back = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: assurancePolicyDigest(one), acknowledgedLoss: ["classical-signatures-accepted"], issuedAt: T + 10 });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed({ ...back, suite: "ed25519/v1" }))).body).toEqual({ error: "strict-requires-hybrid" });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed({ ...back, acknowledgedLoss: [] }))).body).toEqual({ error: "loss-not-acknowledged" });
    expect((await handlePostAssurancePolicyChange(w.deps, U, signed(back))).status).toBe(200);

    const got = (await handleGetAssurancePolicy(w.deps, U, "installation", S)).body as { state: { profile: string; generation: number }; chain: Array<{ change: unknown; signature: { suite: string } }>; evidence: unknown };
    expect(got.state).toMatchObject({ profile: "compatibility", generation: 2 });
    expect(got.chain.map((c) => c.change)).toEqual([one, back]);
    expect(got.chain.map((c) => c.signature.suite)).toEqual(["hybrid-ed25519-mldsa65/v1", "hybrid-ed25519-mldsa65/v1"]);
    expect(got.evidence).toEqual({ recoveryChecked: true });
    expect((await handlePostDaemonStatus(status, { request: { ...report, nonce: "cd" }, signature: hex(signDaemonStatusReport({ ...report, nonce: "cd" }, stk.edSign)) })).status).toBe(200);
  });
});
