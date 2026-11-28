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
  deriveOrgInviteKeys,
  orgInviteAcceptSignature,
  orgInviteReadSignature,
  canonicalOrgInviteWithdraw,
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
  handleOrgInviteGet,
  handleOrgInviteWithdraw,
  handleOrgSeatsGet,
  handleOrgLog,
  handleOrgOverturn,
  handleOrgSeatGrant,
  type OrgDeps,
} from "../src/orgs.js";
import { handleOrgKeysGet } from "../src/orgServers.js";

// The invite key a fixed link key derives (test-vectors/org-invite-key).
const IK = deriveOrgInviteKeys(new Uint8Array(32).fill(0x33));
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
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY, inviteKeyPub: IK.inviteKeyPub };
    const noLabel = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [], sealedLabelHex: "", offerHex: "00" });
    expect((noLabel.body as { code: string }).code).toBe("org-label-missing");
    const inv = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex, offerHex: "0102" });
    expect(inv.status).toBe(200);

    const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), memberKeyId: MM.keyId, adminKeyId: "", issuedAt: now };
    const signature = Buffer.from(hybridSign(MM.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
    const acc = await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) });
    expect(acc.status).toBe(200);

    const grant = { orgId: ORG, seatId: MM.seatId, labelSha256: invite.labelSha256, memberKeyId: MM.keyId, adminKeyId: "", rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: now, expiresAt: now + 300 * DAY };
    const bundle = { grant, roles, memberBinding: MM.binding, adminBinding: null, approvals: [approve(A, canonicalOrgSeatGrant(grant), 1, now)] };
    const g = await handleOrgSeatGrant(d, ORG, bundle);
    expect(g.status).toBe(200);
  });

  it("refuses a seat beyond the plan's limit", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    await d.store.setPlan(ORG, { planTier: "business", seatLimit: 0, paidUntil: null });
    const roles: OrgSeatRole[] = [{ role: "member" }];
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from("aa", "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY, inviteKeyPub: IK.inviteKeyPub };
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

  it("takes no founder-removal or recovery entry until .com observes the notice itself", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    for (const via of ["founder-removal", "recovery"] as const) {
      const entry = { ...chain.entries[1], via } as unknown as typeof chain.entries[1];
      const r = await handleOrgAuthorityAppend(d, ORG, { entry });
      expect(r.status).toBe(400);
      expect((r.body as { code: string }).code).toBe("delayed-change-unavailable");
    }
  });

  it("never opens a server code as a ceremony (ceremonies are readable by anyone with the org id)", async () => {
    const now = chain.entries[1].record.issuedAt + 3_600_000;
    const d = await created(now);
    const order = new TextEncoder().encode(`flagship/org-server-code/v1|${ORG}|x|orgsrv-0001-secret|home|home.acme.flagship.services|-|${now}|${now + 1}`);
    const open = await handleOrgCeremonyOpen(d, ORG, { order: new TextDecoder().decode(order), approvals: [approve(A, order, 1, now)] });
    expect(open.status).toBe(400);
    expect(JSON.stringify(open.body)).not.toContain("orgsrv-0001-secret");
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
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY, inviteKeyPub: IK.inviteKeyPub };
    expect((await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex, offerHex: "0102" })).status).toBe(200);
    const kem = orgKemKeyPair(new Uint8Array(32).fill(0x71));
    const statement = { orgId: ORG, seatId: MM.seatId, kemKeyId: kem.kemKeyId, issuedAt: now };
    const seatKem = { statement, kemPubHex: Buffer.from(kem.kemPub).toString("hex"), signature: signOrgSeatKem(statement, MM.secret) };
    const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), memberKeyId: MM.keyId, adminKeyId: "", issuedAt: now };
    const signature = Buffer.from(hybridSign(MM.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
    // A statement signed by another key is refused with the accept.
    const forged = { ...seatKem, signature: signOrgSeatKem(statement, A.secret) };
    expect((await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept), seatKem: forged })).status).toBe(403);
    expect((await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept), seatKem })).status).toBe(200);
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

describe("the invite link's key (no squatting on an orgId)", () => {
  const roles: OrgSeatRole[] = [{ role: "member" }];
  const sealedLabelHex = "aa".repeat(40);
  async function invited(now: number) {
    const d = await created(now);
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY, inviteKeyPub: IK.inviteKeyPub };
    expect((await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex, offerHex: "0102" })).status).toBe(200);
    const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: orgSha256Hex(canonicalOrgSeatInvite(invite)), memberKeyId: MM.keyId, adminKeyId: "", issuedAt: now };
    const signature = Buffer.from(hybridSign(MM.secret, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept))).toString("hex");
    return { d, invite, accept, signature };
  }
  const now = chain.entries[1].record.issuedAt + 3_600_000;
  const OTHER = deriveOrgInviteKeys(new Uint8Array(32).fill(0x34));

  it("refuses an invite without an invite key", async () => {
    const d = await created(now);
    const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY };
    const r = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [], sealedLabelHex, offerHex: "0102" });
    expect(r.status).toBe(403);
    expect((r.body as { code: string }).code).toBe("org-malformed");
  });

  it("reads the offer only with a fresh invite-key proof; otherwise it is an unknown invite", async () => {
    const { d } = await invited(now);
    const unknown = await handleOrgInviteGet(d, ORG, "ef".repeat(16), { issuedAt: String(now), signature: orgInviteReadSignature(IK.hybridSecret, ORG, "ef".repeat(16), now) });
    expect(unknown.status).toBe(404);
    const proof = (secret: Uint8Array, seat: string, at: number) => ({ issuedAt: String(at), signature: orgInviteReadSignature(secret, ORG, seat, at) });
    for (const p of [
      { issuedAt: null, signature: null },
      proof(OTHER.hybridSecret, MM.seatId, now),
      proof(IK.hybridSecret, "ef".repeat(16), now),
      proof(IK.hybridSecret, MM.seatId, now - 6 * 60_000),
      { issuedAt: String(now + 1), signature: proof(IK.hybridSecret, MM.seatId, now).signature },
    ]) {
      const r = await handleOrgInviteGet(d, ORG, MM.seatId, p);
      expect(r.status).toBe(404);
      expect(r.body).toEqual(unknown.body);
    }
    const good = await handleOrgInviteGet(d, ORG, MM.seatId, proof(IK.hybridSecret, MM.seatId, now - 60_000));
    expect(good.status).toBe(200);
    expect((good.body as { offerHex: string; accepted: boolean })).toMatchObject({ offerHex: "0102", accepted: false });
  });

  it("an accept without the invite key's signature is refused, so knowing the orgId cannot claim the seat", async () => {
    const { d, accept, signature } = await invited(now);
    const squat = [
      { accept, memberBinding: MM.binding, adminBinding: null, signature },
      { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: "" },
      { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(OTHER.hybridSecret, accept) },
      { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: signature },
    ];
    for (const body of squat) {
      const r = await handleOrgInviteAccept(d, ORG, MM.seatId, body);
      expect(r.status).toBe(404);
    }
    const seats = (await handleOrgSeatsGet(d, ORG)).body as { accepts: unknown[] };
    expect(seats.accepts).toHaveLength(0);
    // The real invitee, holding the link, still gets in first.
    const ok = await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) });
    expect(ok.status).toBe(200);
    const after = (await handleOrgSeatsGet(d, ORG)).body as { accepts: Array<{ inviteSignature: string }> };
    expect(after.accepts).toHaveLength(1);
    expect(after.accepts[0]!.inviteSignature).toMatch(/^[0-9a-f]{6746}$/);
  });

  it("an admin cannot admit a seat whose accept lacks the invite-key proof (an accept stored before the fix)", async () => {
    const { d, invite, accept, signature } = await invited(now);
    await d.store.putObject(ORG, { kind: "accept", key: MM.seatId, bodyJson: JSON.stringify({ accept, memberBinding: MM.binding, adminBinding: null, signature, seatKem: null }), issuedAt: now, storedAt: now });
    const grant = { orgId: ORG, seatId: MM.seatId, labelSha256: invite.labelSha256, memberKeyId: MM.keyId, adminKeyId: "", rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: now, expiresAt: now + 300 * DAY };
    const g = await handleOrgSeatGrant(d, ORG, { grant, roles, memberBinding: MM.binding, adminBinding: null, approvals: [approve(A, canonicalOrgSeatGrant(grant), 1, now)] });
    expect(g.status).toBe(403);
    expect((g.body as { code: string }).code).toBe("org-invite-proof");
  });

  it("invites stored before the invite key are not served and cannot be read or accepted", async () => {
    const d = await created(now);
    const old = { orgId: ORG, seatId: MM.seatId, labelSha256: orgSha256Hex(Buffer.from(sealedLabelHex, "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY };
    await d.store.putObject(ORG, { kind: "invite", key: MM.seatId, bodyJson: JSON.stringify({ invite: old, roles, approvals: [], sealedLabelHex, offerHex: "01" }), issuedAt: now, storedAt: now });
    expect((await handleOrgInviteGet(d, ORG, MM.seatId, { issuedAt: String(now), signature: orgInviteReadSignature(IK.hybridSecret, ORG, MM.seatId, now) })).status).toBe(404);
    expect(((await handleOrgSeatsGet(d, ORG)).body as { invites: unknown[] }).invites).toHaveLength(0);
  });

  it("an admin withdraws an invite: the invite and its accept go, the seat id is never invited again", async () => {
    const { d, invite, accept, signature } = await invited(now);
    expect((await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) })).status).toBe(200);
    const withdraw = { orgId: ORG, seatId: MM.seatId, oarVersion: 1, issuedAt: now };
    const order = canonicalOrgInviteWithdraw(withdraw);
    const outsider = await handleOrgInviteWithdraw(d, ORG, MM.seatId, { withdraw, approvals: [approve(key("X outsider"), order, 1, now)] });
    expect(outsider.status).toBe(403);
    const board = await handleOrgInviteWithdraw(d, ORG, MM.seatId, { withdraw, approvals: [approve(key("D board"), order, 1, now)] });
    expect(board.status).toBe(403);
    const otherSeat = await handleOrgInviteWithdraw(d, ORG, "ef".repeat(16), { withdraw, approvals: [approve(B, order, 1, now)] });
    expect(otherSeat.status).toBe(400);
    const r = await handleOrgInviteWithdraw(d, ORG, MM.seatId, { withdraw, approvals: [approve(B, order, 1, now)] });
    expect(r.status).toBe(200);
    const seats = (await handleOrgSeatsGet(d, ORG)).body as { accepts: unknown[]; invites: unknown[] };
    expect(seats.accepts).toHaveLength(0);
    expect(seats.invites).toHaveLength(0);
    expect((await handleOrgInviteGet(d, ORG, MM.seatId, { issuedAt: String(now), signature: orgInviteReadSignature(IK.hybridSecret, ORG, MM.seatId, now) })).status).toBe(404);
    const again = await handleOrgInviteCreate(d, ORG, { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex, offerHex: "0102" });
    expect(again.status).toBe(409);
    const log = (await handleOrgLog(d, ORG, 0)).body as { entries: Array<{ kind: string; refSha256: string }> };
    expect(log.entries.at(-1)).toMatchObject({ kind: "invite-withdraw", refSha256: orgSha256Hex(order) });
  });

  it("refuses to withdraw an invite once its seat is admitted", async () => {
    const { d, invite, accept, signature } = await invited(now);
    expect((await handleOrgInviteAccept(d, ORG, MM.seatId, { accept, memberBinding: MM.binding, adminBinding: null, signature, inviteSignature: orgInviteAcceptSignature(IK.hybridSecret, accept) })).status).toBe(200);
    const grant = { orgId: ORG, seatId: MM.seatId, labelSha256: invite.labelSha256, memberKeyId: MM.keyId, adminKeyId: "", rolesHash: invite.rolesHash, oarVersion: 1, issuedAt: now, expiresAt: now + 300 * DAY };
    expect((await handleOrgSeatGrant(d, ORG, { grant, roles, memberBinding: MM.binding, adminBinding: null, approvals: [approve(A, canonicalOrgSeatGrant(grant), 1, now)] })).status).toBe(200);
    const withdraw = { orgId: ORG, seatId: MM.seatId, oarVersion: 1, issuedAt: now };
    const r = await handleOrgInviteWithdraw(d, ORG, MM.seatId, { withdraw, approvals: [approve(B, canonicalOrgInviteWithdraw(withdraw), 1, now)] });
    expect((r.body as { code: string }).code).toBe("org-seat-admitted");
  });
});
