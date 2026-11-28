/**
 * Org invitations through the Worker's routes on a real D1 schema (docs/enterprise-accounts.md §7): the offer read
 * and the accept need the invite key the link key derives, so knowing an orgId and a seatId neither reads nor claims
 * an invitation; an admin withdraws one, and its seat id is never invited again.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  canonicalOrgInviteWithdraw,
  canonicalOrgSeatAccept,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  deriveOrgInviteKeys,
  hybridSign,
  orgInviteAcceptSignature,
  orgInviteReadSignature,
  orgSeatRolesHash,
  orgSha256Hex,
  signOrgApproval,
  signOrgReadTokenRequest,
} from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "../../../packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const resolveRefs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x)]));
};
const chain = resolveRefs(V.chains[0]);
const ORG = V.orgId as string;
const T0 = chain.entries[1].record.issuedAt + 3_600_000;
const DAY = 86_400_000;
const key = (name: string) => ({ ...V.keys[name], secret: Uint8Array.from(Buffer.from(V.keys[name].edSeedHex + V.keys[name].mldsaSeedHex, "hex")) });
const A = key("A founder");
const MM = key("M member");
const IK = deriveOrgInviteKeys(new Uint8Array(32).fill(0x51));
const SQUAT = deriveOrgInviteKeys(new Uint8Array(32).fill(0x52));

afterEach(() => vi.useRealTimers());

const call = async (env: ControlPlaneEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const r = (await tryControlPlane(new Request(`${ORIGIN}${path}`, init), env))!;
  return { status: r.status, body: (await r.json()) as any };
};
const approve = (order: Uint8Array) => signOrgApproval({ orgId: ORG, oarVersion: 1, order, seatId: A.seatId, adminKeyId: A.keyId, issuedAt: T0, notAfter: T0 + DAY }, A.secret);
async function adminToken(env: ControlPlaneEnv): Promise<string> {
  const request = { orgId: ORG, subject: `seat:${A.seatId}`, pubHex: A.binding.ed25519PubHex, issuedAt: Date.now(), nonceHex: "01".repeat(16) };
  const signature = signOrgReadTokenRequest(request, (m) => ed25519.sign(m, Buffer.from(A.edSeedHex, "hex")));
  const r = await call(env, "POST", `/api/orgs/${ORG}/read-token`, { request, signature });
  expect(r.status).toBe(200);
  return r.body.token as string;
}
const readProof = (secret: Uint8Array, seat: string, at = T0) => ({ "x-flagship-issued-at": String(at), "x-flagship-signature": orgInviteReadSignature(secret, ORG, seat, at) });

async function world() {
  const env: ControlPlaneEnv = { DB: createSqliteD1() as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "k".repeat(64) };
  expect((await call(env, "POST", "/api/orgs", { name: "acme", entry: chain.entries[0] })).status).toBe(200);
  expect((await call(env, "POST", `/api/orgs/${ORG}/authority`, { entry: chain.entries[1] })).status).toBe(200);
  const roles = [{ role: "member" }];
  const sealedLabelHex = "aa".repeat(40);
  const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles as any), oarVersion: 1, issuedAt: T0, expiresAt: T0 + DAY, inviteKeyPub: IK.inviteKeyPub };
  expect((await call(env, "POST", `/api/orgs/${ORG}/invites`, { invite, roles, approvals: [approve(canonicalOrgSeatInvite(invite))], sealedLabelHex, offerHex: "0102" })).status).toBe(200);
  const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), memberKeyId: MM.keyId, adminKeyId: "", issuedAt: T0 };
  const signature = Buffer.from(hybridSign(MM.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
  return { env, roles, invite, accept, signature };
}

describe("org invitation routes", () => {
  it("serves the offer only on a fresh invite-key proof, and answers 404 otherwise as for no invitation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { env } = await world();
    const path = `/api/orgs/${ORG}/invites/${MM.seatId}`;
    const unknown = await call(env, "GET", `/api/orgs/${ORG}/invites/${"ef".repeat(16)}`, undefined, readProof(IK.hybridSecret, "ef".repeat(16)));
    expect(unknown.status).toBe(404);
    for (const h of [{}, readProof(SQUAT.hybridSecret, MM.seatId), readProof(IK.hybridSecret, "ef".repeat(16)), readProof(IK.hybridSecret, MM.seatId, T0 - 6 * 60_000)]) {
      const r = await call(env, "GET", path, undefined, h);
      expect(r).toEqual(unknown);
    }
    const ok = await call(env, "GET", path, undefined, readProof(IK.hybridSecret, MM.seatId));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ offerHex: "0102", accepted: false });
  });

  it("refuses an accept without the invite-key signature: a squatter with only the orgId cannot claim the seat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { env, accept, signature } = await world();
    const path = `/api/orgs/${ORG}/invites/${MM.seatId}/accept`;
    const base = { accept, memberBinding: MM.binding, adminBinding: null, signature };
    expect((await call(env, "POST", path, base)).status).toBe(404);
    expect((await call(env, "POST", path, { ...base, inviteSignature: orgInviteAcceptSignature(SQUAT.hybridSecret, accept) })).status).toBe(404);
    expect((await call(env, "GET", `/api/orgs/${ORG}/seats`)).body.accepts).toEqual([]);
    const inviteSignature = orgInviteAcceptSignature(IK.hybridSecret, accept);
    const real = await call(env, "POST", path, { ...base, inviteSignature });
    expect(real.status).toBe(200);
    const seats = (await call(env, "GET", `/api/orgs/${ORG}/seats`)).body;
    expect(seats.accepts).toHaveLength(1);
    expect(seats.accepts[0].inviteSignature).toBe(inviteSignature);
  });

  it("an admin withdraws a pending invitation; the link stops working and the seat id is never invited again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { env, roles, invite, accept, signature } = await world();
    expect((await call(env, "POST", `/api/orgs/${ORG}/invites/${MM.seatId}/accept`, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) })).status).toBe(200);
    const withdraw = { orgId: ORG, seatId: MM.seatId, oarVersion: 1, issuedAt: T0 };
    const r = await call(env, "POST", `/api/orgs/${ORG}/invites/${MM.seatId}/withdraw`, { withdraw, approvals: [approve(canonicalOrgInviteWithdraw(withdraw))] });
    expect(r).toMatchObject({ status: 200, body: { withdrawn: MM.seatId } });
    const seats = (await call(env, "GET", `/api/orgs/${ORG}/seats`)).body;
    expect(seats.invites).toEqual([]);
    expect(seats.accepts).toEqual([]);
    expect((await call(env, "GET", `/api/orgs/${ORG}/invites/${MM.seatId}`, undefined, readProof(IK.hybridSecret, MM.seatId))).status).toBe(404);
    const again = await call(env, "POST", `/api/orgs/${ORG}/invites`, { invite, roles, approvals: [approve(canonicalOrgSeatInvite(invite))], sealedLabelHex: "aa".repeat(40), offerHex: "0102" });
    expect(again.status).toBe(409);
    const grant = { orgId: ORG, seatId: MM.seatId, labelSha256: invite.labelSha256, memberKeyId: MM.keyId, adminKeyId: "", rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: T0, expiresAt: T0 + 300 * DAY };
    const g = await call(env, "POST", `/api/orgs/${ORG}/seats`, { grant, roles, memberBinding: MM.binding, adminBinding: null, approvals: [approve(canonicalOrgSeatGrant(grant))] });
    expect(g.status).toBe(403);
    const log = (await call(env, "GET", `/api/orgs/${ORG}/log`, undefined, { authorization: `Bearer ${await adminToken(env)}` })).body.entries as Array<{ kind: string }>;
    expect(log.map((e) => e.kind)).toContain("invite-withdraw");
  });
});
