/**
 * V01 adversarial suite: downgrade attempts against the strict (quantum-resistant) profile, the PQ
 * companions that become mandatory once a pin is filled, and boot unlock v1 vs v2. Attacker models: a
 * network or `.com` adversary that strips, relabels or replays suites; a compromised box/app/relay asking
 * for a weaker profile; a revoked device; a forged binding; a malicious boot worker editing a lease.
 *
 *   AT-DWN-01  strict scope, valid classical-only signature            -> refused (strict-requires-hybrid)
 *   AT-DWN-02  hybrid signature with one half zeroed                   -> refused (bad-signature), both profiles
 *   AT-DWN-03  hybrid bytes relabelled ed25519/v1, suite stripped     -> refused; strict needs the bound key
 *   AT-DWN-04  binding look-alike / other key's binding / no binding   -> refused (no-binding / binding-key-mismatch)
 *   AT-DWN-05  signature lifted to another purpose                     -> refused (purpose-mismatch)
 *   AT-DWN-06  box/app/relay/cloud/legacy client asks for compat       -> refused (not-owner-authority)
 *   AT-DWN-07  opt-out signed classically under strict / no loss ack   -> refused
 *   AT-DWN-08  opt-out by a revoked device                             -> refused (signer-not-active)
 *   AT-DWN-09  replayed / skipped / forked policy generation           -> refused
 *   AT-DWN-10  stored state replay, rollout backwards, evidence-only enforcement -> refused
 *   AT-DWN-11  suite negotiation stripped of the hybrid offer          -> refused (upgrade-required)
 *   AT-DWN-12  back to strict after enforcement without re-entry       -> refused (reentry-incomplete)
 *   AT-DWN-13  `.com` serves a truncated chain / classical opt-out     -> box keeps strict
 *   AT-DWN-14  damaged box policy file + `.com` serves an empty chain  -> box stays strict (second copy / non-empty chain)
 *   AT-DWN-15  device that enabled strict is later revoked             -> replay continues from the held head; admin root adopted
 *   AT-DWN-16  stale export authorization (older policy generation)    -> refused
 *   AT-DWN-17  release endorsements once the PQ pin is filled          -> only companion-backed ones eligible; lineage not offered
 *   AT-DWN-18  CA lease edited after the cut-over loses legacy status  -> refused (pq-missing)
 *   AT-DWN-19  box artifact not on the legacy list, PQ halves stripped -> refused (pq-signature-required)
 *   AT-DWN-20  security notice once pinned: classical-only / unpinned  -> refused; store kept
 *   AT-DWN-21  strict box offered a classical v1 reply or lease        -> refused (strict-refuses-v1)
 *   AT-DWN-22  reply sealed by a stranger to the box's PUBLIC reply key -> refused (owner-signature)
 *   AT-DWN-23  reply bound to another nonce / server / boot (replay)   -> refused
 *   AT-DWN-24  boot worker edits a v3 lease (expiry, cap, id); expired  -> refused
 *   AT-DWN-25  phone under strict with no box v2 material / no PQ key  -> phone refuses, never falls back to v1
 *   AT-DWN-26  unlock policy file: garbage content / absent            -> strict / compat (known /boot limitation)
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  PolicyError,
  adoptStoredState,
  advanceRollout,
  applyPolicyChange,
  assurancePolicyDigest,
  canonicalAssurancePolicyChange,
  classicalExchangeAllowed,
  legacyPolicyState,
  selectSignatureSuite,
  type AssurancePolicyChange,
  type PolicySignerKind,
  type PolicyState,
} from "../../../packages/protocol/src/assurancePolicy.js";
import { hybridSigKeygen, hybridSign } from "../../../packages/protocol/src/pqHybrid.js";
import {
  PqTrustError,
  canonicalPqKeyBinding,
  messagePurpose,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  type PqBindingRole,
  type VerifiedPqKeyBinding,
} from "../../../packages/protocol/src/pqTrust.js";
import { ed } from "../../../packages/protocol/src/edSync.js";
import { classifyReleaseEndorsements, type ReleasePqPin } from "../../../packages/protocol/src/releaseEndorsementPq.js";
import { gateCaLeasesPq, type CaLeasePqPin } from "../../../packages/protocol/src/caLeasePq.js";
import { verifyBoxArtifact } from "../../../packages/protocol/src/boxArtifact.js";
import { acceptSecurityNotice, parseSecurityNotice, verifySecurityNotice } from "../../../packages/protocol/src/securityNotice.js";
import {
  BootUnlockV2Error,
  boxAcceptsVersion,
  buildBootReplyV2,
  chooseLeaseVersion,
  chooseReplyVersion,
  openBootReplyV2,
  openLeaseV3,
  parseUnlockPolicy,
  sealLeaseV3,
} from "../../../packages/protocol/src/bootUnlockV2.js";
import { AssurancePolicySync } from "../../../packages/server-daemon/src/assurancePolicySync.js";
// The daemon imports the BUILT package; a verified binding is only recognised by the module instance that made it.
import { verifyPqKeyBinding as pkgVerifyPqKeyBinding } from "@flagship/protocol";

const VEC = resolve(import.meta.dirname, "../../../packages/protocol/test-vectors");
const load = (p: string) => JSON.parse(readFileSync(join(VEC, p), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const T = 1_790_000_000_000;
const U = "alice";
const S = "home.alice.flagship.services";
const seed = (n: number) => new Uint8Array(32).fill(n);

function identity(edN: number, pqN: number) {
  const sk = Uint8Array.from([...seed(edN), ...seed(pqN)]);
  const kp = hybridSigKeygen(seed(edN), seed(pqN));
  return {
    pub: hex(ed.getPublicKey(seed(edN))),
    mldsa: hex(kp.publicKey.subarray(32)),
    edSign: (m: Uint8Array) => ed.sign(m, seed(edN)),
    hybridBytes: (m: Uint8Array) => hybridSign(sk, messagePurpose(m), m),
    hybrid: (m: Uint8Array) => hex(hybridSign(sk, messagePurpose(m), m)),
  };
}
type Id = ReturnType<typeof identity>;
const admin = identity(2, 102);
const dev = identity(3, 103);
const stranger = identity(9, 109);

function verifiedBinding(id: Id, role: PqBindingRole, subjectId: string, verify = verifyPqKeyBinding): VerifiedPqKeyBinding {
  const st = { role, subjectId, ed25519PubHex: id.pub, mldsaPubHex: id.mldsa, issuedAt: T };
  const wire = { v: 1 as const, ...st, signature: id.hybrid(canonicalPqKeyBinding(st)) };
  return verify(wire, { role, subjectId, ed25519PubHex: id.pub, now: T }) as VerifiedPqKeyBinding;
}
const bindings = new Map<string, VerifiedPqKeyBinding>([
  [admin.pub, verifiedBinding(admin, "admin-root", U)],
  [dev.pub, verifiedBinding(dev, "device", "dev_1")],
  [stranger.pub, verifiedBinding(stranger, "device", "dev_x")],
]);
const boxBindings = new Map<string, VerifiedPqKeyBinding>([
  [admin.pub, verifiedBinding(admin, "admin-root", U, pkgVerifyPqKeyBinding as typeof verifyPqKeyBinding)],
  [dev.pub, verifiedBinding(dev, "device", "dev_1", pkgVerifyPqKeyBinding as typeof verifyPqKeyBinding)],
]);

const scope = { kind: "installation" as const, id: S };
const legacy = legacyPolicyState(scope);
const enforced: PolicyState = { scope, profile: "strict", rollout: "enforced", generation: 1, headDigest: "11".repeat(32), enforcedEver: true };
const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof PqTrustError || e instanceof PolicyError || e instanceof BootUnlockV2Error) return e.code;
    throw e;
  }
};

const MSG = new TextEncoder().encode("flagship/server-self-delete/v1|alice|home|1");
const gate = (over: { envelope: { suite: "ed25519/v1" | "hybrid-ed25519-mldsa65/v1"; signature: string }; binding?: VerifiedPqKeyBinding | null; policy?: PolicyState; signer?: string; purpose?: string; message?: Uint8Array }) =>
  verifyCriticalSignature({
    message: over.message ?? MSG,
    expectedPurpose: over.purpose ?? "flagship/server-self-delete/v1",
    envelope: over.envelope,
    signerEd25519PubHex: over.signer ?? admin.pub,
    binding: over.binding === undefined ? bindings.get(admin.pub)! : over.binding,
    policy: over.policy ?? enforced,
  });

function change(over: Partial<AssurancePolicyChange> = {}): AssurancePolicyChange {
  return {
    account: U, scope, prior: "compatibility", next: "strict", generation: 1, prevDigest: GENESIS_DIGEST,
    affectedPeersDigest: "aa".repeat(32), acknowledgedLoss: [], signerKind: "admin-device", signerKeyId: dev.pub,
    suite: "hybrid-ed25519-mldsa65/v1", issuedAt: T, ...over,
  };
}
const entry = (c: AssurancePolicyChange, by: Id = dev) => ({
  change: c,
  signature: c.suite === "ed25519/v1" ? { suite: c.suite, signature: hex(by.edSign(canonicalAssurancePolicyChange(c))) } : { suite: c.suite, signature: by.hybrid(canonicalAssurancePolicyChange(c)) },
});
const okCheck = () => ({ suiteVerified: true, signerActive: true });

async function boxWorld(chain: () => unknown[], o: { statePath?: string; activeDevices?: Set<string> } = {}) {
  const statePath = o.statePath ?? join(mkdtempSync(join(tmpdir(), "at-dwn-")), "assurance-policy.json");
  const active = o.activeDevices ?? new Set([dev.pub]);
  const sync = new AssurancePolicySync({
    path: statePath, account: U, serverDomain: S,
    fetchChain: async () => ({ chain: chain(), evidence: { recoveryChecked: true } }),
    adminRootHex: () => admin.pub,
    isAdminDevice: (pub) => active.has(pub),
    bindingFor: (pub) => boxBindings.get(pub) ?? null,
    ownEvidence: () => ({ stkBound: true, bootKeyHybrid: true }),
    now: () => T,
    log: (m) => { if (process.env.AT_DEBUG) console.log(m); },
  });
  await sync.load();
  return { sync, statePath, active };
}

describe("V01 strict-mode signature gate (AT-DWN-01..05)", () => {
  it("AT-DWN-01 boundary: verifyCriticalSignature under strict. A valid classical-only signature by the right key is refused (catches: strict enforced by the envelope instead of the policy)", () => {
    const sig = hex(admin.edSign(MSG));
    expect(code(() => gate({ envelope: { suite: "ed25519/v1", signature: sig }, policy: legacy }))).toBe("ok");
    expect(code(() => gate({ envelope: { suite: "ed25519/v1", signature: sig } }))).toBe("strict-requires-hybrid");
  });

  it("AT-DWN-02 boundary: hybrid AND, not OR. Zeroing either half of a hybrid signature is refused in every profile (catches: verifier accepting one component)", () => {
    const full = admin.hybridBytes(MSG);
    expect(code(() => gate({ envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(full) } }))).toBe("ok");
    const edZero = Uint8Array.from(full);
    edZero.fill(0, 0, 64);
    const pqZero = Uint8Array.from(full);
    pqZero.fill(0, 64);
    for (const p of [enforced, legacy]) {
      expect(code(() => gate({ envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(edZero) }, policy: p }))).toBe("bad-signature");
      expect(code(() => gate({ envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(pqZero) }, policy: p }))).toBe("bad-signature");
    }
  });

  it("AT-DWN-03 boundary: suite relabelling. Hybrid bytes or their Ed25519 half relabelled as ed25519/v1 never pass, and strict refuses the label itself (catches: suite taken from the envelope as authority)", () => {
    const full = admin.hybridBytes(MSG);
    expect(code(() => gate({ envelope: { suite: "ed25519/v1", signature: hex(full) }, policy: legacy }))).toBe("bad-signature");
    expect(code(() => gate({ envelope: { suite: "ed25519/v1", signature: hex(full.subarray(0, 64)) }, policy: legacy }))).toBe("bad-signature");
    expect(code(() => gate({ envelope: { suite: "ed25519/v1", signature: hex(full.subarray(0, 64)) } }))).toBe("strict-requires-hybrid");
    expect(code(() => gate({ envelope: { suite: "ed25519-mldsa65/v0" as never, signature: hex(full) } }))).toBe("unknown-suite");
  });

  it("AT-DWN-04 boundary: key binding. A look-alike binding object, another identity's binding, or none at all is refused under strict (catches: binding forged in memory / key substitution)", () => {
    const env = { suite: "hybrid-ed25519-mldsa65/v1" as const, signature: admin.hybrid(MSG) };
    expect(code(() => gate({ envelope: env, binding: { ...bindings.get(admin.pub)! } }))).toBe("no-binding");
    expect(code(() => gate({ envelope: env, binding: bindings.get(stranger.pub)! }))).toBe("binding-key-mismatch");
    expect(code(() => gate({ envelope: env, binding: null }))).toBe("strict-requires-binding");
    // The stranger's own valid hybrid signature with its own binding, claimed as the admin's message, fails on the signer.
    expect(code(() => gate({ envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: stranger.hybrid(MSG) } }))).toBe("bad-signature");
  });

  it("AT-DWN-05 boundary: purpose separation. A hybrid signature over one purpose is refused for another (catches: cross-protocol signature reuse)", () => {
    const other = new TextEncoder().encode("flagship/server-update/v1|alice|home|1");
    const env = { suite: "hybrid-ed25519-mldsa65/v1" as const, signature: admin.hybrid(other) };
    expect(code(() => gate({ envelope: env, message: other }))).toBe("purpose-mismatch");
    expect(code(() => gate({ envelope: env, message: MSG }))).toBe("bad-signature");
  });
});

describe("V01 assurance policy chain (AT-DWN-06..16)", () => {
  it("AT-DWN-06 boundary: who may weaken protection. A box, app, relay, cloud or legacy client cannot move a scope to compatibility on the owner's behalf (catches: server-initiated downgrade)", () => {
    for (const k of ["box", "app", "relay", "cloud", "legacy-client"] as PolicySignerKind[]) {
      const c = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: enforced.headDigest, signerKind: k, acknowledgedLoss: ["classical-signatures-accepted"] });
      expect(code(() => applyPolicyChange(enforced, c, okCheck)), k).toBe("not-owner-authority");
    }
  });

  it("AT-DWN-07 boundary: leaving strict needs a strict signer and the owner's acknowledged loss (catches: a classical owner key, possibly quantum-forged, opting a strict scope out)", () => {
    const base = { prior: "strict" as const, next: "compatibility" as const, generation: 2, prevDigest: enforced.headDigest };
    expect(code(() => applyPolicyChange(enforced, change({ ...base, suite: "ed25519/v1", acknowledgedLoss: ["classical-signatures-accepted"] }), okCheck))).toBe("classical-signer-refused");
    expect(code(() => applyPolicyChange(enforced, change({ ...base, acknowledgedLoss: [] }), okCheck))).toBe("loss-not-acknowledged");
  });

  it("AT-DWN-08 boundary: a revoked device's opt-out is refused even with a valid signature (catches: authority judged by signature alone)", () => {
    const c = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: enforced.headDigest, acknowledgedLoss: ["classical-signatures-accepted"] });
    expect(code(() => applyPolicyChange(enforced, c, () => ({ suiteVerified: true, signerActive: false })))).toBe("signer-not-active");
  });

  it("AT-DWN-09 boundary: policy generations. Replayed, skipped or forked changes are refused (catches: an old opt-out replayed after the owner went back to strict)", () => {
    const opt = { prior: "strict" as const, next: "compatibility" as const, acknowledgedLoss: ["classical-signatures-accepted" as const] };
    expect(code(() => applyPolicyChange(enforced, change({ ...opt, generation: 1, prevDigest: enforced.headDigest }), okCheck))).toBe("stale-generation");
    expect(code(() => applyPolicyChange(enforced, change({ ...opt, generation: 3, prevDigest: enforced.headDigest }), okCheck))).toBe("stale-generation");
    expect(code(() => applyPolicyChange(enforced, change({ ...opt, generation: 2, prevDigest: "22".repeat(32) }), okCheck))).toBe("broken-chain");
  });

  it("AT-DWN-10 boundary: stored state and rollout only move forward. Restoring an older state, a same-generation fork, losing enforcedEver, rolling rollout back or enforcing by evidence are refused (catches: backup/restore or copied settings re-enabling classical)", () => {
    expect(code(() => adoptStoredState(enforced, legacy))).toBe("rollback-refused");
    expect(code(() => adoptStoredState(enforced, { ...enforced, headDigest: "33".repeat(32) }))).toBe("rollback-refused");
    expect(code(() => adoptStoredState({ ...enforced, profile: "compatibility", generation: 2 }, { ...enforced, profile: "compatibility", generation: 2, enforcedEver: false }))).toBe("rollback-refused");
    expect(code(() => advanceRollout(enforced, "prepared", {}))).toBe("rollback-refused");
    const prepared = { ...legacy, rollout: "prepared" as const };
    expect(code(() => advanceRollout(prepared, "enforced", { boundPublicKeys: true, recipientsVerified: true, recoveryChecked: true }))).toBe("needs-policy-change");
  });

  it("AT-DWN-11 boundary: suite negotiation. An offer stripped of the hybrid suite is refused under strict, never answered with ed25519 (catches: downgrade by negotiation)", () => {
    expect(code(() => selectSignatureSuite(enforced, ["ed25519/v1"]))).toBe("upgrade-required");
    expect(selectSignatureSuite(legacy, ["ed25519/v1"])).toBe("ed25519/v1");
  });

  it("AT-DWN-12 boundary: return to strict. A scope that was once enforced cannot re-enter strict without re-entry evidence (catches: material exposed under compatibility silently trusted again)", () => {
    const optedOut: PolicyState = { ...enforced, profile: "compatibility", rollout: "enforced", generation: 2 };
    const back = change({ prior: "compatibility", next: "strict", generation: 3, prevDigest: optedOut.headDigest });
    expect(code(() => applyPolicyChange(optedOut, back, okCheck))).toBe("reentry-incomplete");
    const withEvidence = change({ prior: "compatibility", next: "strict", generation: 3, prevDigest: optedOut.headDigest, reentry: { verifierChecksDigest: "a1".repeat(32), enrollmentDigest: "a2".repeat(32), rekeyReceiptDigest: "a3".repeat(32), recoveryTestDigest: "a4".repeat(32) } });
    expect(applyPolicyChange(optedOut, withEvidence, okCheck).profile).toBe("strict");
  });

  it("AT-DWN-13 boundary: the box replays the owner's chain itself. `.com` serving a truncated chain or a classical opt-out cannot weaken a strict box (catches: box trusting `.com`'s policy state)", async () => {
    const one = change();
    let chain: unknown[] = [entry(one)];
    const w = await boxWorld(() => chain);
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", rollout: "enforced", generation: 1 });
    chain = [];
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", generation: 1 });
    const classicalOptOut = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: assurancePolicyDigest(one), acknowledgedLoss: ["classical-signatures-accepted"], suite: "ed25519/v1", issuedAt: T + 1 });
    chain = [entry(one), entry(classicalOptOut)];
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", generation: 1 });
    // A relay/box-kind signer is not even an owner signer.
    const boxOptOut = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: assurancePolicyDigest(one), acknowledgedLoss: ["classical-signatures-accepted"], signerKind: "box", issuedAt: T + 2 });
    chain = [entry(one), entry(boxOptOut)];
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", generation: 1 });
  });

  // AT-DWN-14 (fixed): a damaged state file falls back to its second copy (`<path>.floor`); with both gone the box
  // stays strict and leaves it only for a chain that verifies at least one change, never for an empty one.
  it("AT-DWN-14 boundary: a box whose policy file is damaged must not fall to compatibility because `.com` serves an empty chain", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "at-dwn-")), "assurance-policy.json");
    writeFileSync(path, "{damaged");
    const w = await boxWorld(() => [], { statePath: path });
    expect(w.sync.policy()).toMatchObject({ profile: "strict" });
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict" });
  });

  // AT-DWN-15 (fixed): the replay continues from the head the box already holds (verified when adopted), so only the
  // changes after it are checked against today's device book; the admin root, or a live admin device, continues it.
  it("AT-DWN-15 boundary: revoking the device that turned strict on must not freeze the box's policy", async () => {
    const one = change();
    const two = change({ prior: "strict", next: "compatibility", generation: 2, prevDigest: assurancePolicyDigest(one), acknowledgedLoss: ["classical-signatures-accepted"], signerKind: "admin-root", signerKeyId: admin.pub, issuedAt: T + 10 });
    let chain: unknown[] = [entry(one)];
    const w = await boxWorld(() => chain);
    expect(await w.sync.refresh()).toMatchObject({ profile: "strict", generation: 1 });
    w.active.delete(dev.pub); // the phone is lost and removed
    chain = [entry(one), entry(two, admin)];
    expect(await w.sync.refresh()).toMatchObject({ profile: "compatibility", generation: 2 });
  });

  // AT-DWN-16 (fixed): an export authorization names the strict scope and the policy generation in force.
  it("AT-DWN-16 boundary: an export authorization from an older policy generation, or for another scope, is refused", () => {
    const digest = "ab".repeat(32);
    const now5 = { ...enforced, generation: 5 };
    expect(classicalExchangeAllowed(now5, legacy, digest, { subjectDigest: digest, scope: now5.scope, generation: 1 })).toBe(false);
    expect(classicalExchangeAllowed(now5, legacy, digest, { subjectDigest: digest, scope: { kind: "service" as const, id: S }, generation: 5 })).toBe(false);
    expect(classicalExchangeAllowed(now5, legacy, digest, { subjectDigest: digest, generation: 1 } as never)).toBe(false);
    expect(classicalExchangeAllowed(now5, legacy, digest, { subjectDigest: digest, scope: now5.scope, generation: 5 })).toBe(true);
  });
});

describe("V01 PQ companions once pinned (AT-DWN-17..20)", () => {
  it("AT-DWN-17 boundary: release endorsements under a filled pin. Only companion-backed releases are eligible; pre-cut-over ones are lineage only, never offered; a wrong-commit marker legacies nothing (catches: classical-only release installable after the ceremony)", () => {
    const V = load("release-endorsement-v2/vectors.json");
    const ends = ["A", "B", "C", "D"].map((n) => V.endorsements[n]);
    const names = (xs: { releaseId: string }[]) => xs.map((e) => Object.entries(V.endorsements).find(([, x]) => (x as { releaseId: string }).releaseId === e.releaseId)![0]);
    const run = (pin: ReleasePqPin, companions: unknown[]) => classifyReleaseEndorsements(ends, companions, [V.bindings.release], { pin, now: V.now });
    const main = run(V.pins.main, [V.companions.C]);
    expect(names(main.eligible)).toEqual(["C"]);
    expect(names(main.lineageOnly)).toEqual(["A", "B"]);
    expect(main.refused.map((r) => r.code)).toEqual(["pq-missing"]);
    // Companions stripped by a mirror: nothing becomes eligible.
    expect(run(V.pins.main, []).eligible).toEqual([]);
    // A marker naming the right id but another commit gives no legacy pass.
    expect(run(V.pins["marker-wrong-commit"], []).lineageOnly).toEqual([]);
    // The C companion re-attached to D (another release) does not carry over.
    const moved = { ...V.companions.C, releaseId: V.endorsements.D.releaseId, commitHash: V.endorsements.D.commitHash };
    expect(names(run(V.pins.main, [moved]).eligible)).toEqual([]);
  });

  it("AT-DWN-18 boundary: CA leases under a filled pin. A legacy (pre-cut-over) lease edited by a single byte is no longer legacy and needs its companion (catches: legacy list keyed by id rather than content digest)", () => {
    const V = load("ca-lease-pq/vectors.json");
    const c = V.cases.find((x: { name: string }) => x.name === "pinned: a lease signed before the cut-over");
    const r = gateCaLeasesPq(V.leases, { bindings: c.bindings, endorsements: c.endorsements }, { pin: c.pin as CaLeasePqPin, now: V.now });
    expect(r.accepted.length).toBe(2);
    const legacyIdx = V.leases.findIndex((l: { endorsementId: string }) => !c.endorsements.some((e: { endorsementId: string }) => e.endorsementId === l.endorsementId));
    const edited = V.leases.map((l: { notAfter: number }, i: number) => (i === legacyIdx ? { ...l, notAfter: l.notAfter + 86_400_000 } : l));
    const r2 = gateCaLeasesPq(edited, { bindings: c.bindings, endorsements: c.endorsements }, { pin: c.pin as CaLeasePqPin, now: V.now });
    expect(r2.refused).toEqual([{ endorsementId: V.leases[legacyIdx].endorsementId, code: "pq-missing" }]);
  });

  it("AT-DWN-19 boundary: box artifact under a filled pin. Moving the legacy list to another manifest digest makes the same classical k-of-n insufficient (catches: legacy exemption applied to any manifest)", () => {
    const V = load("box-artifact/pq-vectors.json");
    const c = V.cases.find((x: { name: string }) => x.name === "pinned: a manifest signed before the cut-over");
    const ok = verifyBoxArtifact(V.manifest, c.signatures, { trust: V.trust, verifierVersion: 1, pqPin: c.pin, pqBindings: c.bindings, now: V.now });
    expect(ok.ok).toBe(true);
    const pin = { ...c.pin, legacyManifests: ["ee".repeat(32)] };
    const r = verifyBoxArtifact(V.manifest, c.signatures, { trust: V.trust, verifierVersion: 1, pqPin: pin, pqBindings: c.bindings, now: V.now });
    expect(r.ok ? "ok" : r.code).toBe("pq-signature-required");
  });

  it("AT-DWN-20 boundary: security notices under a filled pin. A classical-only notice or one under an unpinned PQ key is refused, and a pinned client's stored notice survives it (catches: an update lock forged or lifted with a classical key)", () => {
    const V = load("security-notice/pq-vectors.json");
    const byName = (n: string) => V.cases.find((c: { name: string }) => c.name === n).notice;
    const verdict = (n: unknown) => {
      const p = parseSecurityNotice(n);
      if (!p) return "malformed";
      const v = verifySecurityNotice(p, V.authorityKeys, V.pinnedKeyIds);
      return v.ok ? "ok" : v.reason;
    };
    expect(verdict(byName("classical-only"))).toBe("pq-missing");
    expect(verdict(byName("pq-by-unpinned-key"))).toBe("pq-key-not-pinned");
    expect(verdict(byName("hybrid"))).toBe("ok");
    const store = { highestSeq: 0, notice: null };
    const after = acceptSecurityNotice(store, byName("hybrid"), V.authorityKeys, V.pinnedKeyIds);
    expect(after.refused).toBeNull();
    expect(acceptSecurityNotice(after.store, byName("classical-only"), V.authorityKeys, V.pinnedKeyIds)).toEqual({ store: after.store, refused: "pq-missing" });
  });
});

describe("V01 boot unlock v1 vs v2 (AT-DWN-21..26)", () => {
  const V = load("boot-unlock-v2/vectors.json");
  const sk = (k: { edSeed: string; mldsaSeed: string }) => unhex(k.edSeed + k.mldsaSeed);
  const ownerPk = unhex(V.keys.owner.publicKey);
  const ownerSign = (purpose: string, m: Uint8Array) => hybridSign(sk(V.keys.owner), purpose, m);
  const strangerSign = (purpose: string, m: Uint8Array) => hybridSign(sk(V.keys.stranger), purpose, m);
  const diskKey = unhex(V.diskKey);
  const ctx = V.reply.ctx as { serverDomain: string; bootPubHex: string; nonceHex: string; replyKemPubHex: string };
  const boxCtx = { serverDomain: ctx.serverDomain, bootPubHex: ctx.bootPubHex, nonceHex: ctx.nonceHex };
  const replyKemSk = unhex(V.keys.replyKem.seed);
  const open = (sealed: Uint8Array, over: Partial<typeof boxCtx> = {}, kem = replyKemSk) =>
    code(() => openBootReplyV2({ sealed, ctx: { ...boxCtx, ...over }, replyKemSecretKey: kem, ownerHybridPublicKey: ownerPk }));

  it("AT-DWN-21 boundary: the box's unlock policy decides. Under strict a classical v1 reply or lease is refused before anything is opened (catches: reply version chosen by the sender)", () => {
    expect(code(() => boxAcceptsVersion("strict", 1))).toBe("strict-refuses-v1");
    expect(code(() => boxAcceptsVersion("strict", 2))).toBe("ok");
    expect(code(() => boxAcceptsVersion("compat", 1))).toBe("ok");
  });

  it("AT-DWN-22 boundary: reply authenticity. Anyone can seal to the box's PUBLIC per-boot reply key; only the owner's hybrid signature opens the disk (catches: KEM confidentiality mistaken for sender authentication)", () => {
    const evil = buildBootReplyV2({ ctx, diskKey: new Uint8Array(64).fill(7), ownerHybridPublicKey: unhex(V.keys.stranger.publicKey), sign: strangerSign, issuedAt: T });
    expect(open(evil)).toBe("owner-signature");
    // Even the real disk key, if a stranger learned it, cannot be delivered under the stranger's signature.
    const evil2 = buildBootReplyV2({ ctx, diskKey, ownerHybridPublicKey: ownerPk, sign: strangerSign, issuedAt: T });
    expect(open(evil2)).toBe("owner-signature");
    const good = buildBootReplyV2({ ctx, diskKey, ownerHybridPublicKey: ownerPk, sign: ownerSign, issuedAt: T });
    expect(open(good)).toBe("ok");
  });

  it("AT-DWN-23 boundary: reply binding. A genuine owner reply is refused for another nonce, another server, another boot key or a later boot's reply key (catches: replay of an old approval)", () => {
    const good = buildBootReplyV2({ ctx, diskKey, ownerHybridPublicKey: ownerPk, sign: ownerSign, issuedAt: T });
    expect(open(good, { nonceHex: "6b".repeat(32) })).not.toBe("ok");
    expect(open(good, { serverDomain: "kitchen.mallory.flagship.services" })).not.toBe("ok");
    expect(open(good, { bootPubHex: "77".repeat(32) })).not.toBe("ok");
    expect(open(good, {}, unhex(V.keys.otherKem.seed))).toBe("recipient-mismatch");
  });

  it("AT-DWN-24 boundary: lease v3 integrity. The boot worker cannot extend, uncap or re-id a lease, and an expired lease is refused at the floor-raised clock (catches: lease fields trusted from the worker JSON)", () => {
    const lease = V.lease.fields as { serverDomain: string; bootPubHex: string; leaseId: string; issuedAt: number; expiresAt: number; maxUses?: number };
    const sealed = sealLeaseV3({ lease: { ...lease, maxUses: 3 }, leaseKemPublicKey: unhex(V.keys.leaseKem.publicKey), diskKey, ownerHybridPublicKey: ownerPk, sign: ownerSign });
    const openL = (l: typeof lease, nowMs = lease.issuedAt + 1) =>
      code(() => openLeaseV3({ lease: l, sealedKey: sealed, leaseKemSecretKey: unhex(V.keys.leaseKem.seed), ownerHybridPublicKey: ownerPk, nowMs }));
    expect(openL({ ...lease, maxUses: 3 })).toBe("ok");
    expect(openL({ ...lease, maxUses: 3, expiresAt: lease.expiresAt + 86_400_000 })).toBe("owner-signature");
    expect(openL({ ...lease })).toBe("owner-signature"); // cap removed
    expect(openL({ ...lease, maxUses: 3, leaseId: "f".repeat(32) })).not.toBe("ok");
    expect(openL({ ...lease, maxUses: 3 }, lease.expiresAt)).toBe("lease-expired");
  });

  it("AT-DWN-25 boundary: the phone never downgrades a strict server. No box v2 material, no PQ extension on the request, or no ML-DSA key on this phone each refuse instead of sending v1 (catches: silent v1 fallback)", () => {
    expect(code(() => chooseReplyVersion({ strict: true, material: false, requestHasPq: false, canSignHybrid: true }))).toBe("box-has-no-v2");
    expect(code(() => chooseReplyVersion({ strict: true, material: true, requestHasPq: false, canSignHybrid: true }))).toBe("box-has-no-v2");
    expect(code(() => chooseReplyVersion({ strict: true, material: true, requestHasPq: true, canSignHybrid: false }))).toBe("phone-cannot-sign-hybrid");
    expect(code(() => chooseLeaseVersion({ strict: true, material: true, canSignHybrid: false }))).toBe("phone-cannot-sign-hybrid");
    expect(chooseReplyVersion({ strict: false, material: true, requestHasPq: false, canSignHybrid: true })).toBe(1);
  });

  it("AT-DWN-26 boundary: the /boot unlock policy file. Garbage content with v2 material reads strict; an ABSENT file reads compat: KNOWN LIMITATION (pq-suites.md 19.3), /boot is unauthenticated until a measured boot (BO02), so whoever holds the powered-off disk can downgrade", () => {
    expect(parseUnlockPolicy("strict\n", true)).toBe("strict");
    expect(parseUnlockPolicy("compat\n", true)).toBe("compat");
    expect(parseUnlockPolicy("COMPAT", true)).toBe("strict");
    expect(parseUnlockPolicy("compat\n\n", true)).toBe("strict");
    expect(parseUnlockPolicy(null, true)).toBe("compat");
  });
});
