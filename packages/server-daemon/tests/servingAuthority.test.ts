/**
 * The box's half of the serving authority (docs/architecture-v2/serving-wiring.md §3): the store keeps only records
 * the pinned admin key signed, a damaged file can't disarm a lock, the lock fires once and restarts, never under
 * stop-apps, and an approved unlock gets one bounded wait for the approving admin's lease.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { p256 } from "@noble/curves/nist.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boxNameList,
  ed,
  nameListSha256,
  signServingLeaseP256,
  signServingRecord,
  type RenewalKeyDelegation,
  type ServingLease,
  type ServingPolicy,
} from "@flagship/protocol";
import { decodeFrame } from "@flagship/tunnel-protocol";
import { ServingStore, scopeSha256Of } from "../src/servingStore.js";
import { ServingLockController, SERVING_LOCK_KIND } from "../src/servingLock.js";
import { buildServingHttp, SERVING_PATH } from "../src/servingHttp.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import { authorizeRoute, ROUTE_FAMILIES } from "../src/centralAuthorization.js";
import { startTunnelClient, type TunnelWebSocketLike, type WebSocketFactory } from "../src/tunnel/tunnelClient.js";
import type { BootSuspender } from "../src/hostPower.js";
import type { HttpRequest } from "../src/runtime.js";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (n: number) => {
  const seed = new Uint8Array(32).fill(n);
  return { pub: hexOf(ed.getPublicKey(seed)), sign: (m: Uint8Array) => ed.sign(m, seed) };
};
const admin = key(1);
const stranger = key(2);
const BOX = key(5).pub;
const OTHER_BOX = key(7).pub;
const renewal = { sk: new Uint8Array(32).fill(3), pub: "" };
renewal.pub = hexOf(p256.getPublicKey(renewal.sk, true));
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const FQDN = "home.alice.flagship.services";

const policy = (o: Partial<ServingPolicy> = {}): ServingPolicy => ({
  account: "alice",
  box: BOX,
  regGen: 1,
  policyGen: 1,
  grace: "7d",
  onLapse: "lock-server",
  scopeSha256: nameListSha256(boxNameList("home", "alice", "flagship.services")),
  issuedAt: T0,
  ...o,
});
const lease = (o: Partial<ServingLease> = {}): ServingLease => ({
  account: "alice",
  box: BOX,
  regGen: 1,
  policyGen: 1,
  leaseId: "ab".repeat(16),
  issuedAt: T0,
  notAfter: T0 + 7 * DAY,
  ...o,
});
const delegation: RenewalKeyDelegation = { account: "alice", alg: "p256", renewalPub: renewal.pub, deviceId: key(6).pub, issuedAt: T0 };
const sig = <K extends Parameters<typeof signServingRecord>[0]>(kind: K, r: Parameters<typeof signServingRecord<K>>[1], k = admin) =>
  hexOf(signServingRecord(kind, r, k.sign));
const sp = (p: ServingPolicy, k = admin) => ({ record: p, signature: sig("serving-policy", p, k) });
const sl = (l: ServingLease, k = admin) => ({ record: l, signature: sig("serving-lease", l, k) });
const sd = (d = delegation, k = admin) => ({ record: d, signature: sig("renewal-key-delegation", d, k) });

let dir: string;
let now: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-serving-"));
  now = T0 + DAY;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(o: { adminKey?: string | null; changes?: { n: number } } = {}) {
  return new ServingStore({
    path: join(dir, "serving.json"),
    account: "alice",
    boxPub: () => BOX,
    adminKey: o.adminKey === undefined ? admin.pub : o.adminKey,
    serverFqdn: FQDN,
    now: () => now,
    onChange: () => {
      if (o.changes) o.changes.n++;
    },
  });
}

describe("ServingStore: only what the pinned key signed", () => {
  it("keeps a policy and lease signed by the admin key", async () => {
    const changes = { n: 0 };
    const s = store({ changes });
    const r = await s.offer({ regGen: 1, policy: sp(policy()), leases: [sl(lease())] }, ".com");
    expect(r).toEqual({ policyAdopted: true, leasesAccepted: 1, refused: [] });
    expect(s.policy()?.record.policyGen).toBe(1);
    expect(s.leases()).toHaveLength(1);
    expect(changes.n).toBe(1);
    // The same offer again changes nothing.
    await s.offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    expect(changes.n).toBe(1);
  });

  it("refuses a policy or lease signed by another key", async () => {
    const s = store();
    const r = await s.offer({ policy: sp(policy(), stranger) }, ".com");
    expect(r.refused).toEqual([{ kind: "policy", code: "serving-policy-signature" }]);
    expect(s.policy()).toBeNull();
    await s.offer({ policy: sp(policy()) }, ".com");
    const r2 = await s.offer({ leases: [sl(lease(), stranger)] }, ".com");
    expect(r2.leasesAccepted).toBe(0);
    expect(r2.refused[0]).toMatchObject({ kind: "lease", code: "serving-lease-signature" });
  });

  it("refuses a policy for another box or another account", async () => {
    const s = store();
    expect((await s.offer({ policy: sp(policy({ box: OTHER_BOX })) }, ".com")).policyAdopted).toBe(false);
    expect((await s.offer({ policy: sp(policy({ account: "bob" })) }, ".com")).policyAdopted).toBe(false);
    expect(s.policy()).toBeNull();
  });

  it("keeps nothing when the box pins no admin key", async () => {
    const s = store({ adminKey: null });
    await s.offer({ policy: sp(policy()) }, ".com");
    expect(s.policy()).toBeNull();
  });

  it("never goes back to an older policy, and a newer one drops the older policy's leases", async () => {
    const s = store();
    await s.offer({ policy: sp(policy({ policyGen: 2, grace: "30d" })), leases: [sl(lease({ policyGen: 2, notAfter: T0 + 30 * DAY }))] }, ".com");
    const r = await s.offer({ policy: sp(policy({ policyGen: 1 })) }, ".com");
    expect(r.refused).toEqual([{ kind: "policy", code: "serving-policy-stale" }]);
    expect(s.policy()?.record.policyGen).toBe(2);
    expect((await s.offer({ leases: [sl(lease({ policyGen: 1 }))] }, ".com")).refused[0]?.code).toBe("serving-lease-stale");
    await s.offer({ policy: sp(policy({ policyGen: 3, grace: "7d" })) }, "app");
    expect(s.leases()).toHaveLength(0);
  });

  it("refuses a lease longer than the grace", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()) }, ".com");
    const r = await s.offer({ leases: [sl(lease({ notAfter: T0 + 8 * DAY }))] }, ".com");
    expect(r.leasesAccepted).toBe(0);
  });

  it("keeps a P-256 lease through its delegation, and only the best lease per signer", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()) }, ".com");
    const l1 = lease();
    const l2 = lease({ leaseId: "cd".repeat(16), issuedAt: T0 + DAY, notAfter: T0 + 8 * DAY });
    const r = await s.offer(
      {
        delegations: [sd()],
        leases: [
          { record: l1, signature: signServingLeaseP256(l1, renewal.sk), delegationPub: renewal.pub },
          { record: l2, signature: signServingLeaseP256(l2, renewal.sk), delegationPub: renewal.pub },
        ],
      },
      ".com",
    );
    expect(r.leasesAccepted).toBe(2);
    expect(s.leases()).toHaveLength(1);
    expect(s.leases()[0]!.record.leaseId).toBe("cd".repeat(16));
    // An admin-signed lease is a different signer: kept beside it.
    await s.offer({ leases: [sl(lease())] }, "app");
    expect(s.leases()).toHaveLength(2);
    expect(s.bestLeaseEnd()).toBe(T0 + 8 * DAY);
  });

  it("refuses a P-256 lease whose delegation another key signed, or with no delegation at all", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()) }, ".com");
    const l = lease();
    const p = signServingLeaseP256(l, renewal.sk);
    expect((await s.offer({ delegations: [sd(delegation, stranger)], leases: [{ record: l, signature: p, delegationPub: renewal.pub }] }, ".com")).leasesAccepted).toBe(0);
    expect((await s.offer({ leases: [{ record: l, signature: p }] }, ".com")).leasesAccepted).toBe(0);
  });

  it("refuses a high-S P-256 lease", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()) }, ".com");
    const l = lease();
    const low = signServingLeaseP256(l, renewal.sk);
    const n = p256.Point.CURVE().n;
    const high = low.slice(0, 64) + (n - BigInt(`0x${low.slice(64)}`)).toString(16).padStart(64, "0");
    expect((await s.offer({ delegations: [sd()], leases: [{ record: l, signature: high, delegationPub: renewal.pub }] }, ".com")).leasesAccepted).toBe(0);
    expect((await s.offer({ delegations: [sd()], leases: [{ record: l, signature: low, delegationPub: renewal.pub }] }, ".com")).leasesAccepted).toBe(1);
  });

  it("`.com`'s regGen is only shown: it can't make the box drop its policy", async () => {
    const s = store();
    await s.offer({ regGen: 1, policy: sp(policy()), leases: [sl(lease())] }, ".com");
    await s.offer({ regGen: 9 }, ".com");
    expect(s.decisionInput()?.regGen).toBe(1);
    expect(s.view().regGen).toBe(9);
  });

  it("persists and reloads", async () => {
    await store().offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    const b = store();
    await b.load();
    expect(b.policy()?.record).toEqual(policy());
    expect(b.leases()).toHaveLength(1);
  });
});

describe("ServingStore: a damaged file can't disarm the lock", () => {
  it("serving.json damaged: the floor copy brings back the policy and the best lease", async () => {
    await store().offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    await writeFile(join(dir, "serving.json"), '{"policy": {"rec');
    const b = store();
    await b.load();
    expect(b.policy()?.record.onLapse).toBe("lock-server");
    expect(b.leases()).toHaveLength(1);
    // The damaged file was set aside and a whole one written back.
    expect(JSON.parse(await readFile(join(dir, "serving.json"), "utf8")).policy.record.policyGen).toBe(1);
  });

  it("serving.json deleted: the floor copy still holds the lock", async () => {
    await store().offer({ policy: sp(policy()) }, ".com");
    await rm(join(dir, "serving.json"));
    const b = store();
    await b.load();
    expect(b.policy()?.record.onLapse).toBe("lock-server");
  });

  it("the floor copy damaged: serving.json wins and the floor is rewritten", async () => {
    await store().offer({ policy: sp(policy({ policyGen: 2 })) }, ".com");
    await writeFile(join(dir, "serving-floor.json"), "garbage");
    const b = store();
    await b.load();
    expect(b.policy()?.record.policyGen).toBe(2);
    expect(JSON.parse(await readFile(join(dir, "serving-floor.json"), "utf8")).policy.record.policyGen).toBe(2);
  });

  it("an edited file can't plant a policy the admin didn't sign, nor bring back an older one", async () => {
    await store().offer({ policy: sp(policy({ policyGen: 2 })) }, ".com");
    const forged = { comRegGen: 1, policy: sp(policy({ policyGen: 3, onLapse: "stop-apps" }), stranger), leases: [] };
    await writeFile(join(dir, "serving.json"), JSON.stringify(forged));
    const b = store();
    await b.load();
    expect(b.policy()?.record).toMatchObject({ policyGen: 2, onLapse: "lock-server" });
  });

  it("both files lost: the default (indefinitely, stop-apps) until `.com` sends the policy again", async () => {
    await store().offer({ policy: sp(policy()) }, ".com");
    await writeFile(join(dir, "serving.json"), "x");
    await writeFile(join(dir, "serving-floor.json"), "y");
    const b = store();
    await b.load();
    expect(b.policy()).toBeNull();
    expect(b.view()).toMatchObject({ grace: "indefinite", onLapse: "stop-apps", until: null, policyGen: 0 });
  });
});

function lockHarness(s: ServingStore, o: { confirm?: boolean; windowMs?: number } = {}) {
  const events: string[] = [];
  const notes: Array<[string, string]> = [];
  const suspender: BootSuspender = {
    suspend: async (reason) => {
      events.push(`suspend:${reason}`);
      return o.confirm === false ? { confirmed: false, why: "unreachable" } : { confirmed: true };
    },
  };
  const mk = () =>
    new ServingLockController({
      store: s,
      suppressor: { suppress: async () => void events.push("suppress") },
      runner: { power: async (m) => void events.push(`power:${m}`) },
      suspender,
      markerPath: join(dir, "serving-lock.json"),
      note: (k, d) => void notes.push([k, d]),
      now: () => now,
      approvalWindowMs: o.windowMs ?? 15 * 60_000,
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {},
      log: () => {},
    });
  return { events, notes, mk };
}

describe("ServingLockController: the lock", () => {
  it("fires once when the lease lapses, and restarts (never powers off)", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    const h = lockHarness(s);
    const c = h.mk();
    await c.start();
    expect(h.events).toEqual([]);
    now = T0 + 7 * DAY - 1;
    await c.checkOnce();
    expect(h.events).toEqual([]);
    now = T0 + 7 * DAY;
    await c.checkOnce();
    expect(h.events).toEqual(["suppress", "suspend:dead-man", "power:restart"]);
    expect(h.notes).toEqual([[SERVING_LOCK_KIND, expect.stringContaining("7 days")]]);
    await Promise.all([c.checkOnce(), c.checkOnce()]);
    now += DAY;
    await c.checkOnce();
    expect(h.events.filter((e) => e.startsWith("power"))).toHaveLength(1);
    expect(c.lockMarker()).toMatchObject({ confirmed: true, resumedAt: null, policyGen: 1 });
  });

  it("does nothing under stop-apps, under an indefinite policy, or with no policy", async () => {
    for (const p of [policy({ onLapse: "stop-apps" }), policy({ grace: "indefinite", onLapse: "stop-apps" }), null]) {
      await rm(join(dir, "serving.json"), { force: true });
      await rm(join(dir, "serving-floor.json"), { force: true });
      const s = store();
      if (p) await s.offer({ policy: sp(p) }, ".com");
      const h = lockHarness(s);
      const c = h.mk();
      now = T0 + 60 * DAY;
      await c.start();
      expect(h.events).toEqual([]);
    }
  });

  it("never locks sooner than one grace after the policy was signed, even with no lease yet", async () => {
    const s = store();
    await s.offer({ policy: sp(policy({ issuedAt: T0 })) }, ".com");
    const h = lockHarness(s);
    const c = h.mk();
    now = T0 + 6 * DAY;
    await c.start();
    expect(h.events).toEqual([]);
    now = T0 + 7 * DAY;
    await c.checkOnce();
    expect(h.events).toContain("power:restart");
  });

  it("a lease arriving in time keeps the box up; a newer stop-apps policy disarms it", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    const h = lockHarness(s);
    const c = h.mk();
    await c.start();
    now = T0 + 6 * DAY;
    await s.offer({ leases: [sl(lease({ leaseId: "cd".repeat(16), issuedAt: now, notAfter: now + 7 * DAY }))] }, "app");
    now = T0 + 10 * DAY;
    await c.checkOnce();
    expect(h.events).toEqual([]);
    await s.offer({ policy: sp(policy({ policyGen: 2, onLapse: "stop-apps" })) }, "app");
    now = T0 + 40 * DAY;
    await c.checkOnce();
    expect(h.events).toEqual([]);
  });
});

describe("ServingLockController: after an approved unlock", () => {
  async function lockedOnce(o: { confirm?: boolean } = {}) {
    const s = store();
    await s.offer({ policy: sp(policy()), leases: [sl(lease())] }, ".com");
    const h = lockHarness(s, o);
    now = T0 + 8 * DAY;
    await h.mk().start();
    expect(h.events.filter((e) => e.startsWith("power"))).toHaveLength(1);
    h.events.length = 0;
    return { s, h };
  }

  it("waits for the approving admin's lease, which clears the lock", async () => {
    const { s, h } = await lockedOnce();
    now += 10 * 60_000;
    const booted = h.mk();
    await booted.start();
    expect(h.events).toEqual([]);
    expect(booted.lockMarker()?.resumedAt).toBe(now);
    now += 60_000;
    await s.offer({ leases: [sl(lease({ leaseId: "ef".repeat(16), issuedAt: now, notAfter: now + 7 * DAY }))] }, "the approving phone");
    await booted.checkOnce();
    expect(booted.lockMarker()).toBeNull();
    now += 6 * DAY;
    await booted.checkOnce();
    expect(h.events).toEqual([]);
  });

  it("locks again when no lease arrives within the wait", async () => {
    const { h } = await lockedOnce();
    const booted = h.mk();
    await booted.start();
    now += 14 * 60_000;
    await booted.checkOnce();
    expect(h.events).toEqual([]);
    now += 60_000;
    await booted.checkOnce();
    expect(h.events).toContain("power:restart");
    expect(booted.lockMarker()).toMatchObject({ resumedAt: null });
  });

  it("a reboot during the wait doesn't start another wait", async () => {
    const { h } = await lockedOnce();
    await h.mk().start();
    now += 15 * 60_000;
    // Rebooted (without a fresh approval: the one-shot suppression was used up) after the wait ran out.
    await h.mk().start();
    expect(h.events).toContain("power:restart");
  });

  it("no wait when the boot worker never confirmed the lock (the next boot may not have needed an approval)", async () => {
    const { h } = await lockedOnce({ confirm: false });
    const booted = h.mk();
    await booted.start();
    expect(h.events.some((e) => e.startsWith("power"))).toBe(true);
  });

  it("an unreadable marker grants no wait", async () => {
    const { h } = await lockedOnce();
    await writeFile(join(dir, "serving-lock.json"), "{bad");
    await h.mk().start();
    expect(h.events).toContain("power:restart");
  });
});

describe("POST /api/screens/serving and server-detail", () => {
  const req = (o: Partial<HttpRequest>): HttpRequest => ({ method: "GET", path: SERVING_PATH, headers: {}, body: Buffer.alloc(0), ...o });

  it("takes an admin's records and answers with the view; a companion can't post", async () => {
    const s = store();
    let companion = false;
    const h = buildServingHttp({
      store: s,
      denyCompanion: () => (companion ? { status: 403, headers: {}, body: "{}" } : null),
    });
    const body = Buffer.from(JSON.stringify({ policy: sp(policy()), leases: [sl(lease())], regGen: 99 }));
    const r = await h(SERVING_PATH, "POST", req({ method: "POST", body }));
    const out = JSON.parse(String(r!.body));
    expect(out).toMatchObject({ ok: true, policyAdopted: true, leasesAccepted: 1, serving: { grace: "7d", onLapse: "lock-server", policyGen: 1, regGen: 1 } });
    expect(out.serving.until).toBe(T0 + 7 * DAY);
    expect((await h(SERVING_PATH, "POST", req({ method: "POST", body: Buffer.from("[") })))!.status).toBe(400);
    companion = true;
    expect((await h(SERVING_PATH, "POST", req({ method: "POST", body })))!.status).toBe(403);
  });

  it("server-detail carries serving with the scope hash a policy edit signs", async () => {
    const s = store();
    await s.offer({ regGen: 2 }, ".com");
    const handle = buildScreensHttp({
      serverFqdn: FQDN,
      username: "alice",
      daemonVersion: "t",
      startedAt: 0,
      now: () => now,
      gate: { has: () => true, check: () => null },
      serving: s,
    });
    const r = await handle(req({ path: "/api/screens/server-detail" }));
    const body = JSON.parse(String(r!.body));
    expect(body.deadMan).toBeUndefined();
    expect(body.serving).toEqual({
      grace: "indefinite",
      onLapse: "stop-apps",
      until: null,
      policyGen: 0,
      regGen: 2,
      scopeSha256: nameListSha256(boxNameList("home", "alice", "flagship.services")),
      boxPub: BOX,
    });
    expect(scopeSha256Of(FQDN, "alice")).toBe(body.serving.scopeSha256);
  });
});

describe("HELLO carries the serving fields", () => {
  class FakeWS extends EventEmitter implements TunnelWebSocketLike {
    readyState = 1;
    binaryType = "arraybuffer";
    sent: Uint8Array[] = [];
    close(): void {
      this.readyState = 3;
      this.emit("close");
    }
    send(data: Uint8Array | string): void {
      if (typeof data !== "string") this.sent.push(data);
    }
    ping(): void {}
  }

  it("sends servingAdminKey and servingPolicy", async () => {
    const s = store();
    await s.offer({ policy: sp(policy()) }, ".com");
    const ws = new FakeWS();
    const factory: WebSocketFactory = Object.assign(((_u: string) => ws) as (u: string) => TunnelWebSocketLike, { OPEN: 1, CLOSED: 3 });
    const client = startTunnelClient({
      hubUrl: "wss://hub.example/tunnel",
      sign: () => new Uint8Array(64),
      getEntitlements: async () => ({
        rootEntitlement: { username: "alice", podPubKey: new Uint8Array(32), podCanonical: FQDN, issuedAt: 0 },
        rootEntitlementSig: new Uint8Array(64),
      }),
      resolveBackend: () => null,
      wsFactory: factory,
      servingHello: () => s.helloFields(),
    });
    ws.emit("open");
    for (let i = 0; i < 200 && ws.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const d = decodeFrame(ws.sent[0]!);
    if (d.kind !== "ok") throw new Error("no HELLO frame");
    const hello = JSON.parse(new TextDecoder().decode(d.frame.payload));
    expect(hello.servingAdminKey).toBe(admin.pub);
    expect(hello.servingPolicy).toEqual(sp(policy()));
    void client.close().catch(() => {});
  });
});

describe("the old dead-man routes are gone", () => {
  it("no /api/deadman route family, and a Remote session can't post serving records", () => {
    expect(Object.keys(ROUTE_FAMILIES)).not.toContain("/api/deadman");
    expect(authorizeRoute("companion", "GET", "/api/deadman").allow).toBe(false);
    expect(authorizeRoute("companion", "POST", "/api/screens/serving").allow).toBe(false);
    expect(authorizeRoute("companion", "GET", "/api/screens/serving").allow).toBe(true);
  });

  it("the daemon's sources no longer mount them", async () => {
    const src = await readFile(join(__dirname, "../src/index.ts"), "utf8");
    expect(src).not.toMatch(/api\/deadman|DeadManController|set-deadman-policy|deadman-affirm/);
  });
});
