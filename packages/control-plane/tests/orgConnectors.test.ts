import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalOrgDirectorySliceWrite, canonicalOrgProposalDecision, canonicalOrgSeatGrant, orgSha256Hex, signOrgApproval } from "@flagship/protocol";
import { InMemoryOrgStorage, InMemoryStorage } from "@flagship/storage";
import {
  handleOrgAuthorityAppend,
  handleOrgConnectorPut,
  handleOrgConnectorsGet,
  handleOrgCreate,
  handleOrgProposalDecision,
  handleOrgProposalPost,
  handleOrgProposalsGet,
  handleOrgDirectorySlicePut,
  handleOrgDirectorySlicesGet,
  handleOrgKeysGet,
  type OrgDeps,
} from "../src/index.js";

const dir = resolve(import.meta.dirname, "../../protocol/test-vectors");
const A = JSON.parse(readFileSync(resolve(dir, "org-authority/vectors.json"), "utf8"));
const D = JSON.parse(readFileSync(resolve(dir, "org-directory/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const chain = refs(A.chains[0]);
const grants = refs(A.seatBooks[0]).grants;
const ORG = A.orgId as string;
const C = D.connectors;
const key = (name: string) => {
  const k = A.keys[name];
  return { seatId: k.seatId as string, keyId: k.keyId as string, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const B = key("B admin");
const S = key("S scoped admin");

async function world() {
  let t = C.connector.connector.issuedAt;
  const store = new InMemoryOrgStorage();
  const d: OrgDeps & { set: (x: number) => void } = { orgs: store, usernames: new InMemoryStorage().usernames, now: () => t, set: (x) => (t = x) };
  expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
  expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
  for (const g of grants) await store.putObject(ORG, { kind: "grant", key: `${g.grant.seatId}:${g.grant.issuedAt}`, bodyJson: JSON.stringify(g), issuedAt: g.grant.issuedAt, storedAt: 0 });
  await store.putObject(ORG, { kind: "server", key: "home.acme.flagship.services", bodyJson: JSON.stringify({ serverDomain: "home.acme.flagship.services" }), issuedAt: 0, storedAt: 0 });
  return { d, store };
}

describe(".com directory connectors and proposals", () => {
  it("stores a connector one org admin approved, takes its signed proposals, and records a decision only for an order in the log", async () => {
    const { d, store } = await world();
    expect((await handleOrgConnectorPut(d, ORG, C.connector)).status).toBe(200);
    expect(((await handleOrgConnectorsGet(d, ORG)).body as { connectors: unknown[] }).connectors).toHaveLength(1);
    d.set(C.proposals[0].bundle.proposal.issuedAt);
    for (const p of C.proposals) expect((await handleOrgProposalPost(d, ORG, p.bundle)).status).toBe(200);
    expect((await handleOrgProposalPost(d, ORG, C.proposals[0].bundle)).status).toBe(409);
    const forged = { ...C.proposals[1].bundle, proposal: { ...C.proposals[1].bundle.proposal, proposalId: "d9".repeat(16) } };
    expect((await handleOrgProposalPost(d, ORG, forged)).status).toBe(403);
    const listed = (await handleOrgProposalsGet(d, ORG)).body as { proposals: Array<{ decision: unknown }> };
    expect(listed.proposals).toHaveLength(2);
    // Nothing that names the person reaches storage unsealed.
    expect(JSON.stringify(await store.listObjects(ORG, "proposal"))).not.toMatch(/Ben|acme\.example|Engineering/);

    d.set(C.decision.statement.issuedAt);
    const st = { ...C.decision.statement };
    const approve = (k: typeof B, s: typeof st) =>
      signOrgApproval({ orgId: ORG, oarVersion: 1, order: canonicalOrgProposalDecision(s), seatId: k.seatId, adminKeyId: k.keyId, issuedAt: s.issuedAt, notAfter: s.issuedAt + 86_400_000 }, k.secret);
    const notLogged = await handleOrgProposalDecision(d, ORG, { decision: st, approvals: [approve(B, st)] });
    expect((notLogged.body as { code: string }).code).toBe("org-order-mismatch");
    const ref = orgSha256Hex(canonicalOrgSeatGrant(grants[0].grant));
    await store.appendLog(ORG, "grant", ref, st.issuedAt);
    const done = { ...st, refSha256: ref };
    expect((await handleOrgProposalDecision(d, ORG, { decision: done, approvals: [approve(S, done)] })).status).toBe(403);
    expect((await handleOrgProposalDecision(d, ORG, { decision: done, approvals: [approve(B, done)] })).status).toBe(200);
    expect((await handleOrgProposalDecision(d, ORG, { decision: done, approvals: [approve(B, done)] })).status).toBe(409);
  });

  it("refuses a connector on a box that is not the org's", async () => {
    const { d, store } = await world();
    await store.deleteObject(ORG, "server", "home.acme.flagship.services");
    expect((await handleOrgConnectorPut(d, ORG, C.connector)).status).toBe(403);
  });
});

describe(".com connector standing and members' slices", () => {
  it("flags a connector whose approver left as needing re-approval, then suspended, and lists it with the pending rotations", async () => {
    const st = D.standing;
    const c = st.cases[1];
    let t = c.now;
    const store = new InMemoryOrgStorage();
    const base = new InMemoryStorage();
    const d = { orgs: store, usernames: base.usernames, servers: base.servers, now: () => t };
    expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
    for (const e of chain.entries.slice(1, 3)) expect((await handleOrgAuthorityAppend(d, ORG, { entry: e })).status).toBe(200);
    await store.putObject(ORG, { kind: "connector", key: c.bundle.connector.connectorId, bodyJson: JSON.stringify(c.bundle), issuedAt: c.bundle.connector.issuedAt, storedAt: 0 });
    const got = (await handleOrgConnectorsGet(d, ORG)).body as { connectors: Array<{ standing: { state: string } }>; toReapprove: unknown[] };
    expect(got.connectors[0]!.standing.state).toBe("needs-reapproval");
    expect(got.toReapprove).toHaveLength(1);
    const keys = (await handleOrgKeysGet(d, ORG)).body as { pendingConnectors: Array<{ connectorId: string }> };
    expect(keys.pendingConnectors.map((p) => p.connectorId)).toEqual([c.bundle.connector.connectorId]);
    t = st.cases[2].now;
    expect(((await handleOrgConnectorsGet(d, ORG)).body as { connectors: Array<{ standing: { state: string } }> }).connectors[0]!.standing.state).toBe("suspended");
  });

  it("stores a member's slice under one org admin's approval, sealed to the seat's announced KEM key", async () => {
    const { d, store } = await world();
    const sl = D.slices.seats[0];
    d.set(sl.slice.issuedAt);
    const approve = (k: typeof B, s: unknown) =>
      signOrgApproval({ orgId: ORG, oarVersion: 1, order: canonicalOrgDirectorySliceWrite(s as never), seatId: k.seatId, adminKeyId: k.keyId, issuedAt: sl.slice.issuedAt, notAfter: sl.slice.issuedAt + 86_400_000 }, k.secret);
    // The seat has not announced a KEM key yet.
    expect((await handleOrgDirectorySlicePut(d, ORG, { slice: sl.slice, approvals: [approve(B, sl.slice)] })).status).toBe(403);
    await store.putObject(ORG, { kind: "seat-kem", key: sl.seatId, bodyJson: JSON.stringify({ statement: { orgId: ORG, seatId: sl.seatId, kemKeyId: sl.slice.kemKeyId, issuedAt: 1 } }), issuedAt: 1, storedAt: 0 }, true);
    expect((await handleOrgDirectorySlicePut(d, ORG, { slice: sl.slice, approvals: [approve(S, sl.slice)] })).status).toBe(403);
    expect((await handleOrgDirectorySlicePut(d, ORG, { slice: sl.slice, approvals: [approve(B, sl.slice)] })).status).toBe(200);
    expect((await handleOrgDirectorySlicePut(d, ORG, { slice: sl.slice, approvals: [approve(B, sl.slice)] })).status).toBe(409);
    const other = { ...sl.slice, kemKeyId: "ee".repeat(32), issuedAt: sl.slice.issuedAt + 1 };
    expect((await handleOrgDirectorySlicePut(d, ORG, { slice: other, approvals: [approve(B, other)] })).status).toBe(403);
    const got = (await handleOrgDirectorySlicesGet(d, ORG)).body as { slices: unknown[] };
    expect((got.slices as Array<{ slice: unknown; approvals: unknown[] }>).map((x) => x.slice)).toEqual([sl.slice]);
    expect(JSON.stringify(await store.listObjects(ORG, "directory-slice"))).not.toMatch(/Alma|Bo"|acme\.example/);
  });
});
