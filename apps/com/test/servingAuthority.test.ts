/**
 * The serving authority on `.com` (docs/architecture-v2/serving-wiring.md §1) over a real D1-over-sqlite
 * binding with every migration applied: the four account routes, the internal relay routes, the
 * trigger-written revocation log and the heartbeat's `serving` block.
 */
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  ACCOUNT_READ_TOKEN_LABEL,
  applyRevocationEntries,
  deriveIRK,
  ed,
  emptyRevocationState,
  leaseFor,
  signDeviceEndpointClaim,
  signServingLeaseP256,
  signServingRecord,
  type RenewalKeyDelegation,
  type ServingLease,
  type ServingPolicy,
} from "@flagship/protocol";
import { endpointFor, LIMITS } from "../src/rateLimit.js";
import { mayCommitRevocation, servingForBox } from "../src/servingAuthority.js";

const ORIGIN = "https://flagshipserver.com";
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const seed = (n: number) => new Uint8Array(32).fill(n);
const ADMIN = seed(1);
const OTHER = seed(2);
const adminPub = hex(ed.getPublicKey(ADMIN));
const BOX = hex(ed.getPublicKey(seed(9)));
const BOX2 = hex(ed.getPublicKey(seed(10)));
const DEVICE_PUB = hex(ed.getPublicKey(seed(20)));
const DEVICE_ID = "d".repeat(32);
const RENEWAL = p256.utils.randomSecretKey();
const RENEWAL_PUB = hex(p256.getPublicKey(RENEWAL, true));
const SEED_HEX = "11".repeat(32);
const REVOCATION_PUB = hex(ed.getPublicKey(seed(0x11)));
const CONTROL = "control-secret";
const irk = deriveIRK({ seed: seed(5) });

const sign = (msg: Uint8Array, key = ADMIN) => ed.sign(msg, key);

async function setup() {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1, adminRootPubHex: adminPub });
  await storage.usernames.put({ username: "bob", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: "home.alice.flagship.services", username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
  await storage.servers.put({ serverDomain: "home.bob.flagship.services", username: "bob", identityPubKeyHex: BOX2, registeredAt: 1 });
  await storage.deviceIdentities.put({
    accountId: "alice", deviceId: DEVICE_ID, devicePubHex: DEVICE_PUB, platformClass: null, createdAt: 1, lastSeenAt: 1, revokedAt: null,
  });
  const env: ControlPlaneEnv = {
    DB: sqlite as unknown as D1Database,
    ACCOUNT_READ_TOKEN_SECRET: "route-secret",
    SERVICES_CONTROL_SECRET: CONTROL,
    SERVING_REVOCATION_SEED: SEED_HEX,
  };
  return { env, storage, sqlite, close: () => sqlite.close() };
}

const call = (env: ControlPlaneEnv, path: string, init: RequestInit & { json?: unknown } = {}) =>
  tryControlPlane(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      ...(init.json !== undefined ? { method: "POST", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: JSON.stringify(init.json) } : {}),
    }),
    env,
  ) as Promise<Response>;
const internal = (env: ControlPlaneEnv, path: string, secret = CONTROL) => call(env, path, { headers: { authorization: `Bearer ${secret}` } });

function policy(o: Partial<ServingPolicy> = {}): ServingPolicy {
  return { account: "alice", box: BOX, regGen: 1, policyGen: 1, grace: "7d", onLapse: "stop-apps", scopeSha256: "ab".repeat(32), issuedAt: Date.now(), ...o };
}
function signedPolicy(p: ServingPolicy, key = ADMIN) {
  return { policy: p, signature: hex(signServingRecord("serving-policy", p, (m) => sign(m, key))) };
}
function delegation(o: Partial<RenewalKeyDelegation> = {}): RenewalKeyDelegation {
  return { account: "alice", alg: "p256", renewalPub: RENEWAL_PUB, deviceId: DEVICE_PUB, issuedAt: Date.now(), ...o };
}
const leaseId = (n: number) => n.toString(16).padStart(32, "0");

async function withPolicy(env: ControlPlaneEnv, p = policy()) {
  const r = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(p) });
  expect(r.status).toBe(200);
  return p;
}

async function readToken(env: ControlPlaneEnv, user: string) {
  const now = Date.now();
  const claim = { username: user, endpointLabel: ACCOUNT_READ_TOKEN_LABEL, phoneIrkPub: irk.publicKey, issuedAt: now, expiresAt: now + 60_000, nonce: crypto.getRandomValues(new Uint8Array(32)) };
  const r = await call(env, `/api/accounts/${user}/read-token`, {
    json: { auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) }, authSignature: hex(signDeviceEndpointClaim(claim, irk)) },
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

describe("serving-policy", () => {
  it("stores an admin-signed policy and refuses a stale generation", async () => {
    const { env, close } = await setup();
    try {
      await withPolicy(env);
      const again = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(policy()) });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "serving-policy-stale" });
      const newer = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(policy({ policyGen: 2, grace: "30d" })) });
      expect(newer.status).toBe(200);
    } finally {
      close();
    }
  });

  it("refuses the wrong key, another account's box and another regGen", async () => {
    const { env, close } = await setup();
    try {
      const wrongKey = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(policy(), OTHER) });
      expect(wrongKey.status).toBe(403);
      expect(await wrongKey.json()).toMatchObject({ code: "serving-policy-signature" });
      // The membership IRK is not the admin key on an admin-pinned account.
      const irkSigned = { policy: policy(), signature: hex(signServingRecord("serving-policy", policy(), (m) => ed.sign(m, irk.privateKey))) };
      expect((await call(env, "/api/accounts/alice/serving-policy", { json: irkSigned })).status).toBe(403);
      const otherBox = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(policy({ box: BOX2 })) });
      expect(await otherBox.json()).toMatchObject({ code: "serving-unknown-box" });
      const regGen = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(policy({ regGen: 2 })) });
      expect(regGen.status).toBe(409);
      expect(await regGen.json()).toMatchObject({ code: "serving-reg-gen" });
      const forBob = await call(env, "/api/accounts/alice/serving-policy", { json: signedPolicy(policy({ account: "bob" })) });
      expect(await forBob.json()).toMatchObject({ code: "serving-account" });
    } finally {
      close();
    }
  });
});

describe("renewal-delegations and serving-leases", () => {
  it("accepts admin and renewal-key leases and refuses the rest, each with a code", async () => {
    const { env, close } = await setup();
    try {
      const p = await withPolicy(env);
      const d = delegation();
      const dr = await call(env, "/api/accounts/alice/renewal-delegations", {
        json: { delegation: d, signature: hex(signServingRecord("renewal-key-delegation", d, (m) => sign(m))) },
      });
      expect(dr.status).toBe(200);
      const now = Date.now();
      const byAdmin = leaseFor(p, now, leaseId(1))!;
      const byKey = leaseFor(p, now + 1, leaseId(2))!;
      const forBob: ServingLease = { ...leaseFor(p, now, leaseId(3))!, account: "bob", box: BOX2 };
      const oldGen: ServingLease = { ...leaseFor(p, now, leaseId(4))!, policyGen: 9 };
      const wrongReg: ServingLease = { ...leaseFor(p, now, leaseId(5))!, regGen: 2 };
      const expired: ServingLease = { ...leaseFor(p, now - 8 * 86_400_000, leaseId(6))!, notAfter: now - 86_400_000 };
      const tooLong: ServingLease = { ...leaseFor(p, now, leaseId(7))!, notAfter: now + 8 * 86_400_000 };
      const sigOf = (l: ServingLease, key = ADMIN) => hex(signServingRecord("serving-lease", l, (m) => sign(m, key)));
      const r = await call(env, "/api/accounts/alice/serving-leases", {
        json: {
          leases: [
            { lease: byAdmin, signature: sigOf(byAdmin) },
            { lease: byKey, signature: signServingLeaseP256(byKey, RENEWAL), delegationPub: RENEWAL_PUB },
            { lease: forBob, signature: sigOf(forBob) },
            { lease: oldGen, signature: sigOf(oldGen) },
            { lease: wrongReg, signature: sigOf(wrongReg) },
            { lease: expired, signature: sigOf(expired) },
            { lease: tooLong, signature: sigOf(tooLong) },
            { lease: byAdmin, signature: sigOf(byAdmin, OTHER) },
            { lease: byAdmin, signature: sigOf(byAdmin), delegationPub: "02" + "ab".repeat(32) },
            { lease: { nope: true }, signature: sigOf(byAdmin) },
          ],
        },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { accepted: number; refused: Array<{ leaseId: string | null; code: string }> };
      expect(body.accepted).toBe(2);
      expect(body.refused.map((x) => x.code)).toEqual([
        "serving-lease-account",
        "serving-lease-policy-gen",
        "serving-lease-reg-gen",
        "serving-lease-expired",
        "serving-lease-invalid",
        "serving-lease-invalid",
        "serving-lease-delegation",
        "serving-lease-malformed",
      ]);

      // The relay's view: admin key, regGen, the policy and both leases (the renewal one with its delegation).
      const box = await internal(env, `/api/internal/serving/alice/${BOX}`);
      expect(box.status).toBe(200);
      const view = (await box.json()) as { adminKey: string; regGen: number; policy: { record: ServingPolicy }; leases: Array<{ delegationPub?: string; delegation?: unknown }>; delegations: unknown[] };
      expect(view.adminKey).toBe(adminPub);
      expect(view.regGen).toBe(1);
      expect(view.policy.record.policyGen).toBe(1);
      expect(view.leases).toHaveLength(2);
      expect(view.leases.find((l) => l.delegationPub)?.delegationPub).toBe(RENEWAL_PUB);
      expect(view.delegations).toHaveLength(1);
      expect((await internal(env, `/api/internal/serving/alice/${BOX}`, "wrong")).status).toBe(401);
      expect((await internal(env, `/api/internal/serving/alice/${BOX2}`)).status).toBe(404);
    } finally {
      close();
    }
  });

  it("refuses a lease under no limit, and a delegation for a removed device", async () => {
    const { env, storage, close } = await setup();
    try {
      await withPolicy(env, policy({ grace: "indefinite" }));
      const p = policy({ grace: "7d" });
      const l = leaseFor(p, Date.now(), leaseId(1))!;
      const r = await call(env, "/api/accounts/alice/serving-leases", { json: { leases: [{ lease: l, signature: hex(signServingRecord("serving-lease", l, (m) => sign(m))) }] } });
      expect(((await r.json()) as { refused: Array<{ code: string }> }).refused[0]?.code).toBe("serving-lease-no-limit");

      await storage.deviceIdentities.revoke("alice", DEVICE_ID, Date.now());
      const d = delegation();
      const dr = await call(env, "/api/accounts/alice/renewal-delegations", {
        json: { delegation: d, signature: hex(signServingRecord("renewal-key-delegation", d, (m) => sign(m))) },
      });
      expect(dr.status).toBe(403);
      expect(await dr.json()).toMatchObject({ code: "renewal-delegation-device" });
      const wrong = await call(env, "/api/accounts/alice/renewal-delegations", {
        json: { delegation: d, signature: hex(signServingRecord("renewal-key-delegation", d, (m) => sign(m, OTHER))) },
      });
      expect(await wrong.json()).toMatchObject({ code: "renewal-delegation-signature" });
    } finally {
      close();
    }
  });

  it("removing a device revokes its renewal key: one signed entry, and its leases are refused", async () => {
    const { env, storage, close } = await setup();
    try {
      const p = await withPolicy(env);
      const d = delegation();
      await call(env, "/api/accounts/alice/renewal-delegations", {
        json: { delegation: d, signature: hex(signServingRecord("renewal-key-delegation", d, (m) => sign(m))) },
      });
      await storage.deviceIdentities.revoke("alice", DEVICE_ID, Date.now());
      const l = leaseFor(p, Date.now(), leaseId(1))!;
      const r = await call(env, "/api/accounts/alice/serving-leases", {
        json: { leases: [{ lease: l, signature: signServingLeaseP256(l, RENEWAL), delegationPub: RENEWAL_PUB }] },
      });
      expect(((await r.json()) as { refused: Array<{ code: string }> }).refused[0]?.code).toBe("serving-lease-key-revoked");

      const log = await internal(env, "/api/internal/serving-revocations?since=0");
      const { entries, sequence } = (await log.json()) as { entries: Array<{ entry: { kind: string; subject: string } }>; sequence: number };
      expect(sequence).toBe(1);
      expect(entries.map((e) => [e.entry.kind, e.entry.subject])).toEqual([["renewal-key", RENEWAL_PUB]]);
      const applied = applyRevocationEntries(emptyRevocationState(), entries as never, REVOCATION_PUB);
      expect(applied.ok && applied.state.renewalKeys.has(RENEWAL_PUB)).toBe(true);
      // Re-delegating the same key never revives it.
      const again = await call(env, "/api/accounts/alice/renewal-delegations", {
        json: { delegation: d, signature: hex(signServingRecord("renewal-key-delegation", d, (m) => sign(m))) },
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "renewal-key-revoked" });
    } finally {
      close();
    }
  });
});

describe("the revocation log", () => {
  it("appends a signed box entry on revoke, in sequence, and un-revoking starts a new regGen", async () => {
    const { env, storage, sqlite, close } = await setup();
    try {
      await storage.servers.revoke("home.alice.flagship.services", "lost", 1_000);
      await storage.servers.revoke("home.alice.flagship.services", "again", 2_000);
      await storage.servers.revoke("home.bob.flagship.services", "lost", 3_000);
      const r = await internal(env, "/api/internal/serving-revocations?since=0");
      const body = (await r.json()) as { entries: Array<{ entry: { sequence: number; kind: string; account: string; subject: string; generation: number; revokedAt: number }; signature: string }>; sequence: number };
      expect(body.sequence).toBe(2);
      expect(body.entries.map((e) => e.entry)).toEqual([
        { sequence: 1, kind: "box", account: "alice", subject: BOX, generation: 1, revokedAt: 1_000 },
        { sequence: 2, kind: "box", account: "bob", subject: BOX2, generation: 1, revokedAt: 3_000 },
      ]);
      const applied = applyRevocationEntries(emptyRevocationState(), body.entries as never, REVOCATION_PUB);
      expect(applied.ok).toBe(true);
      expect(applyRevocationEntries(emptyRevocationState(), body.entries as never, adminPub).ok).toBe(false);
      const later = (await (await internal(env, "/api/internal/serving-revocations?since=1")).json()) as { entries: unknown[] };
      expect(later.entries).toHaveLength(1);

      await storage.servers.unrevoke("home.alice.flagship.services");
      const row = sqlite.raw.prepare("SELECT reg_gen FROM servers WHERE server_domain = ?").get("home.alice.flagship.services") as { reg_gen: number };
      expect(row.reg_gen).toBe(2);
      const hb = await servingForBox(env.DB!, { username: "alice", identityPubKeyHex: BOX });
      expect(hb?.regGen).toBe(2);
      await storage.servers.revoke("home.alice.flagship.services", "lost", 4_000);
      const third = (await (await internal(env, "/api/internal/serving-revocations?since=2")).json()) as { entries: Array<{ entry: { generation: number } }> };
      expect(third.entries.map((e) => e.entry.generation)).toEqual([2]);
    } finally {
      close();
    }
  });

  it("serves the public key and refuses the internal routes without the control secret", async () => {
    const { env, close } = await setup();
    try {
      const key = await call(env, "/api/serving/revocation-key");
      expect(await key.json()).toEqual({ alg: "ed25519", publicKey: REVOCATION_PUB });
      expect((await internal(env, "/api/internal/serving-revocations?since=0", "nope")).status).toBe(401);
      expect((await call(env, "/api/internal/serving-revocations?since=0")).status).toBe(401);
      const unset = await call({ ...env, SERVING_REVOCATION_SEED: undefined }, "/api/serving/revocation-key");
      expect(unset.status).toBe(503);
    } finally {
      close();
    }
  });

  it("knows which writes can commit a revocation", () => {
    expect(mayCommitRevocation("POST", "/api/server-registry/revoke")).toBe(true);
    expect(mayCommitRevocation("DELETE", "/api/accounts/alice/devices/abc")).toBe(true);
    expect(mayCommitRevocation("GET", "/api/server-registry/revoke")).toBe(false);
    expect(mayCommitRevocation("POST", "/api/accounts/alice/serving-leases")).toBe(false);
  });
});

describe("GET /api/accounts/:u/serving", () => {
  it("needs the account read token and shows the deadline", async () => {
    const { env, storage, close } = await setup();
    try {
      // bob's admin key is his IRK (no admin root pinned).
      const p = policy({ account: "bob", box: BOX2, grace: "30d", onLapse: "lock-server" });
      const pr = await call(env, "/api/accounts/bob/serving-policy", {
        json: { policy: p, signature: hex(signServingRecord("serving-policy", p, (m) => ed.sign(m, irk.privateKey))) },
      });
      expect(pr.status).toBe(200);
      const l = leaseFor(p, Date.now(), leaseId(1))!;
      await call(env, "/api/accounts/bob/serving-leases", { json: { leases: [{ lease: l, signature: hex(signServingRecord("serving-lease", l, (m) => ed.sign(m, irk.privateKey))) }] } });

      expect((await call(env, "/api/accounts/bob/serving")).status).toBe(401);
      const token = await readToken(env, "bob");
      const r = await call(env, "/api/accounts/bob/serving", { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      const { servers } = (await r.json()) as { servers: Array<{ boxPub: string; until: number | null; onLapse: string; grace: string; serving: boolean; confirmedByRelays: boolean }> };
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ boxPub: BOX2, until: l.notAfter, onLapse: "lock-server", grace: "30d", serving: true, confirmedByRelays: true });

      // After a revocation no relay has acknowledged yet, it is not confirmed.
      await storage.servers.revoke("home.bob.flagship.services", "lost", Date.now());
      const after = (await (await call(env, "/api/accounts/bob/serving", { headers: { authorization: `Bearer ${token}` } })).json()) as { servers: Array<{ revoked: boolean; confirmedByRelays: boolean }> };
      expect(after.servers[0]).toMatchObject({ revoked: true, confirmedByRelays: false });
    } finally {
      close();
    }
  });
});

describe("rate limits", () => {
  it("meters lease posts and signed writes per source and per account", () => {
    expect(endpointFor("POST", "/api/accounts/alice/serving-leases")).toBe("serving-lease");
    expect(endpointFor("POST", "/api/accounts/alice/serving-policy")).toBe("serving-signed");
    expect(endpointFor("POST", "/api/accounts/alice/renewal-delegations")).toBe("serving-signed");
    expect(LIMITS["serving-lease"].some((r) => r.axis === "subject")).toBe(true);
  });
});
