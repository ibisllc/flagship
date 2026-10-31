// The serving authority in the webapp (docs/architecture-v2/serving-wiring.md §4):
// the shared vectors, the renewal key (non-extractable P-256, low-S), the
// delegation, the leases signed on open, the policy editor's order and the
// server page's line. Everything the webapp signs is checked with
// @flagship/protocol's own verifier and servingDecision.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import {
  ed,
  servingDecision,
  emptyRevocationState,
  verifyServingLeaseP256,
  verifyServingRecord,
  type ServingPolicy,
} from "@flagship/protocol";
import {
  canonicalRenewalKeyDelegation,
  canonicalServingLease,
  canonicalServingPolicy,
  compressP256,
  ensureDelegation,
  ensureRenewalKey,
  leaseFor,
  loadRenewalKey,
  normalizeLowS,
  renewServingLeases,
  saveServingPolicy,
  servingView,
  signLeaseP256,
  startServingRenewal,
} from "../public/webapp/lib/servingAuthority.js";
import { servingLineParts } from "../public/webapp/lib/servingUi.js";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/serving-authority/vectors.json"), "utf8"),
);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CANON: Record<string, (r: any) => Uint8Array> = {
  "serving-policy": canonicalServingPolicy,
  "renewal-key-delegation": canonicalRenewalKeyDelegation,
  "serving-lease": canonicalServingLease,
};

describe("serving-authority vectors (webapp port)", () => {
  const ours = V.records.filter((r: any) => r.kind in CANON);

  it("covers every record kind the webapp signs", () => {
    expect(new Set(ours.map((r: any) => r.kind))).toEqual(new Set(Object.keys(CANON)));
  });

  it("reproduces each canonical string, and each signature verifies over it", async () => {
    for (const r of ours) {
      const bytes = CANON[r.kind]!(r.record);
      expect(utf8(bytes)).toBe(r.canonical);
      if (r.alg === "ed25519") {
        expect(ed.verify(fromHex(r.signature), bytes, fromHex(r.signerPub))).toBe(true);
      } else {
        expect(r.alg).toBe("p256");
        expect(p256.verify(fromHex(r.signature), bytes, fromHex(r.signerPub), { lowS: true })).toBe(true);
      }
    }
  });

  it("refuses what the protocol refuses", () => {
    const p = V.records.find((r: any) => r.kind === "serving-policy").record;
    expect(() => canonicalServingPolicy({ ...p, grace: "indefinite", onLapse: "lock-server" })).toThrow(/time limit/);
    expect(() => canonicalServingPolicy({ ...p, grace: "1d" })).toThrow();
    expect(() => canonicalServingPolicy({ ...p, account: "Alice" })).toThrow();
    const l = V.records.find((r: any) => r.kind === "serving-lease").record;
    expect(() => canonicalServingLease({ ...l, notAfter: l.issuedAt })).toThrow();
    expect(() => canonicalServingLease({ ...l, leaseId: "ab" })).toThrow();
    const d = V.records.find((r: any) => r.kind === "renewal-key-delegation").record;
    expect(() => canonicalRenewalKeyDelegation({ ...d, renewalPub: "04" + "00".repeat(32) })).toThrow();
  });

  it("leaseFor is the full grace ahead, and nothing under an indefinite policy", () => {
    const p = V.records.find((r: any) => r.kind === "serving-policy" && r.record.grace === "7d").record;
    const lease = leaseFor(p, 1_000, "ab".repeat(16))!;
    expect(lease).toEqual({ account: "alice", box: p.box, regGen: 1, policyGen: 1, leaseId: "ab".repeat(16), issuedAt: 1_000, notAfter: 1_000 + 7 * 86_400_000 });
    expect(leaseFor({ ...p, grace: "30d" }, 0, "ab".repeat(16))!.notAfter).toBe(30 * 86_400_000);
    expect(leaseFor({ ...p, grace: "indefinite" }, 0, "ab".repeat(16))).toBeNull();
  });
});

describe("P-256 in the form the protocol takes", () => {
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const lease = V.records.find((r: any) => r.kind === "serving-lease" && r.alg === "p256");

  it("turns a high S into n - s and leaves a low one alone", () => {
    const low = fromHex(lease.signature);
    expect(hex(normalizeLowS(low))).toBe(lease.signature);
    const s = BigInt("0x" + lease.signature.slice(64));
    const high = fromHex(lease.signature.slice(0, 64) + (N - s).toString(16).padStart(64, "0"));
    const bytes = canonicalServingLease(lease.record);
    expect(p256.verify(high, bytes, fromHex(lease.signerPub), { lowS: true })).toBe(false);
    expect(hex(normalizeLowS(high))).toBe(lease.signature);
    expect(() => normalizeLowS(new Uint8Array(63))).toThrow();
  });

  it("compresses an uncompressed point", () => {
    const priv = p256.utils.randomSecretKey();
    const full = p256.getPublicKey(priv, false);
    expect(hex(compressP256(full))).toBe(hex(p256.getPublicKey(priv, true)));
  });

  it("a WebCrypto key's leases always verify under the protocol's strict rule", async () => {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const pub = hex(compressP256(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))));
    // WebCrypto picks either S; about half of these would be refused without the normalisation.
    for (let i = 0; i < 24; i++) {
      const l = { ...lease.record, leaseId: i.toString(16).padStart(32, "0") };
      const sig = await signLeaseP256(l, kp.privateKey);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
      expect(verifyServingLeaseP256(l, sig, pub)).toBe(true);
    }
  });
});

// ── a little world: an admin device, `.com` and one box ─────────────────────

const ADMIN = new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff);
const ADMIN_PUB = hex(ed.getPublicKey(ADMIN));
const BOX = "6e".repeat(32);
const SCOPE = "1b".repeat(32);
const DEVICE = "8a".repeat(32);

function memKv() {
  const m = new Map<string, unknown>();
  return { m, kv: { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v) } };
}

function signPolicy(p: ServingPolicy) {
  return { record: p, signature: hex(ed.sign(canonicalServingPolicy(p), ADMIN)) };
}

function world(extra: Record<string, unknown> = {}) {
  const { m, kv } = memKv();
  const posts: Array<{ url: string; body: any }> = [];
  const box: Array<{ fqdn: string; path: string; body: any }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === "POST") posts.push({ url, body });
    if (url.endsWith("/renewal-delegations")) return json(200, { ok: true });
    if (url.endsWith("/serving-leases")) return json(200, { accepted: body.leases.length, refused: [] });
    if (url.endsWith("/serving-policy")) return json(200, { ok: true });
    return json(404, { error: "no" });
  });
  const deps = {
    session: { umk: new Uint8Array(32).fill(1), username: "alice", adminRootSeed: new Uint8Array(32) },
    profile: { accountId: "0f".repeat(16), deviceId: "a1".repeat(16) },
    signer: { kind: "admin", sign: async (b: Uint8Array) => ed.sign(b, ADMIN) },
    deviceId: DEVICE,
    kv,
    recordKey: "renewal",
    fetch,
    comBase: "https://flagshipserver.com",
    boxFetch: async (fqdn: string, path: string, init: RequestInit) => {
      box.push({ fqdn, path, body: JSON.parse(String(init.body)) });
      return { ok: true };
    },
    now: () => 1_800_000_000_000,
    ...extra,
  };
  return { m, posts, box, fetch, deps };
}

const policy7d: ServingPolicy = { account: "alice", box: BOX, regGen: 2, policyGen: 3, grace: "7d", onLapse: "lock-server", scopeSha256: SCOPE, issuedAt: 1_700_000_000_000 };

describe("the renewal key", () => {
  it("is a non-extractable P-256 key kept as a CryptoKey, made once", async () => {
    const w = world();
    expect(await loadRenewalKey(w.deps)).toBeNull();
    const a = await ensureRenewalKey(w.deps);
    expect(a.privateKey.extractable).toBe(false);
    expect(a.privateKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
    expect(a.pubHex).toMatch(/^0[23][0-9a-f]{64}$/);
    const [b, c] = await Promise.all([ensureRenewalKey(w.deps), ensureRenewalKey(w.deps)]);
    expect(b.pubHex).toBe(a.pubHex);
    expect(c.pubHex).toBe(a.pubHex);
    expect(w.m.get("renewal")).toBeTruthy();
  });

  it("is delegated once by the admin root and posted to .com", async () => {
    const w = world();
    const rec = await ensureDelegation(w.deps);
    const post = w.posts.find((p) => p.url === "https://flagshipserver.com/api/accounts/alice/renewal-delegations")!;
    expect(post.body.delegation).toEqual({ account: "alice", alg: "p256", renewalPub: rec.pubHex, deviceId: DEVICE, issuedAt: 1_800_000_000_000 });
    expect(verifyServingRecord("renewal-key-delegation", post.body.delegation, post.body.signature, ADMIN_PUB)).toBe(true);
    await ensureDelegation(w.deps);
    expect(w.posts.filter((p) => p.url.endsWith("/renewal-delegations"))).toHaveLength(1);
  });

  it("keeps a delegation .com didn't take and posts the same one next time", async () => {
    const w = world();
    w.fetch.mockImplementationOnce(async () => json(503, { error: "down" }));
    const first = await ensureDelegation(w.deps);
    expect(first.delegation.posted).toBe(false);
    const again = await ensureDelegation(w.deps);
    expect(again.delegation.posted).toBe(true);
    expect(again.delegation.signature).toBe(first.delegation.signature);
  });

  it("forgets a renewal key .com says was revoked, and makes a new one next time", async () => {
    const w = world();
    w.fetch.mockImplementationOnce(async () => json(409, { error: "revoked", code: "renewal-key-revoked" }));
    const first = await ensureRenewalKey(w.deps);
    expect(await ensureDelegation(w.deps)).toBeNull();
    expect(await loadRenewalKey(w.deps)).toBeNull();
    const fresh = await ensureDelegation(w.deps);
    expect(fresh.pubHex).not.toBe(first.pubHex);
    expect(fresh.delegation.posted).toBe(true);
  });

  it("is never delegated from a device that doesn't hold the admin root", async () => {
    const w = world({ signer: { kind: "irk", sign: async () => new Uint8Array(64) } });
    await expect(ensureDelegation(w.deps)).rejects.toThrow(/admin device/);
  });
});

describe("renewal on open", () => {
  it("signs one lease per finite policy, posts them in one call and to each box", async () => {
    const w = world();
    const rows = [
      { serverDomain: "home.alice.flagship.services", boxPub: BOX, regGen: 2, policy: signPolicy(policy7d) },
      { serverDomain: "office.alice.flagship.services", boxPub: "22".repeat(32), regGen: 1, policy: signPolicy({ ...policy7d, box: "22".repeat(32), regGen: 1, grace: "indefinite", onLapse: "stop-apps" }) },
      { serverDomain: "media.alice.flagship.services", boxPub: "33".repeat(32), regGen: 1 },
    ];
    const r = await renewServingLeases({ ...w.deps, rows });
    expect(r).toMatchObject({ signed: 1, accepted: 1, refused: [] });
    const calls = w.posts.filter((p) => p.url.endsWith("/serving-leases"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://flagshipserver.com/api/accounts/alice/serving-leases");
    const [entry] = calls[0]!.body.leases;
    expect(calls[0]!.body.leases).toHaveLength(1);
    expect(entry.lease).toMatchObject({ account: "alice", box: BOX, regGen: 2, policyGen: 3, issuedAt: 1_800_000_000_000, notAfter: 1_800_000_000_000 + 7 * 86_400_000 });
    expect(entry.lease.leaseId).toMatch(/^[0-9a-f]{32}$/);
    const key = await loadRenewalKey(w.deps);
    expect(entry.delegationPub).toBe(key!.pubHex);
    expect(verifyServingLeaseP256(entry.lease, entry.signature, entry.delegationPub)).toBe(true);

    // The box gets the lease with its delegation, so it can check both itself.
    expect(w.box).toHaveLength(1);
    expect(w.box[0]).toMatchObject({ fqdn: "home.alice.flagship.services", path: "/api/screens/serving" });
    const sentToBox = w.box[0]!.body;
    expect(sentToBox.leases[0]).toEqual({ record: entry.lease, signature: entry.signature, delegationPub: entry.delegationPub });
    expect(sentToBox.delegations).toHaveLength(1);
    expect(sentToBox.delegations[0].record.renewalPub).toBe(entry.delegationPub);
    const boxLease = { ...sentToBox.leases[0], delegation: sentToBox.delegations[0] };

    // What the relay and the box decide with these records: apps served until the lease's end.
    const d = servingDecision({
      account: "alice",
      box: BOX,
      regGen: 2,
      adminKeyFromCom: ADMIN_PUB,
      adminKeyFromBox: ADMIN_PUB,
      policies: [rows[0]!.policy!],
      leases: [boxLease],
      revocations: emptyRevocationState(),
      now: 1_800_000_000_000 + 1000,
    });
    expect(d).toMatchObject({ control: true, apps: true, until: entry.lease.notAfter, onLapse: "lock-server" });
  });

  it("signs nothing, and sends nothing, under indefinite policies", async () => {
    const w = world();
    const rows = [{ serverDomain: "home.alice.flagship.services", policy: signPolicy({ ...policy7d, grace: "indefinite", onLapse: "stop-apps" }) }];
    expect(await renewServingLeases({ ...w.deps, rows })).toEqual({ signed: 0 });
    expect(w.posts).toEqual([]);
    expect(w.box).toEqual([]);
    // A fresh install still gets its renewal key, ready for the first finite policy.
    expect(await loadRenewalKey(w.deps)).not.toBeNull();
  });

  it("a non-admin device signs nothing", async () => {
    const w = world({ signer: null, session: { umk: new Uint8Array(32), username: "alice", adminRootSeed: null }, profile: {} });
    const rows = [{ serverDomain: "home.alice.flagship.services", policy: signPolicy(policy7d) }];
    expect(await renewServingLeases({ ...w.deps, rows })).toEqual({ signed: 0 });
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("reads the account's servers from .com when not given them", async () => {
    const w = world();
    w.fetch.mockImplementationOnce(async () => json(200, { servers: [{ serverDomain: "home.alice.flagship.services", policy: signPolicy(policy7d) }] }));
    const r = await renewServingLeases(w.deps);
    expect(w.fetch.mock.calls[0]![0]).toBe("https://flagshipserver.com/api/accounts/alice/serving");
    expect(r.signed).toBe(1);
  });

  it("runs on start, on return to the foreground at most every interval, and only while active", async () => {
    const listeners: Record<string, Array<() => void>> = {};
    const doc = { visibilityState: "visible", addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f) };
    const target = { document: doc, addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f), setInterval: () => 1, clearInterval: () => {} };
    let t = 0;
    let active = false;
    const renew = vi.fn(async () => ({ signed: 0 }));
    const h = startServingRenewal({ isActive: () => active, renew, now: () => t, minIntervalMs: 1000, periodMs: 0, target });
    await h.sync();
    expect(renew).not.toHaveBeenCalled();
    active = true;
    listeners["flagship:view-shown"]![0]!();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    listeners["visibilitychange"]![0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(renew).toHaveBeenCalledTimes(1);
    t = 2000;
    listeners["visibilitychange"]![0]!();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
  });
});

describe("the editor's order", () => {
  const view = { grace: "indefinite", onLapse: "stop-apps", until: null, policyGen: 4, regGen: 2, scopeSha256: SCOPE, boxPub: BOX };

  it("signs policyGen + 1 with the box's scope, posts it to .com and the box, and leases a finite one at once", async () => {
    const w = world();
    const r = await saveServingPolicy({ serverDomain: "home.alice.flagship.services", view, grace: "30d", onLapse: "lock-server" }, w.deps);
    const post = w.posts.find((p) => p.url === "https://flagshipserver.com/api/accounts/alice/serving-policy")!;
    expect(post.body.policy).toEqual({ account: "alice", box: BOX, regGen: 2, policyGen: 5, grace: "30d", onLapse: "lock-server", scopeSha256: SCOPE, issuedAt: 1_800_000_000_000 });
    expect(verifyServingRecord("serving-policy", post.body.policy, post.body.signature, ADMIN_PUB)).toBe(true);
    expect(w.box[0]!.body).toEqual({ policy: { record: post.body.policy, signature: post.body.signature } });
    const leases = w.posts.find((p) => p.url.endsWith("/serving-leases"))!.body.leases;
    expect(leases).toHaveLength(1);
    expect(leases[0].lease).toMatchObject({ policyGen: 5, regGen: 2, notAfter: 1_800_000_000_000 + 30 * 86_400_000 });
    expect(r.until).toBe(1_800_000_000_000 + 30 * 86_400_000);
  });

  it("Never can't lock, and signs no lease", async () => {
    const w = world();
    const r = await saveServingPolicy({ serverDomain: "home.alice.flagship.services", view: { ...view, grace: "7d" }, grace: "indefinite", onLapse: "lock-server" }, w.deps);
    expect(r.policy).toMatchObject({ grace: "indefinite", onLapse: "stop-apps", policyGen: 5 });
    expect(r.until).toBeNull();
    expect(w.posts.filter((p) => p.url.endsWith("/serving-leases"))).toEqual([]);
  });

  it("shows .com's refusal in its own words and sends nothing to the box", async () => {
    const w = world();
    w.fetch.mockImplementationOnce(async () => json(409, { error: "Another device changed this setting. Showing the latest one.", code: "serving-policy-stale" }));
    await expect(saveServingPolicy({ serverDomain: "home.alice.flagship.services", view, grace: "7d", onLapse: "stop-apps" }, w.deps)).rejects.toMatchObject({
      message: "Another device changed this setting. Showing the latest one.",
      status: 409,
      code: "serving-policy-stale",
    });
    expect(w.box).toEqual([]);
  });

  it("won't sign without the box's scope (an older box)", async () => {
    const w = world();
    await expect(saveServingPolicy({ serverDomain: "home.alice.flagship.services", view: { ...view, scopeSha256: null }, grace: "7d", onLapse: "stop-apps" }, w.deps)).rejects.toMatchObject({ code: "no-scope" });
    expect(w.fetch).not.toHaveBeenCalled();
  });
});

describe("the server page's line", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const until = Date.UTC(2026, 10, 14, 12);

  it("reads the box and .com, preferring .com's deadline and policy", () => {
    const detail = { grace: "7d", onLapse: "stop-apps", until: until - 1000, policyGen: 2, regGen: 1, scopeSha256: SCOPE };
    expect(servingView({ detail })).toMatchObject({ grace: "7d", onLapse: "stop-apps", until: until - 1000, policyGen: 2, regGen: 1, scopeSha256: SCOPE, boxPub: null });
    expect(servingView({ detail: { ...detail, boxPub: BOX } })!.boxPub).toBe(BOX);
    const row = { serverDomain: "home.alice.flagship.services", boxPub: BOX, regGen: 1, policy: signPolicy({ ...policy7d, regGen: 1, policyGen: 3 }), until, grace: "7d", onLapse: "lock-server" };
    expect(servingView({ detail, row })).toMatchObject({ grace: "7d", onLapse: "lock-server", until, policyGen: 3, boxPub: BOX });
    expect(servingView({})).toBeNull();
    expect(servingView({ detail: { grace: "indefinite", onLapse: "lock-server", until: 5 } })).toMatchObject({ grace: "indefinite", onLapse: "stop-apps", until: null });
  });

  it("says the date, locks, no limit, or waiting", () => {
    expect(servingLineParts({ grace: "7d", onLapse: "stop-apps", until }, now)).toEqual({ lead: "Stays online until Nov 14", rest: "if no admin opens Flagship", grace: "7 days" });
    expect(servingLineParts({ grace: "30d", onLapse: "lock-server", until }, now)).toEqual({ lead: "Locks on Nov 14", rest: "if no admin opens Flagship", grace: "30 days" });
    expect(servingLineParts({ grace: "indefinite", onLapse: "stop-apps", until: null }, now)).toEqual({ lead: "No time limit", rest: "", grace: "" });
    expect(servingLineParts({ grace: "7d", onLapse: "stop-apps", until: now - 1 }, now).lead).toBe("Its apps are stopped until an admin opens Flagship");
  });
});

describe("a serving policy that locks bounds auto-unlock (SEC-DEADMAN-001, as iOS / Android ServingLockLeaseBound)", () => {
  it("caps a lease at the deadline, and allows none without a live one", async () => {
    const { servingLockLeaseExpiry } = await import("../public/webapp/lib/bootSuspension.js");
    expect(servingLockLeaseExpiry(1_000, false, null, 10)).toBe(1_000);
    expect(servingLockLeaseExpiry(1_000, true, 500, 10)).toBe(500);
    expect(servingLockLeaseExpiry(300, true, 500, 10)).toBe(300);
    expect(servingLockLeaseExpiry(1_000, true, 5, 10)).toBeNull();
    expect(servingLockLeaseExpiry(1_000, true, null, 10)).toBeNull();
  });

  it("remembers what a server's policy says, and forgets it after six hours", async () => {
    const { rememberServingState, cachedServingState } = await import("../public/webapp/lib/bootSuspension.js");
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const S = "home.alice.flagship.services";
    expect(cachedServingState(S, { storage, now: () => 0 })).toBeUndefined();
    rememberServingState(S, { grace: "7d", onLapse: "lock-server", until: 9_000 }, { storage, now: () => 0 });
    expect(cachedServingState(S, { storage, now: () => 1 })).toEqual({ locks: true, until: 9_000 });
    expect(cachedServingState(S, { storage, now: () => 7 * 3_600_000 })).toBeUndefined();
    rememberServingState(S, { grace: "indefinite", onLapse: "lock-server", until: null }, { storage, now: () => 0 });
    expect(cachedServingState(S, { storage, now: () => 1 })).toEqual({ locks: false, until: null });
    rememberServingState(S, { grace: "30d", onLapse: "stop-apps", until: 5 }, { storage, now: () => 0 });
    expect(cachedServingState(S, { storage, now: () => 1 })).toEqual({ locks: false, until: null });
  });

  it("renewal remembers each server's state, with the deadline its new lease sets", async () => {
    const { cachedServingState } = await import("../public/webapp/lib/bootSuspension.js");
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const w = world({ storage });
    const rows = [
      { serverDomain: "home.alice.flagship.services", policy: signPolicy(policy7d), until: 5 },
      { serverDomain: "office.alice.flagship.services", policy: signPolicy({ ...policy7d, box: "22".repeat(32), grace: "indefinite", onLapse: "stop-apps" }) },
    ];
    await renewServingLeases({ ...w.deps, rows });
    expect(cachedServingState("home.alice.flagship.services", { storage, now: w.deps.now })).toEqual({ locks: true, until: 1_800_000_000_000 + 7 * 86_400_000 });
    expect(cachedServingState("office.alice.flagship.services", { storage, now: w.deps.now })).toEqual({ locks: false, until: null });
  });

  it("Lock on: revokes the auto-unlock leases that outlive the deadline before saving, and saves nothing when that fails", async () => {
    const { saveServingChoice } = await import("../public/webapp/lib/servingUi.js");
    const view = { grace: "7d", onLapse: "stop-apps", until: null, policyGen: 1, regGen: 2, scopeSha256: SCOPE, boxPub: BOX };
    const now = 1_800_000_000_000;
    const leases = [{ leaseId: "long", expiresAt: now + 8 * 86_400_000 }, { leaseId: "short", expiresAt: now + 86_400_000 }];
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      return { policy: { grace: "7d", onLapse: "lock-server", policyGen: 2 }, until: now + 7 * 86_400_000 };
    });
    await saveServingChoice(
      { serverDomain: "home.alice.flagship.services", view, grace: "7d", onLapse: "lock-server" },
      { now: () => now, listLeases: async () => leases, revokeLease: async (_s: string, id: string) => void order.push(`revoke ${id}`), saveServingPolicy: save },
    );
    expect(order).toEqual(["revoke long", "save"]);

    const failing = vi.fn(async () => ({}));
    await expect(
      saveServingChoice(
        { serverDomain: "home.alice.flagship.services", view, grace: "7d", onLapse: "lock-server" },
        { now: () => now, listLeases: async () => leases, revokeLease: async () => { throw new Error("revoke lease failed: 503"); }, saveServingPolicy: failing },
      ),
    ).rejects.toMatchObject({ message: "Couldn't remove this server's auto-unlock, so locking was not turned on. revoke lease failed: 503", code: "auto-unlock-revoke" });
    expect(failing).not.toHaveBeenCalled();

    // Not locking: no lease is touched.
    const list = vi.fn(async () => leases);
    await saveServingChoice({ serverDomain: "home.alice.flagship.services", view, grace: "30d", onLapse: "stop-apps" }, { now: () => now, listLeases: list, saveServingPolicy: save });
    expect(list).not.toHaveBeenCalled();
  });
});
