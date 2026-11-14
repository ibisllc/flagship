/**
 * The certificate issuance service (docs/architecture-v2/issuance-service.md) over a real D1-over-sqlite binding and a
 * fake ACME CA that checks DNS-01 against a fake zone. Each refusal rule of the journal's Appendix H "Issuance boundary"
 * (steps 1-6) and scenario 5 (a box with the account wildcard grant asks for the bare user name) is one case here.
 */
import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { D1Storage, type D1Database } from "@flagship/storage";
import {
  boxNameList,
  ed,
  nameListSha256,
  signDeviceCapabilityGrant,
  SERVER_WILDCARD_GRANT_MAX_AGE_MS,
  signServerWildcardGrant,
  signServingRecord,
  type CertificateOrder,
  type DeviceCapabilityGrant,
  type ServingPolicy,
} from "@flagship/protocol";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { runIssuanceSweep, tryIssuanceRoute, type IssuanceDeps, type IssuanceEnv } from "../src/certificateIssuance.js";
import { cronPlan, TEN_MINUTE_CRON } from "../src/cronPlan.js";
import { ISSUANCE_LIMITS } from "@flagship/control-plane";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { accountKeyPem, FakeAcme, FakeDns, makeCsr } from "./support/fakeAcme.js";

const ORIGIN = "https://flagshipserver.com";
const APEX = "flagship.services";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (n: number) => new Uint8Array(32).fill(n);
const ADMIN = seed(1);
const BOX_KEY = seed(9);
const BOX = hex(ed.getPublicKey(BOX_KEY));
const BOB_BOX_KEY = seed(10);
const BOB_BOX = hex(ed.getPublicKey(BOB_BOX_KEY));
const PHONE_KEY = seed(20);
const PHONE = hex(ed.getPublicKey(PHONE_KEY));
const PHONE_ID = "a1".repeat(16);
const TABLET_KEY = seed(21);
const TABLET = hex(ed.getPublicKey(TABLET_KEY));
const TABLET_ID = "b2".repeat(16);
const SERVER = `home.alice.${APEX}`;
const ACCOUNT_KEY = await accountKeyPem();

async function setup() {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const storage = new D1Storage(db);
  const adminPub = hex(ed.getPublicKey(ADMIN));
  await storage.usernames.put({ username: "alice", irkPubHex: hex(ed.getPublicKey(seed(5))), claimedAt: 1, adminRootPubHex: adminPub });
  await storage.usernames.put({ username: "bob", irkPubHex: hex(ed.getPublicKey(seed(6))), claimedAt: 1 });
  await storage.servers.put({ serverDomain: SERVER, username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
  await storage.servers.put({ serverDomain: `home.bob.${APEX}`, username: "bob", identityPubKeyHex: BOB_BOX, registeredAt: 1 });
  for (const [id, pub] of [[PHONE_ID, PHONE], [TABLET_ID, TABLET]] as const) {
    await storage.deviceIdentities.put({ accountId: "alice", deviceId: id, devicePubHex: pub, platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
  }
  const grant: DeviceCapabilityGrant = {
    grantId: "g-admin",
    username: "alice",
    deviceId: PHONE_ID,
    devicePubKey: ed.getPublicKey(PHONE_KEY),
    scopes: ["admin", "view-directory"],
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 10 * 86_400_000,
  };
  await storage.deviceCapabilityGrants.put({
    grantId: grant.grantId,
    username: "alice",
    deviceId: PHONE_ID,
    devicePubHex: PHONE,
    scopesJson: JSON.stringify(grant.scopes),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(grant, { privateKey: ADMIN, publicKey: ed.getPublicKey(ADMIN) } as never)),
    revokedAt: null,
    signerRoot: "admin-root",
  });
  const dns = new FakeDns();
  const ca = new FakeAcme(dns);
  const clock = { t: Date.now() };
  const env: IssuanceEnv = { DB: db, ISSUANCE_ACME_ACCOUNT_KEY: ACCOUNT_KEY, ISSUANCE_ACME_DIRECTORY: ca.directory, SERVICES_APEX: APEX };
  const deps: IssuanceDeps = {
    usernames: storage.usernames,
    grants: storage.deviceCapabilityGrants,
    dns,
    fetchImpl: ca.fetch as typeof fetch,
    now: () => clock.t,
    propagationMs: 0,
    challengeQuietMs: 0,
  };
  return { sqlite, db, storage, dns, ca, clock, env, deps, close: () => sqlite.close() };
}
type World = Awaited<ReturnType<typeof setup>>;

const rid = () => hex(webcrypto.getRandomValues(new Uint8Array(16)));
async function sha256(b: Uint8Array) {
  return hex(new Uint8Array(await webcrypto.subtle.digest("SHA-256", b)));
}

interface Ask {
  cls: CertificateOrder["class"];
  names: string[];
  key?: Uint8Array;
  device?: string;
  server?: string | null;
  account?: string;
  regGen?: number;
  grant?: boolean | { issuedAt: number; signature: string };
  csr?: { der: Uint8Array; keys: CryptoKeyPair };
  csrSha256?: string;
  issuedAt?: number;
  requestId?: string;
  extraIp?: string;
}

async function ask(w: World, a: Ask) {
  const key = a.key ?? (a.cls === "phone" ? PHONE_KEY : BOX_KEY);
  const csr = a.csr ?? (await makeCsr(a.names, a.extraIp ? { extraIp: a.extraIp } : {}));
  const order: CertificateOrder = {
    class: a.cls,
    device: a.device ?? hex(ed.getPublicKey(key)),
    regGen: a.regGen ?? (a.cls === "phone" ? 0 : 1),
    csrSha256: a.csrSha256 ?? (await sha256(csr.der)),
    requestId: a.requestId ?? rid(),
    issuedAt: a.issuedAt ?? w.clock.t,
  };
  const grant =
    a.grant === true
      ? (() => {
          const issuedAt = w.clock.t - 1000;
          const sig = signServerWildcardGrant({ username: "alice", serverDomain: SERVER, stkPubHex: BOX, issuedAt }, (m) => ed.sign(m, ADMIN));
          return { issuedAt, signature: hex(sig) };
        })()
      : a.grant || undefined;
  const body = {
    account: a.account ?? "alice",
    ...(a.server !== null ? { server: a.server ?? (a.cls === "phone" ? undefined : SERVER) } : {}),
    order,
    signature: hex(signServingRecord("certificate-order", order, (m) => ed.sign(m, key))),
    csr: Buffer.from(csr.der).toString("base64url"),
    ...(grant ? { serverWildcardGrant: grant } : {}),
  };
  const res = (await tryIssuanceRoute(
    new Request(`${ORIGIN}/api/certificates/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    w.env,
    w.deps,
  ))!;
  return { res, json: (await res.json()) as Record<string, unknown>, body, csr };
}

async function poll(w: World, orderId: string) {
  const res = (await tryIssuanceRoute(new Request(`${ORIGIN}/api/certificates/orders/${orderId}`), w.env, w.deps))!;
  return (await res.json()) as Record<string, unknown>;
}

async function drive(w: World, orderId: string, beforeStep?: (step: string) => Promise<void>) {
  for (let i = 0; i < 12; i++) {
    const v = await poll(w, orderId);
    if (v.status !== "pending") return v;
    if (beforeStep) await beforeStep(String(v.step));
    w.clock.t += 1000;
  }
  throw new Error("order did not finish");
}

async function issue(w: World, a: Ask) {
  const r = await ask(w, a);
  expect(r.res.status, JSON.stringify(r.json)).toBe(202);
  return { ...r, done: await drive(w, String(r.json.orderId)) };
}

describe("issuance: names come from .com's records", () => {
  it("issues a box's control certificate for exactly its control name, writing only that order's record", async () => {
    const w = await setup();
    try {
      const { done } = await issue(w, { cls: "control", names: [SERVER] });
      expect(done).toMatchObject({ status: "issued", class: "control", names: [SERVER] });
      expect(String(done.chainPem)).toContain("BEGIN CERTIFICATE");
      expect(w.dns.written).toEqual([`_acme-challenge.${SERVER}`]);
      expect(w.dns.records.size).toBe(0);
    } finally {
      w.close();
    }
  });

  it("issues the apps certificate with the account wildcard only with the admin's grant", async () => {
    const w = await setup();
    try {
      const without = await issue(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(without.done).toMatchObject({ status: "issued", names: [`*.${SERVER}`] });
      const withGrant = await issue(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`], grant: true });
      expect(withGrant.done).toMatchObject({ status: "issued", names: [`*.alice.${APEX}`, `*.${SERVER}`] });
      expect(new Set(w.dns.written)).toEqual(new Set([`_acme-challenge.${SERVER}`, `_acme-challenge.alice.${APEX}`]));
      // The account wildcard without a grant, and a forged grant, are refused.
      expect((await ask(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`] })).json.code).toBe("issuance-csr-names");
      const forged = await ask(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`], grant: { issuedAt: 1, signature: "00".repeat(64) } });
      expect(forged.json.code).toBe("issuance-wildcard-grant");
    } finally {
      w.close();
    }
  });

  it("orders sharing a challenge name take turns, so neither sees the other's record (gym 20)", async () => {
    const w = await setup();
    try {
      const control = await ask(w, { cls: "control", names: [SERVER] });
      const apps = await ask(w, { cls: "apps", names: [`*.${SERVER}`] });
      const [c, a] = [String(control.json.orderId), String(apps.json.orderId)];
      const seen: string[] = [];
      let vc = await poll(w, c);
      let va = await poll(w, a);
      for (let i = 0; i < 24 && (vc.status === "pending" || va.status === "pending"); i++) {
        // While one holds _acme-challenge.<server>, the other has published nothing.
        expect(w.dns.records.size).toBeLessThanOrEqual(1);
        seen.push(`${vc.step}/${va.step}`);
        w.clock.t += 1000;
        if (vc.status === "pending") vc = await poll(w, c);
        if (va.status === "pending") va = await poll(w, a);
      }
      expect(vc).toMatchObject({ status: "issued" });
      expect(va).toMatchObject({ status: "issued" });
      // Whichever went first, the other stayed at "new" while it published and validated.
      expect(seen).toEqual(expect.arrayContaining([expect.stringMatching(/^(published\/new|new\/published)$/)]));
    } finally {
      w.close();
    }
  });

  it("an order its device stopped polling does not hold up another on the same challenge name (gym 22)", async () => {
    const w = await setup();
    try {
      const abandoned = await ask(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(abandoned.res.status).toBe(202);
      w.clock.t += 121_000;
      const { done } = await issue(w, { cls: "control", names: [SERVER] });
      expect(done).toMatchObject({ status: "issued" });
    } finally {
      w.close();
    }
  });

  it("waits out the DNS propagation spell without a failed step (gym 21: an empty update was invalid SQL)", async () => {
    const w = await setup();
    const warn = vi.spyOn(console, "warn");
    try {
      w.deps.propagationMs = 5000;
      const { done } = await issue(w, { cls: "control", names: [SERVER] });
      expect(done).toMatchObject({ status: "issued" });
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("issuance-step-retry"))).toEqual([]);
    } finally {
      warn.mockRestore();
      w.close();
    }
  });

  it("issues the bare account name to an admin phone only", async () => {
    const w = await setup();
    try {
      const { done } = await issue(w, { cls: "phone", names: [`alice.${APEX}`] });
      expect(done).toMatchObject({ status: "issued", names: [`alice.${APEX}`] });
      const tablet = await ask(w, { cls: "phone", names: [`alice.${APEX}`], key: TABLET_KEY });
      expect(tablet.res.status).toBe(403);
      expect(tablet.json.code).toBe("issuance-not-admin");
      const bob = await ask(w, { cls: "phone", names: [`bob.${APEX}`], account: "bob" });
      expect(bob.json.code).toBe("issuance-not-admin");
    } finally {
      w.close();
    }
  });
});

describe("scenario 5: a box with the account wildcard grant asks for the bare user name", () => {
  it("refuses the bare name alone, mixed into a box order, through the phone class and as a raw DNS record", async () => {
    const w = await setup();
    try {
      const bare = `alice.${APEX}`;
      for (const cls of ["control", "apps"] as const) {
        const alone = await ask(w, { cls, names: [bare], grant: cls === "apps" });
        expect(alone.res.status).toBe(403);
        expect(alone.json.code).toBe("issuance-csr-names");
      }
      const mixedApps = await ask(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`, bare], grant: true });
      expect(mixedApps.json.code).toBe("issuance-csr-names");
      const mixedControl = await ask(w, { cls: "control", names: [SERVER, bare] });
      expect(mixedControl.json.code).toBe("issuance-csr-names");
      // The phone class signed by the box's key: the box is no admin device.
      const asPhone = await ask(w, { cls: "phone", names: [bare], key: BOX_KEY });
      expect(asPhone.json.code).toBe("issuance-not-admin");
      // The phone class with the box's server named.
      const phoneWithServer = await ask(w, { cls: "phone", names: [bare], key: BOX_KEY, server: SERVER });
      expect(phoneWithServer.json.code).toBe("issuance-malformed");
      // A CN naming the bare user while the SANs are right.
      const cn = await ask(w, { cls: "control", names: [SERVER], csr: await makeCsr([SERVER], { cn: bare }) });
      expect(cn.json.code).toBe("issuance-csr-names");
      // Arbitrary challenge values: the old writer is gone for everyone.
      const cp = await tryControlPlane(
        new Request(`${ORIGIN}/api/dns-01/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: { serverId: SERVER, recordName: `_acme-challenge.${bare}`, recordValueHash: "00".repeat(32), issuedAt: Date.now() }, signature: "00", recordValue: "x" }),
        }),
        { DB: w.db } as ControlPlaneEnv,
      );
      expect(cp!.status).toBe(410);
      expect(((await cp!.json()) as { code: string }).code).toBe("dns01-retired");
      expect(w.dns.written).toEqual([]);
      expect(w.ca.newOrders).toBe(0);
    } finally {
      w.close();
    }
  });

  it("refuses extra, missing, IP and another box's names", async () => {
    const w = await setup();
    try {
      expect((await ask(w, { cls: "control", names: [SERVER, `other.alice.${APEX}`] })).json.code).toBe("issuance-csr-names");
      expect((await ask(w, { cls: "control", names: [SERVER], extraIp: "10.0.0.1" })).json.code).toBe("issuance-csr-names");
      expect((await ask(w, { cls: "apps", names: [`*.alice.${APEX}`], grant: true })).json.code).toBe("issuance-csr-names");
      expect((await ask(w, { cls: "control", names: [`home.bob.${APEX}`] })).json.code).toBe("issuance-csr-names");
      expect((await ask(w, { cls: "control", names: [`home.bob.${APEX}`], server: `home.bob.${APEX}` })).json.code).toBe("issuance-unknown-device");
    } finally {
      w.close();
    }
  });
});

describe("step 1: the device and its current authorization", () => {
  it("refuses a bad signature, a stale clock, another account's box, a revoked box and an old registration", async () => {
    const w = await setup();
    try {
      const forged = await ask(w, { cls: "control", names: [SERVER], key: BOB_BOX_KEY, device: BOX });
      expect(forged.json.code).toBe("issuance-signature");
      expect((await ask(w, { cls: "control", names: [SERVER], issuedAt: w.clock.t - 10 * 60_000 })).json.code).toBe("issuance-clock");
      expect((await ask(w, { cls: "control", names: [`home.bob.${APEX}`], key: BOB_BOX_KEY, server: `home.bob.${APEX}` })).json.code).toBe("issuance-unknown-device");
      const regGen = await ask(w, { cls: "control", names: [SERVER], regGen: 2 });
      expect(regGen.res.status).toBe(409);
      expect(regGen.json.code).toBe("issuance-reg-gen");
      await w.db.prepare("UPDATE servers SET revoked_at = ? WHERE server_domain = ?").bind(w.clock.t, SERVER).run();
      expect((await ask(w, { cls: "control", names: [SERVER] })).json.code).toBe("issuance-revoked");
    } finally {
      w.close();
    }
  });

  it("refuses app certificates without a live serving permission but keeps issuing the control name (recovery)", async () => {
    const w = await setup();
    try {
      const p: ServingPolicy = { account: "alice", box: BOX, regGen: 1, policyGen: 1, grace: "7d", onLapse: "stop-apps", scopeSha256: "ab".repeat(32), issuedAt: w.clock.t };
      const sig = hex(signServingRecord("serving-policy", p, (m) => ed.sign(m, ADMIN)));
      await w.db
        .prepare("INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES ('alice', ?, 1, 1, ?, ?, ?)")
        .bind(BOX, JSON.stringify(p), sig, w.clock.t)
        .run();
      const apps = await ask(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(apps.res.status).toBe(403);
      expect(apps.json).toMatchObject({ code: "issuance-no-serving", reason: "no-lease" });
      expect((await issue(w, { cls: "control", names: [SERVER] })).done.status).toBe("issued");
    } finally {
      w.close();
    }
  });
});

describe("step 4: the CSR", () => {
  it("refuses a CSR whose digest is not the signed one, and one whose own signature is broken", async () => {
    const w = await setup();
    try {
      expect((await ask(w, { cls: "control", names: [SERVER], csrSha256: "00".repeat(32) })).json.code).toBe("issuance-csr-signature");
      const good = await makeCsr([SERVER]);
      const broken = good.der.slice();
      broken[broken.length - 3]! ^= 0x01;
      const r = await ask(w, { cls: "control", names: [SERVER], csr: { der: broken, keys: good.keys } });
      expect(["issuance-csr-signature", "issuance-malformed"]).toContain(r.json.code);
    } finally {
      w.close();
    }
  });

  it("answers a repeated request id with the same order and refuses a different body under it", async () => {
    const w = await setup();
    try {
      const first = await ask(w, { cls: "control", names: [SERVER] });
      const again = (await tryIssuanceRoute(
        new Request(`${ORIGIN}/api/certificates/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(first.body) }),
        w.env,
        w.deps,
      ))!;
      expect(((await again.json()) as { orderId: string }).orderId).toBe(first.json.orderId);
      const reused = await ask(w, { cls: "control", names: [SERVER], requestId: first.body.order.requestId });
      expect(reused.json.code).toBe("issuance-request-reused");
    } finally {
      w.close();
    }
  });
});

describe("steps 5 and 6: the order, its records and the chain", () => {
  it("fails the order and revokes the certificate when the chain names something else", async () => {
    const w = await setup();
    try {
      w.ca.mode.leafNames = [SERVER, `alice.${APEX}`];
      const { done } = await issue(w, { cls: "control", names: [SERVER] });
      expect(done).toMatchObject({ status: "failed", code: "issuance-chain-mismatch" });
      expect(done.chainPem).toBeUndefined();
      expect(w.ca.revoked).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it("never delivers a certificate issued after the box was revoked, and revokes it at the CA", async () => {
    const w = await setup();
    try {
      w.ca.mode.processingPolls = 1;
      const r = await ask(w, { cls: "control", names: [SERVER] });
      const done = await drive(w, String(r.json.orderId), async (step) => {
        if (step === "finalizing") await w.db.prepare("UPDATE servers SET revoked_at = ? WHERE server_domain = ?").bind(w.clock.t, SERVER).run();
      });
      expect(done).toMatchObject({ status: "failed", code: "issuance-revoked-during-order" });
      expect(w.ca.revoked).toHaveLength(1);
      expect(w.ca.revoked[0]!.reason).toBe(5);
      const q = await w.db.prepare("SELECT status FROM certificate_revocations").first<{ status: string }>();
      expect(q?.status).toBe("revoked");
    } finally {
      w.close();
    }
  });

  it("stops before answering the challenges when the lease runs out mid-order", async () => {
    const w = await setup();
    try {
      const r = await ask(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(r.res.status).toBe(202);
      const first = await poll(w, String(r.json.orderId));
      expect(first.step).toBe("published");
      await w.db.prepare("UPDATE servers SET revoked_at = ? WHERE server_domain = ?").bind(w.clock.t, SERVER).run();
      const done = await drive(w, String(r.json.orderId));
      expect(done.status).toBe("failed");
      expect(w.dns.records.size).toBe(0);
      expect([...w.ca.authzs.values()].every((a) => a.status === "deactivated")).toBe(true);
    } finally {
      w.close();
    }
  });

  it("fails a validation the CA refuses and cleans up", async () => {
    const w = await setup();
    try {
      w.ca.mode.failValidation = true;
      const { done } = await issue(w, { cls: "control", names: [SERVER] });
      expect(done).toMatchObject({ status: "failed", code: "issuance-acme-failed" });
      expect(w.dns.records.size).toBe(0);
    } finally {
      w.close();
    }
  });
});

describe("removing a box ends its certificates", () => {
  it("revokes at the CA every unexpired certificate the service gave a box that was removed", async () => {
    const w = await setup();
    try {
      await issue(w, { cls: "control", names: [SERVER] });
      await issue(w, { cls: "apps", names: [`*.${SERVER}`] });
      await w.db.prepare("UPDATE servers SET revoked_at = ? WHERE server_domain = ?").bind(w.clock.t, SERVER).run();
      // Any later order runs the sweep (two per request).
      await ask(w, { cls: "phone", names: [`alice.${APEX}`] });
      expect(w.ca.revoked).toHaveLength(2);
      expect(w.ca.revoked.every((r) => r.reason === 5)).toBe(true);
      await ask(w, { cls: "phone", names: [`alice.${APEX}`] });
      expect(w.ca.revoked).toHaveLength(2);
    } finally {
      w.close();
    }
  });
});

describe("H7: renewal window and CA limits", () => {
  it("refuses an early renewal with the same key, lets one new key through, then refuses until due", async () => {
    const w = await setup();
    try {
      const first = await issue(w, { cls: "control", names: [SERVER] });
      const same = await ask(w, { cls: "control", names: [SERVER], csr: await makeCsr([SERVER], { keys: first.csr.keys }) });
      expect(same.res.status).toBe(429);
      expect(same.json.code).toBe("issuance-not-due");
      expect(Number(same.json.dueAt)).toBeGreaterThan(w.clock.t + 50 * 86_400_000);
      expect((await issue(w, { cls: "control", names: [SERVER] })).done.status).toBe("issued");
      expect((await ask(w, { cls: "control", names: [SERVER] })).json.code).toBe("issuance-not-due");
      // Once in the last third, it may renew.
      w.clock.t += 61 * 86_400_000;
      expect((await ask(w, { cls: "control", names: [SERVER] })).res.status).toBe(202);
    } finally {
      w.close();
    }
  });

  it("stays under the per-name-set limit and stops everything after the CA's rateLimited", async () => {
    const w = await setup();
    try {
      for (let i = 0; i < 4; i++) {
        await w.db
          .prepare(
            "INSERT INTO certificate_orders (order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256, order_json, signature, status, step, not_before, not_after, created_at, updated_at) " +
              "VALUES (?, ?, ?, 'alice', ?, 'control', 1, ?, ?, '', ?, '{}', '', 'issued', 'done', ?, ?, ?, ?)",
          )
          .bind(rid(), rid(), "ee".repeat(32), SERVER, SERVER, `alice.${APEX}`, "ff".repeat(32), w.clock.t - 90 * 86_400_000, w.clock.t - 1, w.clock.t - 1000, w.clock.t - 1000)
          .run();
      }
      const limited = await ask(w, { cls: "control", names: [SERVER] });
      expect(limited.res.status).toBe(429);
      expect(limited.json.code).toBe("issuance-rate-limited");
      await w.db.prepare("DELETE FROM certificate_orders").run();

      w.ca.mode.rateLimited = true;
      const r = await ask(w, { cls: "control", names: [SERVER] });
      const done = await drive(w, String(r.json.orderId));
      expect(done).toMatchObject({ status: "failed", code: "issuance-rate-limited" });
      w.ca.mode.rateLimited = false;
      const after = await ask(w, { cls: "phone", names: [`alice.${APEX}`] });
      expect(after.json.code).toBe("issuance-rate-limited");
      expect(Number(after.json.retryAfterMs)).toBeGreaterThanOrEqual(7_000_000);
    } finally {
      w.close();
    }
  });
});

describe("residual authority", () => {
  it("revokes, for the admin only, a certificate another account holds for names under the apex", async () => {
    const w = await setup();
    try {
      const { done } = await issue(w, { cls: "control", names: [SERVER] });
      w.ca.validIdentifiers.clear();
      const env = { ...w.env, FLAGSHIP_ADMIN_SECRET: "admin-secret" };
      const post = (secret: string, pem: string) =>
        tryIssuanceRoute(
          new Request(`${ORIGIN}/api/certificates/admin/revoke`, { method: "POST", headers: { "x-admin-secret": secret }, body: JSON.stringify({ certificatePem: pem }) }),
          env,
          w.deps,
        ).then((r) => r!);
      expect((await post("wrong", String(done.chainPem))).status).toBe(401);
      const ok = await post("admin-secret", String(done.chainPem));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ revoked: true, names: [SERVER] });
      expect(w.ca.revoked).toHaveLength(1);
      expect(w.dns.records.size).toBe(0);
    } finally {
      w.close();
    }
  });
});

describe("configuration", () => {
  it("answers 503 without an account key and serves the account URL with one", async () => {
    const w = await setup();
    try {
      const none = (await tryIssuanceRoute(new Request(`${ORIGIN}/api/certificates/account`), { DB: w.db }, w.deps))!;
      expect(none.status).toBe(503);
      const acct = (await tryIssuanceRoute(new Request(`${ORIGIN}/api/certificates/account`), w.env, w.deps))!;
      expect(acct.status).toBe(200);
      expect(String(((await acct.json()) as { accountUri: string }).accountUri)).toMatch(/^https:\/\/ca\.test\/acct\//);
    } finally {
      w.close();
    }
  });
});

describe("a CA that forgot the stored account (Pebble restarted)", () => {
  it("registers again, replaces the stored account URL and issues", async () => {
    const w = await setup();
    try {
      const account = async () =>
        (await (await tryIssuanceRoute(new Request(`${ORIGIN}/api/certificates/account`), w.env, w.deps))!.json()) as { accountUri: string };
      const before = (await account()).accountUri;
      w.ca.restart();
      const r = await issue(w, { cls: "control", names: [SERVER] });
      expect(r.done.status, JSON.stringify(r.done)).toBe("issued");
      const rows = await w.db.prepare("SELECT account_url FROM issuance_acme_accounts").all<{ account_url: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]!.account_url).not.toBe(before);
      expect(w.ca.accounts.has(rows.results[0]!.account_url)).toBe(true);
      expect((await account()).accountUri).toBe(rows.results[0]!.account_url);
    } finally {
      w.close();
    }
  });
});

// ── B2 / issuance Lows (2026-11-02 review) ─────────────────────────────────

async function seedAcmeOrders(w: World, n: number, o: { username?: string; status?: "failed" | "issued"; acmeJson?: string; errorCode?: string | null } = {}) {
  const user = o.username ?? "mallory";
  for (let i = 0; i < n; i++) {
    await w.db
      .prepare(
        "INSERT INTO certificate_orders (order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256, order_json, signature, status, step, acme_json, acme_ordered_at, error_code, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, NULL, 'phone', 0, ?, ?, '', ?, '{}', '', ?, 'done', ?, ?, ?, ?, ?)",
      )
      .bind(rid(), rid(), "dd".repeat(32), user, `${user}${i}.${APEX}`, `${user}${i}.${APEX}`, "ff".repeat(32), o.status ?? "failed", o.acmeJson ?? "{}", w.clock.t - 60_000, o.errorCode === undefined ? "issuance-superseded" : o.errorCode, w.clock.t - 60_000, w.clock.t - 60_000)
      .run();
  }
}

describe("the service-wide order budget keeps room for renewals", () => {
  it("refuses a first certificate once new orders used their share, but still lets a due renewal through", async () => {
    const w = await setup();
    try {
      const first = await issue(w, { cls: "control", names: [SERVER] });
      expect(first.done.status).toBe("issued");
      w.clock.t += 61 * 86_400_000;
      await seedAcmeOrders(w, ISSUANCE_LIMITS.serviceNewOrdersPer3h);
      const fresh = await ask(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(fresh.res.status).toBe(429);
      expect(fresh.json.code).toBe("issuance-rate-limited");
      const renewal = await issue(w, { cls: "control", names: [SERVER] });
      expect(renewal.done.status).toBe("issued");
    } finally {
      w.close();
    }
  });

  it("re-checks the budget before the CA sees an order queued while it was open", async () => {
    const w = await setup();
    try {
      const r = await ask(w, { cls: "phone", names: [`alice.${APEX}`] });
      expect(r.res.status).toBe(202);
      await seedAcmeOrders(w, ISSUANCE_LIMITS.serviceNewOrdersPer3h);
      const done = await drive(w, String(r.json.orderId));
      expect(done).toMatchObject({ status: "failed", code: "issuance-rate-limited" });
      expect(w.ca.orders.size).toBe(0);
    } finally {
      w.close();
    }
  });
});

describe("one account cannot spend the CA budget by superseding its own orders", () => {
  it("stops a device that keeps replacing orders the CA already saw", async () => {
    const w = await setup();
    try {
      const codes: unknown[] = [];
      for (let i = 0; i < ISSUANCE_LIMITS.perAccountAbandonedOrdersPerDay + 3; i++) {
        const r = await ask(w, { cls: "phone", names: [`alice.${APEX}`] });
        codes.push(r.json.code ?? r.res.status);
        if (r.res.status !== 202) break;
        await poll(w, String(r.json.orderId)); // the CA sees the order
      }
      expect(codes.at(-1)).toBe("issuance-rate-limited");
      const atCa = await w.db.prepare("SELECT COUNT(*) AS n FROM certificate_orders WHERE username = 'alice' AND acme_ordered_at IS NOT NULL").first<{ n: number }>();
      expect(atCa!.n).toBeLessThanOrEqual(ISSUANCE_LIMITS.perAccountAbandonedOrdersPerDay + 1);
      // The order still in flight was not superseded by the refused one.
      const pending = await w.db.prepare("SELECT COUNT(*) AS n FROM certificate_orders WHERE username = 'alice' AND status = 'pending'").first<{ n: number }>();
      expect(pending!.n).toBe(1);
    } finally {
      w.close();
    }
  });
});

describe("a superseded first order followed by a certificate is not abandoned", () => {
  it("lets an account with many servers, each of whose first order was replaced, still order for a new box", async () => {
    const w = await setup();
    try {
      // Each earlier box's first order reached the CA and was superseded; its next order was issued.
      const row = (id: number, device: string, status: string, at: number) =>
        w.db
          .prepare(
            "INSERT INTO certificate_orders (order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256, order_json, signature, status, step, acme_ordered_at, error_code, created_at, updated_at) VALUES (?, ?, ?, 'alice', ?, 'control', 1, ?, ?, 'x', 'x', '{}', 'x', ?, 'done', ?, ?, ?, ?)",
          )
          .bind(String(id).padStart(32, "0"), `r${id}`, device, `b${id}.alice.${APEX}`, `b${id}.alice.${APEX}`, `alice.${APEX}`, status, at, status === "failed" ? "issuance-superseded" : null, at, at)
          .run();
      const n = ISSUANCE_LIMITS.perAccountAbandonedOrdersPerDay + 2;
      for (let i = 0; i < n; i++) {
        const device = hex(ed.getPublicKey(seed(100 + i)));
        await row(2 * i + 1, device, "failed", w.clock.t - 60_000 + i);
        await row(2 * i + 2, device, "issued", w.clock.t - 30_000 + i);
      }
      const r = await ask(w, { cls: "control", names: [SERVER] });
      expect(r.res.status, JSON.stringify(r.json)).toBe(202);
    } finally {
      w.close();
    }
  });
});

describe("a new box that replaced its order three times during first boot is not held against the account", () => {
  async function rows(w: World, boxes: number, gapMs: number) {
    let id = 0;
    for (let b = 0; b < boxes; b++) {
      const device = hex(ed.getPublicKey(seed(200 + b)));
      for (let k = 0; k < 4; k++) {
        const status = k < 3 ? "failed" : "issued";
        const at = w.clock.t - 5 * 3_600_000 + b * 600_000 + k * gapMs;
        id++;
        await w.db
          .prepare(
            "INSERT INTO certificate_orders (order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256, order_json, signature, status, step, acme_ordered_at, error_code, created_at, updated_at) VALUES (?, ?, ?, 'alice', ?, 'control', 1, ?, ?, 'x', 'x', '{}', 'x', ?, 'done', ?, ?, ?, ?)",
          )
          .bind(String(id).padStart(32, "0"), `r${id}`, device, `b${b}.alice.${APEX}`, `b${b}.alice.${APEX}`, `alice.${APEX}`, status, at, status === "failed" ? "issuance-superseded" : null, at, at)
          .run();
      }
    }
  }

  it("lets a fourth box order after three boxes each replaced three orders (the 2026-11-06 Windows run)", async () => {
    const w = await setup();
    try {
      await rows(w, 3, 60_000);
      const r = await ask(w, { cls: "control", names: [SERVER] });
      expect(r.res.status, JSON.stringify(r.json)).toBe(202);
    } finally {
      w.close();
    }
  });

  it("does not forgive orders more than an hour before the certificate", async () => {
    const w = await setup();
    try {
      // 40 minutes apart: only the last replaced order of each box is within the hour, so 2 a box still count.
      await rows(w, 3, 40 * 60_000);
      const r = await ask(w, { cls: "control", names: [SERVER] });
      expect(r.res.status).toBe(429);
      expect(r.json.code).toBe("issuance-rate-limited");
    } finally {
      w.close();
    }
  });
});

describe("the issuance sweep runs on its own (cron), not only inside other people's orders", () => {
  it("revokes a box's certificates once the box is removed, with no other order arriving", async () => {
    const w = await setup();
    try {
      await issue(w, { cls: "control", names: [SERVER] });
      await w.db.prepare("UPDATE servers SET revoked_at = ? WHERE server_domain = ?").bind(w.clock.t, SERVER).run();
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(1);
      expect(w.ca.revoked[0]!.reason).toBe(5);
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it("revokes a phone certificate once its device loses the admin grant", async () => {
    const w = await setup();
    try {
      expect((await issue(w, { cls: "phone", names: [`alice.${APEX}`] })).done.status).toBe("issued");
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(0);
      await w.db.prepare("UPDATE device_capability_grants SET revoked_at = ? WHERE grant_id = 'g-admin'").bind(w.clock.t).run();
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it("revokes an apps certificate whose wildcard grant no longer verifies (the admin key changed)", async () => {
    const w = await setup();
    try {
      expect((await issue(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`], grant: true })).done.status).toBe("issued");
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(0);
      await w.db.prepare("UPDATE usernames SET admin_root_pub_hex = ? WHERE username = 'alice'").bind(hex(ed.getPublicKey(seed(77)))).run();
      expect((await w.storage.usernames.get("alice"))!.adminRootPubHex).toBe(hex(ed.getPublicKey(seed(77))));
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it("revokes an apps certificate only after the serving lease has been gone a long while", async () => {
    const w = await setup();
    try {
      expect((await issue(w, { cls: "apps", names: [`*.${SERVER}`] })).done.status).toBe("issued");
      const p: ServingPolicy = { account: "alice", box: BOX, regGen: 1, policyGen: 1, grace: "7d", onLapse: "stop-apps", scopeSha256: "ab".repeat(32), issuedAt: w.clock.t };
      await w.db
        .prepare("INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES ('alice', ?, 1, 1, ?, ?, ?)")
        .bind(BOX, JSON.stringify(p), hex(signServingRecord("serving-policy", p, (m) => ed.sign(m, ADMIN))), w.clock.t)
        .run();
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(0);
      w.clock.t += 31 * 86_400_000;
      await runIssuanceSweep(w.env, w.deps);
      expect(w.ca.revoked).toHaveLength(1);
    } finally {
      w.close();
    }
  });

  it("is a cron job, every hour", () => {
    const hour = Date.UTC(2026, 10, 2, 6);
    const runs = Array.from({ length: 6 }, (_, i) => cronPlan(TEN_MINUTE_CRON, hour + i * 600_000)).filter((p) => p.jobs.includes("issuance-sweep"));
    expect(runs).toHaveLength(1);
  });
});

describe("the server wildcard grant has an age limit and is bound to the registration", () => {
  const grantAt = (issuedAt: number) => ({
    issuedAt,
    signature: hex(signServerWildcardGrant({ username: "alice", serverDomain: SERVER, stkPubHex: BOX, issuedAt }, (m) => ed.sign(m, ADMIN))),
  });
  const both = [`*.${SERVER}`, `*.alice.${APEX}`];

  it("refuses a grant older than its age limit", async () => {
    const w = await setup();
    try {
      const old = await ask(w, { cls: "apps", names: both, grant: grantAt(w.clock.t - SERVER_WILDCARD_GRANT_MAX_AGE_MS - 1000) });
      expect(old.json.code).toBe("issuance-wildcard-grant");
      expect((await ask(w, { cls: "apps", names: both, grant: grantAt(w.clock.t - SERVER_WILDCARD_GRANT_MAX_AGE_MS + 60_000) })).res.status).toBe(202);
    } finally {
      w.close();
    }
  });

  it("refuses a grant signed before the box's last revocation (an earlier registration generation)", async () => {
    const w = await setup();
    try {
      const before = grantAt(w.clock.t - 10_000);
      await w.db.prepare("UPDATE servers SET revoked_at = ? WHERE server_domain = ?").bind(w.clock.t - 5_000, SERVER).run();
      await w.db.prepare("UPDATE servers SET revoked_at = NULL WHERE server_domain = ?").bind(SERVER).run();
      const regGen = (await w.db.prepare("SELECT reg_gen FROM servers WHERE server_domain = ?").bind(SERVER).first<{ reg_gen: number }>())!.reg_gen;
      expect(regGen).toBe(2);
      expect((await ask(w, { cls: "apps", names: both, regGen, grant: before })).json.code).toBe("issuance-wildcard-grant");
      expect((await ask(w, { cls: "apps", names: both, regGen, grant: grantAt(w.clock.t - 1000) })).res.status).toBe(202);
    } finally {
      w.close();
    }
  });
});

// ── 2026-11-03 review: renewal-window and abandoned-order caps, policy scope ──

describe("the renewal window holds across a name-set change the grant did not make", () => {
  const grantAt = (issuedAt: number) => ({
    issuedAt,
    signature: hex(signServerWildcardGrant({ username: "alice", serverDomain: SERVER, stkPubHex: BOX, issuedAt }, (m) => ed.sign(m, ADMIN))),
  });
  const both = [`*.${SERVER}`, `*.alice.${APEX}`];

  it("refuses dropping a still-valid grant early, and lets a newly granted account wildcard through", async () => {
    const w = await setup();
    try {
      const first = await issue(w, { cls: "apps", names: both, grant: grantAt(w.clock.t - 1000) });
      expect(first.done.status).toBe("issued");
      const dropped = await ask(w, { cls: "apps", names: [`*.${SERVER}`], csr: await makeCsr([`*.${SERVER}`], { keys: first.csr.keys }) });
      expect(dropped.json.code).toBe("issuance-not-due");
    } finally {
      w.close();
    }
  });

  it("lets a box that gets the grant after its certificate add the account wildcard at once", async () => {
    const w = await setup();
    try {
      const first = await issue(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(first.done.status).toBe("issued");
      const granted = await ask(w, { cls: "apps", names: both, grant: grantAt(w.clock.t - 1000), csr: await makeCsr(both, { keys: first.csr.keys }) });
      expect(granted.res.status, JSON.stringify(granted.json)).toBe(202);
    } finally {
      w.close();
    }
  });
});

describe("an issued certificate forgives at most the 3 orders right before it", () => {
  it("still counts a device's earlier failed orders against the account", async () => {
    const w = await setup();
    try {
      const device = hex(ed.getPublicKey(seed(150)));
      const row = (id: number, status: string, at: number) =>
        w.db
          .prepare(
            "INSERT INTO certificate_orders (order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256, order_json, signature, status, step, acme_ordered_at, error_code, created_at, updated_at) VALUES (?, ?, ?, 'alice', ?, 'control', 1, ?, ?, 'x', 'x', '{}', 'x', ?, 'done', ?, ?, ?, ?)",
          )
          .bind(String(id).padStart(32, "0"), `r${id}`, device, `x.alice.${APEX}`, `x.alice.${APEX}`, `alice.${APEX}`, status, at, status === "failed" ? "issuance-superseded" : null, at, at)
          .run();
      // 3 of these are forgiven by the certificate; the cap's worth before them still count.
      const n = ISSUANCE_LIMITS.perAccountAbandonedOrdersPerDay + 3;
      for (let i = 0; i < n; i++) await row(i + 1, "failed", w.clock.t - 60_000 + i);
      await row(n + 1, "issued", w.clock.t - 30_000);
      const r = await ask(w, { cls: "phone", names: [`alice.${APEX}`] });
      expect(r.res.status).toBe(429);
      expect(r.json.code).toBe("issuance-rate-limited");
    } finally {
      w.close();
    }
  });
});

describe("the serving policy's signed scope bounds the apps certificate", () => {
  async function putPolicy(w: World, scopeSha256: string) {
    const p: ServingPolicy = { account: "alice", box: BOX, regGen: 1, policyGen: 1, grace: "indefinite", onLapse: "stop-apps", scopeSha256, issuedAt: w.clock.t };
    await w.db
      .prepare("INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES ('alice', ?, 1, 1, ?, ?, ?)")
      .bind(BOX, JSON.stringify(p), hex(signServingRecord("serving-policy", p, (m) => ed.sign(m, ADMIN))), w.clock.t)
      .run();
  }

  it("refuses app names a policy for another name list does not cover", async () => {
    const w = await setup();
    try {
      await putPolicy(w, "ab".repeat(32));
      const r = await ask(w, { cls: "apps", names: [`*.${SERVER}`] });
      expect(r.res.status).toBe(403);
      expect(r.json).toMatchObject({ code: "issuance-no-serving", reason: "scope" });
    } finally {
      w.close();
    }
  });

  it("a scope without the account wildcard covers only the server's own wildcard; the full list covers both", async () => {
    const w = await setup();
    try {
      await putPolicy(w, nameListSha256([{ class: "control", name: SERVER }, { class: "apps", name: `*.${SERVER}` }]));
      expect((await ask(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`], grant: true })).json).toMatchObject({ reason: "scope" });
      expect((await ask(w, { cls: "apps", names: [`*.${SERVER}`] })).res.status).toBe(202);
      await w.db.prepare("DELETE FROM serving_policies").run();
      await w.db.prepare("DELETE FROM certificate_orders").run();
      await putPolicy(w, nameListSha256(boxNameList("home", "alice", APEX)));
      expect((await ask(w, { cls: "apps", names: [`*.${SERVER}`, `*.alice.${APEX}`], grant: true })).res.status).toBe(202);
    } finally {
      w.close();
    }
  });
});
