import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  buildOrgKeyRing,
  buildOrgSeatBook,
  orgKeyContextFromServed,
  rotateOrgKey,
  canonicalOrgKeyRing,
  canonicalOrgSeatGrant,
  canonicalOrgSeatRevoke,
  canonicalOrgServerCode,
  orgKemKeyPair,
  orgServerCodeSha256,
  orgSha256Hex,
  signOrgApproval,
  signOrgAuditExport,
  signOrgBoxKem,
  signOrgSeatKem,
  signOrgServerRegister,
  signOrgServerEnrolment,
  orgServerEnrolmentPubKey,
  signOrgBoxLogHead,
  verifyOrgAuditExport,
  verifyOrgAuthorityChain,
  type OrgAuditObjects,
  type OrgKemKey,
  type OrgServerCode,
} from "@flagship/protocol";
import { InMemoryOrgStorage, InMemoryStorage } from "@flagship/storage";
import {
  handleOrgAuthorityAppend,
  handleOrgBoxKem,
  handleOrgBoxLogHead,
  handleOrgCreate,
  handleOrgExport,
  handleOrgKeyRingPost,
  handleOrgKeysGet,
  handleOrgSeatKem,
  handleOrgServerCode,
  handleOrgServerRegister,
  handleOrgServersList,
  type OrgServerDeps,
} from "../src/index.js";

const dir = resolve(import.meta.dirname, "../../protocol/test-vectors");
const V = JSON.parse(readFileSync(resolve(dir, "org-authority/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const chain = refs(V.chains[0]);
const grants = refs(V.seatBooks[0]).grants;
const ORG = V.orgId as string;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const AT = chain.entries[1].record.issuedAt + 4 * HOUR;
const SERVER = "home.acme.flagship.services";
const key = (name: string) => {
  const k = V.keys[name];
  return { seatId: k.seatId as string, keyId: k.keyId as string, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const A = key("A founder");
const B = key("B admin");
const S = key("S scoped admin");
const SM = key("S member");
const approve = (k: ReturnType<typeof key>, order: Uint8Array, at: number) =>
  signOrgApproval({ orgId: ORG, oarVersion: 1, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt: at, notAfter: at + DAY }, k.secret);

function world() {
  let t = chain.entries[1].record.issuedAt + HOUR;
  const store = new InMemoryOrgStorage();
  const base = new InMemoryStorage();
  const d: OrgServerDeps & { set: (x: number) => void; store: InMemoryOrgStorage; base: InMemoryStorage } = {
    orgs: store,
    usernames: base.usernames,
    servers: base.servers,
    authCodes: base.authCodes,
    now: () => t,
    set: (x) => {
      t = x;
    },
    store,
    base,
  };
  return d;
}

async function orgWithSeats() {
  const d = world();
  expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
  expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
  for (const g of grants) {
    await d.store.putObject(ORG, { kind: "grant", key: `${g.grant.seatId}:${g.grant.issuedAt}`, bodyJson: JSON.stringify(g), issuedAt: g.grant.issuedAt, storedAt: 0 });
    await d.store.appendLog(ORG, "grant", orgSha256Hex(canonicalOrgSeatGrant(g.grant)), g.grant.issuedAt);
  }
  return d;
}

// The enrolment key's seed: in the recipe only, never sent to .com.
const ENROL = "6e".repeat(32);
const serverCode = (over: Partial<OrgServerCode> = {}): OrgServerCode => ({
  orgId: ORG,
  genesisHash: V.genesisHash,
  serial: "orgsrv-test-0001",
  serverName: "home",
  serverDomain: SERVER,
  delegatedPubKeyHex: "d1".repeat(32),
  enrolmentPubKeyHex: orgServerEnrolmentPubKey(ENROL),
  issuedAt: AT,
  expiresAt: AT + 12 * HOUR,
  ...over,
});
const enrol = (request: Parameters<typeof signOrgServerRegister>[0], c: OrgServerCode, seed = ENROL) => signOrgServerEnrolment(request, c, seed);
const stkSeed = new Uint8Array(32).fill(0x5e);
const stkPub = Buffer.from(ed25519.getPublicKey(stkSeed)).toString("hex");

async function registered() {
  const d = await orgWithSeats();
  d.set(AT + MIN);
  const c = serverCode();
  const issued = await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(B, canonicalOrgServerCode(c), AT)] });
  expect(issued.status).toBe(200);
  d.set(AT + 30 * MIN);
  const request = { orgId: ORG, serial: c.serial, serverDomain: SERVER, codeSha256: orgServerCodeSha256(c), serverIdentityPubKeyHex: stkPub, issuedAt: AT + 30 * MIN, nonceHex: "ab".repeat(16) };
  const reg = await handleOrgServerRegister(d, ORG, { request, signature: signOrgServerRegister(request, stkSeed), enrolmentSignature: enrol(request, c) });
  expect(reg.status).toBe(200);
  return { d, c, request };
}

describe(".com org servers", () => {
  it("issues a server code only under an org admin's (or a servers-add seat's) approval", async () => {
    const d = await orgWithSeats();
    d.set(AT + MIN);
    const c = serverCode();
    const byScoped = await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(S, canonicalOrgServerCode(c), AT)] });
    expect(byScoped.status).toBe(403);
    expect((byScoped.body as { code: string }).code).toBe("org-add-server-refused");
    const wrongDomain = serverCode({ serverDomain: "home.other.flagship.services" });
    expect((await handleOrgServerCode(d, ORG, { code: wrongDomain, approvals: [approve(B, canonicalOrgServerCode(wrongDomain), AT)] })).status).toBe(400);
    expect((await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(B, canonicalOrgServerCode(c), AT)] })).status).toBe(200);
    expect((await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(A, canonicalOrgServerCode(c), AT)] })).status).toBe(409);
  });

  it("never exports a server code its box has not redeemed (an unused code is a secret)", async () => {
    const d = await orgWithSeats();
    d.set(AT + MIN);
    const c = serverCode();
    expect((await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(B, canonicalOrgServerCode(c), AT)] })).status).toBe(200);
    const pending = JSON.stringify((await handleOrgExport(d, ORG)).body);
    expect(pending).not.toContain(c.serial);
    expect((JSON.parse(pending) as { serverCodes: unknown[] }).serverCodes).toEqual([]);
    // Once its box has registered, the (now useless) code travels with the server, as the audit needs.
    const { d: d2, c: used } = await registered();
    const exp = (await handleOrgExport(d2, ORG)).body as { serverCodes: Array<{ code: { serial: string } }> };
    expect(exp.serverCodes.map((x) => x.code.serial)).toEqual([used.serial]);
  });

  it("finds the org behind a server code's serial, for the install timeline", async () => {
    const { d, c } = await registered();
    expect(await d.orgs.findServerCodeOrg(c.serial)).toBe(ORG);
    expect(await d.orgs.findServerCodeOrg("orgsrv-9999-none")).toBeNull();
  });

  it("keeps a box's newest signed log head and puts it, with the server, in the export", async () => {
    const { d } = await registered();
    const at = AT + 40 * MIN;
    d.set(at);
    const head = (seq: number, hash: string, issuedAt: number) => {
      const h = { orgId: ORG, serverDomain: SERVER, seq, headHash: hash, issuedAt };
      return { head: h, signature: signOrgBoxLogHead(h, stkSeed) };
    };
    expect((await handleOrgBoxLogHead(d, ORG, head(5, "aa".repeat(32), at))).status).toBe(200);
    // Another log at the same sequence, an older head, another key, a server that is not the org's.
    expect((await handleOrgBoxLogHead(d, ORG, head(5, "bb".repeat(32), at + 1))).status).toBe(409);
    expect((await handleOrgBoxLogHead(d, ORG, head(4, "cc".repeat(32), at + 2))).status).toBe(409);
    const forged = head(6, "dd".repeat(32), at + 3);
    forged.signature = signOrgBoxLogHead(forged.head, new Uint8Array(32).fill(0x77));
    expect((await handleOrgBoxLogHead(d, ORG, forged)).status).toBe(403);
    const elsewhere = { ...head(6, "dd".repeat(32), at + 3) };
    elsewhere.head = { ...elsewhere.head, serverDomain: "other.acme.flagship.services" };
    expect((await handleOrgBoxLogHead(d, ORG, elsewhere)).status).toBe(404);
    expect((await handleOrgBoxLogHead(d, ORG, head(9, "ee".repeat(32), at + 4))).status).toBe(200);
    const exp = (await handleOrgExport(d, ORG)).body as { servers: Array<{ serverDomain: string; identityPubKeyHex: string }>; boxLogHeads: Array<{ head: { seq: number } }>; log: Array<{ kind: string }> };
    expect(exp.servers).toEqual([{ serverDomain: SERVER, serial: expect.any(String), identityPubKeyHex: stkPub }]);
    expect(exp.boxLogHeads.map((b) => b.head.seq)).toEqual([9]);
    expect(exp.log.filter((e) => e.kind === "box-log-head")).toHaveLength(2);
    // Every logged head and registration travels too, so an auditor can see none was dropped (05c F5).
    const all = exp as unknown as { boxLogHeadHistory: Array<{ seq: number }>; registrations: Array<{ serverDomain: string; identityPubKeyHex: string }> };
    expect(all.boxLogHeadHistory.map((h) => h.seq)).toEqual([5, 9]);
    expect(all.registrations).toEqual([{ serverDomain: SERVER, identityPubKeyHex: stkPub }]);
    // A head stored but not (yet) logged, as when an export reads between the two writes, is not served ahead
    // of its log entry: the export keeps serving the last logged one.
    const late = head(12, "ff".repeat(32), at + 5);
    await d.orgs.putObject(ORG, { kind: "box-log-head", key: SERVER, bodyJson: JSON.stringify(late), issuedAt: late.head.issuedAt, storedAt: at + 5 }, true);
    const exp2 = (await handleOrgExport(d, ORG)).body as { boxLogHeads: Array<{ head: { seq: number } }> };
    expect(exp2.boxLogHeads.map((b) => b.head.seq)).toEqual([9]);
  });

  it("refuses a new server once the org's plan has lapsed", async () => {
    const d = await orgWithSeats();
    await d.store.setPlan(ORG, { planTier: "business", seatLimit: null, paidUntil: AT - 4 * DAY, paidSeats: 3, trialEndsAt: AT - 40 * DAY });
    d.set(AT + MIN);
    const c = serverCode();
    const r = await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(B, canonicalOrgServerCode(c), AT)] });
    expect((r.body as { code: string }).code).toBe("org-plan-lapsed");
  });

  it("registers the box once, with the code it admitted, under the org's name", async () => {
    const { d, c, request } = await registered();
    expect((await d.base.servers.get(SERVER))?.username).toBe("acme");
    expect((await d.base.servers.get(SERVER))?.identityPubKeyHex).toBe(stkPub);
    const again = await handleOrgServerRegister(d, ORG, { request, signature: signOrgServerRegister(request, stkSeed), enrolmentSignature: enrol(request, c) });
    expect(again.status).toBe(409);
    const list = await handleOrgServersList(d, ORG);
    expect((list.body as { servers: Array<{ serverDomain: string }> }).servers.map((s) => s.serverDomain)).toEqual([SERVER]);
  });

  it("refuses a registration over another code or with a bad signature", async () => {
    const d = await orgWithSeats();
    d.set(AT + MIN);
    const c = serverCode();
    await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(B, canonicalOrgServerCode(c), AT)] });
    d.set(AT + 2 * MIN);
    const request = { orgId: ORG, serial: c.serial, serverDomain: SERVER, codeSha256: "00".repeat(32), serverIdentityPubKeyHex: stkPub, issuedAt: AT + 2 * MIN, nonceHex: "cd".repeat(16) };
    expect((await handleOrgServerRegister(d, ORG, { request, signature: signOrgServerRegister(request, stkSeed) })).status).toBe(403);
    const good = { ...request, codeSha256: orgServerCodeSha256(c) };
    const sig = signOrgServerRegister(good, stkSeed);
    expect((await handleOrgServerRegister(d, ORG, { request: good, signature: sig.slice(0, 127) + (sig[127] === "0" ? "1" : "0"), enrolmentSignature: enrol(good, c) })).status).toBe(403);
  });

  it("registers only the box holding the recipe's enrolment key", async () => {
    const d = await orgWithSeats();
    d.set(AT + MIN);
    const c = serverCode();
    expect((await handleOrgServerCode(d, ORG, { code: c, approvals: [approve(B, canonicalOrgServerCode(c), AT)] })).status).toBe(200);
    d.set(AT + 2 * MIN);
    // A box that knows the code (its serial, its hash) but not the recipe's seed signs only with its own STK.
    const request = { orgId: ORG, serial: c.serial, serverDomain: SERVER, codeSha256: orgServerCodeSha256(c), serverIdentityPubKeyHex: stkPub, issuedAt: AT + 2 * MIN, nonceHex: "ef".repeat(16) };
    const stk = signOrgServerRegister(request, stkSeed);
    const missing = await handleOrgServerRegister(d, ORG, { request, signature: stk });
    expect(missing.status).toBe(403);
    expect((missing.body as { code: string }).code).toBe("org-enrolment-signature");
    // The STK's signature in the enrolment slot, or a key that is not the code's, does not count either.
    expect(((await handleOrgServerRegister(d, ORG, { request, signature: stk, enrolmentSignature: stk })).body as { code: string }).code).toBe("org-enrolment-signature");
    const other = Buffer.from(ed25519.sign(new TextEncoder().encode("x"), new Uint8Array(32).fill(0x6f))).toString("hex");
    expect(((await handleOrgServerRegister(d, ORG, { request, signature: stk, enrolmentSignature: other })).body as { code: string }).code).toBe("org-enrolment-signature");
    // A refused attempt does not use the code up: the real box still registers.
    expect((await handleOrgServerRegister(d, ORG, { request, signature: stk, enrolmentSignature: enrol(request, c) })).status).toBe(200);
  });

  it("refuses a code whose enrolment key is the phone's delegated key", async () => {
    const d = await orgWithSeats();
    d.set(AT + MIN);
    const c = serverCode({ enrolmentPubKeyHex: "d1".repeat(32) });
    expect(((await handleOrgServerCode(d, ORG, { code: c, approvals: [] })).body as { code: string }).code).toBe("org-malformed");
  });
});

describe(".com org key ring and rotations", () => {
  const kp = { A: orgKemKeyPair(new Uint8Array(32).fill(0x31)), B: orgKemKeyPair(new Uint8Array(32).fill(0x32)), S: orgKemKeyPair(new Uint8Array(32).fill(0x33)), box: orgKemKeyPair(new Uint8Array(32).fill(0x35)) };
  const kk = (recipient: string, k: ReturnType<typeof orgKemKeyPair>): OrgKemKey => ({ recipient, kemPub: k.kemPub, kemKeyId: k.kemKeyId, issuedAt: 0 });

  async function withKems() {
    const { d } = await registered();
    const t = AT + HOUR;
    d.set(t);
    for (const [seat, signer, k] of [[A, A, kp.A], [B, B, kp.B], [S, SM, kp.S]] as const) {
      const statement = { orgId: ORG, seatId: seat.seatId, kemKeyId: k.kemKeyId, issuedAt: t };
      const r = await handleOrgSeatKem(d, ORG, { statement, kemPubHex: Buffer.from(k.kemPub).toString("hex"), signature: signOrgSeatKem(statement, signer.secret) });
      expect(r.status).toBe(200);
    }
    const boxStatement = { orgId: ORG, serverDomain: SERVER, kemKeyId: kp.box.kemKeyId, issuedAt: t };
    const forged = await handleOrgBoxKem(d, ORG, { statement: boxStatement, kemPubHex: Buffer.from(kp.box.kemPub).toString("hex"), signature: signOrgBoxKem(boxStatement, new Uint8Array(32).fill(1)) });
    expect(forged.status).toBe(403);
    const box = await handleOrgBoxKem(d, ORG, { statement: boxStatement, kemPubHex: Buffer.from(kp.box.kemPub).toString("hex"), signature: signOrgBoxKem(boxStatement, stkSeed) });
    expect(box.status).toBe(200);
    return d;
  }

  it("stores a version only for recipients allowed that key, and lists what a departed seat leaves to rotate", async () => {
    const d = await withKems();
    const t1 = AT + HOUR + MIN;
    d.set(t1);
    const v1 = buildOrgKeyRing({ orgId: ORG, kind: "archive-keys", scope: SERVER, prev: null, key: new Uint8Array(32).fill(7), recipients: [kk(`seat:${A.seatId}`, kp.A), kk(`seat:${S.seatId}`, kp.S), kk(`box:${SERVER}`, kp.box)], retired: [], oarVersion: 1, issuedAt: t1 });
    expect((await handleOrgKeyRingPost(d, ORG, { ...v1, approvals: [approve(A, canonicalOrgKeyRing(v1.ring), t1)] })).status).toBe(200);
    const cgkToS = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: null, key: new Uint8Array(32).fill(8), recipients: [kk(`seat:${S.seatId}`, kp.S)], retired: [], oarVersion: 1, issuedAt: t1 });
    const refusedCgk = await handleOrgKeyRingPost(d, ORG, { ...cgkToS, approvals: [approve(A, canonicalOrgKeyRing(cgkToS.ring), t1)] });
    expect((refusedCgk.body as { code: string }).code).toBe("org-scope");

    // S is offboarded: the archive keys it held are now pending.
    const tLeft = t1 + HOUR;
    d.set(tLeft);
    const revoke = { orgId: ORG, seatId: S.seatId, reason: "offboarded", oarVersion: 1, issuedAt: tLeft };
    await d.store.putObject(ORG, { kind: "revoke", key: S.seatId, bodyJson: JSON.stringify({ revoke, approvals: [approve(A, canonicalOrgSeatRevoke(revoke), tLeft)] }), issuedAt: tLeft, storedAt: tLeft });
    await d.store.appendLog(ORG, "revoke", orgSha256Hex(canonicalOrgSeatRevoke(revoke)), tLeft);
    const before = await handleOrgKeysGet(d, ORG);
    expect((before.body as { pending: unknown }).pending).toEqual([{ seatId: S.seatId, leftAt: tLeft, keys: [{ kind: "archive-keys", scope: SERVER }] }]);

    // A rotation that still seals to S is refused; one that leaves S out completes it.
    const t2 = tLeft + MIN;
    d.set(t2);
    const withS = buildOrgKeyRing({ orgId: ORG, kind: "archive-keys", scope: SERVER, prev: v1.ring, key: new Uint8Array(32).fill(9), recipients: [kk(`seat:${A.seatId}`, kp.A), kk(`seat:${S.seatId}`, kp.S)], retired: [], oarVersion: 1, issuedAt: t2 });
    expect((await handleOrgKeyRingPost(d, ORG, { ...withS, approvals: [approve(B, canonicalOrgKeyRing(withS.ring), t2)] })).status).toBe(403);
    // The client side: plan from what .com serves (verified here), seal, approve, post.
    const served = before.body as { rings: never[]; seatKems: never[]; boxKems: never[] };
    const servers = (await handleOrgServersList(d, ORG)).body as { servers: never[] };
    const state = verifyOrgAuthorityChain(chain.entries.slice(0, 2), { genesisHash: V.genesisHash, now: t2 });
    const revokes = [{ revoke, approvals: [approve(A, canonicalOrgSeatRevoke(revoke), tLeft)] }];
    const book = buildOrgSeatBook(state, { grants, revokes: revokes as never, now: t2 });
    const plan = orgKeyContextFromServed({ state, book, seatKems: served.seatKems, boxKems: served.boxKems, servers: servers.servers, rings: served.rings, history: { revokes, grants }, now: t2 });
    expect(plan.pending.map((p) => p.seatId)).toEqual([S.seatId]);
    const v2 = rotateOrgKey({ ctx: plan.ctx, rings: plan.rings, kind: "archive-keys", scope: SERVER, pending: plan.pending, issuedAt: t2, approve: (order) => approve(B, order, t2) });
    expect(v2.ring.retired).toEqual([S.seatId]);
    expect(v2.recipients.map((r) => r.recipient).sort()).toEqual([`box:${SERVER}`, `seat:${A.seatId}`, `seat:${B.seatId}`].sort());
    expect((await handleOrgKeyRingPost(d, ORG, v2)).status).toBe(200);
    const after = await handleOrgKeysGet(d, ORG);
    expect((after.body as { pending: unknown[] }).pending).toEqual([]);
    expect((after.body as { rings: unknown[] }).rings.length).toBe(2);

    // The audit export holds all of it and verifies offline under one admin's signature.
    const exp = await handleOrgExport(d, ORG);
    expect(exp.status).toBe(200);
    const objects = exp.body as OrgAuditObjects;
    const stateNow = verifyOrgAuthorityChain(objects.entries, { genesisHash: V.genesisHash, now: t2 });
    const signed = signOrgAuditExport(objects, stateNow, { seatId: A.seatId, adminKeyId: A.keyId, hybridSecret: A.secret }, t2);
    const verdict = verifyOrgAuditExport(JSON.parse(JSON.stringify(signed)), { genesisHash: V.genesisHash, now: t2 + 365 * DAY });
    expect(verdict.signedBy).toBe(A.seatId);
    expect(verdict.unlogged).toEqual([]);
  });
});
