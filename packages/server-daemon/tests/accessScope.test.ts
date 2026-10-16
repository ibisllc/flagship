/**
 * Separate lists per server, a Pro option (docs/service-access-gating.md,
 * "Separate lists per server (Pro)"; feat/marketplace): three boxes of one
 * account run the same app. An admin turns separate lists on (each box keeps
 * its copy), changes then stay on the box they were made on, turning it off
 * (or Pro ending, verifiably) makes every box take the lead server's list, and
 * an unverifiable plan changes nothing.
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
  signAppListScope,
  signCreateServiceInvite,
  signPlanAttestation,
  signRedeemServiceInvite,
  signServiceAccessModeV2,
  verifyAppListScope,
  type AppListScope,
  type CreateServiceInvite,
  type Keypair,
} from "@flagship/protocol";
import { AccessPrincipals, AccountDeviceBook } from "../src/accessPrincipals.js";
import { AccessJournal } from "../src/accessJournal.js";
import { AccessScopes, PlanCheck, type ProState } from "../src/accessScope.js";
import { buildListScopeHttp } from "../src/accessScopeHttp.js";
import { buildAccessSync, deriveAccessSyncKey, type AccessSync } from "../src/accessSync.js";
import { buildServiceAccessHttp, ServiceAccessStore, type ServiceAccessHttp } from "../src/serviceAccess.js";

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
const friend = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const friend2 = deriveAccountId({ seed: new Uint8Array(32).fill(23) });
const FRIEND = hex(friend.publicKey);
const FRIEND2 = hex(friend2.publicKey);
const syncKey = deriveAccessSyncKey(new Uint8Array(32).fill(0x77));
const fqdn = (n: string) => `${n}.alice.flagship.services`;

interface Box {
  fqdn: string;
  store: ServiceAccessStore;
  access: ServiceAccessHttp;
  sync: AccessSync;
  journal: AccessJournal;
  scopes: AccessScopes;
  http: ReturnType<typeof buildListScopeHttp>;
  merged: string[][];
  dir: string;
}

async function fleet(names: string[]) {
  const order = names.map(fqdn);
  const up = new Set(order);
  const plan = new Map<string, ProState>(order.map((f) => [f, "pro"]));
  const boxes = new Map<string, Box>();
  let carrier: { create: Record<string, unknown>; createSig: string; boundAID: string } | null = null;
  let clock = NOW;
  const leader = () => order.find((f) => up.has(f)) ?? null;
  const fetchBetween = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const to = boxes.get(u.hostname);
    if (!to || !up.has(u.hostname)) throw new Error("unreachable");
    const res = await to.sync.handle({ method: "POST", path: u.pathname, headers: {}, body: Buffer.from(String(init?.body ?? "")) });
    return new Response(res?.body ?? "", { status: res?.status ?? 404 });
  }) as unknown as typeof fetch;

  async function make(name: string, dir = mkdtempSync(join(tmpdir(), "scope-"))): Promise<Box> {
    const f = name;
    const book = new AccountDeviceBook({
      path: join(dir, "account-devices.json"),
      username: "alice",
      ownerIrkPub: () => ownerIrk.publicKey,
      adminRootPub: () => adminRoot.publicKey,
      fetchGrants: async () => ({ grants: [] }),
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
      serverId: f,
      ownerIrkPub: ownerIrk.publicKey,
      ownerAidPub: ownerAid.publicKey,
      adminRootPub: adminRoot.publicKey,
      store,
      serviceInstalled: (r) => r === SERVICE,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      fetchImpl: (async () =>
        Response.json({ redeemed: true, approvalMode: "auto", firstBind: true, serviceRef: SERVICE, ...carrier })) as unknown as typeof fetch,
      username: "alice",
      onEntry: (r, e) => ref.sync?.record(r, e),
      now: () => clock,
    });
    const planOf = { state: () => plan.get(f) ?? "unknown", refreshSoon: async () => plan.get(f) ?? "unknown" } as const;
    const scopes = new AccessScopes({
      path: join(dir, "data/flagship-access/access-scope.json"),
      plan: planOf,
      verify: (o, s) => verifyAppListScope(o, Buffer.from(s, "hex"), adminRoot.publicKey),
      now: () => clock,
    });
    await scopes.load();
    const peers = {
      leaderFor: () => leader(),
      runners: () => order.filter((x) => x !== f && up.has(x)),
      inOrder: () => order.filter((x) => x === f || up.has(x)),
      servers: () => order.filter((x) => x !== f && up.has(x)),
    };
    const sync = buildAccessSync({
      selfFqdn: f,
      journal,
      store,
      apply: (r, e) => access.applyEntry(r, e),
      peers: () => peers,
      key: syncKey,
      installed: (r) => r === SERVICE,
      apps: () => [SERVICE],
      scopes,
      fetchImpl: fetchBetween,
      now: () => clock,
      aloneAfterMs: 60_000,
    });
    ref.sync = sync;
    scopes.onTransition((r, c) => sync.onScopeChange(r, c));
    const http = buildListScopeHttp({
      selfFqdn: f,
      scopes,
      plan: planOf,
      sync: () => sync,
      peers: () => peers,
      installed: (r) => r === SERVICE,
      now: () => clock,
    });
    const b: Box = { fqdn: f, store, access, sync, journal, scopes, http, merged: [], dir };
    boxes.set(f, b);
    return b;
  }

  for (const f of order) await make(f);
  const box = (n: string) => boxes.get(fqdn(n))!;
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  };
  const post = async (b: Box, path: string, body: unknown) =>
    (await b.access.handle({ method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify(body)) }))!;
  const mode = (b: Box, m: "open" | "restricted") => {
    const request = { serviceRef: SERVICE, mode: m, issuedAt: clock };
    return post(b, "/api/service-access", { request, signature: hex(signServiceAccessModeV2(request, adminRoot)) });
  };
  const listScope = async (b: Box, scope: AppListScope, signer: Keypair = adminRoot) => {
    const o = { serviceRef: SERVICE, scope, issuedAt: clock };
    const path = `/api/screens/services/${SERVICE}/list-scope`;
    const r = (await b.http(path, "POST", { method: "POST", path, headers: {}, body: Buffer.from(JSON.stringify({ order: o, signature: hex(signAppListScope(o, signer)) })) }))!;
    return { status: r.status, body: JSON.parse(String(r.body)) };
  };
  const get = async (b: Box, path: string) => {
    const r = (await b.http(path, "GET", { method: "GET", path, headers: {}, body: Buffer.alloc(0) }))!;
    return { status: r.status, body: JSON.parse(String(r.body)) };
  };
  const redeem = async (b: Box, who: Keypair) => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const inviteId = randomServiceInviteId();
    const create: CreateServiceInvite = {
      inviteId, authorAID: ownerAid.publicKey, serviceRef: SERVICE, secretHash: serviceInviteSecretHash(secret),
      encryptedBundle: sealInviteBundle({ name: "Sam" }, household, inviteId), issuedAt: clock,
    };
    carrier = {
      create: { ...create, authorAID: hex(ownerAid.publicKey) },
      createSig: hex(signCreateServiceInvite(create, adminRoot)),
      boundAID: hex(who.publicKey),
    };
    const secretHash = serviceInviteSecretHash(secret);
    const aidSig = hex(signRedeemServiceInvite({ secretHash, visitorAID: who.publicKey, redeemedAt: clock }, who));
    return post(b, "/api/service-invites/redeem", { secret: hex(secret), visitorAID: hex(who.publicKey), aidSig, redeemedAt: clock });
  };
  /** The plan as one box sees it, then what that box does about it. */
  const setPlan = async (n: string, s: ProState) => {
    plan.set(fqdn(n), s);
    const b = box(n);
    b.merged.push(await b.scopes.planChanged(s));
  };
  return { box, up, make, settle, mode, listScope, get, redeem, setPlan, tick: (ms = 1) => (clock += ms), leader };
}

describe("separate lists per server (Pro)", () => {
  it("turning it on keeps each box's copy; then changes stay on the box they were made on", async () => {
    const f = await fleet(["home", "home2", "home3"]);
    expect((await f.redeem(f.box("home"), friend)).status).toBe(200);
    await f.settle();
    for (const n of ["home", "home2", "home3"]) expect(f.box(n).store.isAllowed(SERVICE, FRIEND)).toBe(true);

    f.tick();
    const on = await f.listScope(f.box("home2"), "server");
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ scope: "server", plan: "pro", leader: fqdn("home") });
    await f.settle();
    for (const n of ["home", "home2", "home3"]) {
      expect(f.box(n).scopes.scope(SERVICE)).toBe("server");
      // Each box kept its copy.
      expect(f.box(n).store.isAllowed(SERVICE, FRIEND)).toBe(true);
    }

    // A join on home2 and a mode order on home3 stay where they were made.
    f.tick();
    expect((await f.redeem(f.box("home2"), friend2)).status).toBe(200);
    f.tick();
    expect((await f.mode(f.box("home3"), "restricted")).status).toBe(200);
    await f.settle();
    await f.box("home").sync.reconcileOnce();
    await f.box("home2").sync.reconcileOnce();
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND2)).toBe(true);
    expect(f.box("home").store.isAllowed(SERVICE, FRIEND2)).toBe(false);
    expect(f.box("home3").store.isAllowed(SERVICE, FRIEND2)).toBe(false);
    expect(f.box("home3").store.mode(SERVICE)).toBe("restricted");
    expect(f.box("home").store.mode(SERVICE)).toBe("open");
    expect(f.box("home2").store.mode(SERVICE)).toBe("open");
  });

  it("refuses to turn it on without Pro, and refuses an order from a non-admin key or an older one", async () => {
    const f = await fleet(["home", "home2"]);
    await f.setPlan("home", "free");
    const r = await f.listScope(f.box("home"), "server");
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("pro-required");
    expect(f.box("home").scopes.scope(SERVICE)).toBe("account");

    const notAdmin = await f.listScope(f.box("home2"), "server", ownerIrk);
    expect(notAdmin.status).toBe(403);
    f.tick();
    expect((await f.listScope(f.box("home2"), "server")).status).toBe(200);
    const older = { serviceRef: SERVICE, scope: "account" as const, issuedAt: NOW - 1 };
    expect(await f.box("home2").scopes.adopt(older, hex(signAppListScope(older, adminRoot)), { direct: true })).toBe("stale");
  });

  it("a box that can't check the plan holds the order as pending (one list) until it sees Pro", async () => {
    const f = await fleet(["home", "home2"]);
    await f.setPlan("home2", "unknown");
    f.tick();
    expect((await f.listScope(f.box("home"), "server")).status).toBe(200);
    await f.settle();
    expect(f.box("home").scopes.scope(SERVICE)).toBe("server");
    expect(f.box("home2").scopes.scope(SERVICE)).toBe("account");
    expect((await f.get(f.box("home2"), `/api/screens/services/${SERVICE}/list-scope`)).body).toMatchObject({ pending: true, plan: "unknown" });
    // Nothing crosses between the pending box and the separate one.
    f.tick();
    await f.redeem(f.box("home2"), friend2);
    await f.settle();
    expect(f.box("home").store.isAllowed(SERVICE, FRIEND2)).toBe(false);
    await f.setPlan("home2", "pro");
    expect(f.box("home2").scopes.scope(SERVICE)).toBe("server");
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND2)).toBe(true);
  });

  it("turning it off: every box takes the lead server's list", async () => {
    const f = await fleet(["home", "home2", "home3"]);
    f.tick();
    expect((await f.listScope(f.box("home3"), "server")).status).toBe(200);
    await f.settle();
    f.tick();
    await f.redeem(f.box("home"), friend);
    f.tick();
    await f.redeem(f.box("home2"), friend2);
    f.tick();
    expect((await f.mode(f.box("home2"), "restricted")).status).toBe(200);
    await f.settle();

    f.tick();
    const off = await f.listScope(f.box("home3"), "account");
    expect(off.status).toBe(200);
    await f.settle();
    for (const n of ["home2", "home3"]) await f.box(n).sync.catchUp(SERVICE);
    for (const n of ["home", "home2", "home3"]) {
      const b = f.box(n);
      expect(b.scopes.scope(SERVICE)).toBe("account");
      expect(b.store.isCatchingUp(SERVICE)).toBe(false);
      expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(true);
      expect(b.store.isAllowed(SERVICE, FRIEND2)).toBe(false);
    }
    // home2 keeps its own mode (no mode order in the leader's list), never opened in between.
    expect(f.box("home2").store.mode(SERVICE)).toBe("restricted");
    // One list again: a change on a follower reaches everyone.
    f.tick();
    await f.redeem(f.box("home3"), friend2);
    await f.settle();
    expect(f.box("home").store.isAllowed(SERVICE, FRIEND2)).toBe(true);
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND2)).toBe(true);
  });

  it("a box that was off during a switch learns it from the next server it talks to", async () => {
    const f = await fleet(["home", "home2"]);
    f.up.delete(fqdn("home2"));
    f.tick();
    expect((await f.listScope(f.box("home"), "server")).status).toBe(200);
    await f.settle();
    f.tick();
    await f.redeem(f.box("home"), friend);
    await f.settle();
    f.up.add(fqdn("home2"));
    await f.box("home2").sync.reconcileOnce();
    expect(f.box("home2").scopes.scope(SERVICE)).toBe("server");
    // It kept its own copy: the join made on home while it was separate never crosses.
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND)).toBe(false);

    // Off again while home2 is down: when it's back it takes home's list.
    f.tick();
    await f.redeem(f.box("home2"), friend2);
    f.up.delete(fqdn("home2"));
    f.tick();
    expect((await f.listScope(f.box("home"), "account")).status).toBe(200);
    f.up.add(fqdn("home2"));
    await f.box("home2").sync.reconcileOnce();
    await f.settle();
    await f.box("home2").sync.catchUp(SERVICE);
    expect(f.box("home2").scopes.scope(SERVICE)).toBe("account");
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND)).toBe(true);
    expect(f.box("home2").store.isAllowed(SERVICE, FRIEND2)).toBe(false);
  });

  it("Pro ending (verifiably) merges every app into the lead server's list; only the leader tells the owner", async () => {
    const f = await fleet(["home", "home2"]);
    f.tick();
    expect((await f.listScope(f.box("home"), "server")).status).toBe(200);
    await f.settle();
    f.tick();
    await f.redeem(f.box("home"), friend);
    f.tick();
    await f.redeem(f.box("home2"), friend2);
    await f.settle();

    const summary = await f.get(f.box("home2"), "/api/screens/access-lists/summary");
    expect(summary.body).toEqual({ plan: "pro", separateApps: 1, leaders: [fqdn("home")] });

    await f.setPlan("home2", "free");
    await f.setPlan("home", "free");
    await f.settle();
    await f.box("home2").sync.catchUp(SERVICE);
    for (const n of ["home", "home2"]) {
      expect(f.box(n).scopes.scope(SERVICE)).toBe("account");
      expect(f.box(n).store.isAllowed(SERVICE, FRIEND)).toBe(true);
      expect(f.box(n).store.isAllowed(SERVICE, FRIEND2)).toBe(false);
    }
    expect(f.box("home").merged.flat()).toEqual([SERVICE]);
    // Pro coming back doesn't bring separate lists back: a new order does.
    await f.setPlan("home", "pro");
    expect(f.box("home").scopes.scope(SERVICE)).toBe("account");
    expect((await f.get(f.box("home"), "/api/screens/access-lists/summary")).body.separateApps).toBe(0);
  });

  it("a plan that can't be checked never merges anything", async () => {
    const f = await fleet(["home", "home2"]);
    f.tick();
    await f.listScope(f.box("home"), "server");
    await f.settle();
    await f.setPlan("home", "unknown");
    await f.setPlan("home2", "unknown");
    expect(f.box("home").merged.flat()).toEqual([]);
    for (const n of ["home", "home2"]) expect(f.box(n).scopes.scope(SERVICE)).toBe("server");
  });

  it("the switch survives a restart and a tampered file can't turn it on", async () => {
    const f = await fleet(["home"]);
    f.tick();
    await f.listScope(f.box("home"), "server");
    const back = await f.make(fqdn("home"), f.box("home").dir);
    expect(back.scopes.scope(SERVICE)).toBe("server");
    const { writeFile } = await import("node:fs/promises");
    const forged = { serviceRef: SERVICE, scope: "server", issuedAt: NOW + 99 };
    await writeFile(
      join(back.dir, "data/flagship-access/access-scope.json"),
      JSON.stringify({ [SERVICE]: { order: forged, signature: hex(signAppListScope(forged as never, ownerIrk)), honoured: true } }),
    );
    const again = await f.make(fqdn("home"), back.dir);
    expect(again.scopes.scope(SERVICE)).toBe("account");
  });

  it("GET list-scope lists the app's servers in order for the picker", async () => {
    const f = await fleet(["home", "home2", "home3"]);
    const s = await f.get(f.box("home2"), `/api/screens/services/${SERVICE}/list-scope`);
    expect(s.body).toMatchObject({
      serviceRef: SERVICE,
      scope: "account",
      pending: false,
      plan: "pro",
      self: fqdn("home2"),
      leader: fqdn("home"),
      servers: [fqdn("home"), fqdn("home2"), fqdn("home3")],
    });
  });
});

describe("PlanCheck", () => {
  const ca = key(0x61);
  const caHex = hex(ca.publicKey);
  const PIN = "ab".repeat(32);
  const DAY = 86_400_000;
  const attest = (tier: "free" | "hobby" | "maker", issuedAt: number, paidUntil = 0, username = "alice", signer = ca) =>
    signPlanAttestation({ username, tier, paidUntil, issuedAt, expiresAt: issuedAt + DAY }, signer);

  function check(served: () => unknown, clock: { t: number }, dir = mkdtempSync(join(tmpdir(), "plan-"))) {
    return new PlanCheck({
      path: join(dir, "plan.json"),
      username: "alice",
      chain: () => ({ authorizedCaKeys: () => [caHex] }),
      fetchAttestation: async () => served(),
      pinnedMandateHash: PIN,
      now: () => clock.t,
    });
  }

  it("is unknown until it holds a CA-signed attestation, then follows it", async () => {
    const clock = { t: NOW };
    let served: unknown = null;
    const p = check(() => served, clock);
    await p.load();
    expect(p.state()).toBe("unknown");
    served = attest("hobby", NOW, NOW + 30 * DAY);
    const seen: ProState[] = [];
    p.onChange((s) => seen.push(s));
    expect(await p.refresh()).toBe("pro");
    served = attest("free", NOW + 10);
    clock.t = NOW + 20;
    expect(await p.refresh()).toBe("free");
    expect(seen).toEqual(["pro", "free"]);
  });

  it("refuses another account's, an unsigned or an older attestation", async () => {
    const clock = { t: NOW + 5 };
    let served: unknown = attest("hobby", NOW, NOW + DAY, "mallory");
    const p = check(() => served, clock);
    expect(await p.refresh()).toBe("unknown");
    served = attest("maker", NOW, NOW + DAY, "alice", key(0x62));
    expect(await p.refresh()).toBe("unknown");
    served = attest("hobby", NOW + 2, NOW + DAY);
    expect(await p.refresh()).toBe("pro");
    served = attest("free", NOW + 1);
    expect(await p.refresh()).toBe("pro");
  });

  it("goes unknown (never free) when the attestation runs out or the paid period ends without word", async () => {
    const clock = { t: NOW + 1 };
    const served: unknown = attest("hobby", NOW, NOW + 3_600_000);
    const p = check(() => served, clock);
    expect(await p.refresh()).toBe("pro");
    clock.t = NOW + 3_600_000;
    expect(p.state()).toBe("unknown");
    clock.t = NOW + DAY;
    expect(p.state()).toBe("unknown");
  });

  it("keeps the newest attestation across a restart", async () => {
    const clock = { t: NOW + 1 };
    const dir = mkdtempSync(join(tmpdir(), "plan-"));
    const p = check(() => attest("maker", NOW, NOW + DAY), clock, dir);
    await p.refresh();
    const q = check(() => null, clock, dir);
    await q.load();
    expect(q.state()).toBe("pro");
  });
});
