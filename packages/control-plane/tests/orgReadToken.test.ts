import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalOrgSeatFreeze,
  canonicalOrgSeatGrant,
  canonicalOrgServerCode,
  orgServerCodeSha256,
  orgSha256Hex,
  signOrgApproval,
  signOrgReadTokenRequest,
  signOrgServerRegister,
  type OrgReadTokenRequest,
  type OrgServerCode,
} from "@flagship/protocol";
import { InMemoryOrgStorage, InMemoryStorage } from "@flagship/storage";
import {
  ORG_BOX_TOKEN_TTL_MS,
  handleMintOrgReadToken,
  handleOrgAuthorityAppend,
  handleOrgCreate,
  handleOrgFreeze,
  handleOrgServerCode,
  handleOrgServerRegister,
  requireOrgRead,
  type OrgReadTokenDeps,
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
const book = refs(V.seatBooks[3]);
const ORG = V.orgId as string;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GRANTED = book.grants[0].grant.issuedAt as number;
const REVOKED = book.revokes[0].revoke.issuedAt as number;
const T0 = GRANTED + 10 * MIN;
const SERVER = "home.acme.flagship.services";

const key = (name: string) => {
  const k = V.keys[name];
  const edSeed = Uint8Array.from(Buffer.from(k.edSeedHex, "hex"));
  return {
    seatId: k.seatId as string,
    keyId: k.keyId as string,
    pubHex: k.binding.ed25519PubHex as string,
    edSeed,
    secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")),
  };
};
const A = key("A founder");
const B = key("B admin");
const C = key("C admin");
const S = key("S scoped admin");
const SM = key("S member");
const M = key("M member");
const X = key("X outsider");

class Nonces {
  seen = new Set<string>();
  async claim(k: string) {
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}

function world() {
  let t = T0;
  const store = new InMemoryOrgStorage();
  const base = new InMemoryStorage();
  const d: OrgReadTokenDeps & { set: (x: number) => void; store: InMemoryOrgStorage; base: InMemoryStorage } = {
    orgs: store,
    usernames: base.usernames,
    servers: base.servers,
    authCodes: base.authCodes,
    secret: "s".repeat(64),
    nonces: new Nonces(),
    now: () => t,
    set: (x) => {
      t = x;
    },
    store,
    base,
  };
  return d;
}

async function org() {
  const d = world();
  expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
  expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
  for (const g of book.grants) {
    await d.store.putObject(ORG, { kind: "grant", key: `${g.grant.seatId}:${g.grant.issuedAt}`, bodyJson: JSON.stringify(g), issuedAt: g.grant.issuedAt, storedAt: 0 });
    await d.store.appendLog(ORG, "grant", orgSha256Hex(canonicalOrgSeatGrant(g.grant)), g.grant.issuedAt);
  }
  return d;
}

const stkSeed = new Uint8Array(32).fill(0x5e);
const stkPub = Buffer.from(ed25519.getPublicKey(stkSeed)).toString("hex");

async function withServer() {
  const d = await org();
  const at = chain.entries[1].record.issuedAt + HOUR;
  d.set(at);
  const c: OrgServerCode = {
    orgId: ORG, genesisHash: V.genesisHash, serial: "orgsrv-test-0001", serverName: "home", serverDomain: SERVER,
    delegatedPubKeyHex: "d1".repeat(32), issuedAt: at, expiresAt: at + 12 * HOUR,
  };
  const approval = signOrgApproval({ orgId: ORG, oarVersion: 1, order: canonicalOrgServerCode(c), seatId: B.seatId, adminKeyId: B.keyId, issuedAt: at, notAfter: at + DAY }, B.secret);
  expect((await handleOrgServerCode(d, ORG, { code: c, approvals: [approval] })).status).toBe(200);
  const request = { orgId: ORG, serial: c.serial, serverDomain: SERVER, codeSha256: orgServerCodeSha256(c), serverIdentityPubKeyHex: stkPub, issuedAt: at + MIN, nonceHex: "ab".repeat(16) };
  d.set(at + MIN);
  expect((await handleOrgServerRegister(d, ORG, { request, signature: signOrgServerRegister(request, stkSeed) })).status).toBe(200);
  d.set(T0);
  return d;
}

let nonce = 0;
function mintBody(subject: string, pubHex: string, seed: Uint8Array, issuedAt: number, over: Partial<OrgReadTokenRequest> = {}) {
  const request: OrgReadTokenRequest = { orgId: ORG, subject, pubHex, issuedAt, nonceHex: (++nonce).toString(16).padStart(32, "0"), ...over };
  return { request, signature: signOrgReadTokenRequest(request, (m) => ed25519.sign(m, seed)) };
}
const seat = (k: ReturnType<typeof key>, at: number) => mintBody(`seat:${k.seatId}`, k.pubHex, k.edSeed, at);
const box = (at: number) => mintBody(`box:${SERVER}`, stkPub, stkSeed, at);

async function mint(d: OrgReadTokenDeps, body: unknown): Promise<string | null> {
  const r = await handleMintOrgReadToken(d, ORG, body);
  return r.status === 200 ? (r.body as { token: string }).token : null;
}
const bearer = (t: string | null) => (t ? `Bearer ${t}` : null);

describe("org read tokens", () => {
  it("are minted by a seat's member key, a seat admin key, an org admin's key, and an org server's STK", async () => {
    const d = await withServer();
    for (const k of [M, SM, S, A, B]) expect(await mint(d, seat(k, T0)), k.seatId).not.toBeNull();
    const t = await handleMintOrgReadToken(d, ORG, box(T0));
    expect(t.status).toBe(200);
    expect((t.body as { expiresAt: number }).expiresAt).toBe(T0 + ORG_BOX_TOKEN_TTL_MS);
  });

  it("refuse an outsider, a key that isn't the seat's, a bad signature, a stale request and a replay", async () => {
    const d = await withServer();
    expect(await mint(d, seat(X, T0))).toBeNull();
    expect(await mint(d, mintBody(`seat:${M.seatId}`, X.pubHex, X.edSeed, T0))).toBeNull();
    const forged = seat(M, T0);
    expect(await mint(d, { ...forged, signature: signOrgReadTokenRequest(forged.request, (m) => ed25519.sign(m, X.edSeed)) })).toBeNull();
    expect(await mint(d, seat(M, T0 - 10 * MIN))).toBeNull();
    const once = seat(M, T0);
    expect(await mint(d, once)).not.toBeNull();
    expect(await mint(d, once)).toBeNull();
    expect(await mint(d, mintBody(`box:other.acme.flagship.services`, stkPub, stkSeed, T0))).toBeNull();
    expect((await handleMintOrgReadToken(d, ORG, mintBody(`seat:${M.seatId}`, M.pubHex, M.edSeed, T0, { orgId: "00".repeat(16) }))).status).toBe(400);
    expect((await handleMintOrgReadToken({ ...d, secret: undefined }, ORG, seat(M, T0))).status).toBe(503);
  });

  it("a revoked seat's token stops passing on its next request", async () => {
    const d = await withServer();
    const t = await mint(d, seat(M, T0));
    expect((await requireOrgRead(d, ORG, bearer(t))).ok).toBe(true);
    for (const r of book.revokes) await d.store.putObject(ORG, { kind: "revoke", key: r.revoke.seatId, bodyJson: JSON.stringify(r), issuedAt: r.revoke.issuedAt, storedAt: 0 });
    d.set(REVOKED + MIN);
    expect((await requireOrgRead(d, ORG, bearer(t))).ok).toBe(false);
    expect(await mint(d, seat(M, REVOKED + MIN))).toBeNull();
  });

  it("a frozen admin's token stops passing while the freeze lasts", async () => {
    const d = await withServer();
    const t = await mint(d, seat(B, T0));
    expect((await requireOrgRead(d, ORG, bearer(t), "admin")).ok).toBe(true);
    const f = { orgId: ORG, seatId: B.seatId, untilMs: T0 + 72 * HOUR, oarVersion: 1, issuedAt: T0 };
    const approval = signOrgApproval({ orgId: ORG, oarVersion: 1, order: canonicalOrgSeatFreeze(f), seatId: C.seatId, adminKeyId: C.keyId, issuedAt: T0, notAfter: T0 + DAY }, C.secret);
    expect((await handleOrgFreeze(d, ORG, { body: f, approvals: [approval] })).status).toBe(200);
    d.set(T0 + MIN);
    expect((await requireOrgRead(d, ORG, bearer(t))).ok).toBe(false);
    expect(await mint(d, seat(B, T0 + MIN))).toBeNull();
  });

  it("a revoked server's token, or one from a replaced server identity, stops passing", async () => {
    const d = await withServer();
    const t = await mint(d, box(T0));
    expect((await requireOrgRead(d, ORG, bearer(t))).ok).toBe(true);
    await d.base.servers.revoke(SERVER, "deleted", T0);
    expect((await requireOrgRead(d, ORG, bearer(t))).ok).toBe(false);
    expect(await mint(d, box(T0))).toBeNull();
    const d2 = await withServer();
    const t2 = await mint(d2, box(T0));
    const row = (await d2.base.servers.get(SERVER))!;
    await d2.base.servers.put({ ...row, identityPubKeyHex: "77".repeat(32) });
    expect((await requireOrgRead(d2, ORG, bearer(t2))).ok).toBe(false);
  });

  it("the admin scope refuses members, scoped admins and servers; people scope refuses servers", async () => {
    const d = await withServer();
    const tokens = { A: await mint(d, seat(A, T0)), M: await mint(d, seat(M, T0)), S: await mint(d, seat(S, T0)), box: await mint(d, box(T0)) };
    expect((await requireOrgRead(d, ORG, bearer(tokens.A), "admin")).ok).toBe(true);
    for (const t of [tokens.M, tokens.S, tokens.box]) expect((await requireOrgRead(d, ORG, bearer(t), "admin")).ok).toBe(false);
    expect((await requireOrgRead(d, ORG, bearer(tokens.box), "people")).ok).toBe(false);
    expect((await requireOrgRead(d, ORG, bearer(tokens.M), "people")).ok).toBe(true);
  });

  it("refuses no token, another org's token, an expired token and an account read token's shape", async () => {
    const d = await withServer();
    const t = await mint(d, seat(M, T0));
    expect((await requireOrgRead(d, ORG, null)).ok).toBe(false);
    const r = await requireOrgRead(d, "ff".repeat(16), bearer(t));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
    expect((await requireOrgRead({ ...d, secret: "t".repeat(64) }, ORG, bearer(t))).ok).toBe(false);
    expect((await requireOrgRead(d, ORG, bearer(t!.replace(/^ort1/, "art1")))).ok).toBe(false);
    d.set(T0 + 8 * DAY);
    expect((await requireOrgRead(d, ORG, bearer(t))).ok).toBe(false);
  });
});
