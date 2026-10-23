import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adapterIndexDigest, attestationDigest, ed, signAdapterAttestation, signAdapterIndex, type AdapterAttestation, type AdapterIndexBody, type Keypair } from "@flagship/protocol";
import { AdapterTrust, type AdapterCandidate, type ServicePolicy } from "../src/buildmodes/adapterTrust.js";

const key = (b: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(b);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const VET = key(0x41);
const OTHER = key(0x42);
const T0 = 1_000_000;
const PINNED = [{ pubHex: hex(VET.publicKey), notBefore: 0, notAfter: 10 ** 12 }];

const bytes = new TextEncoder().encode("diff --git a/x b/x\n");
const cap = "c".repeat(64);
const candidate = (over: Partial<AdapterCandidate> = {}): AdapterCandidate => ({ digestHex: sha(bytes), bytes, baseRevision: "rev1", capabilityDigestHex: cap, provenance: "ai-vetted", ...over });
const policy = (over: Partial<ServicePolicy> = {}): ServicePolicy => ({ manual: [], standingVetted: false, approvedCapabilityDigestHex: null, ...over });

const att = (over: Partial<AdapterAttestation> = {}): AdapterAttestation => ({
  adapterDigestHex: sha(bytes), baseRevision: "rev1", capabilityDigestHex: cap, validatorVersion: "v1", modelVersion: "m1",
  evidenceSha256Hex: "e".repeat(64), outcome: "pass", issuedAt: T0, ...over,
});

function index(seq: number, prev: string, atts: AdapterAttestation[], opts: { withdrawn?: string[]; key?: Keypair; expiresAt?: number } = {}) {
  const body: AdapterIndexBody = { sequence: seq, prevDigestHex: prev, issuedAt: T0, expiresAt: opts.expiresAt ?? T0 + 3_600_000, attestationDigests: atts.map(attestationDigest), withdrawn: opts.withdrawn ?? [] };
  return { signed: signAdapterIndex(body, opts.key ?? VET), digest: adapterIndexDigest(body), atts: atts.map((a) => signAdapterAttestation(a, VET)) };
}

function trust(now = T0 + 1000) {
  let t = now;
  const tr = new AdapterTrust(() => PINNED, () => t);
  return { tr, advance: (ms: number) => void (t += ms) };
}

describe("adapter trust", () => {
  it("a vetted adapter is used only where the admin chose standing trust, and only on a passing attestation", () => {
    const { tr } = trust();
    const i = index(1, "genesis", [att()]);
    expect(tr.accept(i.signed, i.atts)).toEqual({ ok: true });
    expect(tr.decide(candidate(), policy())).toMatchObject({ use: false, code: "needs-acceptance" }); // the verdict alone never authorizes
    expect(tr.decide(candidate(), policy({ standingVetted: true }))).toEqual({ use: true, basis: "standing-vetted", review: "pass" });
  });

  it("a different digest, base revision or capability is not covered by the attestation", () => {
    const { tr } = trust();
    const i = index(1, "genesis", [att()]);
    tr.accept(i.signed, i.atts);
    const p = policy({ standingVetted: true });
    expect(tr.decide(candidate({ baseRevision: "rev2" }), p)).toMatchObject({ use: false, code: "needs-acceptance" });
    expect(tr.decide(candidate({ capabilityDigestHex: "d".repeat(64) }), p)).toMatchObject({ use: false });
    const other = new TextEncoder().encode("another adapter");
    expect(tr.decide(candidate({ digestHex: sha(other), bytes: other }), p)).toMatchObject({ use: false, code: "needs-acceptance" });
  });

  it("a failed or unavailable review is shown, never silently trusted", () => {
    for (const outcome of ["fail", "unavailable"] as const) {
      const { tr } = trust();
      const i = index(1, "genesis", [att({ outcome })]);
      tr.accept(i.signed, i.atts);
      const d = tr.decide(candidate(), policy({ standingVetted: true }));
      expect(d).toMatchObject({ use: false, code: outcome === "fail" ? "review-failed" : "needs-acceptance" });
    }
  });

  it("an attestation signed by an unpinned key, or one the index does not list, is ignored", () => {
    const { tr } = trust();
    const good = index(1, "genesis", [att()]);
    const forged = [{ ...good.atts[0]!, ...signAdapterAttestation(att(), OTHER) }];
    tr.accept(good.signed, forged);
    expect(tr.decide(candidate(), policy({ standingVetted: true }))).toMatchObject({ use: false });
    const t2 = trust();
    const unlisted = index(1, "genesis", []);
    t2.tr.accept(unlisted.signed, [signAdapterAttestation(att(), VET)]);
    expect(t2.tr.decide(candidate(), policy({ standingVetted: true }))).toMatchObject({ use: false });
  });

  it("a community adapter is an inert diff until an admin picks that exact digest", () => {
    const { tr } = trust();
    const c = candidate({ provenance: "community" });
    expect(tr.decide(c, policy())).toMatchObject({ use: false, code: "needs-acceptance" });
    expect(tr.decide(c, policy({ standingVetted: true }))).toMatchObject({ use: false, code: "needs-acceptance" }); // standing trust is for vetted digests only
    const accepted = policy({ manual: [{ digestHex: c.digestHex, capabilityDigestHex: cap, acknowledgedReview: "missing", at: 1 }] });
    expect(tr.decide(c, accepted)).toEqual({ use: true, basis: "manual", review: "missing" });
    const stale = policy({ manual: [{ digestHex: c.digestHex, capabilityDigestHex: "d".repeat(64), acknowledgedReview: "missing", at: 1 }] });
    expect(tr.decide(c, stale)).toMatchObject({ use: false, code: "capability-expanded" });
  });

  it("bytes that do not match their digest can never be accepted", () => {
    const { tr } = trust();
    const tampered = candidate({ bytes: new TextEncoder().encode("evil") });
    const accepted = policy({ manual: [{ digestHex: tampered.digestHex, capabilityDigestHex: cap, acknowledgedReview: "pass", at: 1 }], standingVetted: true });
    expect(tr.decide(tampered, accepted)).toMatchObject({ use: false, code: "integrity" });
    expect(tr.decide({ ...tampered, provenance: "repo-authored" }, accepted)).toMatchObject({ use: false, code: "integrity" });
  });

  it("withdrawal beats every acceptance, manual or standing", () => {
    const { tr } = trust();
    const i = index(1, "genesis", [att()], { withdrawn: [sha(bytes)] });
    tr.accept(i.signed, i.atts);
    const p = policy({ standingVetted: true, manual: [{ digestHex: sha(bytes), capabilityDigestHex: cap, acknowledgedReview: "pass", at: 1 }] });
    expect(tr.decide(candidate(), p)).toMatchObject({ use: false, code: "withdrawn" });
  });

  it("a repo's own adapter is allowed as that repo's code", () => {
    expect(trust().tr.decide(candidate({ provenance: "repo-authored" }), policy())).toMatchObject({ use: true, basis: "repo-authored" });
  });

  it("the index cannot be rolled back, forked, replayed expired, or accepted unsigned", () => {
    const { tr, advance } = trust();
    const i1 = index(1, "genesis", [att()]);
    const i2 = index(2, i1.digest, [att()]);
    expect(tr.accept(i2.signed, i2.atts)).toMatchObject({ ok: true }); // a box may start from a later index
    expect(tr.accept(i1.signed, i1.atts)).toEqual({ ok: false, reason: "rollback" });
    const fork = index(2, "f".repeat(64), [att({ issuedAt: T0 + 5 })]);
    expect(tr.accept(fork.signed, fork.atts)).toEqual({ ok: false, reason: "fork" });
    const i3 = index(3, "9".repeat(64), [att()]);
    expect(tr.accept(i3.signed, i3.atts)).toEqual({ ok: false, reason: "fork" }); // does not extend the one we hold
    expect(tr.accept(index(3, i2.digest, [att()], { key: OTHER }).signed, [])).toEqual({ ok: false, reason: "unknown-key" });
    const tamper = index(3, i2.digest, [att()]);
    expect(tr.accept({ ...tamper.signed, index: { ...tamper.signed.index, withdrawn: [] , attestationDigests: [] } }, [])).toEqual({ ok: false, reason: "bad-signature" });
    expect(tr.accept(tamper.signed, tamper.atts)).toEqual({ ok: true });
    advance(4_000_000);
    expect(tr.decide(candidate(), policy({ standingVetted: true }))).toMatchObject({ use: false, code: "index-unusable" }); // the index lapsed
  });

  it("a rotated vetting key works inside its window only", () => {
    const rotated = [{ pubHex: hex(VET.publicKey), notBefore: T0 + 10_000, notAfter: T0 + 100_000 }];
    const tr = new AdapterTrust(() => rotated, () => T0 + 1000);
    const i = index(1, "genesis", [att()]);
    expect(tr.accept(i.signed, i.atts)).toEqual({ ok: false, reason: "unknown-key" }); // issued before the key's window
  });
});
