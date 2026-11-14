import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalOrgSeatAccept,
  canonicalOrgSeatFreeze,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  hybridSign,
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
  handleOrgFreeze,
  handleOrgInviteAccept,
  handleOrgInviteCreate,
  handleOrgLog,
  handleOrgSeatGrant,
  type OrgDeps,
} from "../src/orgs.js";

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
