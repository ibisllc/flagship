/**
 * Quantum-safe stage 1 on the box (docs/architecture-v2/pq-suites.md §20): under strict, the box
 * re-pins its admin root only on a hop the old root's PQ half signed (and pins the ML-DSA key that
 * hop named), and counts a device only when its grant carries the signing root's hybrid companion.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalPqKeyBinding,
  hybridSign,
  hybridSigKeygen,
  legacyPolicyState,
  signAdminRootRotation,
  signAdminRootRotationPq,
  signDeviceCapabilityGrant,
  signDeviceGrantPq,
  verifyPqKeyBinding,
  type AdminRootRotation,
  type DeviceCapabilityGrant,
  type PolicyState,
  type PqKeyBindingWire,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import { AccountDeviceBook } from "../src/accessPrincipals.js";
import { applyRotationChain, type RotationChainEntry, type RotationPq } from "../src/adminRootRotationConsumer.js";

const USER = "alice";
const NOW = Date.now();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function hybridKey(n: number) {
  const edSeed = new Uint8Array(32).fill(n);
  const mlSeed = new Uint8Array(32).fill(n + 100);
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, mlSeed);
  return { edSeed, publicKey: publicKey.subarray(0, 32), mldsaHex: hex(publicKey.subarray(32)), secret: secretKey };
}
type HK = ReturnType<typeof hybridKey>;

function binding(k: HK, role: "admin-root" | "account-irk", subjectId = USER): PqKeyBindingWire {
  const st = { role, subjectId, ed25519PubHex: hex(k.publicKey), mldsaPubHex: k.mldsaHex, issuedAt: NOW - 1000 };
  return { v: 1, ...st, signature: hex(hybridSign(k.secret, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
}
const verified = (w: PqKeyBindingWire): VerifiedPqKeyBinding =>
  verifyPqKeyBinding(w, { role: w.role, subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex, now: NOW });

const strict: PolicyState = { ...legacyPolicyState({ kind: "installation", id: "home.alice.flagship.services" }), profile: "strict", rollout: "enforced" };
const compat = legacyPolicyState({ kind: "installation", id: "home.alice.flagship.services" });

function hop(seq: number, from: HK, to: HK, withPq: boolean, pqSigner: HK = from): RotationChainEntry {
  const r: AdminRootRotation = { username: USER, oldAdminRootPub: from.publicKey, newAdminRootPub: to.publicKey, issuedAt: NOW - 500 + seq };
  return {
    seq,
    oldAdminRootPub: hex(from.publicKey),
    newAdminRootPub: hex(to.publicKey),
    issuedAt: r.issuedAt,
    signatureHex: hex(signAdminRootRotation(r, { privateKey: from.edSeed, publicKey: from.publicKey })),
    ...(withPq ? { pq: signAdminRootRotationPq(r, pqSigner.secret, binding(to, "admin-root")) } : {}),
  };
}

describe("hybrid admin-root rotation on the box", () => {
  const a = hybridKey(1);
  const b = hybridKey(2);
  const c = hybridKey(3);
  const pqWith = (policy: PolicyState): RotationPq => ({
    policy,
    bindingFor: (pub) => (pub === hex(a.publicKey) ? verified(binding(a, "admin-root")) : null),
    now: NOW,
  });

  it("strict: a classical-only hop re-pins nothing", () => {
    const r = applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, false)], pq: pqWith(strict) });
    expect(r.applied).toBe(0);
    expect(r.stoppedEarly).toBe(true);
    expect(r.pinnedHex).toBe(hex(a.publicKey));
  });

  it("strict: hybrid hops re-pin and the last one's binding is what gets pinned", () => {
    const r = applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, true), hop(2, b, c, true)], pq: pqWith(strict) });
    expect(r.applied).toBe(2);
    expect(r.pinnedHex).toBe(hex(c.publicKey));
    expect(r.pqBinding?.mldsaPubHex).toBe(c.mldsaHex);
  });

  it("strict: a companion signed by anyone but the old root stops the replay", () => {
    const r = applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, true, b)], pq: pqWith(strict) });
    expect(r.applied).toBe(0);
    expect(r.stoppedEarly).toBe(true);
  });

  it("strict: no binding for the pinned root means no re-pin", () => {
    const r = applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, true)], pq: { ...pqWith(strict), bindingFor: () => null } });
    expect(r.applied).toBe(0);
  });

  it("compatibility: a companion the box holds no old-root binding for counts as absent; strict stops", () => {
    const none = { ...pqWith(compat), bindingFor: () => null };
    const r = applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, true)], pq: none });
    expect(r.applied).toBe(1);
    expect(r.pqBinding).toBeUndefined();
  });

  it("compatibility: a classical hop still re-pins, and an offered companion must verify", () => {
    expect(applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, false)], pq: pqWith(compat) }).applied).toBe(1);
    expect(applyRotationChain({ pinnedHex: hex(a.publicKey), username: USER, chain: [hop(1, a, b, true, c)], pq: pqWith(compat) }).applied).toBe(0);
  });
});

describe("hybrid device grants in the device book", () => {
  const root = hybridKey(10);
  const irk = hybridKey(11);
  const devKey = hybridKey(12);
  const other = hybridKey(13);
  const g: DeviceCapabilityGrant = {
    grantId: "0123456789abcdef0123456789abcdef",
    username: USER,
    deviceId: "fedcba9876543210fedcba9876543210",
    devicePubKey: devKey.publicKey,
    scopes: ["admin", "browse"],
    issuedAt: NOW - 10,
    expiresAt: NOW + 3_600_000,
  };
  const listed = (pqSignature?: unknown) => ({
    grantId: g.grantId,
    username: USER,
    deviceId: g.deviceId,
    devicePubHex: hex(devKey.publicKey),
    scopes: g.scopes,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(g, { privateKey: root.edSeed, publicKey: root.publicKey })),
    signerRoot: "admin-root",
    ...(pqSignature ? { pqSignature } : {}),
  });

  async function book(pqSignature: unknown, policy: { current: PolicyState }, rootBinding: PqKeyBindingWire | null = binding(root, "admin-root")) {
    const bk = new AccountDeviceBook({
      path: join(mkdtempSync(join(tmpdir(), "pqgrant-")), "account-devices.json"),
      username: USER,
      ownerIrkPub: () => irk.publicKey,
      adminRootPub: () => root.publicKey,
      policy: () => policy.current,
      now: () => NOW,
      fetchGrants: async () => ({ grants: [listed(pqSignature)], pqKeyBindings: rootBinding ? { adminRoot: rootBinding } : {} }),
    });
    await bk.refresh();
    return bk;
  }

  it("strict hides a device whose grant is classical only; compatibility still counts it", async () => {
    const policy = { current: compat };
    const bk = await book(undefined, policy);
    expect(bk.classify(hex(devKey.publicKey))?.tier).toBe("admin");
    policy.current = strict;
    expect(bk.classify(hex(devKey.publicKey))).toBeNull();
    expect(bk.adminGrants()).toHaveLength(0);
    expect(bk.devices()).toHaveLength(0);
  });

  it("strict counts a device whose grant carries the admin root's hybrid companion", async () => {
    const bk = await book(signDeviceGrantPq(g, root.secret), { current: strict });
    expect(bk.classify(hex(devKey.publicKey))?.tier).toBe("admin");
    expect(bk.adminGrants()).toHaveLength(1);
  });

  it("a companion by another key drops the device even outside strict", async () => {
    const bk = await book(signDeviceGrantPq(g, other.secret), { current: compat });
    expect(bk.classify(hex(devKey.publicKey))).toBeNull();
  });

  it("strict: a companion the box can't check yet (no root binding) does not count", async () => {
    const policy = { current: compat };
    const bk = await book(signDeviceGrantPq(g, root.secret), policy, null);
    expect(bk.classify(hex(devKey.publicKey))?.tier).toBe("admin");
    policy.current = strict;
    expect(bk.classify(hex(devKey.publicKey))).toBeNull();
  });

  it("the root binding a hybrid rotation named wins over the one `.com` relays", async () => {
    const bk = new AccountDeviceBook({
      path: join(mkdtempSync(join(tmpdir(), "pqgrant-")), "account-devices.json"),
      username: USER,
      ownerIrkPub: () => irk.publicKey,
      adminRootPub: () => root.publicKey,
      policy: () => strict,
      now: () => NOW,
      adminRootPqBinding: () => binding(root, "admin-root"),
      fetchGrants: async () => ({ grants: [], pqKeyBindings: { adminRoot: { ...binding(root, "admin-root"), mldsaPubHex: other.mldsaHex } } }),
    });
    await bk.refresh();
    expect(bk.pqBindingFor(hex(root.publicKey))?.mldsaPubHex).toBe(root.mldsaHex);
  });
});
