import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalOrgOverturn,
  canonicalOrgSeatAccept,
  canonicalOrgSeatFreeze,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  hybridSign,
  canonicalOrgDirectoryWrite,
  orgKemKeyPair,
  sealOrgDirectoryEntry,
  signOrgSeatKem,
  orgSeatRolesHash,
  orgSha256Hex,
  signOrgApproval,
  type OrgSeatRole,
} from "@flagship/protocol";
import { InMemoryOrgStorage, InMemoryStorage } from "@flagship/storage";
import {
  authorizeOrgComOp,
  handleOrgAuthorityAppend,
  handleOrgAuthorityGet,
  handleOrgCeremonyApprove,
  handleOrgCeremonyOpen,
  handleOrgCreate,
  handleOrgDirectoryGet,
  handleOrgDirectoryPut,
  handleOrgFreeze,
  handleOrgInviteAccept,
  handleOrgInviteCreate,
  handleOrgLog,
  handleOrgOverturn,
  handleOrgSeatGrant,
  type OrgDeps,
} from "../src/orgs.js";
import { handleOrgKeysGet } from "../src/orgServers.js";

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
const key = (name: string) => {
  const k = V.keys[name];
  return { ...k, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const A = key("A founder");
const B = key("B admin");
const C = key("C admin");
const MM = key("M member");

function deps(now: number): OrgDeps & { store: InMemoryOrgStorage } {
  const store = new InMemoryOrgStorage();
  return { store, orgs: store, usernames: new InMemoryStorage().usernames, now: () => now };
}

const approve = (k: typeof A, order: Uint8Array, oarVersion: number, at: number) =>
  signOrgApproval({ orgId: ORG, oarVersion, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt: at, notAfter: at + DAY }, k.secret);

async function created(now = chain.entries[1].record.issuedAt + 3_600_000) {
  const d = deps(now);
  const r = await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] });
  expect(r.status).toBe(200);
  expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
  return d;
}

describe(".com org accounts", () => {
  it("creates an org from a genesis every admin signed, and refuses one without consent", async () => {
    const d = deps(chain.now);
    const bad = await handleOrgCreate(d, { name: "acme", entry: { ...chain.entries[0], approvals: chain.entries[0].approvals.slice(0, 3) } });
    expect(bad.status).toBe(403);
    expect((bad.body as { code: string }).code).toBe("org-consent-missing");
    expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
    expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(409);
  });

  it("appends the chain only with valid versions and serves it", async () => {
    const d = await created();
    const dup = await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] });
    expect(dup.status).toBe(403);
    const got = await handleOrgAuthorityGet(d, ORG);
    expect((got.body as { currentVersion: number }).currentVersion).toBe(1);
    const log = await handleOrgLog(d, ORG, 0);
    const entries = (log.body as { entries: Array<{ prevHash: string; entryHash: string }> }).entries;
    expect(entries.length).toBe(2);
    expect(entries[1]!.prevHash).toBe(entries[0]!.entryHash);
  });

  it("invites with a pseudonym, takes the person's acceptance, admits the seat", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const roles: OrgSeatRole[] = [{ role: "member" }];
    const sealedLabelHex = "aa".repeat(40);
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY };
    const noLabel = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [], sealedLabelHex: "", offerHex: "00" });
    expect((noLabel.body as { code: string }).code).toBe("org-label-missing");
    const inv = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex, offerHex: "0102" });
    expect(inv.status).toBe(200);

    const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), memberKeyId: MM.keyId, adminKeyId: "", issuedAt: now };
    const signature = Buffer.from(hybridSign(MM.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
    const acc = await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature });
    expect(acc.status).toBe(200);

    const grant = { orgId: ORG, seatId: MM.seatId, labelSha256: invite.labelSha256, memberKeyId: MM.keyId, adminKeyId: "", rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: now, expiresAt: now + 300 * DAY };
    const bundle = { grant, roles, memberBinding: MM.binding, adminBinding: null, approvals: [approve(A, canonicalOrgSeatGrant(grant), 1, now)] };
    const g = await handleOrgSeatGrant(d, ORG, bundle);
    expect(g.status).toBe(200);
  });

  it("refuses a seat beyond the plan's limit", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    await d.store.setPlan(ORG, { planTier: "enterprise-trial", seatLimit: 0, paidUntil: null });
    const roles: OrgSeatRole[] = [{ role: "member" }];
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from("aa", "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY };
    const r = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex: "aa", offerHex: "01" });
    expect((r.body as { code: string }).code).toBe("org-seat-limit");
  });

  it("one admin freezes another for 72 h, not twice in a week", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const f1 = { orgId: ORG, seatId: B.seatId, untilMs: now + 72 * 3_600_000, oarVersion: 1, issuedAt: now };
    expect((await handleOrgFreeze(d, ORG, { body: f1, approvals: [approve(C, canonicalOrgSeatFreeze(f1), 1, now)] })).status).toBe(200);
    const f2 = { orgId: ORG, seatId: A.seatId, untilMs: now + 3_600_000, oarVersion: 1, issuedAt: now + 1 };
    const second = await handleOrgFreeze(d, ORG, { body: f2, approvals: [approve(C, canonicalOrgSeatFreeze(f2), 1, now + 1)] });
    expect((second.body as { code: string }).code).toBe("org-freeze-refused");
    const long = { orgId: ORG, seatId: A.seatId, untilMs: now + 73 * 3_600_000, oarVersion: 1, issuedAt: now };
    expect((await handleOrgFreeze(d, ORG, { body: long, approvals: [approve(B, canonicalOrgSeatFreeze(long), 1, now)] })).status).toBe(403);
  });

  it("collects a ceremony's approvals and gates an order with the shared predicate", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const order = new TextEncoder().encode(`flagship/servers-self-delete/v1|home.acme.flagship.services|${now}`);
    const open = await handleOrgCeremonyOpen(d, ORG, { order: new TextDecoder().decode(order), payload: { what: "delete home" }, approvals: [approve(A, order, 1, now)] });
    expect(open.status).toBe(200);
    const sha = (open.body as { sha256: string }).sha256;
    expect((await authorizeOrgComOp(d, ORG, { kind: "destroy" }, order, [approve(A, order, 1, now)])).ok).toBe(false);
    expect((await handleOrgCeremonyApprove(d, ORG, sha, { approval: approve(B, order, 1, now) })).status).toBe(200);
    const two = await authorizeOrgComOp(d, ORG, { kind: "destroy" }, order, [approve(A, order, 1, now), approve(B, order, 1, now)]);
    expect(two.ok).toBe(true);
  });
});

describe("Restore my access", () => {
  it("the frozen admin opens the overturn of its own freeze, the bylaws' set completes it", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const f = { orgId: ORG, seatId: B.seatId, untilMs: now + 72 * 3_600_000, oarVersion: 1, issuedAt: now };
    expect((await handleOrgFreeze(d, ORG, { body: f, approvals: [approve(C, canonicalOrgSeatFreeze(f), 1, now)] })).status).toBe(200);
    const body = { orgId: ORG, freezeSha256: orgSha256Hex(canonicalOrgSeatFreeze(f)), oarVersion: 1, issuedAt: now + 1 };
    const order = canonicalOrgOverturn(body);
    const open = await handleOrgCeremonyOpen(d, ORG, { order: new TextDecoder().decode(order), payload: { kind: "overturn" }, approvals: [approve(B, order, 1, now + 1)] });
    expect(open.status).toBe(200);
    const D = key("D board");
    const done = await handleOrgOverturn(d, ORG, { body, approvals: [approve(C, order, 1, now + 2), approve(D, order, 1, now + 2)] });
    expect(done.status).toBe(200);
    const other = { orgId: ORG, freezeSha256: "ab".repeat(32), oarVersion: 1, issuedAt: now + 3 };
    const o2 = canonicalOrgOverturn(other);
    const refused = await handleOrgCeremonyOpen(d, ORG, { order: new TextDecoder().decode(o2), payload: {}, approvals: [approve(key("X outsider"), o2, 1, now + 3)] });
    expect(refused.status).toBe(403);
  });
});

describe("org directory and joining", () => {
  it("records the KEM key a member sent with its accept once the grant lands (a member never has to open the org page)", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const roles: OrgSeatRole[] = [{ role: "member" }];
    const sealedLabelHex = "aa".repeat(40);
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY };
    expect((await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex, offerHex: "0102" })).status).toBe(200);
    const kem = orgKemKeyPair(new Uint8Array(32).fill(0x71));
    const statement = { orgId: ORG, seatId: MM.seatId, kemKeyId: kem.kemKeyId, issuedAt: now };
    const seatKem = { statement, kemPubHex: Buffer.from(kem.kemPub).toString("hex"), signature: signOrgSeatKem(statement, MM.secret) };
    const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), memberKeyId: MM.keyId, adminKeyId: "", issuedAt: now };
    const signature = Buffer.from(hybridSign(MM.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
    // A statement signed by another key is refused with the accept.
    const forged = { ...seatKem, signature: signOrgSeatKem(statement, A.secret) };
    expect((await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, seatKem: forged })).status).toBe(403);
    expect((await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, seatKem })).status).toBe(200);
    const deps2 = { ...d, servers: new InMemoryStorage().servers };
    const before = (await handleOrgKeysGet(deps2, ORG)).body as { seatKems: unknown[] };
    expect(before.seatKems).toHaveLength(0);
    const grant = { orgId: ORG, seatId: MM.seatId, labelSha256: invite.labelSha256, memberKeyId: MM.keyId, adminKeyId: "", rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: now, expiresAt: now + 300 * DAY };
    expect((await handleOrgSeatGrant(d, ORG, { grant, roles, memberBinding: MM.binding, adminBinding: null, approvals: [approve(A, canonicalOrgSeatGrant(grant), 1, now)] })).status).toBe(200);
    const after = (await handleOrgKeysGet(deps2, ORG)).body as { seatKems: Array<{ statement: { seatId: string; kemKeyId: string } }> };
    expect(after.seatKems.map((k) => k.statement)).toEqual([expect.objectContaining({ seatId: MM.seatId, kemKeyId: kem.kemKeyId })]);
  });

  it("stores sealed directory entries under one org admin's approval and keeps the newest", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const entry = { seatId: MM.seatId, pendingId: "", pseudonym: "Ana", displayName: "", email: "", externalId: "", source: "manual", groups: [], updatedAt: now };
    const seal = (pseudonym: string, issuedAt: number) =>
      sealOrgDirectoryEntry({ orgId: ORG, entryId: "e1".repeat(16), keyVersion: 1, directoryKey: new Uint8Array(32).fill(9), entry: { ...entry, pseudonym, updatedAt: issuedAt }, issuedAt });
    const s1 = seal("Ana", now);
    expect((await handleOrgDirectoryPut(d, ORG, { entry: s1, approvals: [approve(MM, canonicalOrgDirectoryWrite(s1), 1, now)] })).status).toBe(403);
    expect((await handleOrgDirectoryPut(d, ORG, { entry: s1, approvals: [approve(B, canonicalOrgDirectoryWrite({ ...s1, issuedAt: now + 1 }), 1, now)] })).status).toBe(403);
    expect((await handleOrgDirectoryPut(d, ORG, { entry: s1, approvals: [approve(B, canonicalOrgDirectoryWrite(s1), 1, now)] })).status).toBe(200);
    expect((await handleOrgDirectoryPut(d, ORG, { entry: s1, approvals: [approve(B, canonicalOrgDirectoryWrite(s1), 1, now)] })).status).toBe(409);
    const s2 = seal("Ana P.", now + 1000);
    expect((await handleOrgDirectoryPut(d, ORG, { entry: s2, approvals: [approve(C, canonicalOrgDirectoryWrite(s2), 1, now)] })).status).toBe(200);
    const got = (await handleOrgDirectoryGet(d, ORG)).body as { entries: unknown[] };
    expect(got.entries).toEqual([s2]);
    // Nothing a name could be read from reaches storage: only the sealed bytes and the header.
    const raw = JSON.stringify(await d.store.listObjects(ORG, "directory"));
    expect(raw).not.toContain("Ana");
  });
});
