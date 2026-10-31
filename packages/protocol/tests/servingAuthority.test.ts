import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it } from "vitest";
import {
  applyRevocationEntries,
  boxNameList,
  canonicalNameList,
  canonicalRouteClaim,
  canonicalServingLease,
  canonicalServingPolicy,
  ed,
  emptyRevocationState,
  GRACE_MS,
  leaseFor,
  nameListSha256,
  routeCollisions,
  servingDecision,
  signServingLeaseP256,
  signServingRecord,
  verifyServingLeaseP256,
  verifyServingRecord,
  type RenewalKeyDelegation,
  type RevocationEntry,
  type ServingInput,
  type ServingLease,
  type ServingPolicy,
} from "../src/index.js";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (n: number) => {
  const seed = new Uint8Array(32).fill(n);
  return { pub: hexOf(ed.getPublicKey(seed)), sign: (m: Uint8Array) => ed.sign(m, seed) };
};
const admin = key(1);
const otherAdmin = key(2);
/** A device's hardware renewal key: P-256. */
const p256Key = (n: number) => {
  const sk = new Uint8Array(32).fill(n);
  return { sk, pub: hexOf(p256.getPublicKey(sk, true)) };
};
const renewal = p256Key(3);
const p256Signed = (l: ServingLease, k = renewal) => ({ record: l, signature: signServingLeaseP256(l, k.sk) });
const revoker = key(4);
const box = key(5).pub;
const device = key(6).pub;
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

const policy = (o: Partial<ServingPolicy> = {}): ServingPolicy => ({
  account: "alice",
  box,
  regGen: 1,
  policyGen: 1,
  grace: "7d",
  onLapse: "stop-apps",
  scopeSha256: nameListSha256(boxNameList("home", "alice", "flagship.services")),
  issuedAt: T0,
  ...o,
});
const signed = <T,>(kind: Parameters<typeof signServingRecord>[0], record: T, signer = admin) => ({
  record,
  signature: hexOf(signServingRecord(kind, record as never, signer.sign)),
});
const delegation: RenewalKeyDelegation = { account: "alice", alg: "p256", renewalPub: renewal.pub, deviceId: device, issuedAt: T0 };
const lease = (o: Partial<ServingLease> = {}): ServingLease => ({ ...leaseFor(policy(), T0, "ab".repeat(16))!, ...o });
const input = (o: Partial<ServingInput> = {}): ServingInput => ({
  account: "alice",
  box,
  regGen: 1,
  adminKeyFromCom: admin.pub,
  adminKeyFromBox: admin.pub,
  policies: [signed("serving-policy", policy())],
  leases: [{ ...p256Signed(lease()), delegation: signed("renewal-key-delegation", delegation) }],
  revocations: emptyRevocationState(),
  now: T0 + DAY,
  ...o,
});

describe("canonical bytes", () => {
  it("are fixed for the policy and the lease", () => {
    const p = policy();
    expect(new TextDecoder().decode(canonicalServingPolicy(p))).toBe(
      `flagship/serving-policy/v1|alice|${box}|1|1|7d|stop-apps|${p.scopeSha256}|${T0}`,
    );
    expect(new TextDecoder().decode(canonicalServingLease(lease()))).toBe(
      `flagship/serving-lease/v1|alice|${box}|1|1|${"ab".repeat(16)}|${T0}|${T0 + 7 * DAY}`,
    );
  });

  it("refuse out-of-shape fields", () => {
    expect(() => canonicalServingPolicy(policy({ grace: "forever" as never }))).toThrow();
    expect(() => canonicalServingPolicy(policy({ account: "Alice" }))).toThrow();
    expect(() => canonicalServingPolicy(policy({ box: "AB".repeat(32) }))).toThrow();
    expect(() => canonicalServingPolicy(policy({ regGen: 0 }))).toThrow();
    expect(() => canonicalServingPolicy(policy({ onLapse: "power-off" as never }))).toThrow();
    expect(() => canonicalServingPolicy(policy({ grace: "indefinite", onLapse: "lock-server" }))).toThrow("locking needs a time limit");
    expect(() => canonicalServingLease(lease({ notAfter: T0 }))).toThrow();
    expect(() => canonicalServingLease(lease({ issuedAt: 1.5 }))).toThrow();
    expect(() => canonicalRouteClaim({ account: "alice", phoneRoutePub: device, hostname: "home.alice.flagship.services", generation: 1, sessionNonce: "cd".repeat(16), issuedAt: T0 })).toThrow();
    expect(() => canonicalRouteClaim({ account: "alice", phoneRoutePub: device, hostname: "alice.flagship.services", generation: 1, sessionNonce: "cd".repeat(16), issuedAt: T0 })).not.toThrow();
  });

  it("a signature holds for its own record only", () => {
    const s = signed("serving-policy", policy());
    expect(verifyServingRecord("serving-policy", policy(), s.signature, admin.pub)).toBe(true);
    expect(verifyServingRecord("serving-policy", policy({ grace: "indefinite" }), s.signature, admin.pub)).toBe(false);
    expect(verifyServingRecord("serving-policy", policy(), s.signature, otherAdmin.pub)).toBe(false);
    expect(verifyServingRecord("serving-policy", policy(), "00".repeat(64), admin.pub)).toBe(false);
  });
});

describe("indefinite (the default) needs no lease", () => {
  it("serves apps on the policy alone, with no end", () => {
    const d = servingDecision(input({ policies: [signed("serving-policy", policy({ grace: "indefinite" }))], leases: [] }));
    expect(d).toEqual({ control: true, apps: true, until: null, policyGen: 1, onLapse: "stop-apps" });
  });

  it("an admin device has nothing to sign", () => {
    expect(leaseFor(policy({ grace: "indefinite" }), T0, "ab".repeat(16))).toBeNull();
  });
});

describe("a finite grace", () => {
  it("serves apps until the best lease ends, renewed by any admin device's delegated key", () => {
    expect(servingDecision(input())).toEqual({ control: true, apps: true, until: T0 + 7 * DAY, policyGen: 1, onLapse: "stop-apps" });
  });

  it("stop-apps: the lapse stops app routes and never locks the box", () => {
    expect(servingDecision(input({ now: T0 + 7 * DAY }))).toMatchObject({ apps: false, reason: "lease-expired", lock: false });
  });

  it("lock-server: the same lease keeps the box unlocked; its lapse locks it too", () => {
    const locking = signed("serving-policy", policy({ onLapse: "lock-server" }));
    expect(servingDecision(input({ policies: [locking] }))).toMatchObject({ apps: true, onLapse: "lock-server", until: T0 + 7 * DAY });
    expect(servingDecision(input({ policies: [locking], now: T0 + 7 * DAY }))).toMatchObject({ apps: false, reason: "lease-expired", lock: true });
    expect(servingDecision(input({ policies: [locking], leases: [] }))).toMatchObject({ reason: "no-lease", lock: true });
  });

  it("a policy the box can't verify never locks it (only the owner's signed word can)", () => {
    const forged = signed("serving-policy", policy({ onLapse: "lock-server" }), otherAdmin);
    expect(servingDecision(input({ policies: [forged], leases: [] }))).toMatchObject({ reason: "policy-signature", lock: false });
  });

  it("stops app routes once the lease ends; the control name stays", () => {
    expect(servingDecision(input({ now: T0 + 7 * DAY }))).toMatchObject({ control: true, apps: false, reason: "lease-expired" });
  });

  it("has no app routes without a lease", () => {
    expect(servingDecision(input({ leases: [] }))).toMatchObject({ control: true, apps: false, reason: "no-lease" });
  });

  it("a lease signed by the admin root itself counts too", () => {
    expect(servingDecision(input({ leases: [signed("serving-lease", lease())] }))).toMatchObject({ apps: true });
  });

  it("refuses a lease reaching further than the grace", () => {
    const long = lease({ notAfter: T0 + 30 * DAY });
    expect(servingDecision(input({ leases: [{ ...p256Signed(long), delegation: signed("renewal-key-delegation", delegation) }] }))).toMatchObject({ reason: "no-lease" });
  });

  it("shortening the grace (a new policy generation) outdates older, longer leases", () => {
    const newer = signed("serving-policy", policy({ policyGen: 2, grace: "7d", issuedAt: T0 + DAY }));
    const thirty = policy({ grace: "30d" });
    const oldLease = { ...leaseFor(thirty, T0, "ef".repeat(16))! };
    const d = servingDecision(input({ policies: [newer], leases: [{ ...p256Signed(oldLease), delegation: signed("renewal-key-delegation", delegation) }] }));
    expect(d).toMatchObject({ apps: false, reason: "no-lease" });
  });

  it("refuses a lease from a renewal key the admin never delegated, or one that was revoked", () => {
    const stranger = p256Key(9);
    expect(servingDecision(input({ leases: [p256Signed(lease(), stranger)] }))).toMatchObject({ reason: "no-lease" });
    const forgedDelegation = signed("renewal-key-delegation", { ...delegation, renewalPub: stranger.pub }, otherAdmin);
    expect(servingDecision(input({ leases: [{ ...p256Signed(lease(), stranger), delegation: forgedDelegation }] }))).toMatchObject({ reason: "no-lease" });
    const entry: RevocationEntry = { sequence: 1, kind: "renewal-key", account: "alice", subject: renewal.pub, generation: 0, revokedAt: T0 };
    const pushed = signed("revocation-entry", entry, revoker);
    const r = applyRevocationEntries(emptyRevocationState(), [{ entry: pushed.record, signature: pushed.signature }], revoker.pub);
    expect(r.ok).toBe(true);
    expect(servingDecision(input({ revocations: r.ok ? r.state : emptyRevocationState() }))).toMatchObject({ reason: "no-lease" });
  });

  it("refuses a lease for another box, generation or account", () => {
    for (const bad of [lease({ box: key(8).pub }), lease({ regGen: 2 }), lease({ account: "bob" })]) {
      expect(servingDecision(input({ leases: [signed("serving-lease", bad)] }))).toMatchObject({ reason: "no-lease" });
    }
  });

  it("refuses a lease issued in the future beyond the clock skew", () => {
    const future = lease({ issuedAt: T0 + 2 * DAY, notAfter: T0 + 9 * DAY });
    expect(servingDecision(input({ now: T0, leases: [signed("serving-lease", future)] }))).toMatchObject({ reason: "no-lease" });
  });
});

describe("policies from .com and from the box", () => {
  it("none at all is the default: indefinitely, stop-apps", () => {
    expect(servingDecision(input({ policies: [], leases: [] }))).toEqual({ control: true, apps: true, until: null, policyGen: 0, onLapse: "stop-apps" });
  });

  it("the highest generation that verifies counts, whichever side sent it (neither can drop a stricter one)", () => {
    const loose = signed("serving-policy", policy({ grace: "indefinite", policyGen: 1 }));
    const strict = signed("serving-policy", policy({ grace: "7d", policyGen: 2 }));
    expect(servingDecision(input({ policies: [loose, strict], leases: [] }))).toMatchObject({ apps: false, reason: "no-lease" });
    expect(servingDecision(input({ policies: [strict, loose], leases: [] }))).toMatchObject({ apps: false, reason: "no-lease" });
  });

  it("offered policies that all fail to verify refuse; they never fall back to the default", () => {
    expect(servingDecision(input({ policies: [signed("serving-policy", policy({ grace: "indefinite" }), otherAdmin)], leases: [] }))).toMatchObject({ apps: false, reason: "policy-signature" });
  });
});

describe("the renewal key is P-256", () => {
  it("a delegation names it compressed, and refuses an Ed25519-shaped key", () => {
    expect(verifyServingRecord("renewal-key-delegation", delegation, signed("renewal-key-delegation", delegation).signature, admin.pub)).toBe(true);
    expect(() => signServingRecord("renewal-key-delegation", { ...delegation, renewalPub: key(9).pub }, admin.sign)).toThrow();
    expect(() => signServingRecord("renewal-key-delegation", { ...delegation, alg: "ed25519" as never }, admin.sign)).toThrow();
  });

  it("verifies a low-S compact signature and refuses its high-S twin", () => {
    const l = lease();
    const sig = signServingLeaseP256(l, renewal.sk);
    expect(verifyServingLeaseP256(l, sig, renewal.pub)).toBe(true);
    const n = p256.Point.CURVE().n;
    const sv = BigInt(`0x${sig.slice(64)}`);
    const high = sig.slice(0, 64) + (n - sv).toString(16).padStart(64, "0");
    expect(verifyServingLeaseP256(l, high, renewal.pub)).toBe(false);
    expect(verifyServingLeaseP256({ ...l, notAfter: l.notAfter - 1 }, sig, renewal.pub)).toBe(false);
  });
});

describe("lease trust: both admin keys must agree", () => {
  it("refuses everything when .com's key and the box's pinned key differ", () => {
    expect(servingDecision(input({ adminKeyFromCom: otherAdmin.pub }))).toMatchObject({ control: false, apps: false, reason: "admin-keys-differ" });
    expect(servingDecision(input({ adminKeyFromBox: otherAdmin.pub }))).toMatchObject({ reason: "admin-keys-differ" });
  });

  it("a policy signed by another key gives no app routes", () => {
    expect(servingDecision(input({ policies: [signed("serving-policy", policy(), otherAdmin)] }))).toMatchObject({ control: true, apps: false, reason: "policy-signature" });
  });

  it("a policy for another box gives no app routes", () => {
    expect(servingDecision(input({ policies: [signed("serving-policy", policy({ box: key(8).pub }))] }))).toMatchObject({ reason: "policy-signature" });
  });
});

describe("the pushed revocation log", () => {
  const entry = (sequence: number, o: Partial<RevocationEntry> = {}): RevocationEntry => ({ sequence, kind: "box", account: "alice", subject: box, generation: 1, revokedAt: T0, ...o });
  const push = (...es: RevocationEntry[]) => es.map((e) => signed("revocation-entry", e, revoker) as { entry: RevocationEntry; signature: string } & { record: RevocationEntry });
  const asEntries = (xs: ReturnType<typeof push>) => xs.map((x) => ({ entry: x.record, signature: x.signature }));

  it("applies in order and ends the box (tunnel and apps)", () => {
    const r = applyRevocationEntries(emptyRevocationState(), asEntries(push(entry(1))), revoker.pub);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    if (!r.ok) return;
    expect(r.state.sequence).toBe(1);
    expect(servingDecision(input({ revocations: r.state }))).toMatchObject({ control: false, apps: false, reason: "revoked" });
  });

  it("a later registration generation is not revoked by an earlier one's entry", () => {
    const r = applyRevocationEntries(emptyRevocationState(), asEntries(push(entry(1))), revoker.pub);
    if (!r.ok) throw new Error("apply failed");
    const p = signed("serving-policy", policy({ regGen: 2, grace: "indefinite" }));
    expect(servingDecision(input({ regGen: 2, policies: [p], leases: [], revocations: r.state }))).toMatchObject({ apps: true });
  });

  it("skips duplicates, stops at a gap, and refuses a bad signature, never changing the state passed in", () => {
    const s0 = emptyRevocationState();
    const one = applyRevocationEntries(s0, asEntries(push(entry(1))), revoker.pub);
    if (!one.ok) throw new Error("apply failed");
    expect(applyRevocationEntries(one.state, asEntries(push(entry(1))), revoker.pub)).toMatchObject({ ok: true, applied: 0 });
    expect(applyRevocationEntries(one.state, asEntries(push(entry(3, { subject: key(8).pub }))), revoker.pub)).toEqual({ ok: false, reason: "gap", at: 2 });
    const forged = signed("revocation-entry", entry(2, { subject: key(8).pub }), otherAdmin);
    expect(applyRevocationEntries(one.state, [{ entry: forged.record, signature: forged.signature }], revoker.pub)).toEqual({ ok: false, reason: "bad-signature", at: 2 });
    expect(s0.sequence).toBe(0);
    expect(one.state.sequence).toBe(1);
  });
});

describe("the canonical name list", () => {
  it("is sorted, tagged and stable whatever the input order", () => {
    const names = boxNameList("home", "alice", "flagship.services");
    expect(canonicalNameList(names)).toBe(
      ["apps *.alice.flagship.services", "apps *.home.alice.flagship.services", "control home.alice.flagship.services"].join("\n"),
    );
    expect(nameListSha256([...names].reverse())).toBe(nameListSha256(names));
  });

  it("refuses non-canonical names and a name under two classes", () => {
    expect(() => canonicalNameList([{ class: "apps", name: "Home.alice.flagship.services" }])).toThrow();
    expect(() => canonicalNameList([{ class: "control", name: "*.alice.flagship.services" }])).toThrow();
    expect(() => canonicalNameList([{ class: "apps", name: "a.*.flagship.services" }])).toThrow();
    expect(() =>
      canonicalNameList([
        { class: "control", name: "home.alice.flagship.services" },
        { class: "apps", name: "home.alice.flagship.services" },
      ]),
    ).toThrow();
  });

  it("an app route can never take a server's name or the phone's name", () => {
    expect(
      routeCollisions({
        controlNames: ["home.alice.flagship.services", "home2.alice.flagship.services"],
        phoneName: "alice.flagship.services",
        appNames: ["notes.alice.flagship.services", "Home2.alice.flagship.services", "alice.flagship.services"],
      }),
    ).toEqual(["Home2.alice.flagship.services", "alice.flagship.services"]);
  });
});

describe("shared vectors", () => {
  it("match this implementation", () => {
    const v = JSON.parse(readFileSync(new URL("../test-vectors/serving-authority/vectors.json", import.meta.url), "utf8")) as {
      records: Array<{ kind: Parameters<typeof verifyServingRecord>[0]; record: never; canonical: string; signature: string; signerPub: string; alg: string }>;
      nameLists: Array<{ names: never; canonical: string; sha256: string }>;
    };
    expect(v.records.length).toBeGreaterThan(5);
    for (const r of v.records) {
      const ok = r.alg === "p256" ? verifyServingLeaseP256(r.record, r.signature, r.signerPub) : verifyServingRecord(r.kind, r.record, r.signature, r.signerPub);
      expect(ok, `${r.kind} ${r.alg}`).toBe(true);
    }
    for (const n of v.nameLists) {
      expect(canonicalNameList(n.names)).toBe(n.canonical);
      expect(nameListSha256(n.names)).toBe(n.sha256);
    }
    expect(GRACE_MS["7d"]).toBe(604_800_000);
  });
});
