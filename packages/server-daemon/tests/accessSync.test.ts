/**
 * One access list per app across the account's servers (docs/service-access-
 * gating.md "One list per app"): three boxes of one account run the same app;
 * the leader (first live box in the server order) distributes, every box
 * verifies every entry itself, a box that was down catches up before letting
 * invited people in, and the role passes on when the leader goes down.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  ed,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signAppRank,
  signCreateServiceInvite,
  signDeviceCapabilityGrant,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServiceAccessModeV2,
  type CreateServiceInvite,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import { AccessPrincipals, AccountDeviceBook } from "../src/accessPrincipals.js";
import { AccessJournal } from "../src/accessJournal.js";
import { accessSyncMac, buildAccessSync, deriveAccessSyncKey, type AccessSync } from "../src/accessSync.js";
import { buildMemberRolesHttp, buildRankEntryApplier } from "../src/memberRoles.js";
import { buildServiceAccessHttp, ServiceAccessStore, type ServiceAccessHttp } from "../src/serviceAccess.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";

const NOW = 1_700_000_000_000;
const SERVICE = "alice--club";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);
const household = deriveHouseholdKey(ownerUmk);
const adminRoot = key(0x5a);
const laptop = key(0x62);
const LAPTOP_ID = "b2".repeat(16);
const friend = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const friend2 = deriveAccountId({ seed: new Uint8Array(32).fill(23) });
const FRIEND = hex(friend.publicKey);
const cgk = new Uint8Array(32).fill(0x77);
const syncKey = deriveAccessSyncKey(cgk);

function laptopGrant() {
  const g: DeviceCapabilityGrant = {
    grantId: "g-lap", username: "alice", deviceId: LAPTOP_ID, devicePubKey: laptop.publicKey,
    scopes: ["browse", "view-directory"], issuedAt: NOW - 10, expiresAt: NOW + 1e9,
  };
  return {
    grantId: g.grantId, username: "alice", deviceId: LAPTOP_ID, devicePubHex: hex(laptop.publicKey),
    scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(g, ownerIrk)), signerRoot: "membership",
  };
}

interface Box {
  fqdn: string;
  store: ServiceAccessStore;
  access: ServiceAccessHttp;
  sync: AccessSync;
  journal: AccessJournal;
  roles: (req: HttpRequest) => Promise<HttpResponse | null>;
  dir: string;
}

/** A small fleet: boxes route to each other's sync handler; `up` decides who answers. */
async function fleet(names: string[]) {
  const up = new Set(names.map((n) => `${n}.alice.flagship.services`));
  const order = names.map((n) => `${n}.alice.flagship.services`);
  const boxes = new Map<string, Box>();
  let carrier: { create: Record<string, unknown>; createSig: string } | null = null;
  let clock = NOW;
  const leader = () => order.find((f) => up.has(f)) ?? null;
  const fetchBetween = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const to = boxes.get(u.hostname);
    if (!to || !up.has(u.hostname)) throw new Error("unreachable");
    const res = await to.sync.handle({ method: "POST", path: u.pathname, headers: {}, body: Buffer.from(String(init?.body ?? "")) });
    return new Response(res?.body ?? "", { status: res?.status ?? 404 });
  }) as unknown as typeof fetch;

  async function make(fqdn: string, dir = mkdtempSync(join(tmpdir(), "sync-"))): Promise<Box> {
    const book = new AccountDeviceBook({
      path: join(dir, "account-devices.json"),
      username: "alice",
      ownerIrkPub: () => ownerIrk.publicKey,
      adminRootPub: () => adminRoot.publicKey,
      fetchGrants: async () => ({ grants: [laptopGrant()] }),
    });
    await book.refresh();
    const principals = new AccessPrincipals(hex(ownerAid.publicKey));
    principals.book = book;
    const store = new ServiceAccessStore(join(dir, "data/flagship-access/service-access.json"), { principals });
    await store.load();
    const journal = new AccessJournal(join(dir, "data/flagship-access/access-journal.json"));
    await journal.load();
    const ref: { sync: AccessSync | null } = { sync: null };
    const access = buildServiceAccessHttp({
      serverId: fqdn,
      ownerIrkPub: ownerIrk.publicKey,
      ownerAidPub: ownerAid.publicKey,
      adminRootPub: adminRoot.publicKey,
      store,
      serviceInstalled: (r) => r === SERVICE,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () =>
        Response.json({ redeemed: true, approvalMode: "auto", firstBind: true, serviceRef: SERVICE, boundAID: FRIEND, ...carrier })) as unknown as typeof fetch,
      username: "alice",
      onEntry: (r, e) => ref.sync?.record(r, e),
      now: () => clock,
    });
    const app = (id: string) => (id === SERVICE ? { manifest: { access: { enabled: true, default_role: "member" } } as never } : null);
    const memberOpts = { ownerIrkPub: ownerIrk.publicKey, adminRootPub: adminRoot.publicKey, username: "alice", store, app, now: () => clock };
    const roleHandler = buildMemberRolesHttp({ ...memberOpts, serverDomain: fqdn, onEntry: (r, e) => ref.sync?.record(r, e) });
    const applyRank = buildRankEntryApplier(memberOpts);
    const sync = buildAccessSync({
      selfFqdn: fqdn,
      journal,
      store,
      apply: (r, e) => (e.kind === "rank" ? applyRank(r, e) : access.applyEntry(r, e)),
      peers: () => ({ leaderFor: () => leader(), runners: () => order.filter((f) => f !== fqdn && up.has(f)) }),
      key: syncKey,
      installed: (r) => r === SERVICE,
      apps: () => [SERVICE],
      fetchImpl: fetchBetween,
      now: () => clock,
      aloneAfterMs: 60_000,
    });
    ref.sync = sync;
    const b: Box = { fqdn, store, access, sync, journal, roles: (req) => roleHandler(req.path, req.method, req), dir };
    boxes.set(fqdn, b);
    return b;
  }

  for (const f of order) await make(f);
  const box = (n: string) => boxes.get(`${n}.alice.flagship.services`)!;
  /** Wait until no box has a hand-over under way (one box's push can start another's fan-out). */
  const settle = async () => {
    while ((await Promise.all([...boxes.values()].map((b) => b.sync.idle()))).some(Boolean));
  };
  const post = async (b: Box, path: string, body: unknown) =>
    (await b.access.handle({ method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify(body)) }))!;
  const mode = (b: Box, m: "open" | "restricted", signer: Keypair = adminRoot) => {
    const request = { serviceRef: SERVICE, mode: m, issuedAt: clock };
    return post(b, "/api/service-access", { request, signature: hex(signServiceAccessModeV2(request, signer)) });
  };
  const rank = async (b: Box, target: string, r: string) => {
    const o = { serviceRef: SERVICE, target, rank: r, issuedAt: clock };
    const path = `/api/screens/services/${SERVICE}/members/rank`;
    return (await b.roles({ method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify({ order: o, signature: hex(signAppRank(o, adminRoot)) })) }))!;
  };
  const redeem = async (b: Box, signer: Keypair, who: Keypair = friend, maxRedemptions?: number) => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const inviteId = randomServiceInviteId();
    const create: CreateServiceInvite = {
      inviteId, authorAID: ownerAid.publicKey, serviceRef: SERVICE, secretHash: serviceInviteSecretHash(secret),
      encryptedBundle: sealInviteBundle({ name: "Sam" }, household, inviteId), issuedAt: clock,
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
    };
    carrier = { create: { ...create, authorAID: hex(ownerAid.publicKey) }, createSig: hex(signCreateServiceInvite(create, signer)) };
    const secretHash = serviceInviteSecretHash(secret);
    const aidSig = hex(signRedeemServiceInvite({ secretHash, visitorAID: who.publicKey, redeemedAt: clock }, who));
    const res = await post(b, "/api/service-invites/redeem", { secret: hex(secret), visitorAID: hex(who.publicKey), aidSig, redeemedAt: clock });
    return { res, inviteId, carrier, secretHash };
  };
  return {
    box, up, order, make, settle, mode, rank, redeem, post,
    tick: (ms = 1) => { clock += ms; },
    leader,
  };
}

describe("one access list per app", () => {
  it("an order on a follower reaches the leader and the other box", async () => {
    const f = await fleet(["home", "home2", "home3"]);
    expect(f.leader()).toBe("home.alice.flagship.services");
    expect((await f.mode(f.box("home2"), "restricted")).status).toBe(200);
    await f.settle();
    for (const n of ["home", "home2", "home3"]) expect(f.box(n).store.mode(SERVICE)).toBe("restricted");
    f.tick();
    expect((await f.rank(f.box("home3"), `device:${hex(laptop.publicKey)}`, "refused")).status).toBe(200);
    await f.settle();
    for (const n of ["home", "home2", "home3"]) expect(f.box(n).store.isAllowed(SERVICE, hex(laptop.publicKey))).toBe(false);
  });

  it("a join on one box works on the others; a withdraw there reaches them too", async () => {
    const f = await fleet(["home", "home2"]);
    const { res, inviteId } = await f.redeem(f.box("home2"), laptop);
    expect(res.status).toBe(200);
    await f.settle();
    expect(f.box("home").store.isAllowed(SERVICE, FRIEND)).toBe(true);
    expect(f.box("home").store.effectiveRank(SERVICE, FRIEND, "master")).toBe("member");
    const revoke = { inviteId, issuedAt: NOW };
    f.tick();
    const w = await f.post(f.box("home"), "/api/service-access/invite-withdraw", { revoke, signature: hex(signRevokeServiceInvite(revoke, laptop)) });
    expect(w.status).toBe(200);
    await f.settle();
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND)).toBe(false);
  });

  it("a revoke while one box is down holds there after it comes back", async () => {
    const f = await fleet(["home", "home2"]);
    const { inviteId } = await f.redeem(f.box("home"), adminRoot);
    await f.settle();
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND)).toBe(true);
    f.up.delete("home2.alice.flagship.services");
    const revoke = { inviteId, issuedAt: NOW };
    f.tick();
    expect((await f.post(f.box("home"), "/api/service-access/invite-withdraw", { revoke, signature: hex(signRevokeServiceInvite(revoke, adminRoot)) })).status).toBe(200);
    await f.settle();
    // home2 restarts from its disk: it knows home runs the app, so it waits for the list.
    const back = await f.make("home2.alice.flagship.services", f.box("home2").dir);
    f.up.add("home2.alice.flagship.services");
    back.sync.start();
    expect(back.store.isAllowed(SERVICE, FRIEND)).toBe(false);
    expect(back.store.isCatchingUp(SERVICE)).toBe(true);
    // The account's own devices still get in while it catches up.
    expect(back.store.isAllowed(SERVICE, hex(laptop.publicKey))).toBe(true);
    await f.settle();
    await back.sync.catchUp(SERVICE);
    expect(back.store.isCatchingUp(SERVICE)).toBe(false);
    expect(back.store.isAllowed(SERVICE, FRIEND)).toBe(false);
    back.sync.stop();
  });

  it("a box alone (no other server up) serves its own list after the window", async () => {
    const f = await fleet(["home", "home2"]);
    await f.redeem(f.box("home"), adminRoot);
    await f.settle();
    f.up.delete("home.alice.flagship.services");
    const back = await f.make("home2.alice.flagship.services", f.box("home2").dir);
    back.sync.start();
    expect(back.store.isCatchingUp(SERVICE)).toBe(true);
    expect(back.store.isAllowed(SERVICE, FRIEND)).toBe(false);
    await back.sync.catchUpAll();
    expect(back.store.isCatchingUp(SERVICE)).toBe(true);
    f.tick(61_000);
    await back.sync.catchUpAll();
    expect(back.store.isCatchingUp(SERVICE)).toBe(false);
    expect(back.store.isAllowed(SERVICE, FRIEND)).toBe(true);
    back.sync.stop();
  });

  it("when the leader goes down the next live server in the order leads", async () => {
    const f = await fleet(["home", "home2", "home3"]);
    f.up.delete("home.alice.flagship.services");
    expect(f.leader()).toBe("home2.alice.flagship.services");
    expect((await f.mode(f.box("home3"), "restricted")).status).toBe(200);
    await f.settle();
    expect(f.box("home2").store.mode(SERVICE)).toBe("restricted");
    expect(f.box("home").store.mode(SERVICE)).toBe("open");
    // home comes back and catches up from the new leader.
    f.up.add("home.alice.flagship.services");
    await f.box("home").sync.catchUp(SERVICE);
    expect(f.box("home").store.mode(SERVICE)).toBe("restricted");
  });

  it("the leader is never trusted: a forged entry is refused on every box", async () => {
    const f = await fleet(["home", "home2"]);
    const order = { serviceRef: SERVICE, mode: "restricted" as const, issuedAt: NOW };
    const body = JSON.stringify({ entries: [{ kind: "mode", order, signature: hex(signServiceAccessModeV2(order, ownerIrk)) }] });
    const env = { from: "home.alice.flagship.services", to: "home2.alice.flagship.services", serviceRef: SERVICE, issuedAt: NOW, body };
    const mac = accessSyncMac(syncKey, { op: "push", ...env });
    const r = await f.box("home2").sync.handle({ method: "POST", path: "/api/access-sync/push", headers: {}, body: Buffer.from(JSON.stringify({ ...env, mac })) });
    expect(r?.status).toBe(200);
    expect(JSON.parse(String(r!.body)).taken).toBe(0);
    expect(f.box("home2").store.mode(SERVICE)).toBe("open");
    // Without the account's key nobody gets in at all.
    const bad = await f.box("home2").sync.handle({ method: "POST", path: "/api/access-sync/pull", headers: {}, body: Buffer.from(JSON.stringify({ ...env, mac: "00".repeat(32) })) });
    expect(bad?.status).toBe(403);
  });

  it("a personal invite binds one person on every box, however many joins are handed over", async () => {
    const f = await fleet(["home", "home2"]);
    const { carrier, secretHash } = await f.redeem(f.box("home"), adminRoot);
    await f.settle();
    // A second person "joining" the same personal invite, handed straight to home2.
    const aidSig = hex(signRedeemServiceInvite({ secretHash, visitorAID: friend2.publicKey, redeemedAt: NOW }, friend2));
    const r = await f.box("home2").access.applyEntry(SERVICE, {
      kind: "join",
      create: carrier!.create,
      createSig: carrier!.createSig,
      redeem: { secretHash, visitorAID: hex(friend2.publicKey), redeemedAt: NOW, aidSig },
    });
    expect(r).toBe("refused");
    expect(f.box("home2").store.isAllowed(SERVICE, hex(friend2.publicKey))).toBe(false);
  });

  it("an app copy catches up from the leader", async () => {
    const f = await fleet(["home", "home2"]);
    expect((await f.mode(f.box("home"), "restricted")).status).toBe(200);
    await f.settle();
    const fresh = await f.make("home2.alice.flagship.services");
    expect(fresh.store.mode(SERVICE)).toBe("open");
    expect(await fresh.sync.catchUp(SERVICE)).toBe(true);
    expect(fresh.store.mode(SERVICE)).toBe("restricted");
  });
});
