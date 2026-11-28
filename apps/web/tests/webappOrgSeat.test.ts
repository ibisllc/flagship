// The webapp as an org seat (lib/orgSeat.js; docs/webapp-key-custody.md item 1), against the real
// `.com` org handlers in process: the browser accepts an admin-role invitation (its seat admin key
// sealed under a passkey, custody "browser" in the accept), shows the same code the admin compares,
// a grant that drops the custody is refused, two hardware admins admit it, and the browser seat's
// approvals verify as that seat's.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  orgSeatRolesHash,
  orgSha256Hex,
  signOrgApproval,
  type OrgSeatRole,
  canonicalOrgInviteWithdraw,
  deriveOrgInviteKeys,
} from "@flagship/protocol";
import { InMemoryOrgStorage, InMemoryStorage } from "@flagship/storage";
import {
  handleOrgAuthorityAppend,
  handleOrgAuthorityGet,
  handleOrgCeremonies,
  handleOrgCreate,
  handleOrgInviteAccept,
  handleOrgInviteCreate,
  handleOrgInviteGet,
  handleOrgInviteWithdraw,
  handleOrgSeatGrant,
  handleOrgSeatsGet,
  type OrgDeps,
} from "../../../packages/control-plane/src/orgs.js";
import { DATABASES, makeIndexedDBShim, makeLocalStorage } from "./support/idbShim";

/* eslint-disable @typescript-eslint/no-explicit-any */
const V = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const chain = refs(V.chains[0]);
const ORG = V.orgId as string;
const DAY = 86_400_000;
const key = (name: string) => ({ ...V.keys[name], secret: Uint8Array.from(Buffer.from(V.keys[name].edSeedHex + V.keys[name].mldsaSeedHex, "hex")) });
const A = key("A founder");
const B = key("B admin");
const SEAT = "5e".repeat(16);
const NOW = chain.entries[1].record.issuedAt + 3_600_000;
const UMK = new Uint8Array(32).fill(0x42);
const approve = (k: typeof A, order: Uint8Array, at = NOW) =>
  signOrgApproval({ orgId: ORG, oarVersion: 1, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt: at, notAfter: at + DAY }, k.secret);

/** `fetch` answered by the .com handlers. */
function fakeCom(d: OrgDeps) {
  return async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const m = (re: RegExp) => path.match(re);
    let r: any;
    let x: RegExpMatchArray | null;
    if ((x = m(/^\/api\/orgs\/([0-9a-f]+)\/authority$/))) r = await handleOrgAuthorityGet(d, x[1]!);
    else if ((x = m(/^\/api\/orgs\/([0-9a-f]+)\/seats$/))) r = init.method === "POST" ? await handleOrgSeatGrant(d, x[1]!, body) : await handleOrgSeatsGet(d, x[1]!);
    else if ((x = m(/^\/api\/orgs\/([0-9a-f]+)\/ceremonies$/))) r = await handleOrgCeremonies(d, x[1]!);
    else if ((x = m(/^\/api\/orgs\/([0-9a-f]+)\/invites\/([0-9a-f]+)\/accept$/))) r = await handleOrgInviteAccept(d, x[1]!, x[2]!, body);
    else if ((x = m(/^\/api\/orgs\/([0-9a-f]+)\/invites\/([0-9a-f]+)\/withdraw$/))) r = await handleOrgInviteWithdraw(d, x[1]!, x[2]!, body);
    else if ((x = m(/^\/api\/orgs\/([0-9a-f]+)\/invites\/([0-9a-f]+)$/))) {
      const h = new Headers(init.headers);
      r = await handleOrgInviteGet(d, x[1]!, x[2]!, { issuedAt: h.get("x-flagship-issued-at"), signature: h.get("x-flagship-signature") });
    }
    else throw new Error(`unrouted ${path}`);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
}

function fakeAuth() {
  const prf = async (salt: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([9, ...salt])));
  const calls = { create: 0, get: 0 };
  return {
    calls,
    auth: {
      create: async ({ salt }: any) => (calls.create++, { credentialId: "seat-cred", prf: await prf(salt) }),
      get: async ({ salt }: any) => (calls.get++, { prf: await prf(salt) }),
    },
  };
}

let os: any, kc: any, mw: any;

describe("webapp org seat", () => {
  beforeAll(async () => {
    mw = await import("../public/webapp/lib/mldsaWasm.js");
    mw.setMldsaWasmBytesForTests(new Uint8Array(readFileSync(resolve(__dirname, "../public/webapp/vendor/mldsa-wasm/mldsa65.wasm"))));
    os = await import("../public/webapp/lib/orgSeat.js");
    kc = await import("../public/webapp/lib/keyCustody.js");
  });
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
  });
  afterEach(() => kc.setCustodyAuthenticatorForTests(null));

  async function orgWithInvite(roles: OrgSeatRole[]) {
    const store = new InMemoryOrgStorage();
    const d: OrgDeps = { orgs: store, usernames: new InMemoryStorage().usernames, now: () => NOW } as OrgDeps;
    expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
    expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
    const linkKey = crypto.getRandomValues(new Uint8Array(32));
    const offer = { orgId: ORG, seatId: SEAT, orgName: "acme", pseudonym: "Ops lead", genesisHash: V.genesisHash };
    const ik = deriveOrgInviteKeys(linkKey);
    const k = await crypto.subtle.importKey("raw", ik.offerKey, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(offer))));
    const sealedLabelHex = "ab".repeat(24);
    const invite = { orgId: ORG, seatId: SEAT, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: NOW, expiresAt: NOW + DAY, inviteKeyPub: ik.inviteKeyPub };
    const offerHex = Buffer.from(new Uint8Array([...iv, ...ct])).toString("hex");
    const r = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite))], sealedLabelHex, offerHex });
    expect(r.status).toBe(200);
    return { d, invite, link: { orgId: ORG, seatId: SEAT, keyHex: Buffer.from(linkKey).toString("hex") } };
  }

  it("joins as a browser-custody admin seat that two hardware admins admit", async () => {
    const roles: OrgSeatRole[] = [{ role: "server-admin", servers: ["home.acme.flagship.services"] }];
    const { d, invite, link } = await orgWithInvite(roles);
    const fake = fakeAuth();
    kc.setCustodyAuthenticatorForTests(fake.auth);
    const deps = { fetch: fakeCom(d), apex: "https://flagshipserver.com" };
    const { seat, code } = await os.acceptOrgInvite(link, { umk: UMK, now: NOW, deps });
    expect(fake.calls.create).toBe(1);
    expect(seat.custody).toBe("browser");
    expect(os.listSeats().map((s: any) => s.seatId)).toEqual([SEAT]);

    // The admin's phone reads the same pending join and code.
    const snap = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    const [j] = os.pendingJoins(snap);
    expect(j.custody).toBe("browser");
    expect(os.joinCode(j)).toBe(code);

    const base = { orgId: ORG, seatId: SEAT, labelSha256: invite.labelSha256, memberKeyId: j.accept.memberKeyId, adminKeyId: j.accept.adminKeyId, rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: NOW, expiresAt: NOW + 300 * DAY };
    const bundle = (g: any) => ({ grant: g, roles, memberBinding: j.memberBinding, adminBinding: j.adminBinding, approvals: [A, B].map((k) => approve(k, canonicalOrgSeatGrant(g))) });
    const dropped = await handleOrgSeatGrant(d, ORG, bundle(base));
    expect(dropped.status).toBe(400);
    const ok = await handleOrgSeatGrant(d, ORG, bundle({ ...base, custody: "browser" }));
    expect(ok.status).toBe(200);

    // The browser seat signs with its sealed admin key (one passkey prompt), and it verifies as that seat.
    const after = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    expect(after.book.seats.get(SEAT)?.grant.custody).toBe("browser");
    const order = new TextEncoder().encode("flagship/server-update/v1|home.acme.flagship.services|1");
    const a = await os.withSeatAdminKey(seat, UMK, async (secret: Uint8Array) => os.approvalBy(seat, secret, order, 1, NOW));
    expect(fake.calls.get).toBe(1);
    // The book was built by the bundled protocol, so its own verifier checks it (bindings are verified per module).
    const bundled = await import("../public/webapp/vendor/flagship-org/org.js");
    expect(bundled.verifyOrgApprovers(after.state, after.book, order, [a], NOW)).toEqual([SEAT]);
  });

  it("joins a member seat with no passkey prompt and no custody label", async () => {
    const { d, link } = await orgWithInvite([{ role: "member" }]);
    const fake = fakeAuth();
    kc.setCustodyAuthenticatorForTests(fake.auth);
    const { seat } = await os.acceptOrgInvite(link, { umk: UMK, now: NOW, deps: { fetch: fakeCom(d), apex: "https://x" } });
    expect(seat.custody).toBeNull();
    expect(fake.calls).toEqual({ create: 0, get: 0 });
    await expect(os.withSeatAdminKey(seat, UMK, async () => 1)).rejects.toMatchObject({ code: "not-admin" });
  });

  it("without the link's key the invitation does not exist for the browser", async () => {
    const { d, link } = await orgWithInvite([{ role: "member" }]);
    const bad = { ...link, keyHex: "00".repeat(32) };
    await expect(os.acceptOrgInvite(bad, { umk: UMK, now: NOW, deps: { fetch: fakeCom(d), apex: "https://x" } })).rejects.toMatchObject({ status: 404 });
  });

  it("offers to admit only accepts the invite key signed, and an admin withdraws an invitation", async () => {
    const roles: OrgSeatRole[] = [{ role: "member" }];
    const { d, link } = await orgWithInvite(roles);
    const deps = { fetch: fakeCom(d), apex: "https://x" };
    const before = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    expect(os.pendingInvites(before).map((i: any) => i.seatId)).toEqual([SEAT]);
    await os.acceptOrgInvite(link, { umk: UMK, now: NOW, deps });
    const snap = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    expect(os.pendingInvites(snap)).toEqual([]);
    expect(os.pendingJoins(snap)).toHaveLength(1);
    // A served accept whose invite-key signature is missing or wrong is not offered.
    const tampered = { ...snap, seats: { ...snap.seats, accepts: snap.seats.accepts.map((a: any) => ({ ...a, inviteSignature: undefined })) } };
    expect(os.pendingJoins(tampered)).toEqual([]);
    const swapped = { ...snap, seats: { ...snap.seats, accepts: snap.seats.accepts.map((a: any) => ({ ...a, accept: { ...a.accept, memberKeyId: "77".repeat(32) } })) } };
    expect(os.pendingJoins(swapped)).toEqual([]);

    // The codes did not match: an org admin (A of the vectors) withdraws the invitation.
    const withdraw = { orgId: ORG, seatId: SEAT, oarVersion: 1, issuedAt: NOW };
    const r = await handleOrgInviteWithdraw(d, ORG, SEAT, { withdraw, approvals: [approve(A, canonicalOrgInviteWithdraw(withdraw))] });
    expect(r.status).toBe(200);
    const after = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    expect(os.pendingJoins(after)).toEqual([]);
    expect(os.pendingInvites(after)).toEqual([]);
  });

  it("withdrawInvite signs the withdraw order with the seat's admin key", async () => {
    const roles: OrgSeatRole[] = [{ role: "server-admin", servers: ["home.acme.flagship.services"] }];
    const { d, link } = await orgWithInvite(roles);
    const fake = fakeAuth();
    kc.setCustodyAuthenticatorForTests(fake.auth);
    const deps = { fetch: fakeCom(d), apex: "https://x" };
    const { seat } = await os.acceptOrgInvite(link, { umk: UMK, now: NOW, deps });
    const snap = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    // This browser seat is not admitted, so .com refuses its withdraw: only an org admin may.
    await expect(os.withdrawInvite(seat, snap, SEAT, { umk: UMK, now: NOW, deps })).rejects.toMatchObject({ status: 403 });
    expect(fake.calls.get).toBe(1);
  });

  it("the bundled org protocol is built from this tree (vendor/flagship-org/org.js)", () => {
    expect(() => execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/build-webapp-org-vendor.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
