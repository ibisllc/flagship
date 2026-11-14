import { describe, expect, it } from "vitest";
import {
  ed,
  directAccessOrderSha256,
  signDirectAccessOrder,
  signDirectAddressUpdate,
  signDirectNameOrder,
  type DirectAccessOrder,
  type DirectAddressUpdate,
  type DirectNameOrder,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  desiredDirectRecords,
  handleGetDirectAccess,
  handlePostDirectAccessOrder,
  handlePostDirectAddress,
  handlePostDirectName,
  handleProbeDirectName,
  reconcileDirectName,
  runDirectNamesPublish,
  type DirectAccessDeps,
  type DirectZoneDns,
  type DirectZoneRecord,
  type PublishDeps,
} from "../src/directAccess.js";

const U = "plucky-avocet";
const BOX = `home.${U}.flagship.services`;
const NAME = `game--${U}.fshp.app`;
const NOW = 1_900_000_000_000;
const ACCOUNT_URI = "https://acme-v02.api.letsencrypt.org/acme/acct/42";

function key(seed: number): Keypair {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class FakeZone implements DirectZoneDns {
  records: DirectZoneRecord[] = [];
  next = 1;
  failNext = false;
  calls = 0;
  async list(name: string) {
    this.calls++;
    return this.records.filter((r) => r.name === name).map((r) => ({ ...r }));
  }
  async createRecord(r: { name: string; type: "A" | "AAAA" | "CAA"; content: string }) {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("rate limited");
    }
    const rec = { id: String(this.next++), type: r.type, name: r.name, content: r.content };
    this.records.push(rec);
    return { id: rec.id };
  }
  async deleteById(id: string) {
    this.calls++;
    this.records = this.records.filter((r) => r.id !== id);
  }
  at(name: string) {
    return this.records
      .filter((r) => r.name === name)
      .map((r) => `${r.type} ${r.content}`)
      .sort();
  }
}

async function harness(opts: { pinAdmin?: boolean } = {}) {
  const storage = new InMemoryStorage();
  const irk = key(1);
  const admin = key(2);
  const stk = key(10);
  const otherStk = key(11);
  const pin = opts.pinAdmin ?? true;
  await storage.usernames.put({ username: U, irkPubHex: hex(irk.publicKey), ...(pin ? { adminRootPubHex: hex(admin.publicKey) } : {}), claimedAt: 1 });
  await storage.usernames.put({ username: "someone", irkPubHex: hex(key(3).publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: BOX, username: U, identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  await storage.servers.put({ serverDomain: `x.someone.flagship.services`, username: "someone", identityPubKeyHex: hex(otherStk.publicKey), registeredAt: 1 });
  let now = NOW;
  const zone = new FakeZone();
  const deps: PublishDeps = {
    usernames: storage.usernames,
    servers: storage.servers,
    directAccess: storage.directAccess,
    grants: storage.deviceCapabilityGrants,
    now: () => now,
    dns: zone,
    caaAccountUri: ACCOUNT_URI,
  };
  return { storage, deps, zone, irk, admin, stk, otherStk, tick: (ms: number) => (now += ms), now: () => now };
}

const accessOrder = (over: Partial<DirectAccessOrder> = {}): DirectAccessOrder => ({
  serverDomain: BOX,
  enabled: true,
  addresses: ["81.2.69.142"],
  prefixes: ["2a02:8010:6400::/48"],
  port: 443,
  issuedAt: NOW,
  ...over,
});
const nameOrder = (over: Partial<DirectNameOrder> = {}): DirectNameOrder => ({
  name: NAME,
  serverDomain: BOX,
  enabled: true,
  addresses: [],
  caa: "pin",
  issuedAt: NOW,
  ...over,
});
const signedAccess = (o: DirectAccessOrder, k: Keypair) => ({ order: o, signatureHex: hex(signDirectAccessOrder(o, k)) });
const signedName = (o: DirectNameOrder, k: Keypair) => ({ order: o, signatureHex: hex(signDirectNameOrder(o, k)) });
const signedUpdate = (u: DirectAddressUpdate, k: Keypair) => ({ update: u, signatureHex: hex(signDirectAddressUpdate(u, k)) });

async function publishAll(deps: PublishDeps) {
  await runDirectNamesPublish(deps, 50);
}

describe("direct-access orders on .com", () => {
  it("takes an admin-signed order and refuses forged, unsigned, IRK-signed and other-account orders", async () => {
    const h = await harness();
    expect((await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin))).status).toBe(200);
    const irkSigned = await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder({ issuedAt: NOW + 1 }), h.irk));
    expect(irkSigned.status).toBe(403);
    expect((irkSigned.body as { code: string }).code).toBe("not-admin");
    const forged = signedAccess(accessOrder({ issuedAt: NOW + 2 }), h.admin);
    forged.order = { ...forged.order, addresses: ["81.2.69.143"] };
    expect((await handlePostDirectAccessOrder(h.deps, U, forged)).status).toBe(403);
    expect((await handlePostDirectAccessOrder(h.deps, U, { order: accessOrder() })).status).toBe(400);
    const theirs = signedAccess(accessOrder({ serverDomain: "x.someone.flagship.services", issuedAt: NOW + 3 }), h.admin);
    expect(((await handlePostDirectAccessOrder(h.deps, U, theirs)).body as { code: string }).code).toBe("not-your-server");
    expect((await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin))).status).toBe(409);
  });

  it("an account without an admin root signs with its IRK, as the box allows", async () => {
    const h = await harness({ pinAdmin: false });
    expect((await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.irk))).status).toBe(200);
  });

  it("refuses private addresses and orders dated in the future", async () => {
    const h = await harness();
    const priv = { order: { ...accessOrder(), addresses: ["192.168.1.20"] }, signatureHex: "ab".repeat(64) };
    expect(((await handlePostDirectAccessOrder(h.deps, U, priv)).body as { code: string }).code).toBe("private-address");
    const future = signedAccess(accessOrder({ issuedAt: NOW + 3_600_000 }), h.admin);
    expect(((await handlePostDirectAccessOrder(h.deps, U, future)).body as { code: string }).code).toBe("not-yet-valid");
  });
});

describe("the box's address update", () => {
  it("is taken only inside the held order and under the box's own STK", async () => {
    const h = await harness();
    const order = accessOrder();
    const sha = directAccessOrderSha256(order);
    const u: DirectAddressUpdate = { serverDomain: BOX, orderSha256: sha, addresses: ["2a02:8010:6400:7::1", "81.2.69.142"], port: 443, issuedAt: NOW + 10 };
    expect(((await handlePostDirectAddress(h.deps, signedUpdate(u, h.stk))).body as { code: string }).code).toBe("no-order");
    const r = await handlePostDirectAddress(h.deps, { ...signedUpdate(u, h.stk), directAccess: signedAccess(order, h.admin) });
    expect(r.status).toBe(200);
    expect((await h.storage.directAccess.getOrder(BOX))?.updateIssuedAt).toBe(NOW + 10);

    const wrongBox = await handlePostDirectAddress(h.deps, signedUpdate({ ...u, issuedAt: NOW + 20 }, h.otherStk));
    expect((wrongBox.body as { code: string }).code).toBe("bad-signature");
    const outside = await handlePostDirectAddress(h.deps, signedUpdate({ ...u, addresses: ["2a02:8010:6401::1"], issuedAt: NOW + 30 }, h.stk));
    expect((outside.body as { code: string }).code).toBe("outside-grant");
    const older = await handlePostDirectAddress(h.deps, signedUpdate({ ...u, issuedAt: NOW + 5 }, h.stk));
    expect((older.body as { stored: boolean }).stored).toBe(false);
  });

  it("refuses a bundled order the owner didn't sign", async () => {
    const h = await harness();
    const order = accessOrder({ addresses: ["81.2.69.150"] });
    const u: DirectAddressUpdate = { serverDomain: BOX, orderSha256: directAccessOrderSha256(order), addresses: ["81.2.69.150"], port: 443, issuedAt: NOW };
    const r = await handlePostDirectAddress(h.deps, { ...signedUpdate(u, h.stk), directAccess: signedAccess(order, h.stk) });
    expect((r.body as { code: string }).code).toBe("not-admin");
  });
});

describe("direct names", () => {
  it("takes a derived name of this account and refuses another account's, vanity and forged names", async () => {
    const h = await harness();
    expect((await handlePostDirectName(h.deps, U, signedName(nameOrder(), h.admin))).status).toBe(200);
    const other = await handlePostDirectName(h.deps, U, signedName(nameOrder({ name: "game--someone.fshp.app" }), h.admin));
    expect((other.body as { code: string }).code).toBe("not-your-name");
    const vanity = await handlePostDirectName(h.deps, U, signedName(nameOrder({ name: "johngame.fshp.app" }), h.admin));
    expect((vanity.body as { code: string }).code).toBe("vanity-not-available");
    const forged = signedName(nameOrder({ issuedAt: NOW + 1 }), h.admin);
    forged.order = { ...forged.order, addresses: ["81.2.69.1"] };
    expect(((await handlePostDirectName(h.deps, U, forged)).body as { code: string }).code).toBe("not-admin");
    const irk = await handlePostDirectName(h.deps, U, signedName(nameOrder({ issuedAt: NOW + 2 }), h.irk));
    expect((irk.body as { code: string }).code).toBe("not-admin");
    const priv = { order: nameOrder({ addresses: ["10.0.0.5"] }), signatureHex: "ab".repeat(64) };
    expect(((await handlePostDirectName(h.deps, U, priv)).body as { code: string }).code).toBe("private-address");
  });

  it("publishes the box's addresses with a pinned CAA, follows its updates, and withdraws on off", async () => {
    const h = await harness();
    const order = accessOrder();
    await handlePostDirectAccessOrder(h.deps, U, signedAccess(order, h.admin));
    await handlePostDirectName(h.deps, U, signedName(nameOrder(), h.admin));
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual([
      'A 81.2.69.142',
      'CAA 0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/42; validationmethods=dns-01"',
      'CAA 0 issuewild ";"',
    ]);

    h.tick(1000);
    const u: DirectAddressUpdate = { serverDomain: BOX, orderSha256: directAccessOrderSha256(order), addresses: ["2a02:8010:6400:7::1", "81.2.69.142"], port: 443, issuedAt: h.now() };
    await handlePostDirectAddress(h.deps, signedUpdate(u, h.stk));
    await publishAll(h.deps);
    expect(h.zone.at(NAME).filter((r) => !r.startsWith("CAA"))).toEqual(["A 81.2.69.142", "AAAA 2a02:8010:6400:7::1"]);

    h.tick(1000);
    await handlePostDirectName(h.deps, U, signedName(nameOrder({ enabled: false, issuedAt: h.now() }), h.admin));
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual([]);
    expect((await h.storage.directAccess.getName(`game--${U}`))?.publishReason).toBe("off");
  });

  it("publishes exactly the owner's own addresses, and no CAA when the owner turned it off", async () => {
    const h = await harness();
    await handlePostDirectName(h.deps, U, signedName(nameOrder({ addresses: ["2606:4700:4700::1111", "8.8.8.8"], caa: "off" }), h.admin));
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual(["A 8.8.8.8", "AAAA 2606:4700:4700::1111"]);
  });

  it("publishes nothing without direct access, and nothing pinned without the service's ACME account", async () => {
    const h = await harness();
    await handlePostDirectName(h.deps, U, signedName(nameOrder(), h.admin));
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual([]);
    expect((await h.storage.directAccess.getName(`game--${U}`))?.publishReason).toBe("direct-access-off");
    await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin));
    await publishAll({ ...h.deps, caaAccountUri: null });
    expect(h.zone.at(NAME)).toEqual([]);
    expect((await h.storage.directAccess.getName(`game--${U}`))?.publishReason).toBe("caa-account-unknown");
  });

  it("removes records nobody signed, and withdraws when the box is removed or the admin root rotates", async () => {
    const h = await harness();
    await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin));
    await handlePostDirectName(h.deps, U, signedName(nameOrder({ caa: "off" }), h.admin));
    h.zone.records.push({ id: "stray", type: "A", name: NAME, content: "1.1.1.1" });
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual(["A 81.2.69.142"]);

    await h.storage.usernames.put({ username: U, irkPubHex: hex(h.irk.publicKey), adminRootPubHex: hex(key(99).publicKey), claimedAt: 1 });
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual(["A 81.2.69.142"]);
    h.tick(24 * 3_600_000 + 1);
    await runDirectNamesPublish(h.deps);
    expect(h.zone.at(NAME)).toEqual([]);
    expect((await h.storage.directAccess.getName(`game--${U}`))?.publishReason).toBe("order-unverified");
  });

  it("withdraws a removed box's names and releases a deleted account's", async () => {
    const h = await harness();
    await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin));
    await handlePostDirectName(h.deps, U, signedName(nameOrder({ caa: "off" }), h.admin));
    await publishAll(h.deps);
    await h.storage.servers.revoke(BOX, "removed", h.tick(1));
    await h.storage.directAccess.markPending([`game--${U}`], h.tick(1));
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual([]);
    expect((await h.storage.directAccess.getName(`game--${U}`))?.publishReason).toBe("server-gone");

    await h.storage.usernames.delete(U);
    await h.storage.directAccess.markPending([`game--${U}`], h.tick(1));
    await publishAll(h.deps);
    expect(await h.storage.directAccess.getName(`game--${U}`)).toBeNull();
  });

  it("keeps a name pending when the zone write fails, and suspends it on an abuse report", async () => {
    const h = await harness();
    await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin));
    await handlePostDirectName(h.deps, U, signedName(nameOrder({ caa: "off" }), h.admin));
    h.zone.failNext = true;
    const row = (await h.storage.directAccess.getName(`game--${U}`))!;
    expect((await reconcileDirectName(h.deps, row)).state).toBe("pending");
    expect((await h.storage.directAccess.getName(`game--${U}`))?.publishError).toContain("rate limited");
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual(["A 81.2.69.142"]);
    await h.storage.directAccess.suspend(`game--${U}`, "phishing", h.tick(1));
    await publishAll(h.deps);
    expect(h.zone.at(NAME)).toEqual([]);
  });

  it("only ever publishes public addresses", () => {
    const r = desiredDirectRecords({
      name: nameOrder({ caa: "off" }),
      suspended: false,
      access: { order: accessOrder(), update: { serverDomain: BOX, orderSha256: "", addresses: ["81.2.69.142", "192.168.1.1x"], port: 443, issuedAt: NOW } },
      caaAccountUri: null,
    });
    expect(r.records.map((x) => x.content)).toEqual(["81.2.69.142"]);
  });
});

describe("reading back and the outside probe", () => {
  it("lists the account's state and probes a published name at most once a minute", async () => {
    const h = await harness();
    await handlePostDirectAccessOrder(h.deps, U, signedAccess(accessOrder(), h.admin));
    await handlePostDirectName(h.deps, U, signedName(nameOrder({ caa: "off" }), h.admin));
    const deps: DirectAccessDeps & { prober: { https: (n: string, p: number) => Promise<{ ok: boolean; status?: number }> } } = {
      ...h.deps,
      prober: { https: async (n, p) => (n === NAME && p === 443 ? { ok: true, status: 200 } : { ok: false }) },
    };
    const before = await handleProbeDirectName(deps, U, `game--${U}`);
    expect((before.body as { why: string }).why).toBe("not-published");
    await publishAll(h.deps);
    expect((await handleProbeDirectName(deps, U, `game--${U}`)).status).toBe(429);
    h.tick(61_000);
    const r = await handleProbeDirectName(deps, U, `game--${U}`);
    expect((r.body as { reachable: boolean }).reachable).toBe(true);
    expect((await handleProbeDirectName(deps, "someone", `game--${U}`)).status).toBe(404);

    const view = (await handleGetDirectAccess(h.deps, U)).body as { apex: string; servers: Array<{ on: boolean }>; names: Array<{ name: string; state: string; probe: { reachable: boolean } }> };
    expect(view.apex).toBe("fshp.app");
    expect(view.servers[0]!.on).toBe(true);
    expect(view.names[0]!.name).toBe(NAME);
    expect(view.names[0]!.state).toBe("published");
    expect(view.names[0]!.probe.reachable).toBe(true);
    const signed = view.names[0] as unknown as { order: DirectNameOrder; signatureHex: string };
    expect(signed.order.name).toBe(NAME);
    expect(signed.signatureHex).toMatch(/^[0-9a-f]{128}$/);
  });
});
