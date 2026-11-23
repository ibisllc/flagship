/**
 * Security report F4 (docs/security/F4-invite-cap-race-investigation.md): an
 * invite's cap, end to end. The real `.com` redeem handler over the real D1
 * adapter (node:sqlite, every migration), the real box redeem path and the
 * journal applier: parallel redeems never bind past the cap, every redeemer
 * gets a session as themselves, a removal frees no slot, and the app's servers
 * keep the same first N whatever order the joins reach them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveIRK,
  serviceInviteId,
  serviceInviteSecretHash,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  type CreateServiceInvite,
  type Keypair,
} from "@flagship/protocol";
import { D1Storage } from "@flagship/storage";
import { handleRedeemServiceInvite } from "../../control-plane/src/serviceInvites.js";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import { buildServiceAccessHttp, ServiceAccessStore, ServiceSessionStore } from "../src/serviceAccess.js";
import { entryHash, type AccessEntry } from "../src/accessJournal.js";

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice-notes";
const NOW = 1_770_000_000_000;
const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const tmp = (p: string) => join(mkdtempSync(join(tmpdir(), "f4-")), p);
const person = (n: number) => deriveAccountId({ seed: new Uint8Array(32).fill(100 + n) });

function invite(nonce: number, max?: number) {
  const secret = new Uint8Array(32).fill(nonce);
  const secretHash = serviceInviteSecretHash(secret);
  const inviteId = serviceInviteId(ownerAid.publicKey, ownerIrk.publicKey, nonce);
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: ownerAid.publicKey,
    serviceRef: SERVICE,
    secretHash,
    encryptedBundle: "00",
    issuedAt: NOW,
    ...(max !== undefined ? { maxRedemptions: max } : {}),
  };
  const createSig = hex(signCreateServiceInvite(create, ownerIrk));
  const carrier = { ...create, authorAID: hex(create.authorAID) } as Record<string, unknown>;
  return { secret, secretHash, inviteId, create, createSig, carrier, max };
}

function joinEntry(inv: ReturnType<typeof invite>, k: Keypair, at: number): AccessEntry {
  const aidSig = hex(signRedeemServiceInvite({ secretHash: inv.secretHash, visitorAID: k.publicKey, redeemedAt: at }, k));
  return {
    kind: "join",
    create: inv.carrier,
    createSig: inv.createSig,
    redeem: { secretHash: inv.secretHash, visitorAID: hex(k.publicKey), redeemedAt: at, aidSig },
  };
}

async function box(fetchImpl: typeof fetch, onJoined?: (ref: string) => void) {
  const store = new ServiceAccessStore(tmp("access.json"));
  await store.load();
  const sessions = new ServiceSessionStore(tmp("sessions.json"));
  await store.setMode(SERVICE, "restricted");
  const access = buildServiceAccessHttp({
    serverId: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    store,
    sessions,
    serviceInstalled: (r) => r === SERVICE,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl,
    rateLimitPerMin: 10_000,
    now: () => NOW,
    ...(onJoined ? { onJoined } : {}),
  });
  const redeem = async (inv: ReturnType<typeof invite>, k: Keypair, at = NOW) => {
    const aidSig = hex(signRedeemServiceInvite({ secretHash: inv.secretHash, visitorAID: k.publicKey, redeemedAt: at }, k));
    const res = await access.handle({
      method: "POST",
      path: "/api/service-invites/redeem",
      headers: { host: FQDN },
      body: Buffer.from(JSON.stringify({ secret: hex(inv.secret), visitorAID: hex(k.publicKey), aidSig, redeemedAt: at })),
    } as never);
    const tok = /Flagship-App-Session=([^;]+)/.exec(String(res!.headers?.["set-cookie"] ?? ""))?.[1];
    const sess = tok ? await sessions.lookup(tok, NOW) : null;
    return { me: hex(k.publicKey), status: res!.status, cookieAid: sess ? sess.aid : null };
  };
  return { store, sessions, access, redeem };
}

/** The real `.com`: its redeem handler over the D1 adapter on node:sqlite. */
async function realCom(invites: ReturnType<typeof invite>[]) {
  const sqlite = createSqliteD1();
  const db = new D1Storage(sqlite);
  for (const inv of invites) {
    await db.serviceInvites.create({
      inviteId: inv.inviteId,
      authorAID: hex(ownerAid.publicKey),
      serviceRef: SERVICE,
      encryptedBundle: "00",
      secretHash: inv.secretHash,
      createdAt: NOW,
      createSig: inv.createSig,
      createIssuedAt: NOW,
      ...(inv.max !== undefined ? { maxRedemptions: inv.max } : {}),
    });
  }
  const deps = { invites: db.serviceInvites, usernames: db.usernames, now: () => NOW };
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const r = await handleRedeemServiceInvite(deps, JSON.parse(init.body));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { db, sqlite, fetchImpl };
}

/** A `.com` that binds everyone it is asked about (an over-full ledger, as the old race left), naming each visitor. */
function overBindingCom(inv: ReturnType<typeof invite>): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    const b = JSON.parse(init.body) as { visitorAID: string };
    return new Response(
      JSON.stringify({ redeemed: true, approvalMode: "auto", firstBind: true, serviceRef: SERVICE, boundAID: b.visitorAID, create: inv.carrier, createSig: inv.createSig }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("F4: invite caps end to end (real .com handler, real D1, real box)", () => {
  it("a group invite lets in its cap, and each person in as themselves", async () => {
    const inv = invite(1, 3);
    const com = await realCom([inv]);
    try {
      const b = await box(com.fetchImpl);
      const out = [];
      for (let i = 0; i < 4; i++) out.push(await b.redeem(inv, person(i)));
      expect(out.map((o) => o.status)).toEqual([200, 200, 200, 409]);
      for (const o of out.slice(0, 3)) expect(o.cookieAid).toBe(o.me);
      expect(out[3]!.cookieAid).toBeNull();
      expect((await com.db.serviceInvites.get(inv.inviteId))!.boundAIDs).toHaveLength(3);
      expect(b.store.allowList(SERVICE)).toHaveLength(3);
    } finally {
      com.sqlite.close();
    }
  });

  for (const [label, max, cap] of [
    ["single-use", undefined, 1],
    ["max 1", 1, 1],
    ["max 3", 3, 3],
  ] as const) {
    it(`parallel redeems of a ${label} invite let in exactly ${cap}`, async () => {
      const inv = invite(2, max);
      const com = await realCom([inv]);
      try {
        const b = await box(com.fetchImpl);
        const out = await Promise.all(Array.from({ length: 8 }, (_, i) => b.redeem(inv, person(i))));
        const ok = out.filter((o) => o.status === 200);
        expect(ok).toHaveLength(cap);
        for (const o of ok) expect(o.cookieAid).toBe(o.me);
        for (const o of out.filter((x) => x.status !== 200)) expect(o.cookieAid).toBeNull();
        expect((await com.db.serviceInvites.get(inv.inviteId))!.boundAIDs).toHaveLength(cap);
        expect(b.store.allowList(SERVICE).sort()).toEqual(ok.map((o) => o.me).sort());
      } finally {
        com.sqlite.close();
      }
    });
  }
});

describe("F4: the box holds the cap itself", () => {
  it("parallel redeems past an over-binding .com are capped on the box, keeping the first two by (time, entry hash)", async () => {
    const inv = invite(3, 2);
    const b = await box(overBindingCom(inv));
    const people = Array.from({ length: 6 }, (_, i) => person(i));
    await Promise.all(people.map((k) => b.redeem(inv, k)));
    expect(b.store.boundThrough(SERVICE, inv.inviteId)).toBe(2);
    const firstTwo = people
      .map((k) => ({ aid: hex(k.publicKey), h: entryHash(joinEntry(inv, k, NOW)) }))
      .sort((x, y) => (x.h < y.h ? -1 : 1))
      .slice(0, 2)
      .map((x) => x.aid)
      .sort();
    expect(b.store.allowList(SERVICE).sort()).toEqual(firstTwo);
  });

  it("a redemption that sorts after a full invite's last one is refused with no session", async () => {
    const inv = invite(9, 1);
    const b = await box(overBindingCom(inv));
    expect((await b.redeem(inv, person(0), NOW)).status).toBe(200);
    const later = await b.redeem(inv, person(1), NOW + 1_000);
    expect(later).toMatchObject({ status: 409, cookieAid: null });
  });

  it("removing someone frees no slot on their invite", async () => {
    const inv = invite(4, 1);
    const b = await box(overBindingCom(inv));
    expect((await b.redeem(inv, person(0))).status).toBe(200);
    await b.store.removeAllowed(SERVICE, hex(person(0).publicKey));
    expect(b.store.isAllowed(SERVICE, hex(person(0).publicKey))).toBe(false);
    const later = await b.redeem(inv, person(1), NOW + 1_000);
    expect(later.status).toBe(409);
    expect(b.store.isAllowed(SERVICE, hex(person(1).publicKey))).toBe(false);
    // ... and a join of that later person handed over by another server stays refused.
    expect(await b.access.applyEntry(SERVICE, joinEntry(inv, person(1), NOW + 5))).toBe("refused");
  });

  it("tells the owner once per new person, on the server they joined through", async () => {
    const inv = invite(5, 3);
    const joined: string[] = [];
    const b = await box(overBindingCom(inv), (ref) => joined.push(ref));
    await b.redeem(inv, person(0));
    await b.redeem(inv, person(0));
    await b.redeem(inv, person(1));
    expect(joined).toEqual([SERVICE, SERVICE]);
    // A join handed over by another server is taken quietly.
    expect(await b.access.applyEntry(SERVICE, joinEntry(inv, person(2), NOW))).toBe("applied");
    expect(joined).toHaveLength(2);
  });
});

describe("F4: every server keeps the same first N (journal joins)", () => {
  it("two servers converge whatever order the joins arrive in, and a freed slot readmits nobody", async () => {
    const inv = invite(6, 2);
    const early = [joinEntry(inv, person(0), NOW + 10), joinEntry(inv, person(1), NOW + 20)];
    const late = joinEntry(inv, person(2), NOW + 30);
    const x = await box(overBindingCom(inv));
    const y = await box(overBindingCom(inv));
    for (const e of [...early, late]) await x.access.applyEntry(SERVICE, e);
    // y sees the latest first: it lets that one in, then gives its place to an earlier join.
    for (const e of [late, ...early]) await y.access.applyEntry(SERVICE, e);
    const first = [person(0), person(1)].map((k) => hex(k.publicKey)).sort();
    expect(x.store.allowList(SERVICE).sort()).toEqual(first);
    expect(y.store.allowList(SERVICE).sort()).toEqual(first);
    // Re-sent on every reconcile: still refused, on both.
    expect(await x.access.applyEntry(SERVICE, late)).toBe("refused");
    expect(await y.access.applyEntry(SERVICE, late)).toBe("refused");
    // An admin removes one of the first two: the waiting join stays out.
    await x.store.removeAllowed(SERVICE, first[0]!);
    expect(await x.access.applyEntry(SERVICE, late)).toBe("refused");
    expect(x.store.isAllowed(SERVICE, hex(person(2).publicKey))).toBe(false);
  });

  it("an equal time is broken by the entry hash, the same on every server", async () => {
    const inv = invite(7, 1);
    const a = joinEntry(inv, person(3), NOW);
    const c = joinEntry(inv, person(4), NOW);
    const x = await box(overBindingCom(inv));
    const y = await box(overBindingCom(inv));
    await x.access.applyEntry(SERVICE, a);
    await x.access.applyEntry(SERVICE, c);
    await y.access.applyEntry(SERVICE, c);
    await y.access.applyEntry(SERVICE, a);
    expect(x.store.allowList(SERVICE)).toEqual(y.store.allowList(SERVICE));
    expect(x.store.allowList(SERVICE)).toHaveLength(1);
  });

  it("people bound before the ledger count toward the cap and are never displaced", async () => {
    const inv = invite(8, 1);
    const x = await box(overBindingCom(inv));
    const legacy = hex(person(5).publicKey);
    await x.store.addAllowed(SERVICE, legacy, inv.inviteId);
    expect(await x.access.applyEntry(SERVICE, joinEntry(inv, person(6), NOW - 1_000_000))).toBe("refused");
    expect(x.store.allowList(SERVICE)).toEqual([legacy]);
  });
});
