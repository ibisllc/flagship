/**
 * The seat limit held by the grant's and the invite's own insert: parallel writes can't pass a stale count of live
 * seats. On the D1 adapter over real SQLite with every migration, and the in-memory one.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalOrgSeatAccept,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  deriveOrgInviteKeys,
  hybridSign,
  orgInviteAcceptSignature,
  orgSeatRolesHash,
  orgSha256Hex,
  signOrgApproval,
  type OrgSeatRole,
} from "@flagship/protocol";
import { D1OrgStorage, InMemoryOrgStorage, InMemoryStorage, type OrgStorage } from "@flagship/storage";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import { handleOrgAuthorityAppend, handleOrgCreate, handleOrgInviteAccept, handleOrgInviteCreate, handleOrgLog, handleOrgSeatGrant, type OrgDeps } from "../src/orgs.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/org-authority/vectors.json"), "utf8"));
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
const DAY = 86_400_000;
const NOW = chain.entries[1].record.issuedAt + 3_600_000;
const key = (name: string) => {
  const k = V.keys[name];
  return { ...k, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const A = key("A founder");
const MEMBERS = [key("M member"), key("S member")];
const roles: OrgSeatRole[] = [{ role: "member" }];
const approve = (order: Uint8Array) => signOrgApproval({ orgId: ORG, oarVersion: 1, order, seatId: A.seatId, adminKeyId: A.keyId, issuedAt: NOW, notAfter: NOW + DAY }, A.secret);
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
const IK = deriveOrgInviteKeys(new Uint8Array(32).fill(0x33));

function inviteOf(seatId: string) {
  const invite = { orgId: ORG, seatId, labelSha256: orgSha256Hex(Buffer.from("aa", "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: NOW, expiresAt: NOW + DAY, inviteKeyPub: IK.inviteKeyPub };
  return { invite, roles, approvals: [approve(canonicalOrgSeatInvite(invite))], sealedLabelHex: "aa", offerHex: "01" };
}

function grantOf(m: (typeof MEMBERS)[number], issuedAt = NOW) {
  const grant = { orgId: ORG, seatId: m.seatId, labelSha256: orgSha256Hex(Buffer.from("aa", "hex")), memberKeyId: m.keyId, adminKeyId: "", rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt, expiresAt: NOW + 300 * DAY };
  return { grant, roles, memberBinding: m.binding, adminBinding: null, approvals: [approve(canonicalOrgSeatGrant(grant))] };
}

async function world(store: OrgStorage, seatLimit: number): Promise<OrgDeps> {
  const d: OrgDeps = { orgs: store, usernames: new InMemoryStorage().usernames, now: () => NOW };
  expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
  expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
  await store.setPlan(ORG, { planTier: "business", seatLimit, paidUntil: null });
  return d;
}

async function invitedAndAccepted(d: OrgDeps) {
  for (const m of MEMBERS) {
    const inv = inviteOf(m.seatId);
    expect((await handleOrgInviteCreate(d, ORG, inv)).status).toBe(200);
    const accept = { orgId: ORG, seatId: m.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(inv.invite)), memberKeyId: m.keyId, adminKeyId: "", issuedAt: NOW };
    const signature = Buffer.from(hybridSign(m.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
    expect((await handleOrgInviteAccept(d, ORG, m.seatId, { accept, memberBinding: m.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) })).status).toBe(200);
  }
}

const stores: Array<[string, () => OrgStorage]> = [
  ["in memory", () => new InMemoryOrgStorage()],
  ["D1", () => new D1OrgStorage(createSqliteD1())],
];

describe.each(stores)("org seat limit (%s)", (_name, make) => {
  it("admits one of two parallel new seats at a one-seat limit and logs only the one", async () => {
    const d = await world(make(), 1);
    await invitedAndAccepted(d);
    const logBefore = ((await handleOrgLog(d, ORG, 0)).body as { entries: unknown[] }).entries.length;
    const out = await Promise.all(MEMBERS.map((m) => handleOrgSeatGrant(d, ORG, grantOf(m))));
    expect(out.filter((r) => r.status === 200)).toHaveLength(1);
    expect(out.filter((r) => code(r) === "org-seat-limit")).toHaveLength(1);
    expect(await d.orgs.listObjects(ORG, "grant")).toHaveLength(1);
    const entries = ((await handleOrgLog(d, ORG, 0)).body as { entries: Array<{ kind: string }> }).entries;
    expect(entries.length - logBefore).toBe(1);
    expect(entries.at(-1)!.kind).toBe("grant");
  });

  it("lets a live seat be granted again at the limit", async () => {
    const d = await world(make(), 1);
    await invitedAndAccepted(d);
    expect((await handleOrgSeatGrant(d, ORG, grantOf(MEMBERS[0]!))).status).toBe(200);
    expect((await handleOrgSeatGrant(d, ORG, grantOf(MEMBERS[0]!, NOW + 1))).status).toBe(200);
    expect(code(await handleOrgSeatGrant(d, ORG, grantOf(MEMBERS[1]!)))).toBe("org-seat-limit");
  });

  it("refuses an invite once the live seats fill the limit, from the insert itself", async () => {
    const store = make();
    const d = await world(store, 1);
    await invitedAndAccepted(d);
    const stale = await handleOrgSeatGrant(d, ORG, grantOf(MEMBERS[0]!));
    expect(stale.status).toBe(200);
    const other = "7".repeat(32);
    expect(await store.putSeatObject(ORG, { kind: "invite", key: other, bodyJson: "{}", issuedAt: NOW, storedAt: NOW }, other, 1, NOW)).toBe("full");
    expect(await store.putSeatObject(ORG, { kind: "invite", key: other, bodyJson: "{}", issuedAt: NOW, storedAt: NOW }, other, 2, NOW)).toBe(true);
    // An expired grant no longer holds a seat.
    expect(await store.putSeatObject(ORG, { kind: "invite", key: "8".repeat(32), bodyJson: "{}", issuedAt: NOW, storedAt: NOW }, "8".repeat(32), 1, NOW + 301 * DAY)).toBe(true);
  });
});
