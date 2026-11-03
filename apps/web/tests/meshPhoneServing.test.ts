/**
 * The phone ledger relay (relay-mesh.md §8), the serving gate's mesh inputs (§4.4, §4.6 as amended) and the relay
 * blessing renewed with proof of key (§3.2).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkPhoneItem,
  checkRelayBlessingRequest,
  ed,
  PHONE_ROUTE_LEASE_MS,
  signDeviceCapabilityGrant,
  signServingRecord,
  type RouteClaim,
  type ServingPolicy,
} from "@flagship/protocol";
import { meshPhoneEligibility, PhoneLedgerHost } from "../src/tunnel/mesh/phoneLedger.js";
import { MeshFeed } from "../src/tunnel/mesh/feed.js";
import { meshServingFetcher, ServingGate, UNKNOWN_BOX, type ServingTunnelHandle } from "../src/tunnel/servingGate.js";
import { RelayBlessingProvider, relayKeypairFromSeed } from "../src/tunnel/hubBlessingProvider.js";
import { phoneRouteEligibility } from "@flagship/protocol";
import { adminProof, APEX, hex, keypair, MeshFixture } from "./support/meshFixture.js";
import { lease, policy, type Ed } from "./support/serving.js";

describe("phone ledger relay", () => {
  it("offers the next generation above any seen, grants only to the asking holder, signs a grant every relay accepts", async () => {
    const fx = new MeshFixture();
    let t = 1_000_000;
    fx.now = () => t;
    const L = fx.addRelay("ra");
    fx.addRelay("rb");
    fx.mintDirectory();
    const admin = keypair();
    fx.authority("carol", hex(admin.publicKey), hex(keypair().publicKey));
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source(), now: () => t });
    await feed.poll();
    const vacant: Array<[string, number]> = [];
    const host = new PhoneLedgerHost({ selfRelayId: "ra", servicesApex: APEX, sign: (m) => ed.sign(m, L.key.privateKey), now: () => t, maxSeenGeneration: () => 4, onVacant: (h, g) => vacant.push([h, g]), log: () => feed.state });
    expect(host.begin("carol")).toEqual({ hostname: `carol.${APEX}`, generation: 5, vacant: true });
    const phone = keypair();
    const holder = { relayId: "rb", sessionId: "s1", phoneRoutePub: hex(phone.publicKey) };
    const grants = [adminProof("carol", admin, phone, { now: t })];
    const claimOf = (generation: number) => {
      const claim: RouteClaim = { account: "carol", phoneRoutePub: holder.phoneRoutePub, hostname: `carol.${APEX}`, generation, sessionNonce: "ab".repeat(16), issuedAt: t };
      return { claim, claimSignature: hex(signServingRecord("route-claim", claim, (m) => ed.sign(m, phone.privateKey))), grants };
    };
    // rc may not claim for rb.
    expect(host.apply({ op: "acquire", hostname: `carol.${APEX}`, generation: 5, holder, ...claimOf(5) }, "rc").result).toMatchObject({ ok: false, code: "malformed" });
    // §8.3: a key the phone's own grants do not prove an admin device of the account is never granted.
    const forged = keypair();
    const fakeHolder = { ...holder, phoneRoutePub: hex(forged.publicKey) };
    const fakeClaim: RouteClaim = { ...claimOf(5).claim, phoneRoutePub: fakeHolder.phoneRoutePub };
    const fakeSig = hex(signServingRecord("route-claim", fakeClaim, (m) => ed.sign(m, forged.privateKey)));
    for (const g of [undefined, [], [adminProof("carol", forged, forged, { now: t })], [adminProof("carol", admin, forged, { now: t, scopes: ["browse"] })]]) {
      expect(host.apply({ op: "acquire", hostname: `carol.${APEX}`, generation: 5, holder: fakeHolder, claim: fakeClaim, claimSignature: fakeSig, ...(g ? { grants: g } : {}) }, "rb").result).toMatchObject({ ok: false, code: "malformed" });
    }
    const r = host.apply({ op: "acquire", hostname: `carol.${APEX}`, generation: 5, holder, ...claimOf(5) }, "rb");
    expect(r.result.ok).toBe(true);
    const item = { kind: "phone" as const, grant: r.grant!, signature: r.grantSignature!, ...claimOf(5) };
    expect(checkPhoneItem(item, "rb", { servicesApex: APEX, log: feed.state, directory: fx.directory, now: t })).toEqual({ ok: true });
    expect(host.begin("carol")).toMatchObject({ vacant: false, holderGeneration: 5 });
    // A second claim while held: route-held. The lease lapses: the sweep tells everyone it is vacant.
    expect(host.apply({ op: "acquire", hostname: `carol.${APEX}`, generation: 6, holder: { ...holder, sessionId: "s2" }, ...claimOf(6) }, "rb").result).toMatchObject({ ok: false, code: "route-held" });
    t += PHONE_ROUTE_LEASE_MS + 1;
    host.sweep();
    expect(vacant).toEqual([[`carol.${APEX}`, 5]]);
  });

  it("eligibility comes from the phone's own grant chain under the log's admin root; a revoked grant id ends it", async () => {
    const fx = new MeshFixture();
    const admin = keypair();
    fx.authority("carol", hex(admin.publicKey), hex(keypair().publicKey));
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    const device = keypair();
    const grantId = "ab".repeat(32);
    const g = { grantId, username: "carol", deviceId: "cd".repeat(16), devicePubKey: device.publicKey, scopes: ["admin"] as never, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 86_400_000 };
    const presented = [{ grant: { grantId, username: "carol", deviceId: "cd".repeat(16), devicePubHex: hex(device.publicKey), scopes: ["admin"], issuedAt: g.issuedAt, expiresAt: g.expiresAt }, signatureHex: hex(signDeviceCapabilityGrant(g, admin)), signerRoot: "admin-root" }];
    const elig = meshPhoneEligibility(() => feed.state);
    const rec = (await elig("carol", presented))!;
    expect(phoneRouteEligibility(hex(device.publicKey), "carol", rec.adminRootPub, rec.grants, Date.now()).ok).toBe(true);
    expect((await elig("carol", undefined))!.grants).toEqual([]);
    fx.append({ kind: "device-grant-revoke", grantId, devicePub: hex(device.publicKey) });
    await feed.poll();
    const after = (await elig("carol", presented))!;
    expect(phoneRouteEligibility(hex(device.publicKey), "carol", after.adminRootPub, after.grants, Date.now()).ok).toBe(false);
  });

  it("a grant the apps made (an upper-case UUID id) is revoked by the log's lowercased entry (gym run 28)", async () => {
    const fx = new MeshFixture();
    const admin = keypair();
    fx.authority("carol", hex(admin.publicKey), hex(keypair().publicKey));
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    const device = keypair();
    const grantId = "0F8FAD5B-D9CB-469F-A165-70867728950E";
    const g = { grantId, username: "carol", deviceId: "cd".repeat(16), devicePubKey: device.publicKey, scopes: ["admin"] as never, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 86_400_000 };
    const presented = [{ grant: { grantId, username: "carol", deviceId: "cd".repeat(16), devicePubHex: hex(device.publicKey), scopes: ["admin"], issuedAt: g.issuedAt, expiresAt: g.expiresAt }, signatureHex: hex(signDeviceCapabilityGrant(g, admin)), signerRoot: "admin-root" }];
    const elig = meshPhoneEligibility(() => feed.state);
    const before = (await elig("carol", presented))!;
    expect(phoneRouteEligibility(hex(device.publicKey), "carol", before.adminRootPub, before.grants, Date.now()).ok).toBe(true);
    fx.append({ kind: "device-grant-revoke", grantId: grantId.toLowerCase(), devicePub: hex(device.publicKey) });
    await feed.poll();
    const after = (await elig("carol", presented))!;
    expect(phoneRouteEligibility(hex(device.publicKey), "carol", after.adminRootPub, after.grants, Date.now()).ok).toBe(false);
  });

  it("the phones' begin as the shared vector writes it (what iOS and Android send) is eligible on a mesh relay", async () => {
    const V = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/phone-route/vectors.json", import.meta.url), "utf8")).begin;
    const fx = new MeshFixture();
    fx.authority(V.account, V.adminRootPub, hex(keypair().publicKey));
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    const elig = meshPhoneEligibility(() => feed.state, () => V.now);
    const rec = (await elig(V.account, V.message.grants))!;
    expect(phoneRouteEligibility(V.devicePub, V.account, rec.adminRootPub, rec.grants, V.now).ok).toBe(true);
    const none = (await elig(V.account, []))!;
    expect(phoneRouteEligibility(V.devicePub, V.account, none.adminRootPub, none.grants, V.now).ok).toBe(false);
  });
});

describe("serving gate, mesh inputs", () => {
  const handle = (): ServingTunnelHandle & { closed: Array<[number, string]> } => {
    const closed: Array<[number, string]> = [];
    return { closed, closeTunnel: (c, r) => closed.push([c, r]), closeAppStreams: () => undefined, onAppsChanged: () => undefined };
  };

  it("takes the admin key and regGen from the log and the policy and leases from the HELLO; a policy the log's head does not name is policy-stale", async () => {
    const fx = new MeshFixture();
    const admin = keypair();
    const adminEd: Ed = { priv: admin.privateKey, pub: hex(admin.publicKey) };
    const stk = keypair();
    const boxPub = hex(stk.publicKey);
    const pod = `home.tom.${APEX}`;
    fx.authority("tom", hex(admin.publicKey), hex(admin.publicKey));
    fx.registerBox(pod, boxPub);
    const p1 = policy({ account: "tom", box: boxPub, admin: adminEd, grace: "7d", policyGen: 1 });
    const p2 = policy({ account: "tom", box: boxPub, admin: adminEd, grace: "7d", policyGen: 2 });
    fx.policyHead(boxPub, 1, p2.record as ServingPolicy);
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    const gate = new ServingGate({ fetchRecord: meshServingFetcher(() => feed.state, APEX) });
    const now = Date.now();
    const stale = await gate.attach({ username: "tom", boxPub, podCanonical: pod, adminKey: hex(admin.publicKey), policy: p1, leases: [lease(p1, adminEd, now, now + 60_000)] }, handle());
    expect(stale.decision).toMatchObject({ control: true, apps: false, reason: "policy-stale" });
    const ok = await gate.attach({ username: "tom", boxPub, podCanonical: pod, adminKey: hex(admin.publicKey), policy: p2, leases: [lease(p2, adminEd, now, now + 60_000)] }, handle());
    expect(ok.decision).toMatchObject({ control: true, apps: true });
    // Another key under the name: an unknown box (its tunnel is refused).
    const other = await gate.attach({ username: "tom", boxPub: hex(keypair().publicKey), podCanonical: pod, adminKey: hex(admin.publicKey), policy: null }, handle());
    expect(other.decision).toMatchObject({ control: false, reason: UNKNOWN_BOX });
  });

  it("past the close-all deadline keeps indefinite-policy boxes and closes time-limited ones", async () => {
    const fx = new MeshFixture();
    const admin = keypair();
    const adminEd: Ed = { priv: admin.privateKey, pub: hex(admin.publicKey) };
    const [s1, s2] = [keypair(), keypair()];
    fx.authority("ann", hex(admin.publicKey), hex(admin.publicKey));
    fx.registerBox(`a.ann.${APEX}`, hex(s1.publicKey));
    fx.registerBox(`b.ann.${APEX}`, hex(s2.publicKey));
    const p = policy({ account: "ann", box: hex(s2.publicKey), admin: adminEd, grace: "7d", server: "b" });
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    let quiet = 0;
    const gate = new ServingGate({ fetchRecord: meshServingFetcher(() => feed.state, APEX), contactAgeMs: () => quiet, keepIndefiniteOnLoss: true });
    const h1 = handle();
    const h2 = handle();
    await gate.attach({ username: "ann", boxPub: hex(s1.publicKey), podCanonical: `a.ann.${APEX}`, adminKey: hex(admin.publicKey), policy: null }, h1);
    await gate.attach({ username: "ann", boxPub: hex(s2.publicKey), podCanonical: `b.ann.${APEX}`, adminKey: hex(admin.publicKey), policy: p, leases: [lease(p, adminEd, Date.now(), Date.now() + 3_600_000)] }, h2);
    quiet = 61_000;
    expect(gate.acceptingNewTunnels()).toBe(false);
    quiet = 600_000;
    gate.tick();
    expect(h1.closed).toEqual([]);
    expect(h2.closed).toEqual([[1013, "serving-feed-lost"]]);
  });
});

describe("relay blessing with proof of key", () => {
  it("derives the relay key from its seed, signs the request, and keeps only a blessing for its own key", async () => {
    const fx = new MeshFixture();
    const r = fx.addRelay("ra");
    fx.mintDirectory();
    const kp = relayKeypairFromSeed(r.seedHex);
    expect(hex(kp.publicKey)).toBe(hex(r.key.publicKey));
    expect(() => relayKeypairFromSeed("zz")).toThrow();
    let body: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ relayBlessing: fx.blessings.get("ra"), meshKey: { epoch: 1 } }), { status: 200 });
    }) as typeof fetch;
    const issued: unknown[] = [];
    const p = new RelayBlessingProvider({ keypair: kp, relayId: "ra", servicesApex: APEX, comBaseUrl: "https://com.example", caKeys: () => [fx.caPub], fetchImpl, log: () => undefined, onIssued: (b) => issued.push(b.meshKey) });
    expect(await p.refresh()).toBe(true);
    const b = body as unknown as { relayId: string; relayKey: string; servicesApex: string; issuedAt: number; signature: string };
    expect(checkRelayBlessingRequest({ relayId: b.relayId, relayKey: b.relayKey, servicesApex: b.servicesApex, issuedAt: b.issuedAt }, b.signature, APEX, Date.now())).toEqual({ ok: true });
    expect(p.currentRelayBlessing()?.relayId).toBe("ra");
    expect(issued).toEqual([{ epoch: 1 }]);
    const other = fx.addRelay("rb");
    expect(p.adopt(fx.bless(other))).toBe(false);
    // The hub's hubSig verifies under the blessed key.
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    expect(ed.verify(Buffer.from(p.signNonce(nonce), "hex"), nonce, r.key.publicKey)).toBe(true);
  });
});

describe("phone routes on a stale mesh relay (§4.6 strict rule)", () => {
  it("refuses a begin with `unavailable` and closes the tunnel 1013 try-again; closeAll ends every phone tunnel", async () => {
    const { PhoneRoutes } = await import("../src/tunnel/phoneRoute.js");
    let fresh = false;
    const routes = new PhoneRoutes({ relayId: "ra", apex: APEX, ledger: { read: async () => null, apply: async () => null }, eligibility: async () => null, accepting: () => fresh });
    const sent: Record<string, unknown>[] = [];
    const closed: Array<[number, string]> = [];
    const s = routes.attach({ send: (m) => sent.push(m), tunnel: {} as never, streamCount: () => 0, closeStreams: () => undefined, close: (c, r) => closed.push([c, r]) });
    await routes.begin(s, "carol", []);
    expect(sent).toEqual([{ type: "refused", code: "unavailable" }]);
    expect(closed).toEqual([[1013, "try-again"]]);
    fresh = true;
    routes.closeAll(1013, "serving-feed-lost");
    expect(closed[1]).toEqual([1013, "serving-feed-lost"]);
  });
});
