/**
 * Direct access on the Worker (docs/direct-access-and-domains.md §6 step 3): the routes over the production D1
 * adapter, the cron pass into a fake direct zone, and the fetch prober. The registry's rules are tested in
 * packages/control-plane/tests/directAccess.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  directAccessOrderSha256,
  ed,
  signDirectAccessOrder,
  signDirectAddressUpdate,
  signDirectNameOrder,
  type DirectAccessOrder,
  type DirectNameOrder,
} from "@flagship/protocol";
import { D1Storage, type D1Database } from "@flagship/storage";
import type { DirectZoneDns, DirectZoneRecord } from "@flagship/control-plane";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { directCaaAccountUri, fetchProber, runDirectNamesCron } from "../src/directNames.js";

const ORIGIN = "https://flagshipserver.com";
const U = "alice";
const BOX = `home.${U}.flagship.services`;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const ADMIN = kp(1);
const STK = kp(9);

class Zone implements DirectZoneDns {
  records: DirectZoneRecord[] = [];
  async list(name: string) {
    return this.records.filter((r) => r.name === name);
  }
  async createRecord(r: { name: string; type: "A" | "AAAA" | "CAA"; content: string }) {
    const rec = { id: String(this.records.length + 1), ...r };
    this.records.push(rec);
    return rec;
  }
  async deleteById(id: string) {
    this.records = this.records.filter((r) => r.id !== id);
  }
}

async function setup() {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const storage = new D1Storage(db);
  await storage.usernames.put({ username: U, irkPubHex: hex(kp(5).publicKey), adminRootPubHex: hex(ADMIN.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: BOX, username: U, identityPubKeyHex: hex(STK.publicKey), registeredAt: 1 });
  const env = { DB: db, DIRECT_CAA_ACCOUNT_URI: "https://acme.example/acct/7" } as ControlPlaneEnv;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    (await tryControlPlane(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env))!;
  return { sqlite, db, storage, env, post, close: () => sqlite.close() };
}

const now = () => Date.now();
const accessOrder = (): DirectAccessOrder => ({ serverDomain: BOX, enabled: true, addresses: ["81.2.69.142"], prefixes: [], port: 443, issuedAt: now() });
const nameOrder = (): DirectNameOrder => ({ name: `game--${U}.fshp.app`, serverDomain: BOX, enabled: true, addresses: [], caa: "pin", issuedAt: now() });

describe("direct access routes", () => {
  it("takes orders and the box's update, publishes on the cron, and keeps reads behind the read token", async () => {
    const w = await setup();
    try {
      const a = accessOrder();
      expect((await w.post(`/api/accounts/${U}/direct-access`, { order: a, signatureHex: hex(signDirectAccessOrder(a, ADMIN)) })).status).toBe(200);
      const n = nameOrder();
      expect((await w.post(`/api/accounts/${U}/direct-names`, { order: n, signatureHex: hex(signDirectNameOrder(n, ADMIN)) })).status).toBe(200);
      const u = { serverDomain: BOX, orderSha256: directAccessOrderSha256(a), addresses: ["81.2.69.142"], port: 443, issuedAt: now() };
      const addr = await w.post("/api/direct-access/address", { update: u, signatureHex: hex(signDirectAddressUpdate(u, STK)) });
      expect(addr.status).toBe(200);

      const zone = new Zone();
      expect(await runDirectNamesCron(w.env, w.storage, zone)).toEqual({ reconciled: 1, failed: 0 });
      expect(zone.records.map((r) => `${r.type} ${r.content}`).sort()).toEqual([
        "A 81.2.69.142",
        'CAA 0 issue "letsencrypt.org; accounturi=https://acme.example/acct/7; validationmethods=dns-01"',
        'CAA 0 issuewild ";"',
      ]);

      const read = await tryControlPlane(new Request(`${ORIGIN}/api/accounts/${U}/direct-access`), w.env);
      expect(read!.status).toBe(401);
      expect((await w.post(`/api/accounts/${U}/direct-names/game--${U}/probe`, {})).status).toBe(401);
    } finally {
      w.close();
    }
  });

  it("refuses an IRK-signed order on an admin-pinned account, and publishes nothing without the direct zone", async () => {
    const w = await setup();
    try {
      const a = accessOrder();
      const r = await w.post(`/api/accounts/${U}/direct-access`, { order: a, signatureHex: hex(signDirectAccessOrder(a, kp(5))) });
      expect(r.status).toBe(403);
      expect(await runDirectNamesCron(w.env, w.storage)).toBeNull();
    } finally {
      w.close();
    }
  });

  it("pins the CAA to the issuance service's own ACME account when no override is set", async () => {
    const w = await setup();
    try {
      expect(await directCaaAccountUri({ DB: w.db })).toBeNull();
      await w.db
        .prepare("INSERT INTO issuance_acme_accounts (directory, thumbprint, account_url, created_at) VALUES (?, ?, ?, ?)")
        .bind("https://acme-v02.api.letsencrypt.org/directory", "t", "https://acme-v02.api.letsencrypt.org/acme/acct/99", 1)
        .run();
      expect(await directCaaAccountUri({ DB: w.db })).toBe("https://acme-v02.api.letsencrypt.org/acme/acct/99");
    } finally {
      w.close();
    }
  });
});

describe("the fetch prober", () => {
  it("counts any HTTPS answer as reachable and a failed handshake as not", async () => {
    const seen: string[] = [];
    const ok = fetchProber((async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 404 });
    }) as typeof fetch);
    expect(await ok.https("game--alice.fshp.app", 443)).toEqual({ ok: true, status: 404 });
    expect(await ok.https("game--alice.fshp.app", 8443)).toEqual({ ok: true, status: 404 });
    expect(seen).toEqual(["https://game--alice.fshp.app/", "https://game--alice.fshp.app:8443/"]);
    const bad = fetchProber((async () => {
      throw new Error("certificate does not match");
    }) as typeof fetch);
    expect(await bad.https("game--alice.fshp.app", 443)).toEqual({ ok: false, error: "certificate does not match" });
  });
});
