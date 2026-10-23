/**
 * Architecture v2 milestone 2 on the box: the device book verifies and pins the account's ML-DSA
 * bindings, the box replays the owner's assurance policy chain itself (anti-rollback, fail
 * closed), and while strict is in force every sensitive order needs a hybrid signature by the
 * signer's bound key.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  assurancePolicyDigest,
  canonicalAssurancePolicyChange,
  canonicalPqKeyBinding,
  ed,
  hybridSigKeygen,
  hybridSign,
  legacyPolicyState,
  messagePurpose,
  signDeviceCapabilityGrant,
  type AssurancePolicyChange,
  type PqBindingRole,
} from "@flagship/protocol";
import { AccountDeviceBook } from "../src/accessPrincipals.js";
import { AssurancePolicySync } from "../src/assurancePolicySync.js";
import { authorizeSensitiveOrder } from "../src/adminAuthorityLocal.js";
import { setPqAuthority } from "../src/pqAuthority.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const T = 1_790_000_000_000;
const U = "alice";
const S = "home.alice.flagship.services";
const seed = (n: number) => new Uint8Array(32).fill(n);

function identity(edN: number, pqN: number) {
  const sk = Uint8Array.from([...seed(edN), ...seed(pqN)]);
  return {
    seed: seed(edN),
    pubBytes: ed.getPublicKey(seed(edN)),
    pub: hex(ed.getPublicKey(seed(edN))),
    mldsa: hex(hybridSigKeygen(seed(edN), seed(pqN)).publicKey.subarray(32)),
    edSign: (m: Uint8Array) => ed.sign(m, seed(edN)),
    hybrid: (m: Uint8Array) => hex(hybridSign(sk, messagePurpose(m), m)),
  };
}
const irk = identity(1, 101);
const admin = identity(2, 102);
const dev = identity(3, 103);
const DEVICE_ID = "d1".repeat(16);

function binding(id: ReturnType<typeof identity>, role: PqBindingRole, subjectId: string, mldsa = id.mldsa, issuedAt = T) {
  const st = { role, subjectId, ed25519PubHex: id.pub, mldsaPubHex: mldsa, issuedAt };
  return { v: 1 as const, ...st, signature: id.hybrid(canonicalPqKeyBinding(st)) };
}

function listedGrant(pqKeyBinding?: unknown) {
  const g = { grantId: "11111111-1111-4111-8111-111111111111", username: U, deviceId: DEVICE_ID, devicePubKey: dev.pubBytes, scopes: ["browse", "admin"] as ("browse" | "admin")[], issuedAt: T - 1000, expiresAt: T + 90 * 86_400_000 };
  const sig = signDeviceCapabilityGrant(g, { privateKey: admin.seed, publicKey: admin.pubBytes } as never);
  return { grantId: g.grantId, username: U, deviceId: DEVICE_ID, devicePubHex: dev.pub, scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt, signatureHex: hex(sig), signerRoot: "admin-root", ...(pqKeyBinding ? { pqKeyBinding } : {}) };
}

function makeBook(body: () => unknown, path = join(mkdtempSync(join(tmpdir(), "pqbook-")), "account-devices.json")) {
  return new AccountDeviceBook({
    path,
    username: U,
    ownerIrkPub: () => irk.pubBytes,
    adminRootPub: () => admin.pubBytes,
    fetchGrants: async () => body(),
    now: () => T,
    minRefreshMs: 0,
  });
}

afterEach(() => setPqAuthority(null));

describe("device book bindings", () => {
  it("verifies each binding under the key the box trusts and pins the first ML-DSA key", async () => {
    let served: unknown = { grants: [listedGrant(binding(dev, "device", DEVICE_ID))], pqKeyBindings: { accountIrk: binding(irk, "account-irk", U), adminRoot: binding(admin, "admin-root", U) } };
    const path = join(mkdtempSync(join(tmpdir(), "pqbook-")), "account-devices.json");
    const b = makeBook(() => served, path);
    await b.refresh();
    expect(b.pqBindingFor(dev.pub)?.mldsaPubHex).toBe(dev.mldsa);
    expect(b.pqBindingFor(irk.pub)?.role).toBe("account-irk");
    expect(b.pqBindingFor(admin.pub)?.role).toBe("admin-root");

    // `.com` later relays the same device with another ML-DSA key: ignored, the pin holds.
    const swapped = identity(3, 77);
    served = { grants: [listedGrant(binding(swapped, "device", DEVICE_ID, swapped.mldsa, T + 1))], pqKeyBindings: {} };
    await b.refresh();
    expect(b.pqBindingFor(dev.pub)).toBeNull();
    expect(b.pqBindingFor(irk.pub)).toBeNull();

    // A binding under another key, or relabelled for another device, never verifies.
    const other = identity(9, 109);
    served = { grants: [listedGrant(binding(other, "device", DEVICE_ID))], pqKeyBindings: { accountIrk: binding(other, "account-irk", U) } };
    await b.refresh();
    expect(b.pqBindingFor(dev.pub)).toBeNull();
    expect(b.pqBindingFor(other.pub)).toBeNull();

    // The pin survives a restart.
    const again = makeBook(() => ({ grants: [listedGrant(binding(swapped, "device", DEVICE_ID, swapped.mldsa, T + 1))] }), path);
    await again.load();
    await again.refresh();
    expect(again.pqBindingFor(dev.pub)).toBeNull();
  });
});

function change(over: Partial<AssurancePolicyChange> = {}): AssurancePolicyChange {
  return {
    account: U, scope: { kind: "installation", id: S }, prior: "compatibility", next: "strict", generation: 1, prevDigest: GENESIS_DIGEST,
    affectedPeersDigest: "aa".repeat(32), acknowledgedLoss: [], signerKind: "admin-device", signerKeyId: dev.pub, suite: "hybrid-ed25519-mldsa65/v1", issuedAt: T, ...over,
  };
}
const entry = (c: AssurancePolicyChange, by = dev) => ({
  change: c,
  signature: c.suite === "ed25519/v1" ? { suite: c.suite, signature: hex(by.edSign(canonicalAssurancePolicyChange(c))) } : { suite: c.suite, signature: by.hybrid(canonicalAssurancePolicyChange(c)) },
});

async function world(chain: () => unknown[], statePath = join(mkdtempSync(join(tmpdir(), "pqpol-")), "assurance-policy.json")) {
  const b = makeBook(() => ({ grants: [listedGrant(binding(dev, "device", DEVICE_ID))], pqKeyBindings: { adminRoot: binding(admin, "admin-root", U) } }));
  await b.refresh();
  const sync = new AssurancePolicySync({
    path: statePath,
    account: U,
    serverDomain: S,
    fetchChain: async () => ({ chain: chain(), evidence: { recoveryChecked: true } }),
    adminRootHex: () => admin.pub,
    isAdminDevice: (pub) => b.classify(pub)?.tier === "admin",
    bindingFor: (pub) => b.pqBindingFor(pub),
    ownEvidence: () => ({ stkBound: true, bootKeyHybrid: true }),
    now: () => T,
  });
  await sync.load();
  return { b, sync, statePath };
}

describe("the box replays the owner's chain", () => {
  const one = change();
  const back = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: assurancePolicyDigest(one), acknowledgedLoss: ["classical-signatures-accepted"], issuedAt: T + 5 });

  it("adopts a verified chain and refuses a shorter one later", async () => {
    let chain: unknown[] = [entry(one)];
    const w = await world(() => chain);
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", rollout: "enforced", generation: 1 });
    chain = [];
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", generation: 1 });
    chain = [entry(one), entry(back)];
    expect(await w.sync.refresh()).toMatchObject({ profile: "compatibility", generation: 2, enforcedEver: true });
    const restarted = await world(() => [], w.statePath);
    expect(restarted.sync.policy()).toMatchObject({ profile: "compatibility", generation: 2 });
  });

  it("stops at a change it cannot verify: a forged one, a classical strict signer, a non-admin", async () => {
    const forged = entry(one);
    forged.signature.signature = entry(change({ issuedAt: T + 1 })).signature.signature;
    expect((await (await world(() => [forged])).sync.refresh()).profile).toBe("compatibility");
    expect((await (await world(() => [entry(change({ suite: "ed25519/v1" }))])).sync.refresh()).profile).toBe("compatibility");
    expect((await (await world(() => [entry(change({ signerKeyId: irk.pub }), irk)])).sync.refresh()).profile).toBe("compatibility");
    expect((await (await world(() => [entry(change({ account: "bob" }))])).sync.refresh()).generation).toBe(0);
    // A valid prefix is still taken.
    const tail = entry(back);
    tail.signature.signature = entry(change({ issuedAt: T + 2 })).signature.signature;
    expect(await (await world(() => [entry(one), tail])).sync.refresh()).toMatchObject({ profile: "strict", generation: 1 });
  });

  it("reads an unreadable state file as strict until a verified chain arrives", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pqpol-")), "assurance-policy.json");
    writeFileSync(path, "{not json");
    const w = await world(() => [], path);
    expect(w.sync.policy()).toMatchObject({ profile: "strict", rollout: "enforced" });
    expect(await w.sync.refresh()).toEqual(legacyPolicyState({ kind: "installation", id: S }));
  });
});

describe("sensitive orders under strict", () => {
  const order = new TextEncoder().encode("flagship/server-self-delete/v1|alice|home|1");
  const verify = (o: Uint8Array, sig: Uint8Array, pub: Uint8Array) => ed.verify(sig, o, pub);
  const base = { order, verify, ownerIrkPub: irk.pubBytes, adminRootPub: admin.pubBytes, username: U, now: T };

  it("needs the signer's hybrid signature once the installation is strict", async () => {
    const w = await world(() => [entry(change())]);
    const ctx = { policy: () => w.sync.policy(), bindingFor: (p: string) => w.b.pqBindingFor(p) };
    const classical = { ...base, signature: admin.edSign(order), pq: ctx };
    expect(authorizeSensitiveOrder(classical)).toBe(true);
    await w.sync.refresh();
    expect(authorizeSensitiveOrder(classical)).toBe(false);
    setPqAuthority(ctx);
    expect(authorizeSensitiveOrder({ ...base, signature: admin.edSign(order) })).toBe(false);
    const hybrid = { message: order, envelope: { suite: "hybrid-ed25519-mldsa65/v1" as const, signature: admin.hybrid(order) } };
    expect(authorizeSensitiveOrder({ ...base, signature: admin.edSign(order), hybrid })).toBe(true);
    // Another key's hybrid signature does not stand in for the signer's.
    expect(authorizeSensitiveOrder({ ...base, signature: admin.edSign(order), hybrid: { ...hybrid, envelope: { ...hybrid.envelope, signature: dev.hybrid(order) } } })).toBe(false);
  });
});
